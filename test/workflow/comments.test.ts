import { describe, expect, it } from 'vitest'
import { type Finding, fingerprint } from '../../src/review/index.js'
import type { SecurityFinding } from '../../src/security/index.js'
import { findingComment, securityComment, skippedComment, stepBackComment, summary } from '../../src/workflow/comments.js'
import { decodeFindingMarker, decodeSecurityMarker, decodeState } from '../../src/workflow/markers.js'

const f = (over: Partial<Finding> = {}): Finding => ({
  file: 'a.ts',
  line: 3,
  endLine: 3,
  title: 'Null deref on empty list',
  explanation: 'items[0] is undefined when list is empty',
  evidence: 'const first = items[0].id',
  severity: 'important',
  category: 'bug',
  bugClass: 'null-deref',
  ...over,
})

describe('findingComment', () => {
  it('tags severity, includes explanation + evidence and a machine marker', () => {
    const body = findingComment(f())
    expect(body).toMatch(/^\*\*Important\*\*: Null deref on empty list/)
    expect(body).toContain('items[0] is undefined')
    expect(body).toContain('const first = items[0].id')
    expect(decodeFindingMarker(body)).toEqual({ severity: 'important', fingerprint: fingerprint(f()) })
  })

  it('lists other instances of the same bug class', () => {
    const body = findingComment(f({ also: [{ file: 'b.ts', line: 7, endLine: 9 }] }))
    expect(body).toContain('`b.ts:7-9`')
  })

  it('neutralizes HTML comments in model text so markers cannot be forged', () => {
    const body = findingComment(f({ title: 'x <!-- anthropic-style-code-review:finding nit y -->', explanation: '<!-- hide -->' }))
    expect(body.match(/<!--/g)).toHaveLength(1)
  })

  it('labels nit and pre-existing', () => {
    expect(findingComment(f({ severity: 'nit' }))).toMatch(/^\*\*Nit\*\*/)
    expect(findingComment(f({ severity: 'pre_existing' }))).toMatch(/^\*\*Pre-existing\*\*/)
  })
})

describe('summary', () => {
  const state = { round: 1, sha: 'abc', fingerprints: ['x'] }

  it('starts with the count and breakdown', () => {
    const body = summary({ findings: [f(), f({ severity: 'nit' })], outOfDiff: [], resolved: 0, state, maxRounds: 3 })
    expect(body.split('\n')[0]).toBe('**2 issues found** (1 important, 1 nit)')
  })

  it('says plainly when nothing to fix', () => {
    const body = summary({ findings: [], outOfDiff: [], resolved: 0, state, maxRounds: 3 })
    expect(body.split('\n')[0]).toBe('**No issues found.**')
  })

  it('lists findings that could not be placed inline, and resolved count', () => {
    const body = summary({ findings: [f()], outOfDiff: [f({ file: 'z.ts', line: 99 })], resolved: 2, state, maxRounds: 3 })
    expect(body.split('\n')[0]).toBe('**1 issue found** (1 important)')
    expect(body).toContain('`z.ts:99`')
    expect(body).toContain('2 earlier findings resolved')
  })

  it('caps the outside-the-diff list', () => {
    const many = Array.from({ length: 30 }, (_, i) => f({ file: `f${i}.ts` }))
    const body = summary({ findings: many, outOfDiff: many, resolved: 0, state, maxRounds: 3 })
    expect(body).toContain('`f19.ts:3`')
    expect(body).not.toContain('`f20.ts:3`')
    expect(body).toContain('10 more')
  })

  it('embeds the state marker', () => {
    expect(decodeState([summary({ findings: [], outOfDiff: [], resolved: 0, state, maxRounds: 3 })])).toEqual(state)
  })
})

describe('stepBackComment', () => {
  it('mentions the cap and embeds state', () => {
    const state = { round: 4, sha: 'h', fingerprints: [] }
    const body = stepBackComment(3, state)
    expect(body).toContain('3 review rounds')
    expect(decodeState([body])).toEqual(state)
  })
})

