import { createHash } from 'node:crypto'
import { dedupe, type Location, median, normClass, sortByRank, tally } from '../consensus.js'
import type { Limiter } from '../limiter.js'
import type { ReviewInput, ReviewStats } from '../review/index.js'
import { needsFullPass } from './escalation.js'
import { exclusionReason } from './exclusions.js'

/** Severity of a vulnerability. High and Medium introduced by the PR block merge; Low is informational. */
export type SecurityLevel = 'high' | 'medium' | 'low'

/** The area a security finder concentrates on. `security-general` covers all of them. */
export type SecurityFocus = 'security-general' | 'injection' | 'authz' | 'secrets-crypto' | 'exposure-execution'

/** An exploitable vulnerability with its attack path. */
export type SecurityFinding = Location & {
  /** One-line summary. */
  readonly title: string
  /** Short kebab-case vulnerability class, e.g. `sql-injection`; groups instances and fingerprints findings. */
  readonly vulnClass: string
  /** Attacker-controlled input, e.g. `req.query.id`. Required: findings without one are dropped. */
  readonly source: string
  /** The dangerous operation the input reaches, e.g. `db.query`. Required. */
  readonly sink: string
  /** Concrete attack: what the attacker sends and what happens. Required. */
  readonly exploitScenario: string
  /** What the attacker gains. */
  readonly impact: string
  /** Code quoted from the file at the sink. */
  readonly evidence: string
  /** Severity (finder's proposal; replaced by the verifiers' median after voting). */
  readonly severity: SecurityLevel
  /** True if this PR introduced the vulnerability; false for pre-existing ones (posted, never block). */
  readonly introduced: boolean
  /** Other places with the same vulnerability class (filled in by dedupe). */
  readonly also?: readonly Location[]
}

/** One verifier's exploitability verdict. */
export type ExploitVote = {
  /** True if an attacker can actually exploit it as described. */
  readonly exploitable: boolean
  /** The verifier's severity rating. */
  readonly severity: SecurityLevel
  /** Short justification. */
  readonly reason: string
}

/** The agents that find and judge vulnerabilities. Implemented by e.g. the Pi reviewer. */
export interface SecurityReviewer {
  /** Hunts for exploitable vulnerabilities in `focus`'s area; resolves with every finding (possibly none). */
  findVulnerabilities(focus: SecurityFocus, input: ReviewInput): Promise<readonly SecurityFinding[]>
  /** Independently judges whether `finding` is exploitable, and how severe it is. */
  judgeExploit(finding: SecurityFinding, input: ReviewInput): Promise<ExploitVote>
}

/** Security pass depth: `quick` on every PR, `full` when the diff is security-sensitive. */
export type SecurityPassDepth = 'quick' | 'full'

/** Finders and voting rules for one security pass. */
export type SecurityPlan = {
  /** Which preset this is. */
  readonly depth: SecurityPassDepth
  /** One finder agent per entry. */
  readonly finders: readonly SecurityFocus[]
  /** Verifier votes per finding. */
  readonly voters: number
  /** Exploitable votes needed to keep a finding. */
  readonly needed: number
}

/** Built-in security plans. Voting is 2-of-3 on both: precision comes from verification, and findings are few. */
export const SECURITY_PLANS = {
  quick: { depth: 'quick', finders: ['security-general', 'security-general'], voters: 3, needed: 2 },
  full: { depth: 'full', finders: ['injection', 'authz', 'secrets-crypto', 'exposure-execution'], voters: 3, needed: 2 },
} as const satisfies Record<SecurityPassDepth, SecurityPlan>

/** What decides the plan, beyond the diff itself. */
export type SecurityPlanOptions = {
  /** Extra security-sensitive path globs (REVIEW.md `security_paths`). */
  readonly extraPaths?: readonly string[]
  /** Always use the full plan (e.g. when the bug review runs at `deep`). */
  readonly forceFull?: boolean
}

