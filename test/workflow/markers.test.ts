import { describe, expect, it } from 'vitest'
import {
  countOpenImportant,
  countOpenSecurity,
  decodeFindingMarker,
  decodeSecurityMarker,
  decodeState,
  encodeFindingMarker,
  encodeSecurityMarker,
  encodeState,
} from '../../src/workflow/markers.js'

describe('review state marker', () => {
  const s = { round: 2, sha: 'abc', fingerprints: ['f1', 'f2'] }

  it('round-trips inside other text', () => {
    expect(decodeState([`**No issues found.**\n\n${encodeState(s)}`])).toEqual(s)
  })

  it('round-trips the risk tier, and drops states with an unknown tier', () => {
    const tiered = { ...s, tier: 'high' as const, tierReasons: ['auth'] }
    expect(decodeState([encodeState(tiered)])).toEqual(tiered)
    expect(decodeState([encodeState(s), '<!-- anthropic-style-code-review:state {"round":3,"sha":"x","fingerprints":[],"tier":"urgent"} -->'])).toEqual(s)
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

  it('round-trips the optional securitySha and still reads states without it', () => {
    const withSec = { round: 1, sha: 'a', fingerprints: [], securitySha: 'b' }
    expect(decodeState([encodeState(withSec)])).toEqual(withSec)
    expect(decodeState(['<!-- anthropic-style-code-review:state {"round":1,"sha":"a","fingerprints":[]} -->'])).toEqual({ round: 1, sha: 'a', fingerprints: [] })
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

describe('security marker', () => {
  it.each([
    ['high', true],
    ['medium', false],
    ['low', true],
  ] as const)('round-trips %s introduced=%s', (level, introduced) => {
    expect(decodeSecurityMarker(`x\n${encodeSecurityMarker(level, introduced, 'sec:abc')}`)).toEqual({ level, introduced, fingerprint: 'sec:abc' })
  })

  it('uses the last marker, and ignores bug markers and junk', () => {
    expect(decodeSecurityMarker(`<!-- anthropic-style-code-review:security low new f -->\n${encodeSecurityMarker('high', true, 'g')}`)).toMatchObject({ level: 'high' })
    expect(decodeSecurityMarker(encodeFindingMarker('important', 'x'))).toBeUndefined()
    expect(decodeSecurityMarker('<!-- anthropic-style-code-review:security critical new f -->')).toBeUndefined()
  })

  it('is invisible to the bug gate', () => {
    expect(countOpenImportant([{ isResolved: false, body: encodeSecurityMarker('high', true, 'x') }])).toBe(0)
  })
})

describe('countOpenSecurity', () => {
  const t = (isResolved: boolean, body: string) => ({ isResolved, body })
  it('counts unresolved, introduced High and Medium only', () => {
    expect(
      countOpenSecurity([
        t(false, encodeSecurityMarker('high', true, 'a')),
        t(false, encodeSecurityMarker('medium', true, 'b')),
        t(false, encodeSecurityMarker('low', true, 'c')),
        t(false, encodeSecurityMarker('high', false, 'd')),
        t(true, encodeSecurityMarker('high', true, 'e')),
        t(false, encodeFindingMarker('important', 'f')),
      ]),
    ).toBe(2)
    expect(countOpenSecurity([])).toBe(0)
  })
})