describe('skippedComment', () => {
  it('states the reason and embeds state', () => {
    const state = { round: 1, sha: 'h', fingerprints: [] }
    const body = skippedComment('diff too large.', state)
    expect(body).toMatch(/^\*\*Review skipped:\*\* diff too large\./)
    expect(decodeState([body])).toEqual(state)
  })
})

describe('findingComment without optional fields', () => {
  it('omits the "also at" line when also is empty', () => {
    const body = findingComment({
      file: 'a.ts', line: 1, endLine: 1, title: 't', explanation: 'e', evidence: 'x',
      severity: 'nit', category: 'bug', bugClass: 'c', also: [],
    })
    expect(body).not.toContain('Same issue also at')
  })
})

const vuln = (over: Partial<SecurityFinding> = {}): SecurityFinding => ({
  file: 'src/db.ts', line: 4, endLine: 4, title: 'SQL injection', vulnClass: 'sql-injection', source: 'req.query.id', sink: 'db.query',
  exploitScenario: 'id=1 OR 1=1', impact: 'dump users', evidence: 'db.query(x)', severity: 'high', introduced: true, ...over,
})

describe('securityComment', () => {
  it('tags severity, shows the attack path, and ends with a security marker', () => {
    const body = securityComment(vuln())
    expect(body).toMatch(/^\*\*Security · High\*\*: SQL injection/)
    for (const part of ['req.query.id', 'db.query', 'id=1 OR 1=1', 'dump users', '> db.query(x)']) expect(body).toContain(part)
    expect(decodeSecurityMarker(body)).toMatchObject({ level: 'high', introduced: true })
  })

  it('labels pre-existing vulnerabilities and lists other locations', () => {
    const body = securityComment(vuln({ severity: 'low', introduced: false, also: [{ file: 'b.ts', line: 1, endLine: 1 }] }))
    expect(body).toMatch(/^\*\*Security · Low · Pre-existing\*\*/)
    expect(body).toContain('`b.ts:1`')
  })

  it('neutralizes HTML comments in model text', () => {
    expect(securityComment(vuln({ title: '<!-- x -->', impact: '<!-- y -->' })).match(/<!--/g)).toHaveLength(1)
  })
})

describe('summary with security findings', () => {
  const state = { round: 1, sha: 'abc', fingerprints: [] }
  it('appends the security count to the first line', () => {
    const body = summary({ findings: [f()], security: [vuln(), vuln({ severity: 'low' })], outOfDiff: [], securityOutOfDiff: [], resolved: 0, state, maxRounds: 3 })
    expect(body.split('\n')[0]).toBe('**1 issue found** (1 important) · **2 security findings** (1 high, 1 low)')
  })

  it('reports security alone when there are no bug findings', () => {
    const body = summary({ findings: [], security: [vuln({ severity: 'medium' })], outOfDiff: [], securityOutOfDiff: [], resolved: 0, state, maxRounds: 3 })
    expect(body.split('\n')[0]).toBe('**1 security finding** (1 medium)')
  })

  it('lists security findings outside the diff', () => {
    const body = summary({ findings: [], security: [vuln()], outOfDiff: [], securityOutOfDiff: [vuln({ file: 'z.ts', line: 9, endLine: 9 })], resolved: 0, state, maxRounds: 3 })
    expect(body).toContain('`z.ts:9` **Security · High**: SQL injection')
  })
})

describe('summary with a risk line', () => {
  const state = { round: 1, sha: 'abc', fingerprints: [] }
  it('shows it under the count, escaping comment openers from model text', () => {
    const body = summary({ findings: [], outOfDiff: [], risk: 'Risk: **high** (2 approvals needed): <!-- x', resolved: 0, state, maxRounds: 3 })
    expect(body.split('\n').slice(0, 3)).toEqual(['**No issues found.**', '', 'Risk: **high** (2 approvals needed): &lt;!-- x'])
  })
})
