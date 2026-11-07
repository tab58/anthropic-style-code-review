import { describe, expect, it, vi } from 'vitest'
import { type Finding, fingerprint, type Reviewer } from '../../src/review/index.js'
import { encodeState, decodeState } from '../../src/workflow/markers.js'
import { type BotThread, createWorkflow, type GitHub, type WorkflowOptions } from '../../src/workflow/index.js'

const diffFor = (path: string, added: string[]) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,${added.length + 1} @@\n ctx\n${added.map((l) => `+${l}`).join('\n')}\n`

const finding = (over: Partial<Finding> = {}): Finding => ({
  file: 'src/a.ts',
  line: 2,
  endLine: 2,
  title: 'Boom',
  explanation: 'it breaks',
  evidence: 'x()',
  severity: 'important',
  category: 'bug',
  bugClass: 'boom',
  ...over,
})

type FakeOpts = {
  diffs?: Record<string, string>
  files?: Record<string, string>
  bodies?: string[]
  threads?: BotThread[]
  fork?: boolean
  draft?: boolean
  ancestor?: boolean
  reviewError?: (comments: number) => unknown
}

/** In-memory GitHub: reviews create threads; resolving flips them. */
function fakeGitHub(opts: FakeOpts = {}) {
  const reviews: { body: string; comments: readonly { path: string; line: number; body: string }[] }[] = []
  const threads: BotThread[] = [...(opts.threads ?? [])]
  const checks: { conclusion: string; title: string }[] = []
  const compared: string[] = []
  const github: GitHub = {
    getPull: async () => ({ number: 1, headSha: 'h2', baseSha: 'b0', title: 'Add x', body: 'desc', isFork: opts.fork ?? false, draft: opts.draft ?? false }),
    compareDiff: async (base, head) => {
      compared.push(`${base}...${head}`)
      return opts.diffs?.[base] ?? diffFor('src/a.ts', ['x()', 'y()'])
    },
    isAncestor: async () => opts.ancestor ?? true,
    readAtRef: async (_ref, path) => opts.files?.[path],
    botReviewBodies: async () => [...(opts.bodies ?? []), ...reviews.map((r) => r.body)],
    botThreads: async () => threads.map((t) => ({ ...t })),
    createReview: async ({ body, comments }) => {
      const err = opts.reviewError?.(comments.length)
      if (err) throw err
      reviews.push({ body, comments })
      comments.forEach((c, i) => threads.push({ id: `new${i}`, isResolved: false, path: c.path, line: c.line, body: c.body }))
    },
    resolveThread: async (id) => {
      const i = threads.findIndex((t) => t.id === id)
      const t = threads[i]
      if (t) threads[i] = { ...t, isResolved: true }
    },
    setCheck: async (c) => {
      checks.push(c)
    },
  }
  return { github, reviews, threads, checks, compared }
}

const fakeReviewer = (findings: readonly Finding[], over: Partial<Reviewer> = {}): Reviewer => ({
  find: vi.fn(async () => findings),
  verify: vi.fn(async () => ({ real: true, reason: '' })),
  recheck: vi.fn(async () => true),
  ...over,
})

const options: WorkflowOptions = { depth: 'quick', maxRounds: 3, maxDiffLines: 1000, maxFindings: 10, concurrency: 2 }
const log = () => ({ info: vi.fn(), warning: vi.fn() })
const important = (id: string, path: string, isResolved = false): BotThread => ({
  id,
  isResolved,
  path,
  line: 2,
  body: '**Important**: Boom\n<!-- anthropic-style-code-review:finding important abc -->',
})

describe('createWorkflow().review', () => {
  it('first round: inline comment, count-first summary, state, failing check, reviewed outcome', async () => {
    const gh = fakeGitHub()
    const outcome = await createWorkflow({ github: gh.github, createReviewer: async () => fakeReviewer([finding()]), log: log() }, options).review()

    expect(gh.compared).toEqual(['b0...h2'])
    expect(gh.reviews).toHaveLength(1)
    expect(gh.reviews[0]?.body.split('\n')[0]).toBe('**1 issue found** (1 important)')
    expect(gh.reviews[0]?.comments).toEqual([expect.objectContaining({ path: 'src/a.ts', line: 2 })])
    expect(decodeState([gh.reviews[0]?.body ?? ''])).toMatchObject({ round: 1, sha: 'h2' })
    expect(gh.checks.at(-1)?.conclusion).toBe('failure')
    expect(outcome).toMatchObject({ status: 'reviewed', round: 1, resolved: 0, stats: { confirmed: 1 } })
  })

  it('works with default options (standard depth from presets)', async () => {
    const gh = fakeGitHub()
    const reviewer = fakeReviewer([])
    await createWorkflow({ github: gh.github, createReviewer: async () => reviewer, log: log() }).review()
    expect(reviewer.find).toHaveBeenCalledTimes(4)
  })

  it('posts findings outside the diff in the summary, not inline', async () => {
    const gh = fakeGitHub()
    await createWorkflow({ github: gh.github, createReviewer: async () => fakeReviewer([finding({ line: 50, endLine: 50 })]), log: log() }, options).review()
    expect(gh.reviews[0]?.comments).toEqual([])
    expect(gh.reviews[0]?.body).toContain('`src/a.ts:50`')
  })

  it('is up-to-date when HEAD was already reviewed', async () => {
    const gh = fakeGitHub({ bodies: [encodeState({ round: 1, sha: 'h2', fingerprints: [] })] })
    const createReviewer = vi.fn()
    const outcome = await createWorkflow({ github: gh.github, createReviewer, log: log() }, options).review()
    expect(outcome.status).toBe('up-to-date')
    expect(createReviewer).not.toHaveBeenCalled()
    expect(gh.reviews).toEqual([])
    expect(gh.checks).toHaveLength(1)
  })

  it('later round: diff-only range, auto-resolves fixed threads', async () => {
    const gh = fakeGitHub({ bodies: [encodeState({ round: 1, sha: 'h1', fingerprints: [] })], threads: [important('t1', 'src/a.ts')] })
    const outcome = await createWorkflow({ github: gh.github, createReviewer: async () => fakeReviewer([], { recheck: vi.fn(async () => false) }), log: log() }, options).review()
    expect(gh.compared).toEqual(['h1...h2', 'b0...h2'])
    expect(gh.threads[0]?.isResolved).toBe(true)
    expect(gh.reviews[0]?.body).toContain('1 earlier finding resolved')
    expect(outcome).toMatchObject({ status: 'reviewed', round: 2, resolved: 1 })
    expect(gh.checks.at(-1)?.conclusion).toBe('success')
  })

  it('does not recheck resolved threads or threads in untouched files', async () => {
    const gh = fakeGitHub({
      bodies: [encodeState({ round: 1, sha: 'h1', fingerprints: [] })],
      threads: [important('t1', 'other.ts'), important('t2', 'src/a.ts', true)],
    })
    const reviewer = fakeReviewer([], { recheck: vi.fn(async () => false) })
    await createWorkflow({ github: gh.github, createReviewer: async () => reviewer, log: log() }, options).review()
    expect(reviewer.recheck).not.toHaveBeenCalled()
  })

  it('needs a verifier quorum to auto-resolve, and treats recheck errors as "still present"', async () => {
    const gh = fakeGitHub({ bodies: [encodeState({ round: 1, sha: 'h1', fingerprints: [] })], threads: [important('t1', 'src/a.ts')] })
    const recheck = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('boom')).mockResolvedValue(true)
    const l = log()
    await createWorkflow({ github: gh.github, createReviewer: async () => fakeReviewer([], { recheck }), log: l }, { ...options, voters: 3, votesNeeded: 2 }).review()
    expect(recheck).toHaveBeenCalledTimes(3)
    expect(gh.threads[0]?.isResolved).toBe(false)
    expect(l.warning).toHaveBeenCalledWith('recheck src/a.ts: boom')
  })

  it('does not repost already-posted findings', async () => {
    const f = finding()
    const gh = fakeGitHub({ bodies: [encodeState({ round: 1, sha: 'h1', fingerprints: [fingerprint(f)] })] })
    const outcome = await createWorkflow({ github: gh.github, createReviewer: async () => fakeReviewer([f]), log: log() }, options).review()
    expect(outcome).toMatchObject({ status: 'reviewed', findings: [] })
  })

  it('posts the step-back note once when the round cap is exceeded, then goes quiet', async () => {
    const first = fakeGitHub({ bodies: [encodeState({ round: 3, sha: 'h1', fingerprints: [] })] })
    const createReviewer = vi.fn()
    expect(await createWorkflow({ github: first.github, createReviewer, log: log() }, options).review()).toMatchObject({ status: 'paused', round: 4 })
    expect(first.reviews[0]?.body).toContain('Review paused after 3 review rounds')
    expect(decodeState([first.reviews[0]?.body ?? ''])).toMatchObject({ round: 4, sha: 'h2' })

    const second = fakeGitHub({ bodies: [encodeState({ round: 4, sha: 'h1', fingerprints: [] })] })
    expect((await createWorkflow({ github: second.github, createReviewer, log: log() }, options).review()).status).toBe('paused')
    expect(second.reviews).toEqual([])
    expect(second.checks).toHaveLength(1)
    expect(createReviewer).not.toHaveBeenCalled()
  })

  it('falls back to the full PR diff after a force push', async () => {
    const gh = fakeGitHub({ bodies: [encodeState({ round: 1, sha: 'gone', fingerprints: [] })], ancestor: false })
    const l = log()
    await createWorkflow({ github: gh.github, createReviewer: async () => fakeReviewer([]), log: l }, options).review()
    expect(gh.compared).toEqual(['b0...h2'])
    expect(l.info).toHaveBeenCalledWith(expect.stringMatching(/force push/))
  })

  it('only comments inline on lines that are in the full PR diff', async () => {
    const incremental = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -5,1 +5,2 @@\n ctx\n+z()\n`
    const gh = fakeGitHub({ bodies: [encodeState({ round: 1, sha: 'h1', fingerprints: [] })], diffs: { h1: incremental } })
    await createWorkflow({ github: gh.github, createReviewer: async () => fakeReviewer([finding({ line: 5, endLine: 5 })]), log: log() }, options).review()
    expect(gh.reviews[0]?.comments).toEqual([])
    expect(gh.reviews[0]?.body).toContain('`src/a.ts:5`')
  })

  it('retries without inline comments when GitHub rejects a line (422)', async () => {
    const gh = fakeGitHub({ reviewError: (n) => (n > 0 ? Object.assign(new Error('Line could not be resolved'), { status: 422 }) : undefined) })
    const l = log()
    await createWorkflow({ github: gh.github, createReviewer: async () => fakeReviewer([finding()]), log: l }, options).review()
    expect(gh.reviews).toHaveLength(1)
    expect(gh.reviews[0]?.body).toContain('`src/a.ts:2`')
    expect(l.warning).toHaveBeenCalledWith(expect.stringMatching(/rejected inline/))
  })

  it('rethrows non-422 review errors, and 422s when there was nothing inline', async () => {
    const boom = fakeGitHub({ reviewError: () => Object.assign(new Error('boom'), { status: 500 }) })
    await expect(createWorkflow({ github: boom.github, createReviewer: async () => fakeReviewer([finding()]), log: log() }, options).review()).rejects.toThrow('boom')
    const noInline = fakeGitHub({ reviewError: () => Object.assign(new Error('bad'), { status: 422 }) })
    await expect(createWorkflow({ github: noInline.github, createReviewer: async () => fakeReviewer([]), log: log() }, options).review()).rejects.toThrow('bad')
  })

  it('applies REVIEW.md skip_paths from the base ref', async () => {
    const gh = fakeGitHub({ files: { 'REVIEW.md': '---\nskip_paths: ["src/**"]\n---\n' } })
    const createReviewer = vi.fn()
    expect(await createWorkflow({ github: gh.github, createReviewer, log: log() }, options).review()).toEqual({ status: 'skipped', message: 'No reviewable changes.' })
    expect(createReviewer).not.toHaveBeenCalled()
  })

  it('uses REVIEW.md nit_cap unless the option overrides it', async () => {
    const nits = [finding({ severity: 'nit', bugClass: 'n1' }), finding({ severity: 'nit', line: 3, endLine: 3, bugClass: 'n2' })]
    const fromMd = fakeGitHub({ files: { 'REVIEW.md': '---\nnit_cap: 1\n---\n' } })
    expect(await createWorkflow({ github: fromMd.github, createReviewer: async () => fakeReviewer(nits), log: log() }, options).review()).toMatchObject({ findings: [{ bugClass: 'n1' }] })
    const overridden = fakeGitHub({ files: { 'REVIEW.md': '---\nnit_cap: 1\n---\n' } })
    const out = await createWorkflow({ github: overridden.github, createReviewer: async () => fakeReviewer(nits), log: log() }, { ...options, nitCap: 0 }).review()
    expect(out).toMatchObject({ findings: [] })
  })

  it('posts a notice and advances state when the diff is too large', async () => {
    const gh = fakeGitHub()
    const createReviewer = vi.fn()
    const outcome = await createWorkflow({ github: gh.github, createReviewer, log: log() }, { ...options, maxDiffLines: 1 }).review()
    expect(outcome).toMatchObject({ status: 'skipped', message: expect.stringMatching(/too large/) })
    expect(decodeState([gh.reviews[0]?.body ?? ''])).toMatchObject({ round: 1, sha: 'h2' })
    expect(createReviewer).not.toHaveBeenCalled()
  })

  it('logs agent errors as warnings', async () => {
    const gh = fakeGitHub()
    const l = log()
    const reviewer = fakeReviewer([finding()], { verify: vi.fn().mockRejectedValue(new Error('timeout')) })
    await createWorkflow({ github: gh.github, createReviewer: async () => reviewer, log: l }, options).review()
    expect(l.warning).toHaveBeenCalledWith('voter: timeout')
  })

  it('rejects when the reviewer factory rejects', async () => {
    const gh = fakeGitHub()
    await expect(createWorkflow({ github: gh.github, createReviewer: () => Promise.reject(new Error('no key')), log: log() }, options).review()).rejects.toThrow('no key')
  })

  it('skips draft PRs but still reports the check', async () => {
    const gh = fakeGitHub({ draft: true })
    const createReviewer = vi.fn()
    expect((await createWorkflow({ github: gh.github, createReviewer, log: log() }, options).review()).status).toBe('skipped')
    expect(createReviewer).not.toHaveBeenCalled()
    expect(gh.checks).toHaveLength(1)
  })

  it('skips fork PRs entirely unless allowFork', async () => {
    const skippedFork = fakeGitHub({ fork: true })
    const createReviewer = vi.fn()
    expect((await createWorkflow({ github: skippedFork.github, createReviewer, log: log() }, options).review()).status).toBe('skipped')
    expect(skippedFork.checks).toEqual([])

    const dispatched = fakeGitHub({ fork: true })
    await createWorkflow({ github: dispatched.github, createReviewer: async () => fakeReviewer([]), log: log() }, options).review({ allowFork: true })
    expect(dispatched.reviews).toHaveLength(1)
  })
})

describe('createWorkflow().gate', () => {
  it('passes when no important thread is open', async () => {
    const gh = fakeGitHub({ threads: [important('t', 'a', true)] })
    const createReviewer = vi.fn()
    expect(await createWorkflow({ github: gh.github, createReviewer, log: log() }).gate()).toEqual({ conclusion: 'success', openImportant: 0 })
    expect(createReviewer).not.toHaveBeenCalled()
    expect(gh.checks).toEqual([expect.objectContaining({ conclusion: 'success', title: 'No open important findings' })])
  })

  it('fails while important threads are open', async () => {
    const gh = fakeGitHub({ threads: [important('t1', 'a'), important('t2', 'b')] })
    expect(await createWorkflow({ github: gh.github, createReviewer: vi.fn(), log: log() }).gate()).toEqual({ conclusion: 'failure', openImportant: 2 })
    expect(gh.checks[0]?.title).toBe('2 open important findings')
  })
})
