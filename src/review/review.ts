import { createHash } from 'node:crypto'
import { dedupe, type Location, normClass, sortByRank, tally } from '../consensus.js'
import type { Limiter } from '../limiter.js'

/** A line range in a file (shared with the security review). */
export type { Location }

/** How bad a finding is. Only `important` blocks merge. */
export type Severity = 'important' | 'pre_existing' | 'nit'

/** What kind of issue a finding is. Only `bug` findings are kept. */
export type Category = 'bug' | 'style' | 'cleanup' | 'diagnostic'

/** The area a finder agent concentrates on. `general` means any real defect. */
export type FinderFocus = 'logic' | 'edge-cases' | 'concurrency-state' | 'api-contract' | 'general'

/** A reported defect with evidence. */
export type Finding = Location & {
  /** One-line summary. */
  readonly title: string
  /** What goes wrong, when, and why. */
  readonly explanation: string
  /** Code quoted from the file; findings with blank evidence are discarded. */
  readonly evidence: string
  /** How bad it is. */
  readonly severity: Severity
  /** What kind of issue it is. */
  readonly category: Category
  /** Short kebab-case label for the kind of bug, used to group instances and fingerprint findings. */
  readonly bugClass: string
  /** Other places with the same bug class (filled in by dedupe). */
  readonly also?: readonly Location[]
}

/** One verifier's verdict on a finding. */
export type Vote = {
  /** True if the verifier confirmed the defect is real. */
  readonly real: boolean
  /** Short justification. */
  readonly reason: string
}

/** A previously posted review comment, for re-checking after new commits. */
export type PostedIssue = {
  /** File the comment is on. */
  readonly file: string
  /** Line the comment is on; 0 when unknown (outdated threads). */
  readonly line: number
  /** The comment's text. */
  readonly text: string
}

/** What every reviewer agent sees. */
export type ReviewInput = {
  /** Unified diff under review. */
  readonly diff: string
  /** Rendered REVIEW.md + conventions; may be empty. */
  readonly guidance: string
  /** PR title and description. */
  readonly intent: string
}

/** The agents that find and judge defects. Implemented by e.g. the Pi reviewer. */
export interface Reviewer {
  /** Hunts for defects in `focus`'s area; resolves with every finding (possibly none). */
  find(focus: FinderFocus, input: ReviewInput): Promise<readonly Finding[]>
  /** Independently judges whether `finding` is real. */
  verify(finding: Finding, input: ReviewInput): Promise<Vote>
  /** Resolves true if a previously posted issue is still present at HEAD. */
  recheck(issue: PostedIssue, input: ReviewInput): Promise<boolean>
}

/** Review depth preset name. */
export type Depth = 'quick' | 'standard' | 'deep'

/** User overrides for the depth preset. All fields optional; strings are validated by {@link resolveDepth}. */
export type DepthInput = {
  /** Preset name: `quick`, `standard` or `deep`. */
  readonly depth?: string
  /** Verifier votes per finding; a positive integer. */
  readonly voters?: number
  /** Yes votes needed to keep a finding; an integer in `1..voters`. */
  readonly votesNeeded?: number
}

/** Where depth settings come from, by precedence: `input`, then `frontmatterDepth`, then `standard`. */
export type DepthSelection = {
  /** Action-input overrides (highest precedence). */
  readonly input?: DepthInput
  /** `depth` from REVIEW.md frontmatter. */
  readonly frontmatterDepth?: string
}

/** A resolved, validated depth configuration. */
export type DepthConfig = {
  /** Preset that was selected. */
  readonly depth: Depth
  /** One finder agent per entry. */
  readonly finders: readonly FinderFocus[]
  /** Verifier votes per finding. */
  readonly voters: number
  /** Yes votes needed to keep a finding. */
  readonly needed: number
}

/** One review run's parameters. */
export type ReviewRequest = {
  /** What the agents see. */
  readonly input: ReviewInput
  /** Non-deleted paths in the diff; findings elsewhere are discarded. */
  readonly paths: readonly string[]
  /** Finder/voter configuration. */
  readonly depth: DepthConfig
  /** Fingerprints already posted on this PR; never re-verified or reposted. */
  readonly posted: readonly string[]
  /** Maximum deduped findings sent to voting (most severe first); positive integer. */
  readonly maxFindings: number
  /** Maximum nits returned; non-negative integer. */
  readonly nitCap: number
  /** Shared concurrency pool for agent sessions (share one across passes to cap total load). */
  readonly limit: Limiter
}

/** Counts at each stage of a review. */
export type ReviewStats = {
  /** Findings returned by all finders. */
  readonly raw: number
  /** Findings sent to voting after filtering and dedupe. */
  readonly candidates: number
  /** Candidates that won the vote. */
  readonly confirmed: number
}

/** The outcome of {@link runReview}. */
export type ReviewResult = {
  /** Confirmed findings, ranked important > pre_existing > nit, nits capped. */
  readonly findings: readonly Finding[]
  /** Stage counts. */
  readonly stats: ReviewStats
  /** Non-fatal agent errors (a failed finder, an errored vote). */
  readonly errors: readonly string[]
}

const SPECIALISTS: readonly FinderFocus[] = ['logic', 'edge-cases', 'concurrency-state', 'api-contract']

/** Built-in depth presets. */
export const DEPTH_PRESETS = {
  quick: { finders: ['general', 'general'], voters: 1, needed: 1 },
  standard: { finders: SPECIALISTS, voters: 3, needed: 2 },
  deep: { finders: [...SPECIALISTS, 'general', 'general'], voters: 5, needed: 3 },
} as const satisfies Record<Depth, { finders: readonly FinderFocus[]; voters: number; needed: number }>

