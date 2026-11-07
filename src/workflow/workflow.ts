import { type FileDiff, filterDiff, parseDiff } from '../diff.js'
import { type Guidance, loadGuidance, renderGuidance } from '../guidance.js'
import { createLimiter, type Limiter } from '../limiter.js'
import {
  type DepthConfig,
  type Finding,
  fingerprint,
  type Reviewer,
  type ReviewInput,
  type ReviewStats,
  resolveDepth,
  runReview,
} from '../review/index.js'
import { findingComment, skippedComment, stepBackComment, summary } from './comments.js'
import { countOpenImportant, decodeState, type ReviewState } from './markers.js'

/** The pull request under review. */
export type PullRequest = {
  /** PR number. */
  readonly number: number
  /** Current head commit SHA. */
  readonly headSha: string
  /** Base branch commit SHA. */
  readonly baseSha: string
  /** PR title. */
  readonly title: string
  /** PR description; empty string when none. */
  readonly body: string
  /** True when the head branch lives in a fork. */
  readonly isFork: boolean
  /** True for draft PRs. */
  readonly draft: boolean
}

/** A review thread started by this action's bot. */
export type BotThread = {
  /** GraphQL node ID, used to resolve it. */
  readonly id: string
  /** Whether the thread is resolved. */
  readonly isResolved: boolean
  /** File the thread is on. */
  readonly path: string
  /** Line the thread is on; null when outdated. */
  readonly line: number | null
  /** Body of the thread's first comment. */
  readonly body: string
}

/** One inline review comment to post. */
export type ReviewComment = {
  /** File path. */
  readonly path: string
  /** RIGHT-side line; must be in the PR diff. */
  readonly line: number
  /** Markdown body. */
  readonly body: string
}

/** Merge-gate check result. */
export type CheckConclusion = 'success' | 'failure'

/** A completed check run to publish on a commit. */
export type CheckRun = {
  /** Commit to attach the check to. */
  readonly headSha: string
  /** Pass or fail. */
  readonly conclusion: CheckConclusion
  /** One-line title. */
  readonly title: string
  /** Markdown summary. */
  readonly summary: string
}

/** Everything the workflow needs from GitHub, scoped to one PR. Implemented by the GitHub client. */
export interface GitHub {
  /** Fetches the PR. */
  getPull(): Promise<PullRequest>
  /** Unified diff of `base...head` (three-dot). */
  compareDiff(base: string, head: string): Promise<string>
  /** True when `ancestor` is reachable from `head`; false after a force push or for unknown SHAs. */
  isAncestor(ancestor: string, head: string): Promise<boolean>
  /** A file's text at `ref`, or undefined if it does not exist. */
  readAtRef(ref: string, path: string): Promise<string | undefined>
  /** Bodies of this bot's reviews, oldest first. */
  botReviewBodies(): Promise<readonly string[]>
  /** Review threads started by this bot. */
  botThreads(): Promise<readonly BotThread[]>
  /** Posts one COMMENT review. Rejects with `status: 422` when an inline line is not in the PR diff. */
  createReview(review: { readonly headSha: string; readonly body: string; readonly comments: readonly ReviewComment[] }): Promise<void>
  /** Resolves a review thread. */
  resolveThread(id: string): Promise<void>
  /** Publishes the merge-gate check run. */
  setCheck(check: CheckRun): Promise<void>
}

/** Progress and warning sink. */
export interface Log {
  /** Informational message. */
  info(msg: string): void
  /** Something went wrong but the run continues. */
  warning(msg: string): void
}

/** Builds the reviewer lazily, so gate-only runs never need an API key. */
export type ReviewerFactory = () => Promise<Reviewer>

/** Required collaborators for {@link createWorkflow}. */
export type WorkflowConfig = {
  /** GitHub access for this PR. */
  readonly github: GitHub
  /** Creates the agents; called at most once per review round. */
  readonly createReviewer: ReviewerFactory
  /** Where progress and warnings go. */
  readonly log: Log
}

