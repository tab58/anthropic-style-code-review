import { describe, expect, it } from 'vitest'
import type { FinderFocus, Finding } from '../../src/review/index.js'
import { FOCUS, finderPrompt, recheckPrompt, verifierPrompt } from '../../src/pi-reviewer/prompts.js'

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
