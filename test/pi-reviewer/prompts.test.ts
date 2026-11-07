import { describe, expect, it } from 'vitest'
import type { FinderFocus, Finding } from '../../src/review/index.js'
import { exploitPrompt, FOCUS, finderPrompt, recheckPrompt, SECURITY_FOCUS, securityFinderPrompt, verifierPrompt } from '../../src/pi-reviewer/prompts.js'
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
