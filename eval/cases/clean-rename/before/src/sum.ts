export function total(xs: readonly number[]): number {
  let t = 0
  for (const x of xs) t += x
  return t
}
