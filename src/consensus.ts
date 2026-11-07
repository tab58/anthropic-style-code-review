/**
 * Shared consensus logic for review passes: merge duplicate reports, count votes, rank.
 * Generic over the report type so the bug and security reviews share one implementation.
 */

/** A line range in a file. */
export type Location = {
  /** Repo-relative path. */
  readonly file: string
  /** First line, in the new version of the file (1-based). */
  readonly line: number
  /** Last line; `>= line`. */
  readonly endLine: number
}

/** How {@link dedupe} reads a report's class and rank. */
export type DedupeKeys<T> = {
  /** Kind of issue; reports with the same (normalized, non-empty) class are grouped. */
  readonly classOf: (item: T) => string
  /** Lower is more important; the best-ranked report survives a merge. */
  readonly rankOf: (item: T) => number
}

/**
 * Normalizes a class label: trimmed, lower-case, spaces/underscores → dashes.
 *
 * @param c - Raw label from a model; may be empty.
 * @returns The normalized label (empty stays empty).
 */
export const normClass = (c: string): string => c.trim().toLowerCase().replace(/[\s_]+/g, '-')

/**
 * Sorts by rank ascending (most important first), stable within a rank.
 *
 * @param items - Reports to sort; not mutated.
 * @param rankOf - Rank of a report; lower sorts first.
 * @returns A new sorted array.
 */
export function sortByRank<T>(items: readonly T[], rankOf: (item: T) => number): readonly T[] {
  return [...items].sort((a, b) => rankOf(a) - rankOf(b))
}

/** True when two locations are in the same file with overlapping line ranges. */
const overlaps = (a: Location, b: Location) => a.file === b.file && a.line <= b.endLine && b.line <= a.endLine

/** Just the location of a report. */
const locationOf = ({ file, line, endLine }: Location): Location => ({ file, line, endLine })

/**
 * Merges duplicate reports from independent finders.
 * 1. Same file + overlapping lines → keep the best-ranked.
 * 2. Same class anywhere → one report, other places listed in `also` (flag the class, not one line).
 *
 * @param items - Reports; not mutated.
 * @param keys - How to read each report's class and rank.
 * @returns Merged reports, best-ranked first.
 */
export function dedupe<T extends Location>(items: readonly T[], keys: DedupeKeys<T>): readonly (T & { readonly also?: readonly Location[] })[] {
  const merged = sortByRank(items, keys.rankOf).reduce<readonly T[]>((acc, f) => (acc.some((m) => overlaps(m, f)) ? acc : [...acc, f]), [])
  const groups = merged.reduce((acc, f, i) => {
    const key = normClass(keys.classOf(f)) || `#${i}`
    const group = acc.get(key)
    return new Map(acc).set(key, group ? { ...group, rest: [...group.rest, f] } : { primary: f, rest: [] })
  }, new Map<string, { primary: T; rest: readonly T[] }>())
  return [...groups.values()].map(({ primary, rest }) => (rest.length === 0 ? primary : { ...primary, also: rest.map(locationOf) }))
}

/**
 * Whether enough votes said yes.
 *
 * @param votes - One boolean per voter; may be empty.
 * @param needed - Yes votes required.
 * @returns True when at least `needed` votes are true.
 */
export const tally = (votes: readonly boolean[], needed: number): boolean => votes.filter(Boolean).length >= needed

/**
 * Median of numeric votes (lower middle for an even count).
 *
 * @param values - Values; may be empty.
 * @returns The median, or undefined when there are no values.
 */
export function median(values: readonly number[]): number | undefined {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)]
}
