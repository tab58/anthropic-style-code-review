import { matchesGlob } from 'node:path'
import { type FileDiff, matchesGlobDot } from '../diff.js'

/** How risky a PR is; sets how many human approvals it needs. */
export type RiskTier = 'low' | 'medium' | 'high'

/** Every tier, least risky first. */
export const RISK_TIERS: readonly RiskTier[] = ['low', 'medium', 'high']

/** Approvals needed per tier. */
export type RiskApprovals = Readonly<Record<RiskTier, number>>

/** The article's default: low 0, medium 1, high 2. */
export const DEFAULT_RISK_APPROVALS: RiskApprovals = { low: 0, medium: 1, high: 2 }

/** A tier and why. */
export type RiskAssessment = {
  /** The tier. */
  readonly tier: RiskTier
  /** Human-readable reasons for the tier, shown in the summary and the approvals check. */
  readonly reasons: readonly string[]
}

/** Deterministic inputs to {@link assessRisk}. */
export type RiskSignals = {
  /** The full PR diff (base...head), after nothing is filtered out. */
  readonly files: readonly FileDiff[]
  /** REVIEW.md `risk_high_paths`: globs that force `high`. May be empty. */
  readonly highPaths: readonly string[]
  /** REVIEW.md `risk_medium_paths`: globs that force at least `medium`. Default none. */
  readonly mediumPaths?: readonly string[]
  /** REVIEW.md `skip_paths`: files left out of the size count (generated code, lockfiles, fixtures). Default none. */
  readonly skipPaths?: readonly string[]
  /** REVIEW.md `risk_default`: tier of source changes no rule matches. Default `medium`. */
  readonly defaultTier?: 'low' | 'medium'
  /** REVIEW.md `risk_large_pr_lines`: more changed lines than this makes a PR at least `medium`. Default 200. */
  readonly largeLines?: number
  /** A High or Medium security finding introduced by this PR was posted this round. */
  readonly blockingSecurity: boolean
  /** Automated review didn't run on these commits (oversized diff or round cap). */
  readonly skipped: boolean
}

/** What a {@link RiskClassifier} sees. */
export type RiskInput = {
  /** The full PR diff text (untrusted). */
  readonly diff: string
  /** PR title and description (untrusted). */
  readonly intent: string
  /** The rule floor; the classifier may only raise it. */
  readonly floor: RiskAssessment
}

/** An LLM that judges a PR's risk tier. */
export interface RiskClassifier {
  /** Returns the classifier's own tier and reasons; rejects on model or API errors. */
  classifyRisk(input: RiskInput): Promise<RiskAssessment>
}

/** A GitHub review state, as the reviews API reports it. */
export type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'

/** One submitted pull request review. */
export type PullReview = {
  /** Reviewer login. */
  readonly login: string
  /** True for GitHub Apps and other bot accounts. */
  readonly isBot: boolean
  /** Review state. */
  readonly state: ReviewState
  /** Commit the review was submitted on. */
  readonly commitId: string
}

const DEFAULT_LARGE_LINES = 200
const DOCS_AND_TESTS = ['**/*.md', 'docs/**', '**/docs/**', 'test/**', 'tests/**', '**/test/**', '**/tests/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*', '**/*_test.*']
const rank = (t: RiskTier) => RISK_TIERS.indexOf(t)

/** Line-comment syntax by file extension. Block-comment bodies (`/** … *\/`, ` * …`) count only for C-style languages. */
const C_STYLE = /^(\/\/|\/\*|\*\/|\*(\s|\/|$))/
const HASH = /^#/
const DASH = /^--/
const COMMENT_SYNTAX: Readonly<Record<string, RegExp>> = Object.fromEntries([
  ...['go', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'java', 'kt', 'kts', 'swift', 'rs', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'scala', 'dart', 'php', 'proto'].map((e) => [e, C_STYLE] as const),
  ...['py', 'rb', 'sh', 'bash', 'zsh', 'r', 'pl'].map((e) => [e, HASH] as const),
  ...['sql', 'lua', 'hs'].map((e) => [e, DASH] as const),
])

/**
 * True when every added and removed line is blank or a comment in a language whose comment syntax is known. Conservative:
 * unknown extensions, and lines that merely contain a comment after code, count as code.
 */
function commentOnly(f: FileDiff): boolean {
  const syntax = COMMENT_SYNTAX[f.path.slice(f.path.lastIndexOf('.') + 1).toLowerCase()]
  if (syntax === undefined || f.deleted) return false
  const changed = f.text.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l))
  return changed.every((l) => {
    const body = l.slice(1).trim()
    return body === '' || syntax.test(body)
  })
}

/**
 * The highest of the given tiers.
 *
 * @param tiers - Tiers to compare; undefined entries are ignored.
 * @returns The riskiest tier, or `low` when none is given.
 */
export const maxTier = (...tiers: readonly (RiskTier | undefined)[]): RiskTier =>
  tiers.reduce<RiskTier>((a, t) => (t !== undefined && rank(t) > rank(a) ? t : a), 'low')

/** `a, b, c and N more`. */
const list = (paths: readonly string[]) => paths.slice(0, 3).join(', ') + (paths.length > 3 ? ` and ${paths.length - 3} more` : '')

