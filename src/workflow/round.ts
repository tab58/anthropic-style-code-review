import type { Location } from '../consensus.js'
import { type FileDiff, filterDiff, parseDiff } from '../diff.js'
import { type Guidance, loadGuidance, renderGuidance } from '../guidance.js'
import { createLimiter, type Limiter } from '../limiter.js'
import {
  type DepthConfig,
  type Finding,
  fingerprint,
  type Reviewer,
  type ReviewInput,
  type ReviewResult,
  resolveDepth,
  runReview,
} from '../review/index.js'
import {
  chooseSecurityPlan,
  SECURITY_PLANS,
  runSecurityReview,
  type SecurityFinding,
  securityFingerprint,
  type SecurityPassDepth,
  type SecurityResult,
  type SecurityReviewer,
} from '../security/index.js'
import { requiredApprovals, type RiskAssessment, type RiskClassifier } from '../risk/index.js'
import { findingComment, securityComment, skippedComment, stepBackComment, summary } from './comments.js'
import { decodeState, type ReviewState } from './markers.js'
import { openThreads } from './gates.js'
import { assessRound, tierFields } from './risk.js'
import type { BotThread, PullRequest, RoundOutcome, WorkflowConfig, WorkflowOptions } from './workflow.js'

/** Options with fixed defaults applied. */
export type Settings = WorkflowOptions & {
  readonly maxRounds: number
  readonly maxDiffLines: number
  readonly maxFindings: number
  readonly concurrency: number
  readonly securityReview: boolean
  readonly checkName: string
  readonly riskTiers: boolean
  readonly nitCapDefault: number
}

/** Everything a round's helpers need. */
export type Context = WorkflowConfig & { readonly settings: Settings }

/** One pass's diff range (after skip_paths). */
type PassRange = { readonly files: readonly FileDiff[] }

/** What this event reviews: a range per due pass, plus the full PR diff and base-ref guidance. */
type Ranges = {
  readonly bug: PassRange | undefined
  readonly security: PassRange | undefined
  readonly prFiles: readonly FileDiff[]
  readonly guidance: Guidance
}

/** A security pass that ran, failed, or wasn't due. */
type SecurityPass =
  | { readonly status: 'done'; readonly result: SecurityResult; readonly depth: SecurityPassDepth }
  | { readonly status: 'failed'; readonly reason: string }
  | undefined

/** HTTP status of an Octokit-style error, if any. */
const statusOf = (e: unknown): number | undefined =>
  typeof e === 'object' && e !== null && 'status' in e && typeof e.status === 'number' ? e.status : undefined
/** Error message of any thrown value. */
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))
/** A `skipped` outcome. */
const skipped = (message: string): RoundOutcome => ({ status: 'skipped', message })
/** Paths a pass may report on. */
const livePaths = (r: PassRange) => r.files.filter((f) => !f.deleted).map((f) => f.path)

/** Tier for commits automated review skipped (high), when risk tiers are on. */
const skippedRisk = (ctx: Context, pr: PullRequest, state: ReviewState | undefined) =>
  ctx.settings.riskTiers ? assessRound(pr, state, { prFiles: [], guidance: undefined, bugs: [], security: [], skipped: true }) : Promise.resolve(undefined)

/** Past the round cap: post the step-back note once (when first exceeded), then stay quiet. Security stays behind, so its gate fails closed. */
async function pauseRound(ctx: Context, pr: PullRequest, state: ReviewState | undefined, round: number): Promise<RoundOutcome> {
  const { maxRounds } = ctx.settings
  if (state?.round === maxRounds) {
    const risk = await skippedRisk(ctx, pr, state)
    await ctx.github.createReview({ headSha: pr.headSha, body: stepBackComment(maxRounds, { ...state, round, sha: pr.headSha, ...tierFields(risk) }), comments: [] })
  }
  return { status: 'paused', round, message: `Round cap (${maxRounds}) reached; not reviewing.` }
}

