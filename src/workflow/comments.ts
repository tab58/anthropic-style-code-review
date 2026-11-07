import { type Finding, fingerprint, type Location, type Severity } from '../review/index.js'
import { encodeFindingMarker, encodeState, type ReviewState } from './markers.js'

const LABEL: Record<Severity, string> = { important: 'Important', pre_existing: 'Pre-existing', nit: 'Nit' }
const ORDER: readonly Severity[] = ['important', 'pre_existing', 'nit']

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

/** First summary line: the count and severity breakdown, or a plain 'No issues found.' */
function countLine(findings: readonly Finding[]): string {
  if (findings.length === 0) return '**No issues found.**'
  const parts = ORDER.map((s) => [s, findings.filter((f) => f.severity === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${LABEL[s].toLowerCase()}`)
  return `**${findings.length} issue${findings.length === 1 ? '' : 's'} found** (${parts.join(', ')})`
}

/** What the round summary reports. */
export type SummaryInput = {
  /** Every finding posted this round (inline or not). */
  readonly findings: readonly Finding[]
  /** Subset whose line is outside the diff, so they are listed here instead of inline. */
  readonly outOfDiff: readonly Finding[]
  /** Earlier threads auto-resolved this round. */
  readonly resolved: number
  /** State to embed (this round's). */
  readonly state: ReviewState
  /** Round cap, shown in the footer. */
  readonly maxRounds: number
}

/** Review summary body: count first, resolved count, out-of-diff findings, round footer, state marker. */
export function summary({ findings, outOfDiff, resolved, state, maxRounds }: SummaryInput): string {
  return [
    countLine(findings),
    ...(resolved > 0 ? ['', `${resolved} earlier finding${resolved === 1 ? '' : 's'} resolved by new commits.`] : []),
    ...(outOfDiff.length
      ? [
          '',
          'Outside the diff:',
          ...outOfDiff.slice(0, OUT_OF_DIFF_CAP).map((f) => `- ${loc(f)} **${LABEL[f.severity]}**: ${safe(f.title)}. ${safe(f.explanation).trim()}`),
          ...(outOfDiff.length > OUT_OF_DIFF_CAP ? [`- …and ${outOfDiff.length - OUT_OF_DIFF_CAP} more`] : []),
        ]
      : []),
    '',
    `<sub>Review round ${state.round}/${maxRounds}. Resolve each thread by fixing it or replying with a reason.</sub>`,
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
