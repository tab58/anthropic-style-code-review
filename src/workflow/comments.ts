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

/** `file:line` or `file:line-end`, as inline code. */
const loc = (l: Location) => `\`${safe(l.file)}:${l.line}${l.endLine > l.line ? `-${l.endLine}` : ''}\``
/** Markdown blockquote of (sanitized) text. */
const quote = (text: string) => safe(text).trim().split('\n').map((l) => `> ${l}`).join('\n')

/** Inline comment body for one finding, ending with its hidden finding marker. */
export function findingComment(f: Finding): string {
  return [
    `**${LABEL[f.severity]}**: ${safe(f.title)}`,
    '',
    safe(f.explanation).trim(),
    '',
    quote(f.evidence),
    ...(f.also?.length ? ['', `Same issue also at: ${f.also.map(loc).join(', ')}`] : []),
    '',
    encodeFindingMarker(f.severity, fingerprint(f)),
  ].join('\n')
}

/** Security tag, e.g. `Security · High · Pre-existing`. */
const securityLabel = (f: SecurityFinding) => `Security · ${LEVEL_LABEL[f.severity]}${f.introduced ? '' : ' · Pre-existing'}`

/** Inline comment body for one vulnerability (attack path, evidence), ending with its hidden security marker. */
export function securityComment(f: SecurityFinding): string {
  return [
    `**${securityLabel(f)}**: ${safe(f.title)}`,
    '',
    `- **Source:** ${safe(f.source)}`,
    `- **Sink:** ${safe(f.sink)}`,
    `- **Exploit:** ${safe(f.exploitScenario)}`,
    `- **Impact:** ${safe(f.impact)}`,
    '',
    quote(f.evidence),
    ...(f.also?.length ? ['', `Same vulnerability also at: ${f.also.map(loc).join(', ')}`] : []),
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

/** Summary lines for findings outside the diff, capped. */
function outOfDiffLines(items: readonly string[]): readonly string[] {
  if (items.length === 0) return []
  return ['', 'Outside the diff:', ...items.slice(0, OUT_OF_DIFF_CAP), ...(items.length > OUT_OF_DIFF_CAP ? [`- …and ${items.length - OUT_OF_DIFF_CAP} more`] : [])]
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
}

/** Review summary body: count first, resolved count, out-of-diff findings, round footer, state marker. */
export function summary({ findings, outOfDiff, security = [], securityOutOfDiff = [], notes = [], passes = [], resolved, state, maxRounds }: SummaryInput): string {
  const outside = [
    ...outOfDiff.map((f) => `- ${loc(f)} **${LABEL[f.severity]}**: ${safe(f.title)}. ${safe(f.explanation).trim()}`),
    ...securityOutOfDiff.map((f) => `- ${loc(f)} **${securityLabel(f)}**: ${safe(f.title)}. ${safe(f.exploitScenario).trim()}`),
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
