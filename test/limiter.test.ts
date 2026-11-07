import { describe, expect, it } from 'vitest'
import { createLimiter } from '../src/limiter.js'

describe('createLimiter', () => {
  it('never runs more than max tasks at once and returns all results', async () => {
    const limit = createLimiter(2)
    let active = 0
    let peak = 0
    const task = (n: number) => async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      return n
    }
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => limit(task(n))))
    expect(results).toEqual([1, 2, 3, 4, 5])
    expect(peak).toBe(2)
  })

  it('releases slot when a task throws', async () => {
    const limit = createLimiter(1)
    await expect(limit(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(limit(async () => 'ok')).resolves.toBe('ok')
  })

  it.each([0, -1, 1.5, Number.NaN])('rejects max %s', (max) => {
    expect(() => createLimiter(max)).toThrow(/positive integer/)
  })
})