/** Loads each due pass's range (incremental from its last completed SHA unless history was rewritten) and base-ref guidance. */
async function loadRanges(ctx: Context, pr: PullRequest, state: ReviewState | undefined, due: { bug: boolean; security: boolean }): Promise<Ranges> {
  const cache = new Map<string, Promise<readonly FileDiff[]>>()
  const diff = (base: string) => {
    const hit = cache.get(base) ?? ctx.github.compareDiff(base, pr.headSha).then(parseDiff)
    cache.set(base, hit)
    return hit
  }
  const logged = new Set<string>()
  const since = async (pass: string, sha: string | undefined) => {
    const incremental = sha !== undefined && (await ctx.github.isAncestor(sha, pr.headSha))
    if (sha !== undefined && !incremental) ctx.log.info(`Last reviewed ${short(sha)} is not an ancestor of HEAD (force push?); reviewing the full PR.`)
    const base = incremental ? sha : pr.baseSha
    const files = await diff(base)
    if (!logged.has(base)) ctx.log.info(`${pass}: ${describeRange(files)}, ${short(base)}...${short(pr.headSha)} (${incremental ? 'new commits since the last review' : 'whole PR'})`)
    logged.add(base)
    return files
  }
  const bugAll = due.bug ? await since('Range', state?.sha) : undefined
  const securityAll = due.security ? await since('Security range', state?.securitySha) : undefined
  const changed = [...(bugAll ?? []), ...(securityAll ?? [])].map((f) => f.path)
  const guidance = await loadGuidance({ read: (path) => ctx.github.readAtRef(pr.baseSha, path) }, [...new Set(changed)])
  const skip = guidance.review?.config.skipPaths ?? []
  return {
    bug: bugAll && { files: filterDiff(bugAll, skip) },
    security: securityAll && { files: filterDiff(securityAll, skip) },
    prFiles: await diff(pr.baseSha), // cached when a range already starts at the base
    guidance,
  }
}

/** State field carrying every thread recorded as fixed-but-unresolvable. */
const fixedFields = (state: ReviewState | undefined, added: readonly string[]) => {
  const fixedThreads = [...(state?.fixedThreads ?? []), ...added]
  return fixedThreads.length > 0 ? { fixedThreads } : {}
}

/** First 7 characters of a SHA. */
const short = (sha: string) => sha.slice(0, 7)

/** `3 files, +120/-30 lines`. */
function describeRange(files: readonly FileDiff[]): string {
  const added = files.reduce((n, f) => n + f.addedLines.size, 0)
  const removed = files.reduce((n, f) => n + f.changed, 0) - added
  return `${plural(files.length, 'file')}, +${added}/-${removed} lines`
}

/** What the agents see for a range. */
const buildInput = (pr: PullRequest, range: PassRange, guidance: Guidance): ReviewInput => ({
  diff: range.files.map((f) => f.text).join(''),
  guidance: renderGuidance(guidance),
  intent: `${pr.title}\n\n${pr.body}`.trim(),
})

/** Asks `depth.voters` verifiers whether one thread's issue is still present; true if a quorum says fixed. */
async function isFixed(ctx: Context, reviewer: Reviewer, limit: Limiter, t: BotThread, input: ReviewInput, depth: DepthConfig): Promise<boolean> {
  const answers = await Promise.all(
    Array.from({ length: depth.voters }, () =>
      limit(() => reviewer.recheck({ file: t.path, line: t.line ?? 0, text: t.body }, input)).catch((e: unknown) => {
        ctx.log.warning(`recheck ${t.path}: ${errMsg(e)}`)
        return true // unsure → still present
      }),
    ),
  )
  const fixedVotes = answers.filter((still) => !still).length
  const fixed = fixedVotes >= depth.needed
  ctx.log.info(`recheck ${t.path}:${t.line ?? 'outdated'}: ${fixedVotes}/${depth.voters} say fixed → ${fixed ? 'fixed' : 'still open'}`)
  return fixed
}

