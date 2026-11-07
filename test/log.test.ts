import { describe, expect, it } from 'vitest'
import { actionsLine } from '../src/log.js'

describe('actionsLine', () => {
  it('collapses newlines so model text cannot start a new log line', () => {
    expect(actionsLine('a\n::set-output name=x::y\r\nb')).toBe('a ⏎ ::set-output name=x::y ⏎ b')
  })

  it('neutralizes workflow commands at the start of the line', () => {
    expect(actionsLine('::add-mask::x')).toBe(' ::add-mask::x')
    expect(actionsLine('##[warning]x')).toBe(' ##[warning]x')
  })

  it('leaves ordinary text and empty strings alone', () => {
    expect(actionsLine('▶ finder:logic (glm)')).toBe('▶ finder:logic (glm)')
    expect(actionsLine('')).toBe('')
  })
})
