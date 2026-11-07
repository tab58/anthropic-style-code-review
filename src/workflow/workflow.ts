import type { Finding, Reviewer, ReviewStats } from '../review/index.js'
import type { PullReview, RiskAssessment, RiskClassifier, RiskTier } from '../risk/index.js'
import type { SecurityFinding, SecurityPassDepth, SecurityReviewer } from '../security/index.js'
import { publishApprovals, publishGates } from './gates.js'
import { type Context, reviewRound, type Settings } from './round.js'

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
  /** Login of the PR author; empty when the account was deleted. */
  readonly author: string
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
  /** Replies after the first comment, oldest first. A write-access `/resolve <reason>` reply dismisses the finding. */
  readonly replies?: readonly { readonly login: string; readonly body: string }[]
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
  /** Check name, e.g. `anthropic-style-code-review` or `anthropic-style-code-review/security`. */
  readonly name: string
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
  /** Publishes a merge-gate check run. */
  setCheck(check: CheckRun): Promise<void>
  /** Every review on the PR (any author), oldest first. */
  pullReviews(): Promise<readonly PullReview[]>
  /** True when `login` has write, maintain or admin permission on the repo. */
  canApprove(login: string): Promise<boolean>
  /** Labels the PR `risk:<tier>`, removing the other tier labels. */
  setRiskLabel(tier: RiskTier): Promise<void>
}

/** Progress and warning sink. */
export interface Log {
  /** Informational message. */
  info(msg: string): void
  /** Something went wrong but the run continues. */
  warning(msg: string): void
}

/** Builds the bug + security reviewer and risk classifier lazily, so gate-only runs never need an API key. */
export type ReviewerFactory = () => Promise<Reviewer & SecurityReviewer & RiskClassifier>

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
  /** Run the security pass and publish its gate. Default true. */
  readonly securityReview?: boolean
  /** Bug gate check name; the other gates are `<checkName>/security` and `<checkName>/approvals`. Default `anthropic-style-code-review`. */
  readonly checkName?: string
  /** Assess a risk tier, label the PR and publish the approvals gate. Default false. */
  readonly riskTiers?: boolean
}

/** Defaults for the {@link WorkflowOptions} that have a fixed default. */
export const DEFAULT_WORKFLOW_OPTIONS = {
  maxRounds: 3,
  maxDiffLines: 3000,
  maxFindings: 15,
  concurrency: 3,
  nitCap: 3,
  securityReview: true,
  checkName: 'anthropic-style-code-review',
  riskTiers: false,
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
      /** Security pass result; undefined when the security review is off. */
      readonly security: SecurityOutcome | undefined
      /** The PR's tier after this round; undefined when risk tiers are off. */
      readonly risk?: RiskAssessment
    }

/** What the security pass found this round. */
export type SecurityOutcome = {
  /** Pass depth that ran. */
  readonly depth: SecurityPassDepth
  /** Confirmed vulnerabilities posted. */
  readonly findings: readonly SecurityFinding[]
  /** Stage counts. */
  readonly stats: ReviewStats
}

/** The merge gate's verdict. */
export type GateResult = {
  /** `failure` while any Important thread is unresolved. */
  readonly conclusion: CheckConclusion
  /** Unresolved Important threads. */
  readonly openImportant: number
  /** The security gate; undefined when the security review is off. */
  readonly security?: {
    /** `failure` while any introduced High/Medium security thread is unresolved. */
    readonly conclusion: CheckConclusion
    /** Unresolved introduced High/Medium security threads. */
    readonly openBlocking: number
    /** True when the security pass has completed on the current head commit. */
    readonly reviewed: boolean
  }
  /** The approvals gate; undefined when risk tiers are off. */
  readonly approvals?: ApprovalsResult
}

/** The approvals gate's verdict. */
export type ApprovalsResult = {
  /** `failure` until enough qualifying approvals are on the head commit. */
  readonly conclusion: CheckConclusion
  /** The PR's stored tier (`medium` when not assessed yet). */
  readonly tier: RiskTier
  /** Approvals the tier needs. */
  readonly required: number
  /** Logins whose approval counts. */
  readonly approved: readonly string[]
  /** False when no review round has assessed the tier yet (it defaults to `medium`). */
  readonly assessed: boolean
}

/** The review lifecycle for one PR. */
export interface Workflow {
  /** Runs this event's review round (if any is due), posts it, and updates the merge-gate check. */
  review(trigger?: ReviewTrigger): Promise<RoundOutcome>
  /** Recomputes and publishes the merge-gate check only. */
  gate(): Promise<GateResult>
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
    securityReview: options.securityReview ?? d.securityReview,
    checkName: options.checkName ?? d.checkName,
    riskTiers: options.riskTiers ?? d.riskTiers,
    nitCapDefault: d.nitCap,
  }
  const ctx: Context = { ...config, settings }
  const gates = { name: settings.checkName, security: settings.securityReview, approvals: settings.riskTiers }
  return {
    async review({ allowFork = false } = {}) {
      const pr = await ctx.github.getPull()
      // Fork PR tokens are read-only, so there is nothing we could post; just stop.
      if (pr.isFork && !allowFork) return { status: 'skipped', message: 'Fork PR: skipped (no secrets). A maintainer can run workflow_dispatch with pr_number.' }
      // A fresh push must not look mergeable while the review runs: publish the stored tier's verdict first.
      if (settings.riskTiers) await publishApprovals(ctx.github, pr, settings.checkName)
      const outcome: RoundOutcome = pr.draft ? { status: 'skipped', message: 'Draft PR: review skipped.' } : await reviewRound(ctx, pr)
      const gate = await publishGates(ctx.github, pr, gates)
      ctx.log.info(describeGates(settings.checkName, gate))
      if (gate.approvals?.assessed) await labelRisk(ctx, gate.approvals.tier)
      return outcome
    },
    async gate() {
      const pr = await ctx.github.getPull()
      return publishGates(ctx.github, pr, gates)
    },
  }
}

/** `Checks: name ✅ … · name/security ❌ …` for the log. */
function describeGates(name: string, g: GateResult): string {
  const icon = (c: CheckConclusion) => (c === 'success' ? '✅' : '❌')
  const n = (count: number, noun: string) => (count === 0 ? `no open ${noun}s` : `${count} open ${noun}${count === 1 ? '' : 's'}`)
  const parts = [
    `${name} ${icon(g.conclusion)} ${n(g.openImportant, 'important finding')}`,
    ...(g.security ? [`${name}/security ${icon(g.security.conclusion)} ${g.security.reviewed ? n(g.security.openBlocking, 'high/medium finding') : 'latest commits not security-reviewed'}`] : []),
    ...(g.approvals ? [`${name}/approvals ${icon(g.approvals.conclusion)} ${g.approvals.tier}: ${g.approvals.approved.length} of ${g.approvals.required} approvals`] : []),
  ]
  return `Checks: ${parts.join(' · ')}`
}

/** Labels the PR with its tier; a missing `issues: write` permission only warns. */
async function labelRisk(ctx: Context, tier: RiskTier): Promise<void> {
  await ctx.github.setRiskLabel(tier).catch((e: unknown) => ctx.log.warning(`Could not set the risk label (needs issues: write): ${e instanceof Error ? e.message : String(e)}`))
}