/** Threads a quorum found fixed this round, and which of them the token couldn't resolve. */
type AutoResolved = { readonly count: number; readonly unresolvable: readonly string[] }

/** Resolves a fixed thread; on failure (GITHUB_TOKEN often may not resolve threads) warns and reports false. */
async function tryResolve(ctx: Context, t: BotThread): Promise<boolean> {
  try {
    await ctx.github.resolveThread(t.id)
    return true
  } catch (e) {
    ctx.log.warning(`Could not resolve fixed thread ${t.path}:${t.line ?? '?'} (${errMsg(e)}); recording it as fixed so it no longer blocks.`)
    return false
  }
}

/** Resolves open bot threads in touched files that a verifier quorum says are fixed. */
async function autoResolve(ctx: Context, state: ReviewState, a: { reviewer: Reviewer; limit: Limiter; touched: ReadonlySet<string>; input: ReviewInput; depth: DepthConfig }): Promise<AutoResolved> {
  const { reviewer, limit, input, depth } = a
  const open = (await openThreads(ctx.github, state)).filter((t) => a.touched.has(t.path))
  if (open.length > 0) ctx.log.info(`Rechecking ${plural(open.length, 'open finding')} in changed files`)
  const results = await Promise.all(
    open.map(async (t) => {
      if (!(await isFixed(ctx, reviewer, limit, t, input, depth))) return undefined
      return { id: t.id, resolved: await tryResolve(ctx, t) }
    }),
  )
  const fixed = results.filter((r) => r !== undefined)
  return { count: fixed.length, unresolvable: fixed.filter((r) => !r.resolved).map((r) => r.id) }
}

/** Inputs shared by both passes. */
type PassArgs = {
  readonly reviewer: Reviewer & SecurityReviewer
  readonly limit: Limiter
  readonly ranges: Ranges
  readonly pr: PullRequest
  readonly depth: DepthConfig
  readonly posted: readonly string[]
}

/** Runs the bug pass if due and non-empty. */
async function runBugPass(ctx: Context, a: PassArgs): Promise<ReviewResult | undefined> {
  const range = a.ranges.bug
  if (!range || range.files.length === 0) return undefined
  const nitCap = ctx.settings.nitCap ?? a.ranges.guidance.review?.config.nitCap ?? ctx.settings.nitCapDefault
  const input = buildInput(a.pr, range, a.ranges.guidance)
  return runReview(a.reviewer, { input, paths: livePaths(range), depth: a.depth, posted: a.posted, nitCap, maxFindings: ctx.settings.maxFindings, limit: a.limit, onProgress: ctx.log.info })
}

/** Runs the security pass if due. Failures are caught, so they never discard the bug review. */
async function runSecurityPass(ctx: Context, a: PassArgs): Promise<SecurityPass> {
  const range = a.ranges.security
  if (!range) return undefined
  const config = a.ranges.guidance.review?.config
  const plan = chooseSecurityPlan(range.files, { extraPaths: config?.securityPaths ?? [], forceFull: a.depth.depth === 'deep' })
  const why = plan.depth === 'quick' ? '' : a.depth.depth === 'deep' ? ' (depth deep)' : ' (security-sensitive paths or code)'
  if (range.files.length > 0) ctx.log.info(`Security plan: ${plan.depth}${why}, ${plural(plan.finders.length, 'finder')} (${plan.finders.join(', ')}), ${plan.needed} of ${plan.voters} votes needed`)
  if (range.files.length === 0) return { status: 'done', depth: plan.depth, result: { findings: [], stats: { raw: 0, candidates: 0, confirmed: 0 }, errors: [], inconclusive: 0 } }
  const addedLines = new Map(a.ranges.prFiles.map((f) => [f.path, f.addedLines]))
  const request = {
    input: buildInput(a.pr, range, a.ranges.guidance),
    paths: livePaths(range),
    plan,
    posted: a.posted,
    maxFindings: ctx.settings.maxFindings,
    excludePaths: config?.securityExcludePaths ?? [],
    limit: a.limit,
    addedLines,
    onProgress: ctx.log.info,
  }
  try {
    return { status: 'done', depth: plan.depth, result: await runSecurityReview(a.reviewer, request) }
  } catch (e) {
    return { status: 'failed', reason: errMsg(e) }
  }
}

