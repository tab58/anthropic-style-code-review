import { countOpenImportant, countOpenSecurity, decodeState } from './markers.js'
import type { CheckConclusion, GateResult, GitHub } from './workflow.js'

/** Which checks to publish. */
export type GateNames = {
  /** Bug gate check name; the security gate is `<name>/security`. */
  readonly name: string
  /** Also publish the security gate. */
  readonly security: boolean
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

/** Counts blocking threads, checks security coverage of HEAD, and publishes the bug gate (and the security gate when enabled). */
export async function publishGates(github: GitHub, headSha: string, names: GateNames): Promise<GateResult> {
  const threads = await github.botThreads()
  const openImportant = countOpenImportant(threads)
  await github.setCheck({
    name: names.name,
    headSha,
    conclusion: verdict(openImportant > 0),
    title: title(openImportant, 'important finding'),
    summary: 'Fails while any review thread tagged **Important** is unresolved. Fix it or resolve the thread with a reason.',
  })
  if (!names.security) return { conclusion: verdict(openImportant > 0), openImportant }

  const openBlocking = countOpenSecurity(threads)
  const reviewed = decodeState(await github.botReviewBodies())?.securitySha === headSha
  const conclusion = verdict(openBlocking > 0 || !reviewed)
  await github.setCheck({
    name: `${names.name}/security`,
    headSha,
    conclusion,
    title: openBlocking > 0 || reviewed ? title(openBlocking, 'high/medium security finding') : 'Latest commits not security-reviewed',
    summary: SECURITY_SUMMARY,
  })
  return { conclusion: verdict(openImportant > 0), openImportant, security: { conclusion, openBlocking, reviewed } }
}