/**
 * Picks the quick or full security plan for a diff.
 *
 * @param files - Changed files with their raw diff text; may be empty.
 * @param options - Extra sensitive paths and a force-full switch; both optional.
 * @returns {@link SECURITY_PLANS}.full if forced or the diff is security-sensitive, else quick.
 */
export function chooseSecurityPlan(files: readonly { readonly path: string; readonly text: string }[], options: SecurityPlanOptions): SecurityPlan {
  return options.forceFull || needsFullPass(files, options.extraPaths ?? []) ? SECURITY_PLANS.full : SECURITY_PLANS.quick
}

/**
 * Line-independent identity of a security finding. Prefixed `sec:` so it never collides with bug fingerprints.
 * Includes `introduced`, so a vulnerability the PR introduces is not suppressed by an earlier pre-existing one.
 *
 * @param f - The finding's file, vulnerability class (compared case- and separator-insensitively) and introduced flag.
 * @returns `sec:` followed by 12 hex characters.
 */
export const securityFingerprint = (f: Pick<SecurityFinding, 'file' | 'vulnClass' | 'introduced'>): string =>
  `sec:${createHash('sha1').update(`${f.file}\0${normClass(f.vulnClass)}\0${f.introduced ? 'new' : 'pre'}`).digest('hex').slice(0, 12)}`

/** One security review run's parameters. */
export type SecurityRequest = {
  /** What the agents see (same as the bug review). */
  readonly input: ReviewInput
  /** Non-deleted paths in the diff; findings elsewhere are discarded. */
  readonly paths: readonly string[]
  /** Finders and voting rules. */
  readonly plan: SecurityPlan
  /** Fingerprints already posted on this PR; never re-verified or reposted. */
  readonly posted: readonly string[]
  /** Maximum deduped findings sent to voting (introduced and most severe first); positive integer. */
  readonly maxFindings: number
  /** Extra excluded path globs (REVIEW.md `security_exclude_paths`); may be empty. */
  readonly excludePaths: readonly string[]
  /** Shared concurrency pool for agent sessions. */
  readonly limit: Limiter
  /** Lines the PR added, per file. A finding on one of them is introduced, whatever the model said. Default none. */
  readonly addedLines?: ReadonlyMap<string, ReadonlySet<number>>
  /** Receives a line per finder result, the candidate funnel and each vote. Default: discard. */
  readonly onProgress?: (message: string) => void
}

/** The outcome of {@link runSecurityReview}. */
export type SecurityResult = {
  /** Confirmed vulnerabilities, introduced first, then high → low. */
  readonly findings: readonly SecurityFinding[]
  /** Stage counts. */
  readonly stats: ReviewStats
  /** Non-fatal agent errors. */
  readonly errors: readonly string[]
  /** Candidates left undecided because so many votes errored that the rest could not reach a verdict. */
  readonly inconclusive: number
}

const LEVELS: readonly SecurityLevel[] = ['high', 'medium', 'low']
/** Introduced before pre-existing, then high → low. */
const rankOf = (f: SecurityFinding) => (f.introduced ? 0 : LEVELS.length) + LEVELS.indexOf(f.severity)
const KEYS = { classOf: (f: SecurityFinding) => f.vulnClass, rankOf }
/** Error message of any thrown value. */
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** `1 finding`, `2 findings`. */
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

/** Runs every planned finder (bounded); a failed finder is recorded, but all failing is fatal. */
async function runFinders(reviewer: SecurityReviewer, r: SecurityRequest) {
  const settled = await Promise.all(
    r.plan.finders.map((focus) =>
      r.limit(() => reviewer.findVulnerabilities(focus, r.input)).then(
        (findings) => {
          r.onProgress?.(`security finder ${focus}: ${count(findings.length, 'finding')}`)
          return { findings, error: undefined }
        },
        (e: unknown) => {
          r.onProgress?.(`security finder ${focus}: failed (${message(e)})`)
          return { findings: [], error: `security finder ${focus}: ${message(e)}` }
        },
      ),
    ),
  )
  const errors = settled.flatMap((s) => (s.error ? [s.error] : []))
  if (errors.length === settled.length) throw new Error(`All security finders failed: ${errors.join('; ')}`)
  return { findings: settled.flatMap((s) => s.findings), errors }
}

