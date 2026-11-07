/**
 * Runs an async task once a concurrency slot is free and resolves with the task's result.
 * Tasks wait in FIFO order; a task that throws still frees its slot.
 */
export type Limiter = <T>(task: () => Promise<T>) => Promise<T>

/**
 * Creates a limiter that runs at most `max` tasks at once.
 *
 * @param max - Maximum tasks in flight; must be a positive integer.
 * @returns A {@link Limiter} sharing one pool of `max` slots across every call.
 * @throws {@link Error} If `max` is not a positive integer.
 */
export function createLimiter(max: number): Limiter {
  if (!Number.isInteger(max) || max < 1) throw new Error(`max_concurrency must be a positive integer, got ${max}`)
  let active = 0
  const waiting: (() => void)[] = []

  /** Hands the slot straight to the next waiter; frees it only when nobody waits. */
  const release = () => {
    const next = waiting.shift()
    if (next) next()
    else active--
  }

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve))
    else active++
    try {
      return await task()
    } finally {
      release()
    }
  }
}