/** Narrows a string to a preset name. */
const RANK: Record<Severity, number> = { important: 0, pre_existing: 1, nit: 2 }
const SEVERITY_KEYS = { classOf: (f: Finding) => f.bugClass, rankOf: (f: Finding) => RANK[f.severity] }

/** Ranks important > pre_existing > nit (stable within a severity) and keeps at most `nitCap` nits. */
function rank(findings: readonly Finding[], nitCap: number): readonly Finding[] {
  const ranked = sortByRank(findings, SEVERITY_KEYS.rankOf)
  return [...ranked.filter((f) => f.severity !== 'nit'), ...ranked.filter((f) => f.severity === 'nit').slice(0, nitCap)]
}

const isDepth = (d: string): d is Depth => Object.hasOwn(DEPTH_PRESETS, d)
/** Error message of any thrown value. */
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Resolves the depth preset and applies overrides.
 *
 * @param selection - Overrides and REVIEW.md depth; both optional.
 * @returns The validated configuration (default preset `standard`).
 * @throws {@link Error} If the depth is unknown, `voters` is not a positive integer, or `votesNeeded` is outside `1..voters`.
 */
export function resolveDepth({ input = {}, frontmatterDepth }: DepthSelection): DepthConfig {
  const depth = input.depth ?? frontmatterDepth ?? 'standard'
  if (!isDepth(depth)) throw new Error(`Unknown depth "${depth}" (expected quick | standard | deep)`)

  const preset = DEPTH_PRESETS[depth]
  const voters = input.voters ?? preset.voters
  const needed = input.votesNeeded ?? preset.needed
  if (!Number.isInteger(voters) || voters < 1) throw new Error(`voters must be a positive integer, got ${voters}`)
  if (!Number.isInteger(needed) || needed < 1 || needed > voters) {
    throw new Error(`votes_needed must be an integer in 1..${voters}, got ${needed}`)
  }
  return { depth, finders: [...preset.finders], voters, needed }
}

/**
 * Line-independent identity of a finding, so it isn't reposted after code shifts.
 *
 * @param f - The finding's file and bug class (class is compared case- and separator-insensitively).
 * @returns A 12-character hex fingerprint.
 */
export const fingerprint = (f: Pick<Finding, 'file' | 'bugClass'>): string =>
  createHash('sha1').update(`${f.file}\0${normClass(f.bugClass)}`).digest('hex').slice(0, 12)

/** Runs every finder (bounded); a failed finder is recorded, but all failing is fatal. */
async function runFinders(reviewer: Reviewer, r: ReviewRequest, limit: Limiter) {
  const settled = await Promise.all(
    r.depth.finders.map((focus) =>
      limit(() => reviewer.find(focus, r.input)).then(
        (findings) => ({ findings, error: undefined }),
        (e: unknown) => ({ findings: [], error: `finder ${focus}: ${message(e)}` }),
      ),
    ),
  )
  const errors = settled.flatMap((s) => (s.error ? [s.error] : []))
  if (errors.length === settled.length) throw new Error(`All finders failed: ${errors.join('; ')}`)
  return { findings: settled.flatMap((s) => s.findings), errors }
}

/** Cheap filters before paying for votes: bugs only, in the diff, with evidence, not already posted; then dedupe and cap. */
function selectCandidates(raw: readonly Finding[], r: ReviewRequest): readonly Finding[] {
  const inDiff = new Set(r.paths)
  const posted = new Set(r.posted)
  const plausible = raw.filter(
    (f) => f.category === 'bug' && inDiff.has(f.file) && f.evidence.trim() !== '' && !posted.has(fingerprint(f)),
  )
  return rank(dedupe(plausible, SEVERITY_KEYS), Infinity).slice(0, r.maxFindings)
}

/** Collects `voters` votes on one finding; an errored vote counts as "no". */
async function voteOn(reviewer: Reviewer, f: Finding, r: ReviewRequest, limit: Limiter) {
  const votes = await Promise.all(
    Array.from({ length: r.depth.voters }, () =>
      limit(() => reviewer.verify(f, r.input)).then(
        (vote) => ({ vote, error: undefined }),
        (e: unknown) => ({ vote: { real: false, reason: 'verifier error' }, error: `voter: ${message(e)}` }),
      ),
    ),
  )
  return { finding: f, kept: tally(votes.map((v) => v.vote.real), r.depth.needed), errors: votes.flatMap((v) => (v.error ? [v.error] : [])) }
}

/**
 * Runs the full review: finders in parallel → filter → dedupe → verifier vote → rank.
 *
 * @param reviewer - The agents that find and judge defects.
 * @param request - Diff, guidance, depth and limits for this run.
 * @returns Confirmed, ranked findings with stage counts and non-fatal errors.
 * @throws {@link Error} If every finder fails.
 */
export async function runReview(reviewer: Reviewer, request: ReviewRequest): Promise<ReviewResult> {
  const { limit } = request
  const finders = await runFinders(reviewer, request, limit)
  const candidates = selectCandidates(finders.findings, request)
  const votes = await Promise.all(candidates.map((f) => voteOn(reviewer, f, request, limit)))
  const confirmed = votes.filter((v) => v.kept).map((v) => v.finding)
  return {
    findings: rank(confirmed, request.nitCap),
    stats: { raw: finders.findings.length, candidates: candidates.length, confirmed: confirmed.length },
    errors: [...finders.errors, ...votes.flatMap((v) => v.errors)],
  }
}
