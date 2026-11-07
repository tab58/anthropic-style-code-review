/**
 * A GitHub stand-in for running the review workflow on a local git repo.
 * Diffs and base-ref files come from git; reviews, threads and check results are kept in a JSON
 * state file (under .git/, never committed) and echoed to the terminal instead of being posted.
 */
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { Type } from 'typebox'
import { Check } from 'typebox/value'
import type { BotThread, CheckRun, GitHub, PullRequest, ReviewComment } from '../src/workflow/index.js'

const run = promisify(execFile)

/** Where the local "PR" lives and how it is described. */
export type LocalGitHubConfig = {
  /** Repo root. */
  readonly repo: string
  /** Base branch or ref the "PR" targets, e.g. `main`. */
  readonly base: string
  /** PR title; defaults to HEAD's commit subject. */
  readonly title?: string
  /** PR description. */
  readonly body?: string
  /** JSON file holding posted reviews and threads across runs. */
  readonly statePath: string
  /** Receives everything that would have been posted to GitHub. */
  readonly print: (text: string) => void
}

const StateSchema = Type.Object({
  reviews: Type.Array(Type.String()),
  threads: Type.Array(
    Type.Object({ id: Type.String(), isResolved: Type.Boolean(), path: Type.String(), line: Type.Union([Type.Integer(), Type.Null()]), body: Type.String() }),
  ),
})
type State = { readonly reviews: readonly string[]; readonly threads: readonly BotThread[] }

/** Runs git in the repo and returns trimmed stdout. */
const git = async (repo: string, ...args: string[]) => (await run('git', args, { cwd: repo, maxBuffer: 64 * 1024 * 1024 })).stdout

/** Hidden markers are machine state; hide them when echoing to a human. */
const visible = (text: string) => text.replace(/<!--[\s\S]*?-->/g, '').trim()

async function loadState(path: string): Promise<State> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
    return Check(StateSchema, raw) ? raw : { reviews: [], threads: [] }
  } catch {
    return { reviews: [], threads: [] }
  }
}

async function saveState(path: string, state: State): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`)
}

/** Prints one review the way it would appear on the PR. */
function printReview(print: (t: string) => void, body: string, comments: readonly ReviewComment[]) {
  print(`\n━━━ Review ━━━\n${visible(body)}`)
  for (const c of comments) print(`\n── ${c.path}:${c.line} ──\n${visible(c.body)}`)
}

/**
 * Creates a {@link GitHub} backed by local git and a state file.
 *
 * @param c - Repo, base ref, PR text, state file and output sink.
 * @returns A GitHub implementation for `createWorkflow`. Git failures reject with git's error.
 */
export function createLocalGitHub(c: LocalGitHubConfig): GitHub {
  const update = async (fn: (s: State) => State) => saveState(c.statePath, fn(await loadState(c.statePath)))
  return {
    async getPull(): Promise<PullRequest> {
      const [headSha, baseSha, subject] = await Promise.all([
        git(c.repo, 'rev-parse', 'HEAD'),
        git(c.repo, 'rev-parse', c.base),
        git(c.repo, 'log', '-1', '--format=%s'),
      ])
      return { number: 0, headSha: headSha.trim(), baseSha: baseSha.trim(), title: c.title ?? subject.trim(), body: c.body ?? '', isFork: false, draft: false }
    },
    compareDiff: (base, head) => git(c.repo, 'diff', '--no-color', '--no-ext-diff', `${base}...${head}`),
    async isAncestor(ancestor, head) {
      return git(c.repo, 'merge-base', '--is-ancestor', ancestor, head).then(
        () => true,
        () => false,
      )
    },
    readAtRef: (ref, path) => git(c.repo, 'show', `${ref}:${path}`).catch(() => undefined),
    botReviewBodies: async () => (await loadState(c.statePath)).reviews,
    botThreads: async () => (await loadState(c.statePath)).threads,
    async createReview({ body, comments }) {
      printReview(c.print, body, comments)
      await update((s) => ({
        reviews: [...s.reviews, body],
        threads: [
          ...s.threads,
          ...comments.map((cm, i) => ({ id: `t${s.threads.length + i + 1}`, isResolved: false, path: cm.path, line: cm.line, body: cm.body })),
        ],
      }))
    },
    async resolveThread(id) {
      c.print(`\n✓ Auto-resolved ${id} (fixed by new commits)`)
      await update((s) => ({ ...s, threads: s.threads.map((t) => (t.id === id ? { ...t, isResolved: true } : t)) }))
    },
    async setCheck({ name, conclusion, title }: CheckRun) {
      c.print(`\n━━━ ${name}: ${conclusion === 'success' ? '✅ pass' : '❌ fail'} (${title}) ━━━`)
    },
  }
}
