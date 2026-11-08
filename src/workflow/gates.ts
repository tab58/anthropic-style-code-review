import { loadGuidance } from '../guidance.js'
import { approvers, maxTier, requiredApprovals, type RiskApprovals } from '../risk/index.js'
import { RESOLVE_COMMAND } from './prior.js'
import { countOpenImportant, countOpenSecurity, decodeState, type ReviewState } from './markers.js'
import type { ApprovalsResult, BotThread, CheckConclusion, GateResult, GitHub, PullRequest } from './workflow.js'

/** Which checks to publish. */
export type GateNames = {
  /** Bug gate check name; the others are `<name>/security` and `<name>/approvals`. */
  readonly name: string
  /** Also publish the security gate. */
  readonly security: boolean
  /** Also publish the approvals gate. */
  readonly approvals: boolean
}

/** `n open <noun>s`, or the all-clear title. */
const title = (open: number, noun: string) => (open === 0 ? `No open ${noun}s` : `${open} open ${noun}${open === 1 ? '' : 's'}`)
/** Fails while anything blocks. */
const verdict = (blocked: boolean): CheckConclusion => (blocked ? 'failure' : 'success')

const SECURITY_SUMMARY = [
  'Fails while any **Security · High** or **Security · Medium** thread introduced by this PR is unresolved,',
  'or while the latest commits have not been security-reviewed (the pass failed or was undecided and will retry on the next run,',
  'the diff exceeded `max_diff_lines`, or the review is paused at the round cap; a human must review those).',
  'Low and pre-existing findings never block.',
].join(' ')

const APPROVALS_FOOTER =
  'Counts the latest review per person: an approval on the current head commit from someone with write access who is not the PR author. ' +
  'A new push resets approvals. This check only blocks merges when branch protection requires it.'

/** Base-branch REVIEW.md risk settings. */
type RiskPolicy = { readonly approvals: Partial<RiskApprovals>; readonly trustedTeam?: string }

/** Base-branch `risk_approvals` and `risk_trusted_team`, or the error that makes REVIEW.md unusable. */
async function riskPolicy(github: GitHub, pr: PullRequest): Promise<RiskPolicy | Error> {
  try {
    const config = (await loadGuidance({ read: (path) => github.readAtRef(pr.baseSha, path) }, [])).review?.config
    return { approvals: config?.riskApprovals ?? {}, ...(config?.riskTrustedTeam !== undefined && { trustedTeam: config.riskTrustedTeam }) }
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e))
  }
}

/**
 * Why the author isn't trusted, or undefined when they are (or no team is configured). A failed lookup counts as
 * untrusted, the strict direction.
 */
async function untrustedReason(github: GitHub, pr: PullRequest, team: string | undefined): Promise<string | undefined> {
  if (team === undefined) return undefined
  try {
    return (await github.inTeam(team, pr.author)) ? undefined : `author @${pr.author} is not in the trusted team ${team}: needs at least 1 approval`
  } catch (e) {
    return `could not check whether @${pr.author} is in the trusted team ${team} (${e instanceof Error ? e.message : String(e)}): needs at least 1 approval`
  }
}

/**
 * Publishes the approvals gate. The stored tier counts only for the head commit a round assessed; on a newer
 * head it is at least `medium` until the round finishes, so a push after a `low` round never starts green.
 */