/** The diff, not the model, decides `introduced` for lines the PR added (so text can't relabel a new vuln as old). */
const withIntroduced = (f: SecurityFinding, added: SecurityRequest['addedLines']): SecurityFinding =>
  added?.get(f.file)?.has(f.line) ? { ...f, introduced: true } : f

/** In the diff, with evidence, not posted, not excluded; then dedupe, rank and cap. */
function selectCandidates(raw: readonly SecurityFinding[], r: SecurityRequest): readonly SecurityFinding[] {
  const inDiff = new Set(r.paths)
  const posted = new Set(r.posted)
  const plausible = raw.map((f) => withIntroduced(f, r.addedLines)).filter(
    (f) => inDiff.has(f.file) && f.evidence.trim() !== '' && !posted.has(securityFingerprint(f)) && exclusionReason(f, r.excludePaths) === undefined,
  )
  return sortByRank(dedupe(plausible, KEYS), rankOf).slice(0, r.maxFindings)
}

/** Collects exploitability votes; keeps the finding on a majority and sets severity to the median exploitable vote. */
async function judge(reviewer: SecurityReviewer, f: SecurityFinding, r: SecurityRequest) {
  const votes = await Promise.all(
    Array.from({ length: r.plan.voters }, () =>
      r.limit(() => reviewer.judgeExploit(f, r.input)).then(
        (vote) => ({ vote, error: undefined }),
        (e: unknown) => ({ vote: { exploitable: false, severity: f.severity, reason: 'verifier error' }, error: `security voter: ${message(e)}` }),
      ),
    ),
  )
  const yes = votes.filter((v) => v.vote.exploitable)
  const answered = votes.filter((v) => v.error === undefined).length
  // Undecided if the votes that arrived can neither confirm nor rule out the finding.
  const inconclusive = yes.length < r.plan.needed && answered - yes.length <= r.plan.voters - r.plan.needed
  const level = LEVELS[median(yes.map((v) => LEVELS.indexOf(v.vote.severity))) ?? -1] ?? f.severity
  const kept = tally(votes.map((v) => v.vote.exploitable), r.plan.needed)
  const outcome = kept ? `confirmed (${level})` : inconclusive ? 'undecided (voter errors)' : 'dropped'
  r.onProgress?.(`exploit vote ${f.file}:${f.line} "${f.title}": ${yes.length}/${r.plan.voters} exploitable → ${outcome}`)
  return {
    finding: { ...f, severity: level },
    kept,
    inconclusive,
    errors: votes.flatMap((v) => (v.error ? [v.error] : [])),
  }
}

/**
 * Runs the security review: finders → exclusion rules → dedupe → exploitability vote → rank.
 *
 * @param reviewer - The agents that find and judge vulnerabilities.
 * @param request - Diff, plan and limits for this run.
 * @returns Confirmed vulnerabilities with stage counts and non-fatal errors.
 * @throws {@link Error} If every security finder fails.
 */
export async function runSecurityReview(reviewer: SecurityReviewer, request: SecurityRequest): Promise<SecurityResult> {
  const finders = await runFinders(reviewer, request)
  const candidates = selectCandidates(finders.findings, request)
  request.onProgress?.(`${finders.findings.length} raw → ${count(candidates.length, 'candidate')} for voting`)
  const judged = await Promise.all(candidates.map((f) => judge(reviewer, f, request)))
  const confirmed = judged.filter((j) => j.kept).map((j) => j.finding)
  return {
    findings: sortByRank(confirmed, rankOf),
    stats: { raw: finders.findings.length, candidates: candidates.length, confirmed: confirmed.length },
    errors: [...finders.errors, ...judged.flatMap((j) => j.errors)],
    inconclusive: judged.filter((j) => j.inconclusive).length,
  }
}
