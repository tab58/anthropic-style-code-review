export function firstPage<T>(items: readonly T[], size: number): T[] {
  return items.slice(0, size)
}