/** Optional tuning for {@link createWorkflow}. Unset fields fall back to {@link DEFAULT_WORKFLOW_OPTIONS} or REVIEW.md. */
export type WorkflowOptions = {
  /** Depth preset: `quick` | `standard` | `deep`. Overrides REVIEW.md; default `standard`. */
  readonly depth?: string
  /** Verifier votes per finding; positive integer. Overrides the preset. */
  readonly voters?: number
  /** Yes votes needed to post; integer in `1..voters`. Overrides the preset. */
  readonly votesNeeded?: number
  /** Review rounds before the step-back note; positive integer. */
  readonly maxRounds?: number
  /** Skip the round when more lines than this changed; positive integer. */
  readonly maxDiffLines?: number
  /** Cap on deduped findings sent to voting; positive integer. */
  readonly maxFindings?: number
  /** Max agent sessions (= concurrent LLM requests); positive integer. */
  readonly concurrency?: number
  /** Max nits per review; non-negative integer. Overrides REVIEW.md; default 3. */
  readonly nitCap?: number
}

/** Defaults for the {@link WorkflowOptions} that have a fixed default. */
export const DEFAULT_WORKFLOW_OPTIONS = {
  maxRounds: 3,
  maxDiffLines: 3000,
  maxFindings: 15,
  concurrency: 3,
  nitCap: 3,
} as const satisfies WorkflowOptions

/** Per-call data for {@link Workflow.review}. */
export type ReviewTrigger = {
  /** Review fork PRs too; only for maintainer-dispatched runs. Default false. */
  readonly allowFork?: boolean
}

/** What a review call did. Every variant carries a human-readable `message`. */
export type RoundOutcome =
  | { readonly status: 'skipped'; readonly message: string }
  | { readonly status: 'up-to-date'; readonly message: string }
  | { readonly status: 'paused'; readonly message: string; readonly round: number }
  | {
      readonly status: 'reviewed'
      readonly message: string
      readonly round: number
      readonly findings: readonly Finding[]
      readonly resolved: number
      readonly stats: ReviewStats
    }

/** The merge gate's verdict. */
export type GateResult = {
  /** `failure` while any Important thread is unresolved. */
  readonly conclusion: CheckConclusion
  /** Unresolved Important threads. */
  readonly openImportant: number
}

/** The review lifecycle for one PR. */
export interface Workflow {
  /** Runs this event's review round (if any is due), posts it, and updates the merge-gate check. */
  review(trigger?: ReviewTrigger): Promise<RoundOutcome>
  /** Recomputes and publishes the merge-gate check only. */
  gate(): Promise<GateResult>
}

/** Options with fixed defaults applied. */
type Settings = WorkflowOptions & { readonly maxRounds: number; readonly maxDiffLines: number; readonly maxFindings: number; readonly concurrency: number }
/** Everything a round's helpers need. */
type Context = WorkflowConfig & { readonly settings: Settings }

/** The diff range this round reviews, after skip_paths. */
type Range = { readonly incremental: boolean; readonly allFiles: readonly FileDiff[]; readonly files: readonly FileDiff[]; readonly guidance: Guidance }

/** HTTP status of an Octokit-style error, if any. */
const statusOf = (e: unknown): number | undefined =>
  typeof e === 'object' && e !== null && 'status' in e && typeof e.status === 'number' ? e.status : undefined
/** Error message of any thrown value. */
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))
/** A `skipped` outcome. */
const skipped = (message: string): RoundOutcome => ({ status: 'skipped', message })

/** Counts open Important threads and publishes the check. */
async function updateCheck(github: GitHub, headSha: string): Promise<GateResult> {
  const openImportant = countOpenImportant(await github.botThreads())
  const conclusion: CheckConclusion = openImportant > 0 ? 'failure' : 'success'
  const title = openImportant === 0 ? 'No open important findings' : `${openImportant} open important finding${openImportant === 1 ? '' : 's'}`
  const text = 'Fails while any review thread tagged **Important** is unresolved. Fix it or resolve the thread with a reason.'
  await github.setCheck({ headSha, conclusion, title, summary: text })
  return { conclusion, openImportant }
}

