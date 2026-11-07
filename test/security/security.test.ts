import { describe, expect, it, vi } from 'vitest'
import { createLimiter } from '../../src/limiter.js'
import { fingerprint } from '../../src/review/index.js'
import {
  chooseSecurityPlan,
  runSecurityReview,
  SECURITY_PLANS,
  type SecurityFinding,
  securityFingerprint,
  type SecurityRequest,
  type SecurityReviewer,
} from '../../src/security/index.js'

const f = (over: Partial<SecurityFinding> = {}): SecurityFinding => ({
  file: 'src/db.ts',
  line: 3,
  endLine: 3,
  title: 'SQL injection',
  vulnClass: 'sql-injection',
  source: 'req.query.id',
  sink: 'db.query',
  exploitScenario: 'id=1 OR 1=1',
  impact: 'dump users',
  evidence: 'db.query(`${id}`)',
  severity: 'high',
  introduced: true,
  ...over,
})

const diff = (path: string, line: string) => ({ path, text: `diff --git a/${path} b/${path}\n+++ b/${path}\n@@ -0,0 +1 @@\n+${line}\n` })

describe('chooseSecurityPlan', () => {
  it('uses the quick plan for ordinary changes', () => {
    expect(chooseSecurityPlan([diff('src/ui.ts', 'x')], {})).toEqual(SECURITY_PLANS.quick)
    expect(SECURITY_PLANS.quick).toEqual({ depth: 'quick', finders: ['security-general', 'security-general'], voters: 3, needed: 2 })
  })

  it('uses the full plan for risky paths, risky code, extra globs, or when forced', () => {
    expect(chooseSecurityPlan([diff('src/auth.ts', 'x')], {}).depth).toBe('full')
    expect(chooseSecurityPlan([diff('src/x.ts', 'eval(a)')], {}).depth).toBe('full')
    expect(chooseSecurityPlan([diff('src/pay.ts', 'x')], { extraPaths: ['src/pay.ts'] }).depth).toBe('full')
    expect(chooseSecurityPlan([], { forceFull: true }).depth).toBe('full')
    expect(SECURITY_PLANS.full.finders).toEqual(['injection', 'authz', 'secrets-crypto', 'exposure-execution'])
  })
})

describe('securityFingerprint', () => {
  it('is sec:-prefixed, line-independent and class-normalized', () => {
    expect(securityFingerprint(f())).toMatch(/^sec:[0-9a-f]{12}$/)
    expect(securityFingerprint(f({ line: 1 }))).toBe(securityFingerprint(f({ line: 99 })))
    expect(securityFingerprint(f({ vulnClass: 'SQL Injection' }))).toBe(securityFingerprint(f({ vulnClass: 'sql-injection' })))
  })

  it('differs between pre-existing and introduced, so a newly introduced instance is not suppressed', () => {
    expect(securityFingerprint(f({ introduced: false }))).not.toBe(securityFingerprint(f({ introduced: true })))
  })

  it('never collides with a bug fingerprint for the same file and class', () => {
    expect(securityFingerprint(f())).not.toBe(fingerprint({ file: 'src/db.ts', bugClass: 'sql-injection' }))
  })
})

