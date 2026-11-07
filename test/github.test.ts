import { describe, expect, it } from 'vitest'
import { createGitHubClient, type GitHubApi, type GitHubClientConfig } from '../src/github.js'

type Call = { kind: 'request' | 'graphql'; route: string; params: Readonly<Record<string, unknown>> }
type Handler = (route: string, params: Readonly<Record<string, unknown>>) => unknown

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status })

/** Fake API: `handler` returns the response data (or throws); every call is recorded. */
function fakeApi(handler: Handler) {
  const calls: Call[] = []
  const api: GitHubApi = {
    request: async (route, params = {}) => {
      calls.push({ kind: 'request', route, params })
      return { data: handler(route, params) }
    },
    graphql: async (query, variables = {}) => {
      calls.push({ kind: 'graphql', route: query, params: variables })
      return handler(query, variables)
    },
  }
  return { api, calls }
}

const client = (handler: Handler, over: Partial<GitHubClientConfig> = {}) => {
  const { api, calls } = fakeApi(handler)
  const gh = createGitHubClient({ api, owner: 'o', repo: 'r', prNumber: 7, botLogin: 'github-actions[bot]', checkName: 'gate', secrets: [], ...over })
  return { gh, calls }
}

const pull = (over: Record<string, unknown> = {}) => ({
  number: 7,
  title: 'T',
  body: 'B',
  draft: false,
  head: { sha: 'h', repo: { full_name: 'o/r' } },
  base: { sha: 'b', repo: { full_name: 'o/r' } },
  ...over,
})

describe('getPull', () => {
  it('maps the PR', async () => {
    const { gh, calls } = client(() => pull())
    expect(await gh.getPull()).toEqual({ number: 7, headSha: 'h', baseSha: 'b', title: 'T', body: 'B', isFork: false, draft: false })
    expect(calls[0]?.params).toMatchObject({ owner: 'o', repo: 'r', pull_number: 7 })
  })

  it('defaults a null body and missing draft', async () => {
    const { draft: _, ...noDraft } = pull({ body: null })
    expect(await client(() => noDraft).gh.getPull()).toMatchObject({ body: '', draft: false })
  })

  it.each([
    [{ head: { sha: 'h', repo: { full_name: 'fork/r' } } }, true],
    [{ head: { sha: 'h', repo: null } }, true],
    [{ draft: true }, false],
  ])('detects forks %j', async (over, isFork) => {
    expect((await client(() => pull(over)).gh.getPull()).isFork).toBe(isFork)
  })

  it('rejects malformed responses and API errors', async () => {
    await expect(client(() => ({ nope: 1 })).gh.getPull()).rejects.toThrow('Unexpected GitHub response for pulls.get')
    await expect(client(() => { throw httpError(500) }).gh.getPull()).rejects.toThrow('HTTP 500')
  })
})

describe('compareDiff', () => {
  it('requests a three-dot diff and returns the text', async () => {
    const { gh, calls } = client(() => 'diff --git a b')
    expect(await gh.compareDiff('b', 'h')).toBe('diff --git a b')
    expect(calls[0]?.params).toMatchObject({ basehead: 'b...h', mediaType: { format: 'diff' } })
  })

  it('rejects a non-text response and rethrows 404', async () => {
    await expect(client(() => ({})).gh.compareDiff('b', 'h')).rejects.toThrow(/Unexpected GitHub response/)
    await expect(client(() => { throw httpError(404) }).gh.compareDiff('b', 'h')).rejects.toThrow('HTTP 404')
  })
})

describe('isAncestor', () => {
  it.each([
    ['ahead', true],
    ['identical', true],
    ['behind', false],
    ['diverged', false],
  ])('status %s → %s', async (status, expected) => {
    expect(await client(() => ({ status })).gh.isAncestor('a', 'h')).toBe(expected)
  })

  it.each([404, 422])('unknown SHA (%i) → false', async (status) => {
    expect(await client(() => { throw httpError(status) }).gh.isAncestor('a', 'h')).toBe(false)
  })

  it('rethrows other errors', async () => {
    await expect(client(() => { throw httpError(500) }).gh.isAncestor('a', 'h')).rejects.toThrow('HTTP 500')
    await expect(client(() => { throw new Error('network') }).gh.isAncestor('a', 'h')).rejects.toThrow('network')
  })
})

describe('readAtRef', () => {
  it('returns raw file text at the ref', async () => {
    const { gh, calls } = client(() => 'content')
    expect(await gh.readAtRef('b', 'REVIEW.md')).toBe('content')
    expect(calls[0]?.params).toMatchObject({ path: 'REVIEW.md', ref: 'b', mediaType: { format: 'raw' } })
  })

  it('returns undefined on 404 and rethrows other errors', async () => {
    expect(await client(() => { throw httpError(404) }).gh.readAtRef('b', 'x')).toBeUndefined()
    await expect(client(() => { throw httpError(403) }).gh.readAtRef('b', 'x')).rejects.toThrow('HTTP 403')
  })
})

