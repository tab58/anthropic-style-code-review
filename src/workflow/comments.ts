import { type Finding, fingerprint, type Location, type Severity } from '../review/index.js'
import { type SecurityFinding, securityFingerprint, type SecurityLevel } from '../security/index.js'
import { encodeFindingMarker, encodeSecurityMarker, encodeState, type ReviewState } from './markers.js'

const LABEL: Record<Severity, string> = { important: 'Important', pre_existing: 'Pre-existing', nit: 'Nit' }
const ORDER: readonly Severity[] = ['important', 'pre_existing', 'nit']
const LEVEL_LABEL: Record<SecurityLevel, string> = { high: 'High', medium: 'Medium', low: 'Low' }
const LEVEL_ORDER: readonly SecurityLevel[] = ['high', 'medium', 'low']

/** Model text must not be able to open HTML comments (hidden text, forged markers). */
const safe = (t: string) => t.replace(/<!--/g, '&lt;!--')
const OUT_OF_DIFF_CAP = 20

/** Builds a link to a location's lines at the PR head, or undefined when there's no web URL (local runs). */
export type Linker = (l: Location) => string | undefined

/**
 * A {@link Linker} for a PR: `https://github.com/o/r/blob/<head sha>/<file>#L10-L14`. GitHub renders such a permalink,
 * on its own line, as a code snippet.
 *
 * @param pr - The PR's web URL (`…/pull/<n>`) and head commit; without a URL every link is undefined.
 * @returns The linker.
 */
export const permalinker =
  (pr: { readonly url?: string; readonly headSha: string }): Linker =>
  (l) =>
    pr.url === undefined ? undefined : `${pr.url.replace(/\/pull\/\d+\/?$/, '')}/blob/${pr.headSha}/${l.file.split('/').map(encodeURIComponent).join('/')}${lineAnchor(l)}`

/** `#L10` or `#L10-L14`. */
const lineAnchor = (l: Location) => `#L${l.line}${l.endLine > l.line ? `-L${l.endLine}` : ''}`

/** `file#L10-L14`, as inline code. */
const loc = (l: Location) => `<code>${escapeHtml(l.file)}${lineAnchor(l)}</code>`

/** Escapes text for use inside HTML tags (`<summary>`, `<code>`). */
const escapeHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Collapsible location that expands to the permalink snippet; a plain location when there's no link. */
function locationBlock(l: Location, link: Linker): string {
  const url = link(l)
  return url === undefined ? loc(l) : ['<details>', `<summary>${loc(l)}</summary>`, '', url, '', '</details>'].join('\n')
}

const LANGUAGE: Readonly<Record<string, string>> = {
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js', go: 'go', py: 'python', rb: 'ruby', java: 'java', kt: 'kotlin',
  rs: 'rust', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', swift: 'swift', scala: 'scala', sql: 'sql',
  sh: 'bash', bash: 'bash', yml: 'yaml', yaml: 'yaml', json: 'json', html: 'html', css: 'css', scss: 'scss', tf: 'hcl', proto: 'protobuf',
}

/**
 * Evidence as a fenced code block, highlighted by the file's language. The fence is longer than any backtick run in
 * the code, and `<!--` is defused so model text can't forge a hidden marker.
 */
function codeBlock(file: string, code: string): string {
  const lang = LANGUAGE[file.slice(file.lastIndexOf('.') + 1).toLowerCase()] ?? ''
  const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map((m) => m[0].length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${lang}\n${code.replace(/<!--/g, '<!-\u200b-').replace(/\s+$/, '')}\n${fence}`
}

/** "Also at" blocks for a finding's other locations. */
const alsoBlocks = (also: readonly Location[] | undefined, link: Linker, what: string): readonly string[] =>
  also?.length ? ['', `${what} also at:`, '', ...also.map((l) => locationBlock(l, link)).flatMap((b) => [b, ''])] : []

/** Inline comment body for one finding, ending with its hidden finding marker. */
export function findingComment(f: Finding, link: Linker = () => undefined): string {
  return [
    `### ${LABEL[f.severity]}: ${safe(f.title)}`,
    '',
    safe(f.explanation).trim(),
    '',
    codeBlock(f.file, f.evidence),
    ...alsoBlocks(f.also, link, 'Same issue'),
    '',
    encodeFindingMarker(f.severity, fingerprint(f)),
  ].join('\n')
}

/** Security tag, e.g. `Security · High · Pre-existing`. */
const securityLabel = (f: SecurityFinding) => `Security · ${LEVEL_LABEL[f.severity]}${f.introduced ? '' : ' · Pre-existing'}`

/** The attack path, collapsed. */
const attackPath = (f: SecurityFinding) => ['<details>', '<summary>Attack path</summary>', '', `- **Source:** ${safe(f.source)}`, `- **Sink:** ${safe(f.sink)}`, '', '</details>']

/** Inline comment body for one vulnerability (exploit, impact, attack path, evidence), ending with its hidden security marker. */
export function securityComment(f: SecurityFinding, link: Linker = () => undefined): string {
  return [
    `### ${securityLabel(f)}: ${safe(f.title)}`,
    '',
    safe(f.exploitScenario).trim(),
    '',
    `**Impact:** ${safe(f.impact).trim()}`,
    '',
    ...attackPath(f),
    '',
    codeBlock(f.file, f.evidence),
    ...alsoBlocks(f.also, link, 'Same vulnerability'),
    '',
    encodeSecurityMarker(f.severity, f.introduced, securityFingerprint(f)),
  ].join('\n')
}