/** Whether the security pass finished with a verdict on every candidate. */
const securityComplete = (s: SecurityPass) => s?.status === 'done' && s.result.inconclusive === 0

/** Why the security pass didn't complete, for the summary; undefined if it did or wasn't due. */
function securityNote(s: SecurityPass): string | undefined {
  if (s?.status === 'failed') return `Security review did not complete (${s.reason}); it will retry on the next run, and its check stays red until then.`
  if (s?.status === 'done' && s.result.inconclusive > 0) {
    return `Security review left ${s.result.inconclusive} finding(s) undecided (verifier errors); it will retry on the next run, and its check stays red until then.`
  }
  return undefined
}

/** Where comments may go: exact RIGHT-side lines of the full PR diff, or the nearest such line in the same file. */
function placement(prFiles: readonly FileDiff[]) {
  const lines = new Map(prFiles.map((f) => [f.path, [...f.rightLines]]))
  return {
    exact: (l: Location) => lines.get(l.file)?.includes(l.line) ?? false,
    nearest: (l: Location): number | undefined =>
      (lines.get(l.file) ?? []).reduce<number | undefined>((best, n) => (best === undefined || Math.abs(n - l.line) < Math.abs(best - l.line) ? n : best), undefined),
  }
}

/** This round's confirmed findings. */
type Posting = { readonly bugs: readonly Finding[]; readonly security: readonly SecurityFinding[] }

/** Blocking security findings get a thread even off the diff (anchored to the nearest changed line), so the gate can see them. */
const blocking = (f: SecurityFinding) => f.introduced && f.severity !== 'low'

/** Inline comments for this round, plus what stays summary-only. */
function layout(found: Posting, prFiles: readonly FileDiff[]) {
  const at = placement(prFiles)
  const securityLine = (f: SecurityFinding) => (at.exact(f) ? f.line : blocking(f) ? at.nearest(f) : undefined)
  const securityComments = found.security.flatMap((f) => {
    const line = securityLine(f)
    if (line === undefined) return []
    const note = line === f.line ? '' : `_Reported at line ${f.line}; anchored to the nearest changed line._\n\n`
    return [{ finding: f, comment: { path: f.file, line, body: note + securityComment(f) } }]
  })
  return {
    bugComments: found.bugs.filter(at.exact).map((f) => ({ path: f.file, line: f.line, body: findingComment(f) })),
    securityComments,
    outside: { bugs: found.bugs.filter((f) => !at.exact(f)), security: found.security.filter((f) => securityLine(f) === undefined) },
  }
}

/** Posts the review. If GitHub rejects a line (422), reposts with every finding in the summary, then retries each blocking security comment alone. */
async function postReview(ctx: Context, pr: PullRequest, found: Posting, prFiles: readonly FileDiff[], body: (outside: Posting) => string) {
  const { bugComments, securityComments, outside } = layout(found, prFiles)
  const comments = [...bugComments, ...securityComments.map((c) => c.comment)]
  ctx.log.info(`Posting review: ${plural(comments.length, 'inline comment')}, ${outside.bugs.length + outside.security.length} in the summary only`)
  try {
    await ctx.github.createReview({ headSha: pr.headSha, body: body(outside), comments })
  } catch (e) {
    if (statusOf(e) !== 422 || comments.length === 0) throw e
    ctx.log.warning(`GitHub rejected inline comments (${errMsg(e)}); posting all findings in the summary.`)
    await ctx.github.createReview({ headSha: pr.headSha, body: body(found), comments: [] })
    for (const { finding, comment } of securityComments.filter((c) => blocking(c.finding))) {
      await ctx.github
        .createReview({ headSha: pr.headSha, body: '', comments: [comment] })
        .catch((err: unknown) => ctx.log.warning(`Could not post blocking security finding ${finding.file}:${finding.line} inline: ${errMsg(err)}`))
    }
  }
}