/** Past the round cap: post the step-back note once (when first exceeded), then stay quiet. */
async function pauseRound(ctx: Context, pr: PullRequest, state: ReviewState | undefined, round: number): Promise<RoundOutcome> {
  const { maxRounds } = ctx.settings
  if (state?.round === maxRounds) {
    await ctx.github.createReview({ headSha: pr.headSha, body: stepBackComment(maxRounds, { ...state, round, sha: pr.headSha }), comments: [] })
  }
  return { status: 'paused', round, message: `Round cap (${maxRounds}) reached; not reviewing.` }
}

/** After round 1, the diff since the last reviewed commit (unless history was rewritten); guidance from the base ref. */
async function loadRange(ctx: Context, pr: PullRequest, state: ReviewState | undefined): Promise<Range> {
  const incremental = state !== undefined && (await ctx.github.isAncestor(state.sha, pr.headSha))
  if (state && !incremental) ctx.log.info(`Last reviewed ${state.sha} is not an ancestor of HEAD (force push?); reviewing the full PR.`)
  const allFiles = parseDiff(await ctx.github.compareDiff(incremental ? state.sha : pr.baseSha, pr.headSha))
  const repo = { read: (path: string) => ctx.github.readAtRef(pr.baseSha, path) }
  const guidance = await loadGuidance(repo, allFiles.map((f) => f.path))
  return { incremental, allFiles, guidance, files: filterDiff(allFiles, guidance.review?.config.skipPaths ?? []) }
}

