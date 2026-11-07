/**
 * Review a local branch with the real workflow and agents, no GitHub involved.
 *
 *   PROVIDER_API_KEY=... npm run local -- --repo ../my-project --base main
 *
 * Reviews `base...HEAD` (committed changes only). Agents read the working tree, so commit first for
 * accurate line numbers. State (rounds, posted findings, threads) persists in .git/anthropic-style-code-review/
 * so re-running after new commits behaves like a push: incremental review, auto-resolve, no repeats.
 * Use --reset to start over.
 */
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createPiReviewer } from '../src/pi-reviewer/index.js'
import { createWorkflow } from '../src/workflow/index.js'
import { createLocalGitHub } from './local-github.js'

const USAGE = `Usage: npm run local -- [--repo <path>] [--base <ref>] [--depth quick|standard|deep] [--title <text>] [--reset] [--no-security] [--risk]

Env: PROVIDER_API_KEY (or OLLAMA_API_KEY), PROVIDER_BASE_URL (default https://ollama.com/v1),
     FINDER_MODEL (glm-5.3), VERIFIER_MODEL (deepseek-v4.1-flash), SECURITY_FINDER_MODEL, SECURITY_VERIFIER_MODEL, CONCURRENCY (3)`

async function main() {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string', default: process.env.INIT_CWD ?? process.cwd() },
      base: { type: 'string', default: 'main' },
      depth: { type: 'string' },
      title: { type: 'string' },
      reset: { type: 'boolean', default: false },
      'no-security': { type: 'boolean', default: false },
      risk: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })
  if (values.help) return console.log(USAGE)
  const apiKey = process.env.PROVIDER_API_KEY ?? process.env.OLLAMA_API_KEY
  if (!apiKey) throw new Error(`Set PROVIDER_API_KEY.\n\n${USAGE}`)

  const repo = resolve(values.repo)
  const statePath = join(repo, '.git', 'anthropic-style-code-review', 'state.json')
  if (values.reset) await rm(statePath, { force: true })

  const github = createLocalGitHub({ repo, base: values.base, title: values.title, statePath, print: (t) => console.log(t) })
  const createReviewer = () =>
    createPiReviewer({
      baseUrl: process.env.PROVIDER_BASE_URL ?? 'https://ollama.com/v1',
      apiKey,
      finderModel: process.env.FINDER_MODEL ?? 'glm-5.3',
      verifierModel: process.env.VERIFIER_MODEL ?? 'deepseek-v4.1-flash',
      securityFinderModel: process.env.SECURITY_FINDER_MODEL,
      securityVerifierModel: process.env.SECURITY_VERIFIER_MODEL,
      cwd: repo,
      log: (m) => console.error(m),
    })
  const log = { info: (m: string) => console.error(`· ${m}`), warning: (m: string) => console.error(`⚠ ${m}`) }
  const workflow = createWorkflow({ github, createReviewer, log }, { depth: values.depth, concurrency: Number(process.env.CONCURRENCY ?? 10), securityReview: !values['no-security'], riskTiers: values.risk })

  console.error(`Reviewing ${repo} (${values.base}...HEAD)…`)
  const outcome = await workflow.review()
  console.error(`\n${outcome.message}`)
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