/** `n label` pairs for the non-zero buckets. */
const breakdown = <K extends string>(keys: readonly K[], countOf: (k: K) => number, label: (k: K) => string) =>
  keys
    .map((k) => [k, countOf(k)] as const)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${label(k).toLowerCase()}`)
    .join(', ')

/** First summary line: bug count, then security count, or a plain 'No issues found.' */
function countLine(findings: readonly Finding[], security: readonly SecurityFinding[]): string {
  if (findings.length === 0 && security.length === 0) return '**No issues found.**'
  const bugs = findings.length
    ? `**${findings.length} issue${findings.length === 1 ? '' : 's'} found** (${breakdown(ORDER, (s) => findings.filter((f) => f.severity === s).length, (s) => LABEL[s])})`
    : undefined
  const sec = security.length
    ? `**${security.length} security finding${security.length === 1 ? '' : 's'}** (${breakdown(LEVEL_ORDER, (l) => security.filter((f) => f.severity === l).length, (l) => LEVEL_LABEL[l])})`
    : undefined
  return [bugs, sec].filter((x) => x !== undefined).join(' · ')
}

/** One collapsible summary section: heading, text, then the location snippet. */
const section = (heading: string, text: string, l: Location, link: Linker): readonly string[] => [
  '<details open>',
  `<summary><h3>${heading}</h3></summary>`,
  '',
  text,
  '',
  locationBlock(l, link),
  '',
  '</details>',
]

/** Summary sections for findings outside the diff (they can't be inline comments), capped. */
function outOfDiffLines(items: readonly (readonly string[])[]): readonly string[] {
  if (items.length === 0) return []
  const shown = items.slice(0, OUT_OF_DIFF_CAP).flatMap((s) => ['', '---', '', ...s])
  return ['', '**Outside the diff**', ...shown, ...(items.length > OUT_OF_DIFF_CAP ? ['', `…and ${items.length - OUT_OF_DIFF_CAP} more`] : [])]
}

/** A markdown table cell: comment openers, pipes and newlines neutralized. */
const cell = (t: string) => safe(t).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')

/** `| Pass | Result |` table lines (with a leading blank line), or nothing when there are no rows. */
const passesTable = (rows: readonly (readonly [string, string])[]): readonly string[] =>
  rows.length === 0 ? [] : ['', '| Pass | Result |', '|---|---|', ...rows.map(([label, result]) => `| ${cell(label)} | ${cell(result)} |`)]

/** What the round summary reports. */
export type SummaryInput = {
  /** Every finding posted this round (inline or not). */
  readonly findings: readonly Finding[]
  /** Subset whose line is outside the diff, so they are listed here instead of inline. */
  readonly outOfDiff: readonly Finding[]
  /** Every security finding posted this round. Default none. */
  readonly security?: readonly SecurityFinding[]
  /** Subset of `security` outside the diff. Default none. */
  readonly securityOutOfDiff?: readonly SecurityFinding[]
  /** Extra lines shown under the count (e.g. a security pass that didn't complete). Default none. */
  readonly notes?: readonly string[]
  /** Per-pass `[label, result]` rows, shown as a table under the count. Default none. */
  readonly passes?: readonly (readonly [string, string])[]
  /** Earlier threads auto-resolved this round. */
  readonly resolved: number
  /** State to embed (this round's). */
  readonly state: ReviewState
  /** Round cap, shown in the footer. */
  readonly maxRounds: number
  /** Builds code permalinks for out-of-diff findings. Default: no links. */
  readonly link?: Linker
}

/** Review summary body: count first, resolved count, out-of-diff findings, round footer, state marker. */
export function summary({ findings, outOfDiff, security = [], securityOutOfDiff = [], notes = [], passes = [], resolved, state, maxRounds, link = () => undefined }: SummaryInput): string {
  const outside = [
    ...outOfDiff.map((f) => section(`${LABEL[f.severity]}: ${escapeHtml(f.title)}`, safe(f.explanation).trim(), f, link)),
    ...securityOutOfDiff.map((f) => section(`${securityLabel(f)}: ${escapeHtml(f.title)}`, safe(f.exploitScenario).trim(), f, link)),
  ]
  return [
    countLine(findings, security),
    ...passesTable(passes),
    ...notes.flatMap((n) => ['', `⚠️ ${n}`]),
    ...(resolved > 0 ? ['', `${resolved} earlier finding${resolved === 1 ? '' : 's'} resolved by new commits.`] : []),
    ...outOfDiffLines(outside),
    '',
    `<sub>Review round ${state.round}/${maxRounds}. Fix each finding; only someone other than the author can dismiss one, by replying \`/resolve\` and a reason.</sub>`,
    encodeState(state),
  ].join('\n')
}

/** Review body posted once when the round cap is exceeded. */
export const stepBackComment = (maxRounds: number, state: ReviewState): string =>
  [
    `**Review paused after ${maxRounds} review rounds.**`,
    '',
    'New findings keep appearing round after round. Step back and reconsider the approach rather than patching ' +
      'findings one at a time. Automated review will not run again on this PR; open threads still gate merge.',
    encodeState(state),
  ].join('\n')

/** Review body posted when a round is skipped (e.g. oversized diff); still advances state. */
export const skippedComment = (reason: string, state: ReviewState): string =>
  [`**Review skipped:** ${reason}`, '', 'Later pushes will be reviewed incrementally.', encodeState(state)].join('\n')
