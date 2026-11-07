/**
 * Runs the real pipeline (Pi + your OpenAI-compatible provider) on fixture cases and reports recall and
 * false positives, separately for the bug review and the security review.
 *
 *   PROVIDER_API_KEY=... npm run eval            # all cases
 *   EVAL_DEPTH=quick npm run eval -- sec-        # filter by name prefix
 *   EVAL_SECURITY=off npm run eval               # bug review only
 *
 * A case is eval/cases/<name>/{before/,after/,expected.json}. Add one for every bug or vulnerability that
 * slipped past review in real life, and rerun whenever prompts, models or presets change.
 */
import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Static, Type } from 'typebox'
import { Check } from 'typebox/value'
import type { Location } from '../src/consensus.js'
import { parseDiff } from '../src/diff.js'
import { createLimiter } from '../src/limiter.js'
import { createPiReviewer } from '../src/pi-reviewer/index.js'
import { type DepthConfig, resolveDepth, runReview } from '../src/review/index.js'
import { chooseSecurityPlan, runSecurityReview } from '../src/security/index.js'

const Spot = Type.Object({ file: Type.String(), line: Type.Integer() })
const ExpectedSchema = Type.Object({ intent: Type.String(), bugs: Type.Array(Spot), security: Type.Optional(Type.Array(Spot)) })
type Expected = Static<typeof ExpectedSchema>
type Spot = Static<typeof Spot>

/** Reads and validates a case's expected.json. */
async function readExpected(dir: string): Promise<Expected> {
  const raw: unknown = JSON.parse(await readFile(join(dir, 'expected.json'), 'utf8'))
  if (!Check(ExpectedSchema, raw)) throw new Error(`${dir}/expected.json does not match { intent, bugs: [{ file, line }], security?: [...] }`)
  return raw
}

const TOLERANCE = 3
const CASES = join(import.meta.dirname, 'cases')

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=eval', '-c', 'user.email=eval@example.com', ...args], { cwd, encoding: 'utf8' })

/** Temp git repo at the "after" state plus the before→after diff. */
async function materialize(dir: string): Promise<{ repo: string; diff: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'review-eval-'))
  git(repo, 'init', '-q')
  await cp(join(dir, 'before'), repo, { recursive: true })
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'before')
  git(repo, 'rm', '-rq', '.')
  await cp(join(dir, 'after'), repo, { recursive: true })
  git(repo, 'add', '-A')
  return { repo, diff: git(repo, 'diff', '--cached') }
}

/** True when a reported location covers an expected line (± tolerance). */
const hits = (f: Location, s: Spot) => f.file === s.file && s.line >= f.line - TOLERANCE && s.line <= f.endLine + TOLERANCE

/** Matched and false-positive counts for one pass. `alsoOk` locations aren't false positives (e.g. a bug finder flagging a known vuln). */
function score(found: readonly (Location & { readonly title: string })[], expected: readonly Spot[], alsoOk: readonly Spot[]) {
  const matched = expected.filter((s) => found.some((f) => hits(f, s))).length
  const fps = found.filter((f) => ![...expected, ...alsoOk].some((s) => hits(f, s)))
  return { matched, expected: expected.length, fps }
}

type Tally = { matched: number; expected: number; fps: number }
const add = (t: Tally, s: ReturnType<typeof score>): Tally => ({ matched: t.matched + s.matched, expected: t.expected + s.expected, fps: t.fps + s.fps.length })
const line = (label: string, s: ReturnType<typeof score>) => `${label} ${s.matched}/${s.expected} caught, ${s.fps.length} FP`

/** Runs both passes on one case (sharing one concurrency pool) and scores them. */
async function runCase(name: string, apiKey: string, depth: DepthConfig, security: boolean) {
  const dir = join(CASES, name)
  const expected = await readExpected(dir)
  const { repo, diff } = await materialize(dir)
  const reviewer = await createPiReviewer({
    baseUrl: process.env.PROVIDER_BASE_URL ?? 'https://ollama.com/v1',
    apiKey,
    finderModel: process.env.FINDER_MODEL ?? 'glm-5.3',
    verifierModel: process.env.VERIFIER_MODEL ?? 'deepseek-v4.1-flash',
    securityFinderModel: process.env.SECURITY_FINDER_MODEL,
    securityVerifierModel: process.env.SECURITY_VERIFIER_MODEL,
    cwd: repo,
  })
  const files = parseDiff(diff)
  const input = { diff, guidance: '', intent: expected.intent }
  const paths = files.filter((f) => !f.deleted).map((f) => f.path)
  const limit = createLimiter(Number(process.env.EVAL_CONCURRENCY ?? 3))
  const plan = chooseSecurityPlan(files, { forceFull: depth.depth === 'deep' })
  const [bugs, vulns] = await Promise.all([
    runReview(reviewer, { input, paths, depth, posted: [], maxFindings: 15, nitCap: 3, limit }),
    security ? runSecurityReview(reviewer, { input, paths, plan, posted: [], maxFindings: 15, excludePaths: [], limit }) : undefined,
  ])
  const expectedSecurity = expected.security ?? []
  return {
    bug: score(bugs.findings, expected.bugs, expectedSecurity),
    sec: vulns && { ...score(vulns.findings, expectedSecurity, []), plan: plan.depth },
    errors: [...bugs.errors, ...(vulns?.errors ?? [])],
  }
}

async function main() {
  const apiKey = process.env.PROVIDER_API_KEY
  if (!apiKey) throw new Error('Set PROVIDER_API_KEY')
  const depth = resolveDepth({ input: { depth: process.env.EVAL_DEPTH } })
  const security = process.env.EVAL_SECURITY !== 'off'
  const filters = process.argv.slice(2).map((p) => p.replace(/\*$/, ''))
  const names = (await readdir(CASES)).filter((n) => filters.length === 0 || filters.some((p) => n.startsWith(p))).sort()
  console.log(`depth=${depth.depth} security=${security ? 'on' : 'off'} finder=${process.env.FINDER_MODEL ?? 'glm-5.3'} verifier=${process.env.VERIFIER_MODEL ?? 'deepseek-v4.1-flash'}\n`)

  let bugTotal: Tally = { matched: 0, expected: 0, fps: 0 }
  let secTotal: Tally = { matched: 0, expected: 0, fps: 0 }
  for (const name of names) {
    const started = Date.now()
    const r = await runCase(name, apiKey, depth, security)
    bugTotal = add(bugTotal, r.bug)
    if (r.sec) secTotal = add(secTotal, r.sec)
    const ok = [r.bug, ...(r.sec ? [r.sec] : [])].every((s) => s.matched === s.expected && s.fps.length === 0)
    const sec = r.sec ? ` | ${line(`security(${r.sec.plan})`, r.sec)}` : ''
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${line('bugs', r.bug)}${sec}, ${((Date.now() - started) / 1000).toFixed(0)}s`)
    for (const f of [...r.bug.fps, ...(r.sec?.fps ?? [])]) console.log(`    FP ${f.file}:${f.line} ${f.title}`)
    for (const e of r.errors) console.log(`    error: ${e}`)
  }

  const pct = (t: Tally) => (t.expected ? `${((100 * t.matched) / t.expected).toFixed(0)}%` : 'n/a')
  console.log(`\nBugs:     recall ${bugTotal.matched}/${bugTotal.expected} (${pct(bugTotal)}), false positives ${bugTotal.fps}`)
  if (security) console.log(`Security: recall ${secTotal.matched}/${secTotal.expected} (${pct(secTotal)}), false positives ${secTotal.fps}`)
  console.log(`across ${names.length} cases`)
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