/** What the agents see for this range. */
const buildInput = (pr: PullRequest, range: Range): ReviewInput => ({
  diff: range.files.map((f) => f.text).join(''),
  guidance: renderGuidance(range.guidance),
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
  return answers.filter((still) => !still).length >= depth.needed
}

/** Resolves open bot threads in touched files that a verifier quorum says are fixed; returns how many. */
async function autoResolve(ctx: Context, reviewer: Reviewer, range: Range, input: ReviewInput, depth: DepthConfig): Promise<number> {
  const touched = new Set(range.files.map((f) => f.path))
  const open = (await ctx.github.botThreads()).filter((t) => !t.isResolved && touched.has(t.path))
  const limit = createLimiter(ctx.settings.concurrency) // one pool across every thread
  const fixed = await Promise.all(
    open.map(async (t) => {
      const yes = await isFixed(ctx, reviewer, limit, t, input, depth)
      if (yes) await ctx.github.resolveThread(t.id)
      return yes
    }),
  )
  return fixed.filter(Boolean).length
}

/** Posts the review; if GitHub rejects an inline line (422), reposts with every finding in the summary. */
async function postReview(ctx: Context, pr: PullRequest, findings: readonly Finding[], isInline: (f: Finding) => boolean, body: (outOfDiff: readonly Finding[]) => string) {
  const inline = findings.filter(isInline)
  const comments = inline.map((f) => ({ path: f.file, line: f.line, body: findingComment(f) }))
  try {
    await ctx.github.createReview({ headSha: pr.headSha, body: body(findings.filter((f) => !isInline(f))), comments })
  } catch (e) {
    if (statusOf(e) !== 422 || inline.length === 0) throw e
    ctx.log.warning(`GitHub rejected inline comments (${errMsg(e)}); posting all findings in the summary.`)
    await ctx.github.createReview({ headSha: pr.headSha, body: body(findings), comments: [] })
  }
}

/** Inline-commentable lines come from the FULL PR diff, which is what GitHub validates against. */
async function commentableCheck(ctx: Context, pr: PullRequest, range: Range): Promise<(f: Finding) => boolean> {
  const prFiles = range.incremental ? parseDiff(await ctx.github.compareDiff(pr.baseSha, pr.headSha)) : range.allFiles
  const commentable = new Map(prFiles.map((f) => [f.path, f.rightLines]))
  return (f) => commentable.get(f.file)?.has(f.line) ?? false
}

/** Runs agents over the range, posts the review, and reports the outcome. */
async function reviewRange(ctx: Context, pr: PullRequest, state: ReviewState | undefined, round: number, range: Range): Promise<RoundOutcome> {
  const { settings } = ctx
  const depth = resolveDepth({
    input: { depth: settings.depth, voters: settings.voters, votesNeeded: settings.votesNeeded },
    frontmatterDepth: range.guidance.review?.config.depth,
  })
  const input = buildInput(pr, range)
  const reviewer = await ctx.createReviewer()
  const resolved = state ? await autoResolve(ctx, reviewer, range, input, depth) : 0
  const nitCap = settings.nitCap ?? range.guidance.review?.config.nitCap ?? DEFAULT_WORKFLOW_OPTIONS.nitCap
  const paths = range.files.filter((f) => !f.deleted).map((f) => f.path)
  const posted = state?.fingerprints ?? []
  const result = await runReview(reviewer, { input, paths, depth, posted, nitCap, maxFindings: settings.maxFindings, concurrency: settings.concurrency })
  result.errors.forEach((e) => ctx.log.warning(e))

  const newState: ReviewState = { round, sha: pr.headSha, fingerprints: [...posted, ...result.findings.map(fingerprint)] }
  const isInline = await commentableCheck(ctx, pr, range)
  await postReview(ctx, pr, result.findings, isInline, (outOfDiff) =>
    summary({ findings: result.findings, outOfDiff, resolved, state: newState, maxRounds: settings.maxRounds }),
  )
  const { raw, candidates, confirmed } = result.stats
  const message = `Round ${round}: ${raw} raw → ${candidates} voted on → ${confirmed} confirmed (${depth.depth}); ${resolved} resolved.`
  return { status: 'reviewed', message, round, findings: result.findings, resolved, stats: result.stats }
}

/** One review round: state → round cap → range → size check → agents → post. */
async function reviewRound(ctx: Context, pr: PullRequest): Promise<RoundOutcome> {
  const state = decodeState(await ctx.github.botReviewBodies())
  if (state?.sha === pr.headSha) return { status: 'up-to-date', message: 'HEAD already reviewed.' }

  const round = (state?.round ?? 0) + 1
  if (round > ctx.settings.maxRounds) return pauseRound(ctx, pr, state, round)

  const range = await loadRange(ctx, pr, state)
  if (range.files.length === 0) return skipped('No reviewable changes.')

  const changed = range.files.reduce((n, f) => n + f.changed, 0)
  if (changed > ctx.settings.maxDiffLines) {
    const reason = `diff too large (${changed} changed lines > max_diff_lines ${ctx.settings.maxDiffLines}).`
    ctx.log.warning(`Review skipped: ${reason}`)
    const advanced: ReviewState = { round, sha: pr.headSha, fingerprints: state?.fingerprints ?? [] }
    await ctx.github.createReview({ headSha: pr.headSha, body: skippedComment(reason, advanced), comments: [] })
    return skipped(`Review skipped: ${reason}`)
  }
  return reviewRange(ctx, pr, state, round, range)
}

/**
 * Creates the review workflow for one PR.
 *
 * @param config - GitHub access, the reviewer factory and the log.
 * @param options - Optional tuning; unset fields use {@link DEFAULT_WORKFLOW_OPTIONS}, REVIEW.md, or presets.
 * @returns The PR's {@link Workflow}. Its methods reject when GitHub or every finder fails.
 */
export function createWorkflow(config: WorkflowConfig, options: WorkflowOptions = {}): Workflow {
  const d = DEFAULT_WORKFLOW_OPTIONS
  const settings: Settings = {
    ...options,
    maxRounds: options.maxRounds ?? d.maxRounds,
    maxDiffLines: options.maxDiffLines ?? d.maxDiffLines,
    maxFindings: options.maxFindings ?? d.maxFindings,
    concurrency: options.concurrency ?? d.concurrency,
  }
  const ctx: Context = { ...config, settings }
  return {
    async review({ allowFork = false } = {}) {
      const pr = await ctx.github.getPull()
      // Fork PR tokens are read-only, so there is nothing we could post; just stop.
      if (pr.isFork && !allowFork) return skipped('Fork PR: skipped (no secrets). A maintainer can run workflow_dispatch with pr_number.')
      const outcome = pr.draft ? skipped('Draft PR: review skipped.') : await reviewRound(ctx, pr)
      await updateCheck(ctx.github, pr.headSha)
      return outcome
    },
    async gate() {
      const pr = await ctx.github.getPull()
      return updateCheck(ctx.github, pr.headSha)
    },
  }
}
