import { describe, expect, it } from 'vitest'
import { RESOLVE_COMMAND, renderPrior } from '../../src/workflow/prior.js'
import type { BotThread } from '../../src/workflow/workflow.js'

const thread = (id: string, over: Partial<BotThread> = {}): BotThread => ({
  id,
  isResolved: false,
  path: 'src/a.ts',
  line: 3,
  body: `### Important: Bug ${id}\n\nexplanation\n<!-- anthropic-style-code-review:finding important x -->`,
  ...over,
})

describe('renderPrior', () => {
  it('is empty when nothing was flagged', () => {
    expect(renderPrior([], new Set(), 'alice')).toBe('')
  })

  it('lists open first, then dismissed with the reason, then fixed', () => {
    const out = renderPrior(
      [
        thread('f', { isResolved: true, resolvedBy: 'bob' }),
        thread('d', { replies: [{ login: 'bob', body: '/resolve  false positive:\nvalidated by the router' }] }),
        thread('o'),
        thread('r', { line: null }),
        thread('s'),
      ],
      new Set(['s']),
      'alice',
    )
    expect(out.split('\n')).toEqual([
      '- [open] Important: Bug o (src/a.ts:3)',
      '- [open] Important: Bug r (src/a.ts)',
      '- [dismissed: "false positive: validated by the router"] Important: Bug d (src/a.ts:3)',
      '- [fixed] Important: Bug f (src/a.ts:3)',
      '- [fixed] Important: Bug s (src/a.ts:3)',
    ])
  })

  it("doesn't count the author's own /resolve or resolve click, or bot replies, as settling a finding", () => {
    const out = renderPrior(
      [
        thread('a', { replies: [{ login: 'Alice', body: '/resolve not a bug' }, { login: 'ci[bot]', body: '/resolve auto' }] }),
        thread('b', { isResolved: true, resolvedBy: 'alice' }),
      ],
      new Set(),
      'alice',
    )
    expect(out).toBe('- [open] Important: Bug a (src/a.ts:3)\n- [open] Important: Bug b (src/a.ts:3)')
  })

  it('reads older **Label**: titles and skips the anchoring note on security comments', () => {
    const older = thread('x', { body: '**Nit**: Old format title\n\nmore' })
    const anchored = thread('y', { body: '_Reported at line 9; anchored to the nearest changed line._\n\n### Security · High: SQL Injection In Search\n\nx' })
    expect(renderPrior([older, anchored], new Set(), 'alice').split('\n')).toEqual([
      '- [open] Nit: Old format title (src/a.ts:3)',
      '- [open] Security · High: SQL Injection In Search (src/a.ts:3)',
    ])
  })

  it('caps the list and shortens long titles and reasons', () => {
    const many = Array.from({ length: 45 }, (_, i) => thread(String(i)))
    const out = renderPrior(many, new Set(), 'alice').split('\n')
    expect(out).toHaveLength(41)
    expect(out.at(-1)).toBe('- …and 5 more')
    const long = renderPrior([thread('l', { body: `### Important: ${'x'.repeat(300)}`, replies: [{ login: 'bob', body: `/resolve ${'y'.repeat(300)}` }] })], new Set(), 'alice')
    expect(long.length).toBeLessThan(380)
  })
})

describe('RESOLVE_COMMAND', () => {
  it.each([
    ['/resolve false positive', true],
    ['  /RESOLVE ok', true],
    ['/resolve   ', false],
    ['/resolved it', false],
    ['will /resolve later', false],
  ])('%j → %s', (body, ok) => {
    expect(RESOLVE_COMMAND.test(body)).toBe(ok)
  })
})
