import { describe, expect, it } from 'vitest'
import type { FinderFocus, Finding } from '../../src/review/index.js'
import { exploitPrompt, FOCUS, finderPrompt, recheckPrompt, riskPrompt, SECURITY_FOCUS, securityFinderPrompt, verifierPrompt } from '../../src/pi-reviewer/prompts.js'
import type { SecurityFinding, SecurityFocus } from '../../src/security/index.js'

const input = { diff: 'DIFF', guidance: 'RULES', intent: 'INTENT' }

describe('finderPrompt', () => {
  it.each(Object.keys(FOCUS) as FinderFocus[])('includes the %s focus, guidance, intent and diff', (focus) => {
    const p = finderPrompt(focus, input)
    expect(p).toContain(FOCUS[focus])
    expect(p).toContain('<guidance>\nRULES')
    expect(p).toContain('<intent>\nINTENT')
    expect(p).toContain('<diff>\nDIFF')
  })

  it('omits the guidance block when guidance is empty', () => {
    expect(finderPrompt('general', { ...input, guidance: '' })).not.toContain('<guidance>')
  })
})

describe('verifierPrompt', () => {
  it('names the location and quotes the evidence', () => {
    const f: Finding = { file: 'a.ts', line: 2, endLine: 4, title: 'T', explanation: 'E', evidence: 'EV', severity: 'important', category: 'bug', bugClass: 'c' }
    const p = verifierPrompt(f, input)
    expect(p).toContain('a.ts:2-4')
    expect(p).toContain('EV')
  })
})

describe('single-finding prompts narrow the diff to the finding\'s files', () => {
  const file = (path: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old ${path}\n+new ${path}\n`
  const multi = { ...input, diff: file('a.ts') + file('b.ts') + file('c.ts') }
  const f: Finding = { file: 'a.ts', line: 1, endLine: 1, title: 'T', explanation: 'E', evidence: 'EV', severity: 'important', category: 'bug', bugClass: 'c', also: [{ file: 'b.ts', line: 1, endLine: 1 }] }

  it('verifier: the finding\'s files only, naming the other changed files', () => {
    const p = verifierPrompt(f, multi)
    expect(p).toContain('+new a.ts')
    expect(p).toContain('+new b.ts')
    expect(p).not.toContain('+new c.ts')
    expect(p).toContain('Also changed in this PR; read them if they matter: c.ts')
  })

  it('recheck and exploit: the same narrowing', () => {
    expect(recheckPrompt({ file: 'c.ts', line: 1, text: 'OLD' }, multi)).not.toContain('+new a.ts')
    const v: SecurityFinding = { file: 'b.ts', line: 1, endLine: 1, title: 'T', vulnClass: 'x', source: 'S', sink: 'K', exploitScenario: 'X', impact: 'I', evidence: 'EV', severity: 'high', introduced: true }
    const p = exploitPrompt(v, multi)
    expect(p).toContain('+new b.ts')
    expect(p).not.toContain('+new a.ts')
  })

  it('falls back to the whole diff when the finding\'s file is not in it', () => {
    expect(verifierPrompt({ ...f, file: 'z.ts', also: [] }, multi)).toContain('+new c.ts')
  })
})

describe('already_flagged context', () => {
  it('is fenced into finder and verifier prompts when present, and absent otherwise', () => {
    const withPrior = { ...input, prior: '- [open] Important: Boom (a.ts:3)' }
    expect(finderPrompt('logic', withPrior)).toContain('<already_flagged>\n- [open] Important: Boom (a.ts:3)\n</already_flagged>')
    const f: Finding = { file: 'a.ts', line: 3, endLine: 3, title: 'T', explanation: 'E', evidence: 'EV', severity: 'important', category: 'bug', bugClass: 'c' }
    expect(verifierPrompt(f, withPrior)).toContain('<already_flagged>')
    expect(finderPrompt('logic', input)).not.toContain('<already_flagged>')
  })
})

describe('recheckPrompt', () => {
  it('includes the earlier comment and the new diff', () => {
    const p = recheckPrompt({ file: 'a.ts', line: 3, text: 'OLD' }, input)
    expect(p).toContain('a.ts:3:\nOLD')
    expect(p).toContain('<diff>\nDIFF')
  })
})

describe('securityFinderPrompt', () => {
  it.each(Object.keys(SECURITY_FOCUS) as SecurityFocus[])('includes the %s focus and the diff', (focus) => {
    const p = securityFinderPrompt(focus, input)
    expect(p).toContain(SECURITY_FOCUS[focus])
    expect(p).toContain('<diff>\nDIFF')
  })
})

describe('exploitPrompt', () => {
  it('states the full attack path for the verifier', () => {
    const f: SecurityFinding = {
      file: 'db.ts', line: 4, endLine: 6, title: 'T', vulnClass: 'sqli', source: 'SRC', sink: 'SINK', exploitScenario: 'EXP', impact: 'IMP',
      evidence: 'EV', severity: 'high', introduced: true,
    }
    const p = exploitPrompt(f, input)
    for (const part of ['db.ts:4-6', 'Source: SRC', 'Sink: SINK', 'Exploit scenario: EXP', 'Impact: IMP', 'EV']) expect(p).toContain(part)
  })
})

describe('riskPrompt', () => {
  it('includes the floor and its reasons, the intent and the diff, but no guidance block', () => {
    const p = riskPrompt({ diff: 'DIFF', intent: 'INTENT', floor: { tier: 'medium', reasons: ['changes source: a.ts'] } })
    expect(p).toContain('Rule floor: medium\n- changes source: a.ts')
    expect(p).toContain('<intent>\nINTENT')
    expect(p).toContain('<diff>\nDIFF')
    expect(p).not.toContain('<guidance>')
  })
})