/** Runs the due passes in parallel on one shared pool, posts the review, and reports the outcome. */
async function reviewRanges(ctx: Context, pr: PullRequest, state: ReviewState | undefined, round: number, ranges: Ranges): Promise<RoundOutcome> {
  const { settings } = ctx
  const depth = resolveDepth({ input: { depth: settings.depth, voters: settings.voters, votesNeeded: settings.votesNeeded }, frontmatterDepth: ranges.guidance.review?.config.depth })
  if (ranges.bug && ranges.bug.files.length > 0) {
    ctx.log.info(`Code review plan: ${depth.depth}, ${plural(depth.finders.length, 'finder')} (${depth.finders.join(', ')}), ${depth.needed} of ${depth.voters} votes needed`)
  }
  const reviewer = await ctx.createReviewer()
  const limit = createLimiter(settings.concurrency) // one pool for every agent session this round
  const touched = new Set([...(ranges.bug?.files ?? []), ...(ranges.security?.files ?? [])].map((f) => f.path))
  const anyRange = ranges.bug ?? ranges.security
  const auto = state && anyRange ? await autoResolve(ctx, state, { reviewer, limit, touched, input: buildInput(pr, anyRange, ranges.guidance), depth }) : { count: 0, unresolvable: [] }
  const posted = state?.fingerprints ?? []
  const args = { reviewer, limit, ranges, pr, depth, posted }
  const [bugs, security] = await Promise.all([runBugPass(ctx, args), runSecurityPass(ctx, args)])
  for (const e of [...(bugs?.errors ?? []), ...(security?.status === 'done' ? security.result.errors : [])]) ctx.log.warning(e)
  if (security?.status === 'failed') ctx.log.warning(`Security review failed: ${security.reason}`)
  return finishRound(ctx, pr, state, round, { ranges, bugs, security, resolved: auto.count, unresolvable: auto.unresolvable, posted, depth, classifier: reviewer })
}

/** Everything a round produced, ready to post. */
type RoundResult = {
  readonly ranges: Ranges
  readonly bugs: ReviewResult | undefined
  readonly security: SecurityPass
  readonly resolved: number
  /** Fixed threads the token couldn't resolve this round. */
  readonly unresolvable?: readonly string[]
  readonly posted: readonly string[]
  readonly depth: DepthConfig
  /** Raises the rule floor; omitted for rule-only assessment. */
  readonly classifier?: RiskClassifier
}

/** The round's tier (undefined when risk tiers are off) and the summary line for it. */
async function roundRisk(ctx: Context, pr: PullRequest, state: ReviewState | undefined, r: RoundResult, found: { bugs: readonly Finding[]; security: readonly SecurityFinding[] }) {
  if (!ctx.settings.riskTiers) return { risk: undefined, line: undefined }
  const risk: RiskAssessment = await assessRound(pr, state, { prFiles: r.ranges.prFiles, guidance: r.ranges.guidance, ...found, skipped: false }, r.classifier, ctx.log.info)
  const n = requiredApprovals(risk.tier, r.ranges.guidance.review?.config.riskApprovals)
  const tier = `${TIER_ICON[risk.tier]} ${risk.tier[0]?.toUpperCase()}${risk.tier.slice(1)}`
  return { risk, line: `${tier}: ${plural(n, 'approval')} needed (${risk.reasons.join('; ')})` }
}

