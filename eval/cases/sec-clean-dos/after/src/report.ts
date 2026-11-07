export const noop = () => {}

/** Sums every page of a report. Large reports are fine: this runs in a background job. */
export function total(pages: readonly (readonly number[])[]): number {
  let sum = 0
  for (const page of pages) for (const value of page) sum += value
  return sum
}
