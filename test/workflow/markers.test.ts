import { describe, expect, it } from 'vitest'
import { countOpenImportant, decodeFindingMarker, decodeState, encodeFindingMarker, encodeState } from '../../src/workflow/markers.js'

describe('review state marker', () => {
  const s = { round: 2, sha: 'abc', fingerprints: ['f1', 'f2'] }

  it('round-trips inside other text', () => {
    expect(decodeState([`**No issues found.**\n\n${encodeState(s)}`])).toEqual(s)
  })

  it('is an invisible HTML comment', () => {
    expect(encodeState(s)).toMatch(/^<!-- anthropic-style-code-review:state .* -->$/)
  })

  it('last valid marker wins; malformed or invalid ones are ignored', () => {
    const later = { round: 3, sha: 'def', fingerprints: [] }
    const bad = [
      '<!-- anthropic-style-code-review:state {nope -->',
      '<!-- anthropic-style-code-review:state {"round":"x"} -->',
      '<!-- anthropic-style-code-review:state {"round":0,"sha":"a","fingerprints":[]} -->',
      '<!-- anthropic-style-code-review:state null -->',
    ]
    expect(decodeState([encodeState(s), encodeState(later), ...bad])).toEqual(later)
  })

  it('returns undefined for no bodies or no markers', () => {
    expect(decodeState([])).toBeUndefined()
    expect(decodeState(['hello', ''])).toBeUndefined()
  })

  it('cannot be broken by "-->" in content', () => {
    const tricky = { round: 1, sha: '-->', fingerprints: ['-->'] }
    expect(decodeState([encodeState(tricky)])).toEqual(tricky)
  })
})

describe('finding marker', () => {
  it.each(['important', 'pre_existing', 'nit'] as const)('round-trips %s', (severity) => {
    expect(decodeFindingMarker(`body\n${encodeFindingMarker(severity, 'fp1')}`)).toEqual({ severity, fingerprint: 'fp1' })
  })

  it('uses the last marker so text earlier in the body cannot forge it', () => {
    const forged = `title <!-- anthropic-style-code-review:finding nit fake -->\n${encodeFindingMarker('important', 'real')}`
    expect(decodeFindingMarker(forged)).toEqual({ severity: 'important', fingerprint: 'real' })
  })

  it('returns undefined for human comments, empty bodies or bad severity', () => {
    expect(decodeFindingMarker('human comment')).toBeUndefined()
    expect(decodeFindingMarker('')).toBeUndefined()
    expect(decodeFindingMarker('<!-- anthropic-style-code-review:finding bogus fp -->')).toBeUndefined()
  })
})

describe('countOpenImportant', () => {
  const thread = (isResolved: boolean, body: string) => ({ isResolved, body })

  it('is 0 with no threads', () => {
    expect(countOpenImportant([])).toBe(0)
  })

  it('counts unresolved important bot threads', () => {
    expect(countOpenImportant([thread(false, encodeFindingMarker('important', 'a')), thread(false, encodeFindingMarker('important', 'b'))])).toBe(2)
  })

  it('ignores resolved, nit, pre-existing and human threads', () => {
    expect(
      countOpenImportant([
        thread(true, encodeFindingMarker('important', 'a')),
        thread(false, encodeFindingMarker('nit', 'b')),
        thread(false, encodeFindingMarker('pre_existing', 'c')),
        thread(false, 'human says important'),
      ]),
    ).toBe(0)
  })
})