export async function publishApprovals(github: GitHub, pr: PullRequest, name: string, known?: ReviewState): Promise<ApprovalsResult> {
  const state = known ?? decodeState(await github.botReviewBodies())
  const assessed = state?.tier !== undefined && state.sha === pr.headSha
  const tier = assessed ? (state?.tier ?? 'medium') : maxTier(state?.tier, 'medium')
  const reasons = assessed ? (state?.tierReasons ?? []) : ['not assessed yet for this commit; assuming at least medium until the review finishes', ...(state?.tierReasons ?? [])]
  const policy = await riskPolicy(github, pr)
  if (policy instanceof Error) {
    const summary = `Cannot count approvals: ${policy.message}. Fix REVIEW.md on the base branch.`
    await github.setCheck({ name: `${name}/approvals`, headSha: pr.headSha, conclusion: 'failure', title: 'REVIEW.md is invalid', summary })
    return { conclusion: 'failure', tier, required: requiredApprovals(tier), approved: [], assessed }
  }
  const untrusted = await untrustedReason(github, pr, policy.trustedTeam)
  const required = Math.max(requiredApprovals(tier, policy.approvals), untrusted === undefined ? 0 : 1)
  const candidates = approvers(await github.pullReviews(), pr)
  const writable = await Promise.all(candidates.map((login) => github.canApprove(login)))
  const approved = candidates.filter((_, i) => writable[i])
  const conclusion = verdict(approved.length < required)
  await github.setCheck({
    name: `${name}/approvals`,
    headSha: pr.headSha,
    conclusion,
    title: `Risk ${tier}: ${approved.length} of ${required} approvals`,
    summary: [
      `**Risk tier: ${tier}** (${required} approval${required === 1 ? '' : 's'} needed)`,
      '',
      ...[...reasons, ...(untrusted === undefined ? [] : [untrusted])].map((r) => `- ${r}`),
      '',
      `Approved by: ${approved.length ? approved.map((l) => `@${l}`).join(', ') : 'nobody yet'}`,
      '',
      APPROVALS_FOOTER,
    ].join('\n'),
  })
  return { conclusion, tier, required, approved, assessed }
}


/** Case-insensitive login match. */
const sameUser = (a: string | undefined, b: string) => a !== undefined && a.toLowerCase() === b.toLowerCase()

/** True when a write-access human other than the PR author replied `/resolve <reason>` to the finding. */
async function dismissedByHuman(github: GitHub, t: BotThread, author: string): Promise<boolean> {
  const logins = (t.replies ?? []).filter((r) => RESOLVE_COMMAND.test(r.body)).map((r) => r.login)
  for (const login of new Set(logins.filter((l) => !l.endsWith('[bot]') && !sameUser(l, author)))) if (await github.canApprove(login)) return true
  return false
}

/**
 * Bot threads that still count: not resolved on GitHub by someone other than the PR author, not recorded as fixed in
 * the state, and not dismissed with a `/resolve <reason>` reply by a write-access human other than the author. So
 * an author can clear a finding only by fixing it (the re-review confirms the fix), never by dismissing it.
 */
export async function openThreads(github: GitHub, state: ReviewState | undefined, author: string): Promise<readonly BotThread[]> {
  const fixed = new Set(state?.fixedThreads ?? [])
  const closed = (t: BotThread) => t.isResolved && !sameUser(t.resolvedBy, author)
  const candidates = (await github.botThreads()).filter((t) => !closed(t) && !fixed.has(t.id))
  const dismissed = await Promise.all(candidates.map((t) => dismissedByHuman(github, t, author)))
  return candidates.filter((_, i) => !dismissed[i])
}

/** Counts blocking threads, checks security coverage of HEAD, and publishes the enabled gates. */
export async function publishGates(github: GitHub, pr: PullRequest, names: GateNames): Promise<GateResult> {
  const state = decodeState(await github.botReviewBodies())
  const threads = await openThreads(github, state, pr.author)
  const openImportant = countOpenImportant(threads)
  await github.setCheck({
    name: names.name,
    headSha: pr.headSha,
    conclusion: verdict(openImportant > 0),
    title: title(openImportant, 'important finding'),
    summary: 'Fails while any review thread tagged **Important** is open. Fix it (the next push auto-resolves it), or have someone other than the author reply `/resolve <reason>` to dismiss it (write access needed).',
  })
  return {
    conclusion: verdict(openImportant > 0),
    openImportant,
    ...(names.security && { security: await publishSecurity(github, pr, names.name, threads, state) }),
    ...(names.approvals && { approvals: await publishApprovals(github, pr, names.name, state) }),
  }
}

/** Publishes the security gate: fails on open blocking threads or when HEAD isn't security-reviewed. */
async function publishSecurity(github: GitHub, pr: PullRequest, name: string, threads: Parameters<typeof countOpenSecurity>[0], state: ReviewState | undefined) {
  const openBlocking = countOpenSecurity(threads)
  const reviewed = state?.securitySha === pr.headSha
  const conclusion = verdict(openBlocking > 0 || !reviewed)
  await github.setCheck({
    name: `${name}/security`,
    headSha: pr.headSha,
    conclusion,
    title: openBlocking > 0 || reviewed ? title(openBlocking, 'high/medium security finding') : 'Latest commits not security-reviewed',
    summary: SECURITY_SUMMARY,
  })
  return { conclusion, openBlocking, reviewed }
}