const TIER_ICON = { low: '🟢', medium: '🟡', high: '🔴' } as const
/** `1 issue`, `2 issues`. */
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

/** The code-review row: what ran and what it found, or why it didn't run. */
function codeRow(r: RoundResult): readonly [string, string] {
  const d = r.depth
  const label = `Code review (${d.depth}: ${plural(d.finders.length, 'finder')}, ${d.needed} of ${d.voters} votes)`
  if (!r.bugs) return [label, r.ranges.bug ? '✅ Nothing to review (all changes match skip_paths)' : '— Not due (no new commits)']
  const { findings, stats } = r.bugs
  const important = findings.filter((f) => f.severity === 'important').length
  const verdict = findings.length === 0 ? '✅ No issues' : `⚠️ ${plural(findings.length, 'issue')} (${important} important)`
  return [label, `${verdict} · ${stats.raw} raw → ${stats.candidates} voted on → ${stats.confirmed} confirmed`]
}

/** The security row, or none when the security review is off. */
function securityRow(ctx: Context, r: RoundResult): readonly (readonly [string, string])[] {
  if (!ctx.settings.securityReview) return []
  if (!r.security) return [['Security', '— Not due (no new commits)']]
  if (r.security.status === 'failed') return [['Security', '⚠️ Did not complete; retries on the next run']]
  const { findings, inconclusive } = r.security.result
  const label = `Security (${r.security.depth}: ${plural(SECURITY_PLANS[r.security.depth].finders.length, 'finder')})`
  const blockingCount = findings.filter(blocking).length
  const verdict = findings.length === 0 ? '✅ No findings' : `🔴 ${plural(findings.length, 'finding')} (${blockingCount} blocking)`
  return [[label, inconclusive > 0 ? `${verdict} · ⚠️ ${inconclusive} undecided, retries next run` : verdict]]
}

/** Posts the round's review with the advanced state, and builds the outcome. */
async function finishRound(ctx: Context, pr: PullRequest, state: ReviewState | undefined, round: number, r: RoundResult): Promise<RoundOutcome> {
  const bugFindings = r.bugs?.findings ?? []
  const vulns = r.security?.status === 'done' ? r.security.result.findings : []
  const securitySha = securityComplete(r.security) ? pr.headSha : state?.securitySha
  const { risk, line: riskLine } = await roundRisk(ctx, pr, state, r, { bugs: bugFindings, security: vulns })
  const newState: ReviewState = {
    round,
    sha: r.ranges.bug ? pr.headSha : (state?.sha ?? pr.headSha),
    fingerprints: [...r.posted, ...bugFindings.map(fingerprint), ...vulns.map(securityFingerprint)],
    ...(securitySha !== undefined && { securitySha }),
    ...tierFields(risk),
    ...fixedFields(state, r.unresolvable ?? []),
  }
  const unresolvable = r.unresolvable?.length ?? 0
  const notes = [
    securityNote(r.security),
    unresolvable > 0 ? `${unresolvable} fixed thread${unresolvable === 1 ? '' : 's'} could not be marked resolved (the token lacks permission); they no longer block merge, but please resolve them by hand.` : undefined,
  ].filter((n) => n !== undefined)
  await postReview(ctx, pr, { bugs: bugFindings, security: vulns }, r.ranges.prFiles, (outside) =>
    summary({ findings: bugFindings, outOfDiff: outside.bugs, security: vulns, securityOutOfDiff: outside.security, notes, passes: [codeRow(r), ...securityRow(ctx, r), ...(riskLine ? [['Risk', riskLine] as const] : [])], resolved: r.resolved, state: newState, maxRounds: ctx.settings.maxRounds }),
  )
  const stats = r.bugs?.stats ?? { raw: 0, candidates: 0, confirmed: 0 }
  const sec = r.security?.status === 'done' ? `; security ${r.security.result.stats.confirmed} confirmed (${r.security.depth})` : r.security ? '; security FAILED' : ''
  const message = `Round ${round}: ${stats.raw} raw → ${stats.candidates} voted on → ${stats.confirmed} confirmed (${r.depth.depth})${sec}; ${r.resolved} resolved.`
  const security = r.security?.status === 'done' ? { depth: r.security.depth, findings: vulns, stats: r.security.result.stats } : undefined
  return { status: 'reviewed', message, round, findings: bugFindings, resolved: r.resolved, stats, security, risk }
}

