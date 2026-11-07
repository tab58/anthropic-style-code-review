import type { Finding, Location, Severity, Vote } from './review.js'

const RANK: Record<Severity, number> = { important: 0, pre_existing: 1, nit: 2 }

/** Sort comparator: important first, nits last. */
const bySeverity = (a: Finding, b: Finding) => RANK[a.severity] - RANK[b.severity]

/** True when two findings are in the same file with overlapping line ranges. */
const overlaps = (a: Finding, b: Finding) => a.file === b.file && a.line <= b.endLine && b.line <= a.endLine

/** Normalizes a bug class label: trimmed, lower-case, spaces/underscores → dashes. */
export const normClass = (c: string) => c.trim().toLowerCase().replace(/[\s_]+/g, '-')

/** Just the location of a finding. */
const locationOf = ({ file, line, endLine }: Location): Location => ({ file, line, endLine })

/**
 * 1. Same file + overlapping lines → keep the most severe.
 * 2. Same bug class anywhere → one finding, other places listed in `also` (flag the class, not one line).
 */
export function dedupe(findings: readonly Finding[]): readonly Finding[] {
  const merged = [...findings]
    .sort(bySeverity)
    .reduce<readonly Finding[]>((acc, f) => (acc.some((m) => overlaps(m, f)) ? acc : [...acc, f]), [])

  const groups = merged.reduce((acc, f, i) => {
    const key = normClass(f.bugClass) || `#${i}`
    const group = acc.get(key)
    return new Map(acc).set(key, group ? { ...group, rest: [...group.rest, f] } : { primary: f, rest: [] })
  }, new Map<string, { primary: Finding; rest: readonly Finding[] }>())

  return [...groups.values()].map(({ primary, rest }) => (rest.length === 0 ? primary : { ...primary, also: rest.map(locationOf) }))
}

/** True when at least `needed` votes say the finding is real. */
export const tally = (votes: readonly Vote[], needed: number): boolean => votes.filter((v) => v.real).length >= needed

/** Ranks important > pre_existing > nit (stable within a severity) and keeps at most `nitCap` nits. */
export function rank(findings: readonly Finding[], nitCap: number): readonly Finding[] {
  const ranked = [...findings].sort(bySeverity)
  return [...ranked.filter((f) => f.severity !== 'nit'), ...ranked.filter((f) => f.severity === 'nit').slice(0, nitCap)]
}
