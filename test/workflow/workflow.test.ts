import { describe, expect, it, vi } from 'vitest'
import { type Finding, fingerprint, type Reviewer } from '../../src/review/index.js'
import type { PullReview, RiskClassifier } from '../../src/risk/index.js'
import { type SecurityFinding, securityFingerprint, type SecurityReviewer } from '../../src/security/index.js'
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
  pullReviews?: PullReview[]
  writers?: string[]
  /** Members of every team; or an error to throw from the membership lookup. */
  team?: string[] | Error
  labelError?: unknown
  resolveError?: unknown
}

/** In-memory GitHub: reviews create threads; resolving flips them. */
function fakeGitHub(opts: FakeOpts = {}) {
  const reviews: { body: string; comments: readonly { path: string; line: number; body: string }[] }[] = []
  const threads: BotThread[] = [...(opts.threads ?? [])]
  const checks: { name: string; conclusion: string; title: string; summary: string }[] = []
  const compared: string[] = []
  const labels: string[] = []
  const github: GitHub = {
    getPull: async () => ({ number: 1, headSha: 'h2', baseSha: 'b0', title: 'Add x', body: 'desc', author: 'alice', isFork: opts.fork ?? false, draft: opts.draft ?? false }),
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
      if (opts.resolveError) throw opts.resolveError
      const i = threads.findIndex((t) => t.id === id)
      const t = threads[i]
      if (t) threads[i] = { ...t, isResolved: true }
    },
    setCheck: async (c) => {
      checks.push(c)
    },
    pullReviews: async () => opts.pullReviews ?? [],
    canApprove: async (login) => (opts.writers ?? []).includes(login),
    inTeam: async (_team, login) => {
      if (opts.team instanceof Error) throw opts.team
      return (opts.team ?? []).includes(login)
    },
    setRiskLabel: async (tier) => {
      if (opts.labelError) throw opts.labelError
      labels.push(tier)
    },
  }
  return { github, reviews, threads, checks, compared, labels }
}

const fakeReviewer = (findings: readonly Finding[], over: Partial<Reviewer & SecurityReviewer & RiskClassifier> = {}): Reviewer & SecurityReviewer & RiskClassifier => ({
  classifyRisk: vi.fn(async () => ({ tier: 'low' as const, reasons: [] })),
  find: vi.fn(async () => findings),
  verify: vi.fn(async () => ({ real: true, reason: '' })),
  recheck: vi.fn(async () => true),
  findVulnerabilities: vi.fn(async () => []),
  judgeExploit: vi.fn(async () => ({ exploitable: true, severity: 'high' as const, reason: '' })),
  ...over,
})

const vuln = (over: Partial<SecurityFinding> = {}): SecurityFinding => ({
  file: 'src/a.ts', line: 2, endLine: 2, title: 'Command injection', vulnClass: 'command-injection', source: 'req.body.cmd', sink: 'exec',
  exploitScenario: 'cmd=rm -rf /', impact: 'RCE', evidence: 'x()', severity: 'high', introduced: true, ...over,
})

