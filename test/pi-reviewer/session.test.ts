import { describe, expect, it } from 'vitest'
import { sealedLoader, toFinding, toSecurityFinding } from '../../src/pi-reviewer/session.js'

const raw = {
  file: './src/a.ts',
  line: 5,
  title: 't',
  explanation: 'e',
  evidence: 'x',
  severity: 'nit' as const,
  category: 'bug' as const,
  bug_class: 'c',
}

describe('toFinding', () => {
  it('normalizes the path and defaults endLine to line', () => {
    expect(toFinding(raw)).toEqual({ file: 'src/a.ts', line: 5, endLine: 5, title: 't', explanation: 'e', evidence: 'x', severity: 'nit', category: 'bug', bugClass: 'c' })
  })

  it('keeps a valid end_line and clamps one before line', () => {
    expect(toFinding({ ...raw, end_line: 9 }).endLine).toBe(9)
    expect(toFinding({ ...raw, end_line: 2 }).endLine).toBe(5)
  })

  it('strips a leading slash too', () => {
    expect(toFinding({ ...raw, file: '/src/a.ts' }).file).toBe('src/a.ts')
  })
})

describe('sealedLoader', () => {
  it('returns only our system prompt and no repo resources', async () => {
    const l = sealedLoader('SYS')
    expect(l.getSystemPrompt()).toBe('SYS')
    expect(l.getAgentsFiles().agentsFiles).toEqual([])
    expect(l.getExtensions().extensions).toEqual([])
    expect(l.getSkills().skills).toEqual([])
    expect(l.getPrompts().prompts).toEqual([])
    expect(l.getAppendSystemPrompt()).toEqual([])
    await expect(l.reload()).resolves.toBeUndefined()
  })
})

describe('toSecurityFinding', () => {
  const v = {
    file: './src/db.ts', line: 4, title: 't', vuln_class: 'sqli', source: 's', sink: 'k', exploit_scenario: 'e', impact: 'i', evidence: 'x',
    severity: 'medium' as const, introduced: false,
  }
  it('maps snake_case fields, normalizes the path and clamps endLine', () => {
    expect(toSecurityFinding(v)).toEqual({
      file: 'src/db.ts', line: 4, endLine: 4, title: 't', vulnClass: 'sqli', source: 's', sink: 'k', exploitScenario: 'e', impact: 'i', evidence: 'x',
      severity: 'medium', introduced: false,
    })
    expect(toSecurityFinding({ ...v, end_line: 9 }).endLine).toBe(9)
    expect(toSecurityFinding({ ...v, end_line: 1 }).endLine).toBe(4)
  })
})
