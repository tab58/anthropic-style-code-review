import { describe, expect, it, vi } from 'vitest'
import { createLimiter } from '../../src/limiter.js'
import { type DepthConfig, type Finding, fingerprint, type Reviewer, type ReviewRequest, resolveDepth, runReview } from '../../src/review/index.js'

const f = (over: Partial<Finding> = {}): Finding => ({
  file: 'a.ts',
  line: 2,
  endLine: 2,
  title: 't',
  explanation: 'e',
  evidence: 'y',
  severity: 'important',
  category: 'bug',
  bugClass: 'c1',
  ...over,
})

describe('resolveDepth', () => {
  it('defaults to standard with an empty selection', () => {
    expect(resolveDepth({})).toEqual({
      depth: 'standard',
      finders: ['logic', 'edge-cases', 'concurrency-state', 'api-contract'],
      voters: 3,
      needed: 2,
    })
  })

  it('defaults to standard with an empty input object', () => {
    expect(resolveDepth({ input: {} }).depth).toBe('standard')
  })

  it.each([
    ['quick', ['general', 'general'], 1, 1],
    ['standard', ['logic', 'edge-cases', 'concurrency-state', 'api-contract'], 3, 2],
    ['deep', ['logic', 'edge-cases', 'concurrency-state', 'api-contract', 'general', 'general'], 5, 3],
  ])('preset %s', (depth, finders, voters, needed) => {
    expect(resolveDepth({ input: { depth } })).toEqual({ depth, finders, voters, needed })
  })

  it('uses frontmatter depth when input has none', () => {
    expect(resolveDepth({ frontmatterDepth: 'quick' }).depth).toBe('quick')
  })

  it('input depth beats frontmatter depth', () => {
    expect(resolveDepth({ input: { depth: 'deep' }, frontmatterDepth: 'quick' }).depth).toBe('deep')
  })

  it('applies voters only, votesNeeded only, and both', () => {
    expect(resolveDepth({ input: { voters: 5 } })).toMatchObject({ voters: 5, needed: 2 })
    expect(resolveDepth({ input: { votesNeeded: 3 } })).toMatchObject({ voters: 3, needed: 3 })
    expect(resolveDepth({ input: { voters: 5, votesNeeded: 4 } })).toMatchObject({ voters: 5, needed: 4 })
  })

  it.each([[''], ['ultra']])('rejects unknown depth %j', (depth) => {
    expect(() => resolveDepth({ input: { depth } })).toThrow(/Unknown depth/)
    expect(() => resolveDepth({ frontmatterDepth: depth })).toThrow(/Unknown depth/)
  })

  it.each([
    [{ voters: 0 }, /voters/],
    [{ voters: 1.5 }, /voters/],
    [{ votesNeeded: 0 }, /votes_needed/],
    [{ votesNeeded: 1.5 }, /votes_needed/],
    [{ voters: 2, votesNeeded: 3 }, /votes_needed/],
    [{ voters: 1 }, /votes_needed/], // standard needs 2 > 1
  ])('rejects invalid voting config %j', (input, err) => {
    expect(() => resolveDepth({ input })).toThrow(err)
  })
})

describe('fingerprint', () => {
  it('ignores line numbers', () => {
    expect(fingerprint(f({ line: 1 }))).toBe(fingerprint(f({ line: 99 })))
  })

  it('normalizes case, spaces and underscores in the bug class', () => {
    expect(fingerprint(f({ bugClass: ' Null Deref ' }))).toBe(fingerprint(f({ bugClass: 'null-deref' })))
    expect(fingerprint(f({ bugClass: 'null_deref' }))).toBe(fingerprint(f({ bugClass: 'null-deref' })))
  })

  it('differs by file and by class, including an empty class', () => {
    expect(fingerprint(f({ file: 'a.ts' }))).not.toBe(fingerprint(f({ file: 'b.ts' })))
    expect(fingerprint(f({ bugClass: '' }))).not.toBe(fingerprint(f({ bugClass: 'x' })))
  })

  it('is 12 hex chars', () => {
    expect(fingerprint(f())).toMatch(/^[0-9a-f]{12}$/)
  })
})

