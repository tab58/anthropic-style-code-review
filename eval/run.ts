/**
 * Runs the real pipeline (Pi + your OpenAI-compatible provider) on fixture cases and reports recall + false positives.
 *
 *   PROVIDER_API_KEY=... npm run eval            # all cases
 *   EVAL_DEPTH=quick npm run eval -- clean-*   # filter by name prefix
 *
 * A case is eval/cases/<name>/{before/,after/,expected.json}. Add one for every bug that slipped
 * past review in real life, and rerun whenever prompts, models or presets change.
 */
import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDiff } from '../src/diff.js'
import { createPiReviewer } from '../src/pi-reviewer/index.js'
import { type Finding, resolveDepth, runReview } from '../src/review/index.js'
import { type Static, Type } from 'typebox'
import { Check } from 'typebox/value'

const ExpectedSchema = Type.Object({
  intent: Type.String(),
  bugs: Type.Array(Type.Object({ file: Type.String(), line: Type.Integer() })),
})
type Expected = Static<typeof ExpectedSchema>

/** Reads and validates a case's expected.json. */
async function readExpected(dir: string): Promise<Expected> {
  const raw: unknown = JSON.parse(await readFile(join(dir, 'expected.json'), 'utf8'))
  if (!Check(ExpectedSchema, raw)) throw new Error(`${dir}/expected.json does not match { intent, bugs: [{ file, line }] }`)
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

const hits = (f: Finding, bug: { file: string; line: number }) =>
  f.file === bug.file && bug.line >= f.line - TOLERANCE && bug.line <= f.endLine + TOLERANCE

async function main() {
  const apiKey = process.env.PROVIDER_API_KEY
  if (!apiKey) throw new Error('Set PROVIDER_API_KEY')
  const depth = resolveDepth({ input: { depth: process.env.EVAL_DEPTH } })
  const filters = process.argv.slice(2).map((p) => p.replace(/\*$/, ''))
  const names = (await readdir(CASES)).filter((n) => filters.length === 0 || filters.some((p) => n.startsWith(p))).sort()

  let expectedTotal = 0
  let matchedTotal = 0
  let fpTotal = 0
  console.log(`depth=${depth.depth} finder=${process.env.FINDER_MODEL ?? 'glm-5.3'} verifier=${process.env.VERIFIER_MODEL ?? 'deepseek-v4.1-flash'}\n`)

  for (const name of names) {
    const dir = join(CASES, name)
    const expected = await readExpected(dir)
    const { repo, diff } = await materialize(dir)
    const reviewer = await createPiReviewer({
      baseUrl: process.env.PROVIDER_BASE_URL ?? 'https://ollama.com/v1',
      apiKey,
      finderModel: process.env.FINDER_MODEL ?? 'glm-5.3',
      verifierModel: process.env.VERIFIER_MODEL ?? 'deepseek-v4.1-flash',
      cwd: repo,
    })
    const started = Date.now()
    const result = await runReview(reviewer, {
      input: { diff, guidance: '', intent: expected.intent },
      paths: parseDiff(diff).filter((f) => !f.deleted).map((f) => f.path),
      depth,
      posted: [],
      maxFindings: 15,
      nitCap: 3,
      concurrency: Number(process.env.EVAL_CONCURRENCY ?? 3),
    })
    const matched = expected.bugs.filter((b) => result.findings.some((f) => hits(f, b))).length
    const fps = result.findings.filter((f) => !expected.bugs.some((b) => hits(f, b)))
    expectedTotal += expected.bugs.length
    matchedTotal += matched
    fpTotal += fps.length

    const verdict = matched === expected.bugs.length && fps.length === 0 ? 'PASS' : 'FAIL'
    console.log(
      `${verdict} ${name}: caught ${matched}/${expected.bugs.length}, false positives ${fps.length}, ` +
        `${result.stats.raw} raw → ${result.stats.candidates} voted → ${result.stats.confirmed} confirmed, ${((Date.now() - started) / 1000).toFixed(0)}s`,
    )
    for (const f of fps) console.log(`    FP ${f.severity} ${f.file}:${f.line} ${f.title}`)
    for (const e of result.errors) console.log(`    error: ${e}`)
  }

  const recall = expectedTotal ? ((100 * matchedTotal) / expectedTotal).toFixed(0) : 'n/a'
  console.log(`\nRecall ${matchedTotal}/${expectedTotal} (${recall}%), false positives ${fpTotal} across ${names.length} cases`)
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
