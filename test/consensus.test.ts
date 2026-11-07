import { describe, expect, it } from 'vitest'
import { dedupe, type Location, median, normClass, sortByRank, tally } from '../src/consensus.js'

type Item = Location & { readonly cls: string; readonly rank: number; readonly title: string; readonly also?: readonly Location[] }
const item = (over: Partial<Item>): Item => ({ file: 'a.ts', line: 10, endLine: 10, cls: 'x', rank: 0, title: 't', ...over })
const by = { classOf: (i: Item) => i.cls, rankOf: (i: Item) => i.rank }

describe('dedupe', () => {
  it('merges overlapping ranges in the same file, keeping the best-ranked', () => {
    const out = dedupe([item({ line: 10, endLine: 12, rank: 2, cls: 'a' }), item({ line: 12, endLine: 14, rank: 0, cls: 'b', title: 'keep' })], by)
    expect(out.map((x) => x.title)).toEqual(['keep'])
  })

  it('keeps non-overlapping items in the same file', () => {
    expect(dedupe([item({ line: 1, endLine: 2, cls: 'a' }), item({ line: 3, endLine: 4, cls: 'b' })], by)).toHaveLength(2)
  })

  it('groups the same class across files into one item with extra locations', () => {
    const out = dedupe([item({ file: 'a.ts', cls: 'sqli', rank: 2 }), item({ file: 'b.ts', cls: 'SQLi', title: 'primary' }), item({ file: 'c.ts', cls: 'other' })], by)
    expect(out).toHaveLength(2)
    expect(out.find((x) => x.title === 'primary')?.also).toEqual([{ file: 'a.ts', line: 10, endLine: 10 }])
  })

  it('never groups items with an empty class', () => {
    expect(dedupe([item({ file: 'a.ts', cls: '' }), item({ file: 'b.ts', cls: '' })], by)).toHaveLength(2)
  })

  it('returns [] for no items and does not mutate input', () => {
    expect(dedupe([], by)).toEqual([])
    const input = [item({ cls: 'x' }), item({ file: 'b.ts', cls: 'x' })]
    const copy = structuredClone(input)
    dedupe(input, by)
    expect(input).toEqual(copy)
  })
})

describe('tally', () => {
  it.each([
    [[true, true, false], 2, true],
    [[true, false, false], 2, false],
    [[], 1, false],
    [[true], 1, true],
  ])('%j needs %i → %s', (votes, needed, expected) => {
    expect(tally(votes, needed)).toBe(expected)
  })
})

describe('sortByRank', () => {
  it('sorts ascending by rank, stable, without mutating', () => {
    const input = [item({ title: 'c', rank: 2 }), item({ title: 'a', rank: 0 }), item({ title: 'a2', rank: 0 })]
    expect(sortByRank(input, (i) => i.rank).map((i) => i.title)).toEqual(['a', 'a2', 'c'])
    expect(input[0]?.title).toBe('c')
  })

  it('handles empty input', () => {
    expect(sortByRank([], (i: Item) => i.rank)).toEqual([])
  })
})

describe('median', () => {
  it.each([
    [[3], 3],
    [[1, 3], 1],
    [[3, 1, 2], 2],
    [[1, 1, 3, 3], 1],
  ])('median of %j is %i (lower middle when even)', (values, out) => {
    expect(median(values)).toBe(out)
  })

  it('is undefined for no values', () => {
    expect(median([])).toBeUndefined()
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