describe('botReviewBodies', () => {
  const review = (login: string | null, body: string | null) => ({ user: login === null ? null : { login }, body })

  it('keeps only the bot\'s reviews (with or without [bot]) and maps null bodies to ""', async () => {
    const { gh } = client(() => [review('github-actions[bot]', 'a'), review('human', 'b'), review(null, 'c'), review('github-actions', null)])
    expect(await gh.botReviewBodies()).toEqual(['a', ''])
  })

  it('returns [] with no reviews', async () => {
    expect(await client(() => []).gh.botReviewBodies()).toEqual([])
  })

  it('paginates while pages are full', async () => {
    const full = Array.from({ length: 100 }, (_, i) => review('github-actions[bot]', `p1-${i}`))
    const { gh, calls } = client((_r, p) => (p.page === 1 ? full : [review('github-actions[bot]', 'last')]))
    const bodies = await gh.botReviewBodies()
    expect(bodies).toHaveLength(101)
    expect(bodies.at(-1)).toBe('last')
    expect(calls.map((c) => c.params.page)).toEqual([1, 2])
  })

  it('rejects malformed pages', async () => {
    await expect(client(() => [{ nope: true }]).gh.botReviewBodies()).rejects.toThrow(/pulls.listReviews/)
  })
})

describe('botThreads', () => {
  const node = (id: string, login: string | null, over: Record<string, unknown> = {}) => ({
    id,
    isResolved: false,
    path: 'a.ts',
    line: 3,
    comments: { nodes: [{ body: `body ${id}`, author: login === null ? null : { login } }] },
    ...over,
  })
  const page = (nodes: unknown[], endCursor: string | null = null) => ({
    repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes } } },
  })

  it('keeps threads whose first comment is by the bot', async () => {
    const { gh } = client(() =>
      page([node('1', 'github-actions'), node('2', 'human'), node('3', null), node('4', 'github-actions', { comments: { nodes: [] } })]),
    )
    expect(await gh.botThreads()).toEqual([{ id: '1', isResolved: false, path: 'a.ts', line: 3, body: 'body 1' }])
  })

  it('keeps outdated threads (line null)', async () => {
    expect((await client(() => page([node('1', 'github-actions', { line: null })])).gh.botThreads())[0]?.line).toBeNull()
  })

  it('paginates with the end cursor', async () => {
    const { gh, calls } = client((_q, v) => (v.after === null ? page([node('1', 'github-actions')], 'c1') : page([node('2', 'github-actions')])))
    expect((await gh.botThreads()).map((t) => t.id)).toEqual(['1', '2'])
    expect(calls.map((c) => c.params.after)).toEqual([null, 'c1'])
  })

  it('throws a clear error when the PR does not exist, and on malformed data', async () => {
    await expect(client(() => ({ repository: { pullRequest: null } })).gh.botThreads()).rejects.toThrow('Pull request #7 not found in o/r')
    await expect(client(() => ({})).gh.botThreads()).rejects.toThrow(/reviewThreads/)
  })
})

describe('createReview', () => {
  it('posts a COMMENT review with RIGHT-side inline comments', async () => {
    const { gh, calls } = client(() => ({}))
    await gh.createReview({ headSha: 'h', body: 'B', comments: [{ path: 'a.ts', line: 2, body: 'C' }] })
    expect(calls[0]).toMatchObject({
      route: 'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
      params: { pull_number: 7, commit_id: 'h', event: 'COMMENT', body: 'B', comments: [{ path: 'a.ts', line: 2, side: 'RIGHT', body: 'C' }] },
    })
  })

  it('redacts secrets (8+ chars) from the body and comments', async () => {
    const { gh, calls } = client(() => ({}), { secrets: ['sk-secret-123', 'short', ''] })
    await gh.createReview({ headSha: 'h', body: 'key sk-secret-123 short', comments: [{ path: 'a', line: 1, body: 'sk-secret-123' }] })
    expect(calls[0]?.params).toMatchObject({ body: 'key *** short', comments: [{ body: '***' }] })
  })

  it('posts with no inline comments and propagates API errors (e.g. 422)', async () => {
    const { gh, calls } = client(() => ({}))
    await gh.createReview({ headSha: 'h', body: 'B', comments: [] })
    expect(calls[0]?.params).toMatchObject({ comments: [] })
    await expect(client(() => { throw httpError(422) }).gh.createReview({ headSha: 'h', body: '', comments: [] })).rejects.toMatchObject({ status: 422 })
  })
})

describe('resolveThread', () => {
  it('runs the resolve mutation with the thread id', async () => {
    const { gh, calls } = client(() => ({}))
    await gh.resolveThread('T1')
    expect(calls[0]).toMatchObject({ kind: 'graphql', params: { id: 'T1' } })
    expect(calls[0]?.route).toContain('resolveReviewThread')
  })
})

describe('setCheck', () => {
  it('creates a completed check run with the configured name', async () => {
    const { gh, calls } = client(() => ({}))
    await gh.setCheck({ headSha: 'h', conclusion: 'failure', title: 'T', summary: 'S' })
    expect(calls[0]).toMatchObject({
      route: 'POST /repos/{owner}/{repo}/check-runs',
      params: { name: 'gate', head_sha: 'h', status: 'completed', conclusion: 'failure', output: { title: 'T', summary: 'S' } },
    })
  })
})