describe('runSecurityReview', () => {
  const request: SecurityRequest = {
    input: { diff: 'd', guidance: '', intent: '' },
    paths: ['src/db.ts', 'src/api.ts'],
    plan: SECURITY_PLANS.quick,
    posted: [],
    maxFindings: 10,
    excludePaths: [],
    limit: createLimiter(3),
  }
  const vote = (exploitable: boolean, severity: SecurityFinding['severity'] = 'high') => ({ exploitable, severity, reason: '' })
  const reviewer = (findings: readonly SecurityFinding[], judge: SecurityReviewer['judgeExploit'] = async () => vote(true)): SecurityReviewer => ({
    findVulnerabilities: vi.fn(async () => findings),
    judgeExploit: vi.fn(judge),
  })

  it('reports progress: each finder, the candidate funnel, and each exploitability vote', async () => {
    const progress: string[] = []
    await runSecurityReview(reviewer([f()]), { ...request, onProgress: (m) => progress.push(m) })
    expect(progress).toEqual([
      'security finder security-general: 1 finding',
      'security finder security-general: 1 finding',
      '2 raw → 1 candidate for voting',
      'exploit vote src/db.ts:3 "SQL injection": 3/3 exploitable → confirmed (high)',
    ])
  })

  it('runs every planned finder and keeps findings a majority judges exploitable', async () => {
    const r = reviewer([f()])
    const out = await runSecurityReview(r, request)
    expect(r.findVulnerabilities).toHaveBeenCalledTimes(2)
    expect(r.judgeExploit).toHaveBeenCalledTimes(3)
    expect(out.findings).toHaveLength(1)
    expect(out.stats).toEqual({ raw: 2, candidates: 1, confirmed: 1 })
  })

  it('drops findings a majority judges not exploitable', async () => {
    let i = 0
    const r = reviewer([f()], async () => vote(i++ === 0))
    expect((await runSecurityReview(r, request)).findings).toEqual([])
  })

  it('sets severity to the median of the exploitable votes', async () => {
    const levels = ['high', 'low', 'medium'] as const
    let i = 0
    const r = reviewer([f({ severity: 'low' })], async () => vote(true, levels[i++] ?? 'low'))
    expect((await runSecurityReview(r, request)).findings[0]?.severity).toBe('medium')
  })

  it('ignores non-exploitable votes when computing severity', async () => {
    const votes = [vote(true, 'high'), vote(true, 'high'), vote(false, 'low')]
    let i = 0
    const r = reviewer([f({ severity: 'low' })], async () => votes[i++] ?? vote(false))
    expect((await runSecurityReview(r, request)).findings[0]?.severity).toBe('high')
  })

  it('drops excluded, exploit-less, out-of-diff, evidence-less and posted findings before voting', async () => {
    const r = reviewer([
      f({ vulnClass: 'denial-of-service', title: 'DoS' }),
      f({ file: 'test/db.ts', vulnClass: 'a' }),
      f({ sink: '', vulnClass: 'b' }),
      f({ file: 'other.ts', vulnClass: 'c' }),
      f({ evidence: ' ', vulnClass: 'd' }),
      f({ vulnClass: 'e' }),
    ])
    const out = await runSecurityReview(r, { ...request, posted: [securityFingerprint(f({ vulnClass: 'e' }))] })
    expect(r.judgeExploit).not.toHaveBeenCalled()
    expect(out.stats).toEqual({ raw: 12, candidates: 0, confirmed: 0 })
  })

  it('applies extra excluded paths', async () => {
    const r = reviewer([f()])
    expect((await runSecurityReview(r, { ...request, excludePaths: ['src/db.ts'] })).findings).toEqual([])
  })

  it('groups the same vulnerability class across files', async () => {
    const out = await runSecurityReview(reviewer([f(), f({ file: 'src/api.ts' })]), request)
    expect(out.findings).toHaveLength(1)
    expect(out.findings[0]?.also).toEqual([{ file: 'src/api.ts', line: 3, endLine: 3 }])
  })

  it('verifies at most maxFindings, introduced and most severe first', async () => {
    const r = reviewer([f({ vulnClass: 'pre', introduced: false, line: 1, endLine: 1 }), f({ vulnClass: 'low', severity: 'low', line: 5, endLine: 5 }), f({ vulnClass: 'hi', line: 9, endLine: 9 })])
    const out = await runSecurityReview(r, { ...request, maxFindings: 2 })
    expect(out.findings.map((x) => x.vulnClass)).toEqual(['hi', 'low'])
  })

  it('records finder failures and counts errored votes as "not exploitable"', async () => {
    const r: SecurityReviewer = {
      findVulnerabilities: vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue([f()]),
      judgeExploit: vi.fn().mockRejectedValueOnce(new Error('x')).mockRejectedValueOnce('y').mockResolvedValue(vote(true)),
    }
    const out = await runSecurityReview(r, request)
    expect(out.findings).toEqual([])
    expect(out.errors).toEqual(['security finder security-general: down', 'security voter: x', 'security voter: y'])
  })

  it('forces introduced=true for findings on lines the PR added, before checking posted fingerprints', async () => {
    const r = reviewer([f({ introduced: false, line: 3, endLine: 3 })])
    const addedLines = new Map([['src/db.ts', new Set([3])]])
    expect((await runSecurityReview(r, { ...request, addedLines })).findings[0]?.introduced).toBe(true)

    const posted = [securityFingerprint(f({ introduced: true }))]
    const again = reviewer([f({ introduced: false, line: 3, endLine: 3 })])
    expect((await runSecurityReview(again, { ...request, addedLines, posted })).findings).toEqual([])
  })

  it('keeps introduced=false for lines the PR did not add', async () => {
    const r = reviewer([f({ introduced: false, line: 9, endLine: 9 })])
    const out = await runSecurityReview(r, { ...request, addedLines: new Map([['src/db.ts', new Set([3])]]) })
    expect(out.findings[0]?.introduced).toBe(false)
  })

  it('reports findings left undecided because too many votes errored', async () => {
    const r: SecurityReviewer = {
      findVulnerabilities: vi.fn(async () => [f()]),
      judgeExploit: vi.fn().mockRejectedValueOnce(new Error('429')).mockRejectedValueOnce(new Error('429')).mockResolvedValue(vote(true)),
    }
    const out = await runSecurityReview(r, request)
    expect(out.findings).toEqual([])
    expect(out.inconclusive).toBe(1)
  })

  it('is conclusive when the votes that arrived still decide it', async () => {
    const r: SecurityReviewer = {
      findVulnerabilities: vi.fn(async () => [f()]),
      judgeExploit: vi.fn().mockRejectedValueOnce(new Error('429')).mockResolvedValue(vote(false)),
    }
    expect((await runSecurityReview(r, request)).inconclusive).toBe(0)
  })

  it('throws when every finder fails or the plan has no finders', async () => {
    const failing: SecurityReviewer = { findVulnerabilities: vi.fn().mockRejectedValue(new Error('down')), judgeExploit: vi.fn() }
    await expect(runSecurityReview(failing, request)).rejects.toThrow(/all security finders failed/i)
    await expect(runSecurityReview(reviewer([]), { ...request, plan: { ...SECURITY_PLANS.quick, finders: [] } })).rejects.toThrow(/all security finders failed/i)
  })

  it('returns nothing when finders find nothing', async () => {
    expect(await runSecurityReview(reviewer([]), request)).toEqual({ findings: [], stats: { raw: 0, candidates: 0, confirmed: 0 }, errors: [], inconclusive: 0 })
  })
})
