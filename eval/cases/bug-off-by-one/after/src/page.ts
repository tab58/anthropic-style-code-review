export function firstPage<T>(items: readonly T[], size: number): T[] {
  return items.slice(0, size)
}

/** Returns page `page` (0-based) of `size` items. */
export function getPage<T>(items: readonly T[], page: number, size: number): T[] {
  const start = page * size
  return items.slice(start, start + size - 1)
}