describe('runReview', () => {
  const depth: DepthConfig = { depth: 'standard', finders: ['logic', 'edge-cases'], voters: 3, needed: 2 }
  const request: ReviewRequest = {
    input: { diff: 'd', guidance: '', intent: '' },
    paths: ['a.ts', 'b.ts'],
    depth,
    posted: [],
    maxFindings: 10,
    nitCap: 3,
    limit: createLimiter(2),
  }

  const reviewer = (findings: Partial<Record<string, readonly Finding[]>>, verdict: (f: Finding, i: number) => boolean): Reviewer => {
    let calls = 0
    return {
      find: vi.fn(async (focus: string) => findings[focus] ?? []),
      verify: vi.fn(async (finding: Finding) => ({ real: verdict(finding, calls++), reason: '' })),
      recheck: vi.fn(async () => true),
    }
  }

  it('reports progress: each finder, the candidate funnel, and each vote', async () => {
    const r = reviewer({ logic: [f({ bugClass: 'real' })], 'edge-cases': [f({ line: 3, endLine: 3, bugClass: 'fake', title: 'Fake\nbug' })] }, (x) => x.bugClass === 'real')
    const progress: string[] = []
    await runReview(r, { ...request, onProgress: (m) => progress.push(m) })
    expect(progress).toEqual(
      expect.arrayContaining([
        'finder logic: 1 finding',
        'finder edge-cases: 1 finding',
        '2 raw → 2 candidates for voting',
        expect.stringMatching(/^vote a\.ts:\d+ ".*": 3\/3 real → confirmed$/),
        'vote a.ts:3 "Fake\nbug": 0/3 real → dropped', // one-lined by the log sink
      ]),
    )
  })

  it('reports a failed finder in progress', async () => {
    const r: Reviewer = { find: vi.fn().mockRejectedValueOnce(new Error('429')).mockResolvedValue([]), verify: vi.fn(), recheck: vi.fn() }
    const progress: string[] = []
    await runReview(r, { ...request, onProgress: (m) => progress.push(m) })
    expect(progress).toContain('finder logic: failed (429)')
  })

  it('runs every finder and keeps findings that win the vote', async () => {
    const r = reviewer({ logic: [f({ bugClass: 'real' })], 'edge-cases': [f({ line: 3, endLine: 3, bugClass: 'fake' })] }, (x) => x.bugClass === 'real')
    const out = await runReview(r, request)
    expect(r.find).toHaveBeenCalledTimes(2)
    expect(r.verify).toHaveBeenCalledTimes(6)
    expect(out.findings.map((x) => x.bugClass)).toEqual(['real'])
    expect(out.stats).toEqual({ raw: 2, candidates: 2, confirmed: 1 })
    expect(out.errors).toEqual([])
  })

  it('needs a majority, not unanimity', async () => {
    const r = reviewer({ logic: [f()] }, (_x, i) => i !== 0)
    expect((await runReview(r, request)).findings).toHaveLength(1)
  })

  it('drops findings outside paths, with blank evidence, or not bugs, before voting', async () => {
    const r = reviewer({ logic: [f({ file: 'other.ts' }), f({ evidence: ' ', bugClass: 'b' }), f({ category: 'style', bugClass: 'c' })] }, () => true)
    const out = await runReview(r, request)
    expect(r.verify).not.toHaveBeenCalled()
    expect(out).toMatchObject({ findings: [], stats: { raw: 3, candidates: 0, confirmed: 0 } })
  })

  it('drops everything when paths is empty', async () => {
    const r = reviewer({ logic: [f()] }, () => true)
    expect((await runReview(r, { ...request, paths: [] })).findings).toEqual([])
  })

  it('never re-verifies already-posted findings', async () => {
    const r = reviewer({ logic: [f()] }, () => true)
    expect((await runReview(r, { ...request, posted: [fingerprint(f())] })).findings).toEqual([])
    expect(r.verify).not.toHaveBeenCalled()
  })

  it('still reviews a new instance of an already-posted bug class in another file', async () => {
    const r = reviewer({ logic: [f({ bugClass: 'x' }), f({ file: 'b.ts', bugClass: 'x' })] }, () => true)
    const out = await runReview(r, { ...request, posted: [fingerprint(f({ bugClass: 'x' }))] })
    expect(out.findings.map((x) => x.file)).toEqual(['b.ts'])
  })

  it('groups the same bug class across files', async () => {
    const r = reviewer({ logic: [f({ bugClass: 'x' }), f({ file: 'b.ts', bugClass: 'x' })] }, () => true)
    const out = await runReview(r, request)
    expect(out.findings).toHaveLength(1)
    expect(out.findings[0]?.also).toEqual([{ file: 'b.ts', line: 2, endLine: 2 }])
  })

  it('verifies at most maxFindings, most severe first', async () => {
    const r = reviewer({ logic: [f({ severity: 'nit', line: 3, endLine: 3, bugClass: 'n' }), f({ bugClass: 'i' })] }, () => true)
    expect((await runReview(r, { ...request, maxFindings: 1 })).findings.map((x) => x.bugClass)).toEqual(['i'])
  })

  it('caps nits, including nitCap 0', async () => {
    const r = reviewer({ logic: [f({ severity: 'nit', bugClass: 'n1' }), f({ severity: 'nit', line: 5, endLine: 5, bugClass: 'n2' })] }, () => true)
    expect((await runReview(r, { ...request, nitCap: 1 })).findings).toHaveLength(1)
    expect((await runReview(r, { ...request, nitCap: 0 })).findings).toEqual([])
  })

  it('survives one finder failing and counts voter errors as "no"', async () => {
    const r: Reviewer = {
      find: vi.fn(async (focus: string) => {
        if (focus === 'logic') throw new Error('model down')
        return [f()]
      }),
      verify: vi.fn().mockRejectedValueOnce(new Error('x')).mockRejectedValueOnce('y').mockResolvedValue({ real: true, reason: '' }),
      recheck: vi.fn(),
    }
    const out = await runReview(r, request)
    expect(out.findings).toEqual([])
    expect(out.errors).toEqual(['finder logic: model down', 'voter: x', 'voter: y'])
  })

  it('throws when every finder fails', async () => {
    const r: Reviewer = { find: vi.fn().mockRejectedValue(new Error('down')), verify: vi.fn(), recheck: vi.fn() }
    await expect(runReview(r, request)).rejects.toThrow(/all finders failed/i)
  })

  it('throws when the depth has no finders', async () => {
    await expect(runReview(reviewer({}, () => true), { ...request, depth: { ...depth, finders: [] } })).rejects.toThrow(/all finders failed/i)
  })

  it('respects the concurrency limit across finders and voters', async () => {
    let active = 0
    let peak = 0
    const slow = async <T>(v: T) => {
      peak = Math.max(peak, ++active)
      await new Promise((res) => setTimeout(res, 2))
      active--
      return v
    }
    const r: Reviewer = { find: () => slow([f()]), verify: () => slow({ real: true, reason: '' }), recheck: vi.fn() }
    await runReview(r, { ...request, limit: createLimiter(1) })
    expect(peak).toBe(1)
  })
})