/** Nothing left after skip_paths: record both passes as complete (no agents, no API key needed). */
async function recordNothingToReview(ctx: Context, pr: PullRequest, state: ReviewState | undefined, round: number, ranges: Ranges): Promise<RoundOutcome> {
  const depth = resolveDepth({ input: { depth: ctx.settings.depth, voters: ctx.settings.voters, votesNeeded: ctx.settings.votesNeeded }, frontmatterDepth: ranges.guidance.review?.config.depth })
  const empty = { findings: [], stats: { raw: 0, candidates: 0, confirmed: 0 }, errors: [], inconclusive: 0 }
  const outcome = await finishRound(ctx, pr, state, round, { ranges, bugs: undefined, security: { status: 'done', depth: 'quick', result: empty }, resolved: 0, posted: state?.fingerprints ?? [], depth })
  return { ...outcome, message: 'No reviewable changes.' }
}

/** Advances the bug state past an oversized diff with a notice; security stays behind, so its gate fails closed. */
async function skipOversized(ctx: Context, pr: PullRequest, state: ReviewState | undefined, round: number, changed: number): Promise<RoundOutcome> {
  const reason = `diff too large (${changed} changed lines > max_diff_lines ${ctx.settings.maxDiffLines}).`
  ctx.log.warning(`Review skipped: ${reason}`)
  const advanced: ReviewState = {
    round,
    sha: pr.headSha,
    fingerprints: state?.fingerprints ?? [],
    ...(state?.securitySha !== undefined && { securitySha: state.securitySha }),
    ...tierFields(await skippedRisk(ctx, pr, state)),
    ...fixedFields(state, []),
  }
  await ctx.github.createReview({ headSha: pr.headSha, body: skippedComment(reason, advanced), comments: [] })
  return skipped(`Review skipped: ${reason}`)
}

/**
 * One review event: decide which passes are due (bug: new commits since `sha`; security: since `securitySha`),
 * enforce the round cap and size limit, then review and post.
 */
export async function reviewRound(ctx: Context, pr: PullRequest): Promise<RoundOutcome> {
  const state = decodeState(await ctx.github.botReviewBodies())
  const due = { bug: state?.sha !== pr.headSha, security: ctx.settings.securityReview && state?.securitySha !== pr.headSha }
  if (!due.bug && !due.security) return { status: 'up-to-date', message: 'HEAD already reviewed.' }

  const round = due.bug ? (state?.round ?? 0) + 1 : (state?.round ?? 1)
  if (due.bug && round > ctx.settings.maxRounds) return pauseRound(ctx, pr, state, round)

  ctx.log.info(`PR #${pr.number} "${pr.title}" at ${short(pr.headSha)}: round ${round}, ${[due.bug && 'code review due', due.security && 'security review due'].filter(Boolean).join(', ')}`)
  const ranges = await loadRanges(ctx, pr, state, due)
  const reviewable = [ranges.bug, ranges.security].some((r) => r !== undefined && r.files.length > 0)
  if (!reviewable && !due.security) return skipped('No reviewable changes.')
  if (!reviewable) return recordNothingToReview(ctx, pr, state, round, ranges)

  const changed = Math.max(...[ranges.bug, ranges.security].map((r) => (r?.files ?? []).reduce((n, f) => n + f.changed, 0)))
  if (changed > ctx.settings.maxDiffLines) return skipOversized(ctx, pr, state, round, changed)
  return reviewRanges(ctx, pr, state, round, ranges)
}