// Bug-flow tests run without the security pass; it has its own describe block below.
const options: WorkflowOptions = { depth: 'quick', maxRounds: 3, maxDiffLines: 1000, maxFindings: 10, concurrency: 2, securityReview: false }
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
    expect(gh.reviews[0]?.body).toContain('| Code review (quick: 2 finders, 1 of 1 votes) | ⚠️ 1 issue (1 important) · 2 raw → 1 voted on → 1 confirmed |')
    expect(gh.reviews[0]?.body).not.toContain('| Security')

    expect(gh.compared).toEqual(['b0...h2'])
    expect(gh.reviews).toHaveLength(1)
    expect(gh.reviews[0]?.body.split('\n')[0]).toBe('**1 issue found** (1 important)')
    expect(gh.reviews[0]?.comments).toEqual([expect.objectContaining({ path: 'src/a.ts', line: 2 })])
    expect(decodeState([gh.reviews[0]?.body ?? ''])).toMatchObject({ round: 1, sha: 'h2' })
    expect(gh.checks.at(-1)?.conclusion).toBe('failure')
    expect(outcome).toMatchObject({ status: 'reviewed', round: 1, resolved: 0, stats: { confirmed: 1 } })
  })

  it('logs each stage: what is due, the range, the plan, finder progress, posting and the checks', async () => {
    const gh = fakeGitHub()
    const l = log()
    await createWorkflow({ github: gh.github, createReviewer: async () => fakeReviewer([finding()]), log: l }, options).review()
    const lines = l.info.mock.calls.map(([m]) => String(m))
    expect(lines).toEqual(
      expect.arrayContaining([
        'PR #1 "Add x" at h2: round 1, code review due',
        'Range: 1 file, +2/-0 lines, b0...h2 (whole PR)',
        'Code review plan: quick, 2 finders (general, general), 1 of 1 votes needed',
        'finder general: 1 finding',
        'Posting review: 1 inline comment, 0 in the summary only',
        'Checks: anthropic-style-code-review ❌ 1 open important finding',
      ]),
    )
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
    expect(gh.reviews[0]?.body).toContain('<code>src/a.ts#L50</code>')
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

  it('when the token cannot resolve threads: still posts, records them as fixed, and stops counting them', async () => {
    const gh = fakeGitHub({
      bodies: [encodeState({ round: 1, sha: 'h1', fingerprints: [] })],
      threads: [important('t1', 'src/a.ts')],
      resolveError: Object.assign(new Error('Resource not accessible by integration'), { status: 403 }),
    })
    const l = log()
    const outcome = await createWorkflow({ github: gh.github, createReviewer: async () => fakeReviewer([], { recheck: vi.fn(async () => false) }), log: l }, options).review()
    expect(gh.threads[0]?.isResolved).toBe(false)
    expect(l.warning).toHaveBeenCalledWith(expect.stringContaining('Resource not accessible'))
    expect(decodeState(gh.reviews.map((r) => r.body))).toMatchObject({ round: 2, fixedThreads: ['t1'] })
    expect(gh.reviews[0]?.body).toContain('1 earlier finding resolved')
    expect(gh.reviews[0]?.body).toContain('could not be marked resolved')
    expect(outcome).toMatchObject({ status: 'reviewed', resolved: 1 })
    expect(gh.checks.at(-1)?.conclusion).toBe('success')
  })

  it('gate runs ignore threads dismissed by a write-access /resolve reply with a reason from someone other than the author', async () => {
    const t = (id: string, over: Partial<BotThread>) => ({ ...important(id, 'src/a.ts'), ...over })
    const gh = fakeGitHub({
      bodies: [encodeState({ round: 1, sha: 'h2', fingerprints: [] })],
      writers: ['bob', 'alice'],
      threads: [
        t('reply', { replies: [{ login: 'bob', body: '  /RESOLVE false positive: validated upstream' }] }),
        t('no-reason', { replies: [{ login: 'bob', body: '/resolve   ' }] }),
        t('glued', { replies: [{ login: 'bob', body: '/resolved it' }] }),
        t('outsider', { replies: [{ login: 'mallory', body: '/resolve trust me' }] }),
        t('chatter', { replies: [{ login: 'bob', body: 'will /resolve later' }] }),
        t('bot', { replies: [{ login: 'bob[bot]', body: '/resolve automated' }] }),
        t('author', { replies: [{ login: 'Alice', body: '/resolve not a bug' }] }),
      ],
    })
    expect(await createWorkflow({ github: gh.github, createReviewer: vi.fn(), log: log() }, options).gate()).toMatchObject({ openImportant: 6 })
  })

  it('still counts a thread the author resolved on GitHub; one resolved by anyone else is closed', async () => {
    const gh = fakeGitHub({
      bodies: [encodeState({ round: 1, sha: 'h2', fingerprints: [] })],
      threads: [
        { ...important('by-author', 'src/a.ts', true), resolvedBy: 'alice' },
        { ...important('by-bob', 'src/a.ts', true), resolvedBy: 'bob' },
        { ...important('unknown', 'src/a.ts', true) },
      ],
    })
    expect(await createWorkflow({ github: gh.github, createReviewer: vi.fn(), log: log() }, options).gate()).toMatchObject({ openImportant: 1 })
  })

  it('records an author-resolved thread as fixed once a re-review confirms the fix', async () => {
    const gh = fakeGitHub({ bodies: [encodeState({ round: 1, sha: 'h1', fingerprints: [] })], threads: [{ ...important('t1', 'src/a.ts', true), resolvedBy: 'alice' }] })
    await createWorkflow({ github: gh.github, createReviewer: async () => fakeReviewer([], { recheck: vi.fn(async () => false) }), log: log() }, options).review()
    expect(decodeState(gh.reviews.map((r) => r.body))?.fixedThreads).toEqual(['t1'])
  })

  it('does not recheck threads someone else already dismissed', async () => {
    const gh = fakeGitHub({
      bodies: [encodeState({ round: 1, sha: 'h1', fingerprints: [] })],
      writers: ['bob'],
      threads: [{ ...important('t1', 'src/a.ts'), replies: [{ login: 'bob', body: '/resolve intentional' }] }],
    })
    const reviewer = fakeReviewer([], { recheck: vi.fn(async () => false) })
    await createWorkflow({ github: gh.github, createReviewer: async () => reviewer, log: log() }, options).review()
    expect(reviewer.recheck).not.toHaveBeenCalled()
  })

  it('gate runs ignore threads the state records as fixed', async () => {
    const gh = fakeGitHub({ bodies: [encodeState({ round: 2, sha: 'h2', fingerprints: [], fixedThreads: ['t1'] })], threads: [important('t1', 'src/a.ts'), important('t2', 'src/a.ts')] })
    expect(await createWorkflow({ github: gh.github, createReviewer: vi.fn(), log: log() }, options).gate()).toMatchObject({ openImportant: 1 })
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
    expect(gh.reviews[0]?.body).toContain('<code>src/a.ts#L5</code>')
  })

  it('leaves files merged in from the base branch out of an incremental range', async () => {
    const incremental = diffFor('src/a.ts', ['z()']) + diffFor('.github/workflows/ci.yml', ['run: x'])
    const gh = fakeGitHub({ bodies: [encodeState({ round: 1, sha: 'h1', fingerprints: [] })], diffs: { h1: incremental } })
    const reviewer = fakeReviewer([])
    const l = log()
    await createWorkflow({ github: gh.github, createReviewer: async () => reviewer, log: l }, options).review()
    const reviewed = vi.mocked(reviewer.find).mock.calls[0]?.[1].diff ?? ''
    expect(reviewed).toContain('src/a.ts')
    expect(reviewed).not.toContain('ci.yml')
    expect(l.info).toHaveBeenCalledWith("Ignoring 1 file the PR doesn't change (merged in from the base branch)")
  })

  it('keeps every file of a full-PR (non-incremental) range', async () => {
    const gh = fakeGitHub({ diffs: { b0: diffFor('src/a.ts', ['x()']) + diffFor('src/b.ts', ['y()']) } })
    const reviewer = fakeReviewer([])
    await createWorkflow({ github: gh.github, createReviewer: async () => reviewer, log: log() }, options).review()
    const reviewed = vi.mocked(reviewer.find).mock.calls[0]?.[1].diff ?? ''
    expect(reviewed).toContain('src/b.ts')
  })

  it('retries without inline comments when GitHub rejects a line (422)', async () => {
    const gh = fakeGitHub({ reviewError: (n) => (n > 0 ? Object.assign(new Error('Line could not be resolved'), { status: 422 }) : undefined) })
    const l = log()
    await createWorkflow({ github: gh.github, createReviewer: async () => fakeReviewer([finding()]), log: l }, options).review()
    expect(gh.reviews).toHaveLength(1)
    expect(gh.reviews[0]?.body).toContain('<code>src/a.ts#L2</code>')
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
  it('passes when nothing is open and HEAD is security-reviewed', async () => {
    const gh = fakeGitHub({ threads: [important('t', 'a', true)], bodies: [encodeState({ round: 1, sha: 'h2', fingerprints: [], securitySha: 'h2' })] })
    const createReviewer = vi.fn()
    expect(await createWorkflow({ github: gh.github, createReviewer, log: log() }).gate()).toEqual({
      conclusion: 'success',
      openImportant: 0,
      security: { conclusion: 'success', openBlocking: 0, reviewed: true },
    })
    expect(createReviewer).not.toHaveBeenCalled()
    expect(gh.checks).toEqual([
      expect.objectContaining({ name: 'anthropic-style-code-review', conclusion: 'success', title: 'No open important findings' }),
      expect.objectContaining({ name: 'anthropic-style-code-review/security', conclusion: 'success' }),
    ])
  })

  it('fails while important threads are open', async () => {
    const gh = fakeGitHub({ threads: [important('t1', 'a'), important('t2', 'b')] })
    expect(await createWorkflow({ github: gh.github, createReviewer: vi.fn(), log: log() }).gate()).toEqual({
      conclusion: 'failure',
      openImportant: 2,
      security: { conclusion: 'failure', openBlocking: 0, reviewed: false },
    })
    expect(gh.checks[0]?.title).toBe('2 open important findings')
    expect(gh.checks[1]).toMatchObject({ conclusion: 'failure', title: 'Latest commits not security-reviewed' })
  })
})

describe('security pass', () => {
  const sec: WorkflowOptions = { ...options, securityReview: true }
  const run = async (gh: ReturnType<typeof fakeGitHub>, reviewer: Reviewer & SecurityReviewer & RiskClassifier, opts: WorkflowOptions = sec) =>
    createWorkflow({ github: gh.github, createReviewer: async () => reviewer, log: log() }, opts).review()

  it('posts vulnerabilities inline, counts them in the summary, and fails only the security gate', async () => {
    const gh = fakeGitHub()
    const outcome = await run(gh, fakeReviewer([], { findVulnerabilities: vi.fn(async () => [vuln()]) }))
    expect(gh.reviews[0]?.body.split('\n')[0]).toBe('**1 security finding** (1 high)')
    expect(gh.reviews[0]?.comments).toEqual([expect.objectContaining({ path: 'src/a.ts', line: 2, body: expect.stringContaining('### Security · High: ') })])
    expect(gh.checks).toEqual([
      expect.objectContaining({ name: 'anthropic-style-code-review', conclusion: 'success' }),
      expect.objectContaining({ name: 'anthropic-style-code-review/security', conclusion: 'failure', title: '1 open high/medium security finding' }),
    ])
    expect(outcome).toMatchObject({ status: 'reviewed', security: { depth: 'quick', findings: [{ vulnClass: 'command-injection' }] } })
    expect(outcome.message).toContain('security 1 confirmed (quick)')
  })

  it('does not block on low or pre-existing vulnerabilities', async () => {
    const gh = fakeGitHub()
    const judgeExploit = vi.fn(async (f: SecurityFinding) => ({ exploitable: true, severity: f.severity, reason: '' }))
    // Line 1 is a context line, so the diff doesn't force the pre-existing finding to "introduced".
    const findVulnerabilities = vi.fn(async () => [vuln({ severity: 'low' }), vuln({ line: 1, endLine: 1, vulnClass: 'xss', introduced: false })])
    await run(gh, fakeReviewer([], { findVulnerabilities, judgeExploit }))
    expect(gh.checks.find((c) => c.name.endsWith('/security'))?.conclusion).toBe('success')
  })

  it('uses the quick plan for ordinary diffs and the full plan for risky paths or deep depth', async () => {
    const quick = fakeReviewer([])
    await run(fakeGitHub(), quick)
    expect(vi.mocked(quick.findVulnerabilities).mock.calls.map((c) => c[0])).toEqual(['security-general', 'security-general'])

    const risky = fakeReviewer([])
    await run(fakeGitHub({ diffs: { b0: diffFor('src/auth/login.ts', ['x()']) } }), risky)
    expect(vi.mocked(risky.findVulnerabilities).mock.calls.map((c) => c[0])).toEqual(['injection', 'authz', 'secrets-crypto', 'exposure-execution'])

    const deep = fakeReviewer([])
    await run(fakeGitHub(), deep, { ...sec, depth: 'deep' })
    expect(deep.findVulnerabilities).toHaveBeenCalledTimes(4)
  })

  it('applies REVIEW.md security_paths and security_exclude_paths', async () => {
    const escalated = fakeReviewer([])
    await run(fakeGitHub({ files: { 'REVIEW.md': '---\nsecurity_paths: ["src/a.ts"]\n---\n' } }), escalated)
    expect(escalated.findVulnerabilities).toHaveBeenCalledTimes(4)

    const gh = fakeGitHub({ files: { 'REVIEW.md': '---\nsecurity_exclude_paths: ["src/**"]\n---\n' } })
    const excluded = fakeReviewer([], { findVulnerabilities: vi.fn(async () => [vuln()]) })
    await run(gh, excluded)
    expect(excluded.judgeExploit).not.toHaveBeenCalled()
  })

  it('saves security fingerprints and never reposts them', async () => {
    const gh = fakeGitHub()
    await run(gh, fakeReviewer([], { findVulnerabilities: vi.fn(async () => [vuln()]) }))
    expect(decodeState([gh.reviews[0]?.body ?? ''])?.fingerprints).toContain(securityFingerprint(vuln()))

    const again = fakeGitHub({ bodies: [encodeState({ round: 1, sha: 'h1', fingerprints: [securityFingerprint(vuln())] })] })
    const reviewer = fakeReviewer([], { findVulnerabilities: vi.fn(async () => [vuln()]) })
    await run(again, reviewer)
    expect(reviewer.judgeExploit).not.toHaveBeenCalled()
  })

  it('anchors blocking findings outside the diff to the nearest changed line; non-blocking ones stay in the summary', async () => {
    const gh = fakeGitHub()
    const judgeExploit = vi.fn(async (f: SecurityFinding) => ({ exploitable: true, severity: f.severity, reason: '' }))
    const findVulnerabilities = vi.fn(async () => [vuln({ line: 40, endLine: 40 }), vuln({ line: 50, endLine: 50, vulnClass: 'info-leak', severity: 'low' })])
    await run(gh, fakeReviewer([], { findVulnerabilities, judgeExploit }))
    expect(gh.reviews[0]?.comments).toEqual([expect.objectContaining({ line: 3, body: expect.stringContaining('Reported at line 40') })])
    expect(gh.reviews[0]?.body).toContain('<summary><h3>Security · Low: ')
    expect(gh.checks.find((c) => c.name.endsWith('/security'))?.conclusion).toBe('failure')
  })

  it('posts bug and security findings together, and logs security agent errors', async () => {
    const gh = fakeGitHub()
    const l = log()
    const reviewer = fakeReviewer([finding({ line: 3, endLine: 3 })], {
      findVulnerabilities: vi.fn(async () => [vuln()]),
      judgeExploit: vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({ exploitable: true, severity: 'high', reason: '' }),
    })
    await createWorkflow({ github: gh.github, createReviewer: async () => reviewer, log: l }, sec).review()
    expect(gh.reviews[0]?.body.split('\n')[0]).toBe('**1 issue found** (1 important) · **1 security finding** (1 high)')
    expect(gh.reviews[0]?.comments).toHaveLength(2)
    expect(l.warning).toHaveBeenCalledWith('security voter: timeout')
  })

  it('still posts the bug review when the security pass fails, and keeps the security gate red for a retry', async () => {
    const gh = fakeGitHub()
    const reviewer = fakeReviewer([finding()], { findVulnerabilities: vi.fn().mockRejectedValue(new Error('down')) })
    const outcome = await run(gh, reviewer)
    expect(outcome).toMatchObject({ status: 'reviewed', findings: [{ bugClass: 'boom' }], security: undefined })
    expect(gh.reviews[0]?.body).toContain('Security review did not complete')
    const state = decodeState([gh.reviews[0]?.body ?? ''])
    expect(state).toMatchObject({ sha: 'h2' })
    expect(state?.securitySha).toBeUndefined()
    expect(gh.checks.find((c) => c.name.endsWith('/security'))).toMatchObject({ conclusion: 'failure', title: 'Latest commits not security-reviewed' })
  })

  it('retries only the security pass when HEAD is bug-reviewed but not security-reviewed', async () => {
    const gh = fakeGitHub({ bodies: [encodeState({ round: 2, sha: 'h2', fingerprints: [] })] })
    const reviewer = fakeReviewer([finding()])
    const outcome = await run(gh, reviewer)
    expect(reviewer.find).not.toHaveBeenCalled()
    expect(reviewer.findVulnerabilities).toHaveBeenCalled()
    expect(decodeState([gh.reviews[0]?.body ?? ''])).toMatchObject({ round: 2, sha: 'h2', securitySha: 'h2' })
    expect(outcome).toMatchObject({ status: 'reviewed', round: 2 })
    expect(gh.checks.find((c) => c.name.endsWith('/security'))?.conclusion).toBe('success')
  })

  it('is up-to-date only when both passes have covered HEAD', async () => {
    const gh = fakeGitHub({ bodies: [encodeState({ round: 1, sha: 'h2', fingerprints: [], securitySha: 'h2' })] })
    const createReviewer = vi.fn()
    const outcome = await createWorkflow({ github: gh.github, createReviewer, log: log() }, sec).review()
    expect(outcome.status).toBe('up-to-date')
    expect(createReviewer).not.toHaveBeenCalled()
  })

  it('reviews security incrementally from securitySha, independently of the bug range', async () => {
    const gh = fakeGitHub({ bodies: [encodeState({ round: 1, sha: 'h1', fingerprints: [], securitySha: 's1' })] })
    await run(gh, fakeReviewer([]))
    expect([...gh.compared].sort()).toEqual(['b0...h2', 'h1...h2', 's1...h2'])
  })

  it('reviews the full PR for security when the saved state predates securitySha', async () => {
    const gh = fakeGitHub({ bodies: [encodeState({ round: 1, sha: 'h1', fingerprints: [] })] })
    await run(gh, fakeReviewer([]))
    expect(gh.compared).toEqual(['h1...h2', 'b0...h2'])
  })

  it('does not mark security complete when votes are left undecided', async () => {
    const gh = fakeGitHub()
    const reviewer = fakeReviewer([], {
      findVulnerabilities: vi.fn(async () => [vuln()]),
      judgeExploit: vi.fn().mockRejectedValueOnce(new Error('429')).mockRejectedValueOnce(new Error('429')).mockResolvedValue({ exploitable: true, severity: 'high', reason: '' }),
    })
    await run(gh, reviewer)
    expect(decodeState([gh.reviews[0]?.body ?? ''])?.securitySha).toBeUndefined()
    expect(gh.reviews[0]?.body).toContain('undecided')
  })

  it('fails the security gate closed on oversized diffs and at the round cap', async () => {
    const big = fakeGitHub()
    await run(big, fakeReviewer([]), { ...sec, maxDiffLines: 1 })
    expect(decodeState([big.reviews[0]?.body ?? ''])).toMatchObject({ sha: 'h2' })
    expect(big.checks.find((c) => c.name.endsWith('/security'))?.title).toBe('Latest commits not security-reviewed')

    const capped = fakeGitHub({ bodies: [encodeState({ round: 3, sha: 'h1', fingerprints: [], securitySha: 'h1' })] })
    expect((await run(capped, fakeReviewer([]))).status).toBe('paused')
    expect(capped.checks.find((c) => c.name.endsWith('/security'))?.conclusion).toBe('failure')
  })

  it('records security as complete without agents when everything matches skip_paths', async () => {
    const gh = fakeGitHub({ files: { 'REVIEW.md': '---\nskip_paths: ["src/**"]\n---\n' } })
    const createReviewer = vi.fn()
    const outcome = await createWorkflow({ github: gh.github, createReviewer, log: log() }, sec).review()
    expect(createReviewer).not.toHaveBeenCalled()
    expect(outcome.message).toBe('No reviewable changes.')
    expect(decodeState([gh.reviews[0]?.body ?? ''])).toMatchObject({ sha: 'h2', securitySha: 'h2' })
    expect(gh.checks.find((c) => c.name.endsWith('/security'))?.conclusion).toBe('success')
  })

  it('after a 422, reposts blocking security findings one per review so they still get a thread', async () => {
    let calls = 0
    const gh = fakeGitHub({ reviewError: (n) => (n > 0 && calls++ === 0 ? Object.assign(new Error('bad line'), { status: 422 }) : undefined) })
    await run(gh, fakeReviewer([], { findVulnerabilities: vi.fn(async () => [vuln()]) }))
    expect(gh.reviews).toHaveLength(2)
    expect(gh.reviews[1]?.comments).toEqual([expect.objectContaining({ path: 'src/a.ts', line: 2 })])
    expect(gh.threads).toHaveLength(1)
  })

  it('skips the pass and its gate when securityReview is off', async () => {
    const gh = fakeGitHub()
    const reviewer = fakeReviewer([])
    const outcome = await run(gh, reviewer, { ...sec, securityReview: false })
    expect(reviewer.findVulnerabilities).not.toHaveBeenCalled()
    expect(gh.checks.map((c) => c.name)).toEqual(['anthropic-style-code-review'])
    expect(outcome).toMatchObject({ security: undefined })
  })

  it('adds a security row to the summary table: findings, clean, or did not complete', async () => {
    const found = fakeGitHub()
    await run(found, fakeReviewer([], { findVulnerabilities: vi.fn(async () => [vuln()]) }))
    expect(found.reviews[0]?.body).toContain('| Security (quick: 2 finders) | 🔴 1 finding (1 blocking) |')
    const clean = fakeGitHub()
    await run(clean, fakeReviewer([]))
    expect(clean.reviews[0]?.body).toContain('| Security (quick: 2 finders) | ✅ No findings |')
    const failed = fakeGitHub()
    await run(failed, fakeReviewer([], { findVulnerabilities: vi.fn(async () => { throw new Error('down') }) }))
    expect(failed.reviews[0]?.body).toContain('| Security | ⚠️ Did not complete; retries on the next run |')
  })

  it('uses a custom check name for both gates', async () => {
    const gh = fakeGitHub()
    await run(gh, fakeReviewer([]), { ...sec, checkName: 'review' })
    expect(gh.checks.map((c) => c.name)).toEqual(['review', 'review/security'])
  })
})

describe('risk tiers', () => {
  const risky: WorkflowOptions = { ...options, riskTiers: true }
  const approvals = (gh: ReturnType<typeof fakeGitHub>) => gh.checks.filter((c) => c.name === 'anthropic-style-code-review/approvals')
  const approve = (login: string, commitId = 'h2'): PullReview => ({ login, isBot: false, state: 'APPROVED', commitId })
  const run = (gh: ReturnType<typeof fakeGitHub>, reviewer = fakeReviewer([]), opts = risky) =>
    createWorkflow({ github: gh.github, createReviewer: async () => reviewer, log: log() }, opts).review()

  it('is off by default: no classifier call, no approvals check, no label', async () => {
    const gh = fakeGitHub()
    const reviewer = fakeReviewer([])
    await run(gh, reviewer, options)
    expect(reviewer.classifyRisk).not.toHaveBeenCalled()
    expect(approvals(gh)).toEqual([])
    expect(gh.labels).toEqual([])
  })

  it('publishes a failing medium check before reviewing, then stores the tier, labels and rechecks', async () => {
    const gh = fakeGitHub()
    const reviewer = fakeReviewer([])
    const outcome = await run(gh, reviewer)
    expect(approvals(gh).map((c) => [c.conclusion, c.title])).toEqual([
      ['failure', 'Risk medium: 0 of 1 approvals'],
      ['failure', 'Risk medium: 0 of 1 approvals'],
    ])
    expect(approvals(gh)[0]?.summary).toContain('not assessed yet')
    expect(reviewer.classifyRisk).toHaveBeenCalledWith(expect.objectContaining({ intent: 'Add x\n\ndesc', floor: { tier: 'medium', reasons: ['changes source: src/a.ts'] } }))
    expect(decodeState([gh.reviews[0]?.body ?? ''])).toMatchObject({ tier: 'medium', tierReasons: ['changes source: src/a.ts'] })
    expect(gh.reviews[0]?.body).toContain('| Risk | 🟡 Medium: 1 approval needed (changes source: src/a.ts) |')
    expect(gh.labels).toEqual(['medium'])
    expect(outcome).toMatchObject({ risk: { tier: 'medium' } })
  })

  it('lets the classifier raise the tier, with its reasons in the check', async () => {
    const gh = fakeGitHub()
    await run(gh, fakeReviewer([], { classifyRisk: vi.fn(async () => ({ tier: 'high' as const, reasons: ['billing math'] })) }))
    expect(approvals(gh).at(-1)).toMatchObject({ title: 'Risk high: 0 of 2 approvals' })
    expect(approvals(gh).at(-1)?.summary).toContain('classifier: billing math')
    expect(gh.labels).toEqual(['high'])
  })

  it('never lowers a stored tier', async () => {
    const gh = fakeGitHub({ bodies: [encodeState({ round: 1, sha: 'h1', fingerprints: [], tier: 'high', tierReasons: ['auth'] })] })
    await run(gh)
    expect(decodeState(gh.reviews.map((r) => r.body))).toMatchObject({ tier: 'high', tierReasons: ['auth'] })
  })

  it('raises the tier for a blocking security finding', async () => {
    const gh = fakeGitHub()
    await run(gh, fakeReviewer([], { findVulnerabilities: vi.fn(async () => [vuln()]) }), { ...risky, securityReview: true })
    expect(decodeState(gh.reviews.map((r) => r.body))?.tier).toBe('high')
  })

  it('counts approvals on HEAD from users with write access, excluding the author', async () => {
    const gh = fakeGitHub({ pullReviews: [approve('bob'), approve('carol'), approve('dave', 'h1'), approve('alice'), approve('eve')], writers: ['bob', 'dave', 'alice'] })
    await run(gh)
    expect(approvals(gh).at(-1)).toMatchObject({ conclusion: 'success', title: 'Risk medium: 1 of 1 approvals' })
    expect(approvals(gh).at(-1)?.summary).toContain('Approved by: @bob')
  })

  it('honors REVIEW.md risk_approvals and risk_high_paths', async () => {
    const files = { 'REVIEW.md': '---\nrisk_approvals: { medium: 0 }\n---\n' }
    const zero = fakeGitHub({ files })
    await run(zero)
    expect(approvals(zero).at(-1)).toMatchObject({ conclusion: 'success', title: 'Risk medium: 0 of 0 approvals' })

    const forced = fakeGitHub({ files: { 'REVIEW.md': '---\nrisk_high_paths: ["src/**"]\n---\n' } })
    await run(forced)
    expect(approvals(forced).at(-1)?.title).toBe('Risk high: 0 of 2 approvals')
  })

  it('needs at least one approval when the author is not in risk_trusted_team, even at low', async () => {
    const files = { 'REVIEW.md': '---\nrisk_trusted_team: codeowners\nrisk_approvals: { medium: 0 }\n---\n' }
    const outsider = fakeGitHub({ files, team: ['bob'] })
    await run(outsider)
    expect(approvals(outsider).at(-1)).toMatchObject({ conclusion: 'failure', title: 'Risk medium: 0 of 1 approvals' })
    expect(approvals(outsider).at(-1)?.summary).toContain('author @alice is not in the trusted team codeowners')

    const member = fakeGitHub({ files, team: ['alice'] })
    await run(member)
    expect(approvals(member).at(-1)).toMatchObject({ conclusion: 'success', title: 'Risk medium: 0 of 0 approvals' })

    const approved = fakeGitHub({ files, team: ['bob'], pullReviews: [approve('bob')], writers: ['bob'] })
    await run(approved)
    expect(approvals(approved).at(-1)).toMatchObject({ conclusion: 'success', title: 'Risk medium: 1 of 1 approvals' })
  })

  it('treats a failed team lookup as untrusted and never lowers a higher tier requirement', async () => {
    const lookupFails = fakeGitHub({ files: { 'REVIEW.md': '---\nrisk_trusted_team: codeowners\nrisk_approvals: { medium: 0 }\n---\n' }, team: new Error('Resource not accessible') })
    await run(lookupFails)
    expect(approvals(lookupFails).at(-1)?.title).toBe('Risk medium: 0 of 1 approvals')
    expect(approvals(lookupFails).at(-1)?.summary).toContain('could not check whether @alice is in the trusted team codeowners (Resource not accessible)')

    const high = fakeGitHub({ files: { 'REVIEW.md': '---\nrisk_trusted_team: codeowners\nrisk_high_paths: ["src/**"]\n---\n' }, team: [] })
    await run(high)
    expect(approvals(high).at(-1)?.title).toBe('Risk high: 0 of 2 approvals')
  })

  it('marks oversized and paused rounds medium without calling the classifier', async () => {
    const big = fakeGitHub()
    const reviewer = fakeReviewer([])
    await run(big, reviewer, { ...risky, maxDiffLines: 1 })
    expect(decodeState(big.reviews.map((r) => r.body))?.tier).toBe('medium')
    expect(reviewer.classifyRisk).not.toHaveBeenCalled()

    const capped = fakeGitHub({ bodies: [encodeState({ round: 3, sha: 'h1', fingerprints: [], tier: 'low', tierReasons: [] })] })
    await run(capped)
    expect(decodeState(capped.reviews.map((r) => r.body))?.tier).toBe('medium')
  })

  it('assesses rule-only when nothing is reviewable after skip_paths', async () => {
    const gh = fakeGitHub({ files: { 'REVIEW.md': '---\nskip_paths: ["src/**"]\n---\n' } })
    const createReviewer = vi.fn()
    await createWorkflow({ github: gh.github, createReviewer, log: log() }, { ...risky, securityReview: true }).review()
    expect(createReviewer).not.toHaveBeenCalled()
    expect(decodeState(gh.reviews.map((r) => r.body))?.tier).toBe('medium')
  })

  it('warns but does not fail when labeling is not permitted', async () => {
    const gh = fakeGitHub({ labelError: Object.assign(new Error('Resource not accessible'), { status: 403 }) })
    const l = log()
    await createWorkflow({ github: gh.github, createReviewer: async () => fakeReviewer([]), log: l }, risky).review()
    expect(l.warning).toHaveBeenCalledWith(expect.stringContaining('risk label'))
  })

  it('gate runs recount approvals from the stored tier without any reviewer', async () => {
    const gh = fakeGitHub({ bodies: [encodeState({ round: 1, sha: 'h2', fingerprints: [], tier: 'high', tierReasons: ['auth'] })], pullReviews: [approve('bob'), approve('carol')], writers: ['bob', 'carol'] })
    const createReviewer = vi.fn()
    const gate = await createWorkflow({ github: gh.github, createReviewer, log: log() }, risky).gate()
    expect(createReviewer).not.toHaveBeenCalled()
    expect(gate.approvals).toEqual({ conclusion: 'success', tier: 'high', required: 2, approved: ['bob', 'carol'], assessed: true })
    expect(gh.labels).toEqual([])
  })

  it('gate runs treat a PR without a stored tier as medium', async () => {
    const gh = fakeGitHub()
    const gate = await createWorkflow({ github: gh.github, createReviewer: vi.fn(), log: log() }, risky).gate()
    expect(gate.approvals).toMatchObject({ conclusion: 'failure', tier: 'medium', required: 1, assessed: false })
  })

  it('does not trust a stored low tier on a head no round has assessed yet', async () => {
    const stale = [encodeState({ round: 1, sha: 'h1', fingerprints: [], tier: 'low', tierReasons: ['docs and tests only'] })]
    const gh = fakeGitHub({ bodies: stale })
    await createWorkflow({ github: gh.github, createReviewer: async () => { throw new Error('bad key') }, log: log() }, risky).review().catch(() => undefined)
    expect(approvals(gh)).toEqual([expect.objectContaining({ conclusion: 'failure', title: 'Risk medium: 0 of 1 approvals' })])
    expect(approvals(gh)[0]?.summary).toContain('not assessed yet')

    const gate = await createWorkflow({ github: fakeGitHub({ bodies: stale }).github, createReviewer: vi.fn(), log: log() }, risky).gate()
    expect(gate.approvals).toMatchObject({ tier: 'medium', required: 1, assessed: false })
  })

  it('keeps a stored high tier on an unassessed head', async () => {
    const gh = fakeGitHub({ bodies: [encodeState({ round: 1, sha: 'h1', fingerprints: [], tier: 'high', tierReasons: ['auth'] })] })
    const gate = await createWorkflow({ github: gh.github, createReviewer: vi.fn(), log: log() }, risky).gate()
    expect(gate.approvals).toMatchObject({ tier: 'high', required: 2 })
  })

  it('fails the approvals check, rather than leaving it stale, when base REVIEW.md is invalid', async () => {
    const gh = fakeGitHub({ files: { 'REVIEW.md': '---\nrisk_approvals: 3\n---\n' } })
    const gate = await createWorkflow({ github: gh.github, createReviewer: vi.fn(), log: log() }, risky).gate()
    expect(gate.approvals?.conclusion).toBe('failure')
    expect(approvals(gh).at(-1)).toMatchObject({ conclusion: 'failure', title: 'REVIEW.md is invalid' })
  })
})