/** Paths matching any glob (dotfiles included). */
const matching = (paths: readonly string[], globs: readonly string[] = []) => paths.filter((p) => globs.some((g) => matchesGlobDot(p, g)))

/** Source files whose change is more than docs, tests or comments. */
const sourceChanges = (files: readonly FileDiff[]) => files.filter((f) => !DOCS_AND_TESTS.some((g) => matchesGlob(f.path, g)) && !commentOnly(f)).map((f) => f.path)

/** Every rule that fired, as [tier, reason]. */
function rules(s: RiskSignals): readonly (readonly [RiskTier, string])[] {
  // Path rules ignore comment-only edits: a comment can't change behavior, even in auth code.
  const paths = s.files.filter((f) => !commentOnly(f)).map((f) => f.path)
  const forced = matching(paths, s.highPaths)
  const medium = matching(paths, s.mediumPaths)
  const workflows = matching(paths, ['.github/workflows/**'])
  const code = sourceChanges(s.files)
  const limit = s.largeLines ?? DEFAULT_LARGE_LINES
  const changed = s.files.filter((f) => matching([f.path], s.skipPaths).length === 0).reduce((n, f) => n + f.changed, 0)
  const fired: (readonly [RiskTier, string] | false)[] = [
    workflows.length > 0 && ['high', `changes CI workflows: ${list(workflows)}`],
    forced.length > 0 && ['high', `matches risk_high_paths: ${list(forced)}`],
    s.blockingSecurity && ['high', 'a High/Medium security finding was introduced'],
    medium.length > 0 && ['medium', `matches risk_medium_paths: ${list(medium)}`],
    s.skipped && ['medium', 'automated review did not run on these commits'],
    changed > limit && ['medium', `${changed} changed lines (> ${limit})`],
    (s.defaultTier ?? 'medium') === 'medium' && code.length > 0 && ['medium', `changes source: ${list(code)}`],
  ]
  return fired.filter((r) => r !== false)
}

/**
 * The rule floor: the minimum tier the deterministic signals justify.
 *
 * @param signals - The full PR diff, REVIEW.md globs and this round's results.
 * @returns `high` for CI workflow files, `risk_high_paths` or blocking security findings; `medium` for `risk_medium_paths`, a
 *   skipped review, a large PR, or (with the default `risk_default: medium`) any source change; otherwise `low`: docs, tests,
 *   comment-only changes, and source no rule matches when `risk_default` is `low`. Reasons list every rule that fired at the winning tier.
 */
export function assessRisk(signals: RiskSignals): RiskAssessment {
  const fired = rules(signals)
  const tier = maxTier(...fired.map(([t]) => t))
  const reasons = fired.filter(([t]) => t === tier).map(([, r]) => r)
  const fallback = sourceChanges(signals.files).length > 0 ? 'no risk rule matched these source changes (risk_default: low)' : 'docs, tests and comments only'
  return { tier, reasons: reasons.length > 0 ? reasons : [fallback] }
}

/**
 * Asks the classifier, keeping its answer only when it raises the floor.
 *
 * @param classifier - The LLM classifier.
 * @param input - Diff, intent and the rule floor.
 * @returns The floor, or the classifier's higher tier with its reasons appended (prefixed `classifier:`).
 *   Never rejects: when the classifier fails, the tier is at least `medium` and the reasons say why.
 */
export async function classifyRisk(classifier: RiskClassifier, input: RiskInput): Promise<RiskAssessment> {
  const { floor } = input
  try {
    const out = await classifier.classifyRisk(input)
    if (rank(out.tier) <= rank(floor.tier)) return floor
    return { tier: out.tier, reasons: [...floor.reasons, ...out.reasons.map((r) => `classifier: ${r}`)] }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    return { tier: maxTier(floor.tier, 'medium'), reasons: [...floor.reasons, `risk classifier failed (${why}); assumed at least medium`] }
  }
}

/**
 * Approvals needed for a tier.
 *
 * @param tier - The PR's tier.
 * @param overrides - REVIEW.md `risk_approvals`; missing tiers use {@link DEFAULT_RISK_APPROVALS}.
 * @returns A non-negative integer.
 */
export const requiredApprovals = (tier: RiskTier, overrides: Partial<RiskApprovals> = {}): number => overrides[tier] ?? DEFAULT_RISK_APPROVALS[tier]

/**
 * Users whose latest decisive review (approve, request changes, dismissed) approves the current head commit.
 * Comments and pending reviews never change a decision. Write-permission is checked by the caller.
 *
 * @param reviews - The PR's reviews, oldest first; may be empty.
 * @param pr - Current head SHA and the PR author's login.
 * @returns Approving logins, in order of first review, excluding the author (case-insensitive) and bots.
 */
export function approvers(reviews: readonly PullReview[], pr: { readonly headSha: string; readonly author: string }): readonly string[] {
  const latest = new Map<string, PullReview>()
  for (const r of reviews) if (r.state !== 'COMMENTED' && r.state !== 'PENDING') latest.set(r.login, r)
  return [...latest.values()]
    .filter((r) => r.state === 'APPROVED' && r.commitId === pr.headSha && !r.isBot && r.login.toLowerCase() !== pr.author.toLowerCase())
    .map((r) => r.login)
}
