import { describe, expect, it } from 'vitest'
import type { Finding } from '../../src/review/index.js'
import { dedupe, normClass, rank, tally } from '../../src/review/voting.js'

const f = (over: Partial<Finding>): Finding => ({
  file: 'a.ts',
  line: 10,
  endLine: 10,
  title: 't',
  explanation: 'e',
  evidence: 'x',
  severity: 'important',
  category: 'bug',
  bugClass: 'null-deref',
  ...over,
})

describe('dedupe', () => {
  it('merges overlapping ranges in the same file, keeping the most severe', () => {
    const out = dedupe([f({ line: 10, endLine: 12, severity: 'nit', bugClass: 'a' }), f({ line: 12, endLine: 14, bugClass: 'b', title: 'keep' })])
    expect(out.map((x) => x.title)).toEqual(['keep'])
  })

  it('keeps non-overlapping findings in the same file', () => {
    expect(dedupe([f({ line: 1, endLine: 2, bugClass: 'a' }), f({ line: 3, endLine: 4, bugClass: 'b' })])).toHaveLength(2)
  })

  it('groups the same bug class across files into one finding with extra locations', () => {
    const out = dedupe([
      f({ file: 'a.ts', bugClass: 'sql-injection', severity: 'nit' }),
      f({ file: 'b.ts', bugClass: 'sql-injection', title: 'primary' }),
      f({ file: 'c.ts', bugClass: 'other' }),
    ])
    expect(out).toHaveLength(2)
    expect(out.find((x) => x.bugClass === 'sql-injection')).toMatchObject({ title: 'primary', also: [{ file: 'a.ts', line: 10, endLine: 10 }] })
  })

  it('never groups findings with an empty bug class', () => {
    expect(dedupe([f({ file: 'a.ts', bugClass: '' }), f({ file: 'b.ts', bugClass: '' })])).toHaveLength(2)
  })

  it('returns [] for no findings and does not mutate input', () => {
    expect(dedupe([])).toEqual([])
    const input = [f({ bugClass: 'x' }), f({ file: 'b.ts', bugClass: 'x' })]
    const copy = structuredClone(input)
    dedupe(input)
    expect(input).toEqual(copy)
  })
})

describe('tally', () => {
  const yes = { real: true, reason: '' }
  const no = { real: false, reason: '' }
  it.each([
    [[yes, yes, no], 2, true],
    [[yes, no, no], 2, false],
    [[], 1, false],
    [[yes], 1, true],
  ])('%j needs %i → %s', (votes, needed, expected) => {
    expect(tally(votes, needed)).toBe(expected)
  })
})

describe('rank', () => {
  it('orders important > pre_existing > nit, stable within a severity, and caps nits', () => {
    const out = rank(
      [f({ file: 'n1', severity: 'nit' }), f({ file: 'p', severity: 'pre_existing' }), f({ file: 'n2', severity: 'nit' }), f({ file: 'i' }), f({ file: 'i2' })],
      1,
    )
    expect(out.map((x) => x.file)).toEqual(['i', 'i2', 'p', 'n1'])
  })

  it('handles nitCap 0 and empty input', () => {
    expect(rank([f({ severity: 'nit' })], 0)).toEqual([])
    expect(rank([], 3)).toEqual([])
  })
})

describe('normClass', () => {
  it.each([
    [' Null Deref ', 'null-deref'],
    ['a_b  c', 'a-b-c'],
    ['', ''],
  ])('%j → %j', (input, out) => {
    expect(normClass(input)).toBe(out)
  })
})
