import { matchesGlob } from 'node:path'

/** One file's section of a unified diff. */
export type FileDiff = {
  /** Repo-relative path after the change (the old path for deleted files). */
  readonly path: string
  /** Raw diff text for this file, including its `diff --git` header. */
  readonly text: string
  /** True when the change deletes the file. */
  readonly deleted: boolean
  /** RIGHT-side (new file) line numbers a review comment may target: added and context lines. */
  readonly rightLines: ReadonlySet<number>
  /** RIGHT-side line numbers this diff added (a subset of `rightLines`). */
  readonly addedLines: ReadonlySet<number>
  /** Number of added plus removed lines. */
  readonly changed: number
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** Strips `+++ `/`--- `, an `a/` or `b/` prefix and any trailing timestamp from a file header line. */
const stripPrefix = (header: string) => header.slice(4).replace(/\t.*$/, '').replace(/^[ab]\//, '')

/** Resolves a file section's path from its `+++`/`---` headers, falling back to the `diff --git` line. */
function pathOf(lines: readonly string[]): { path: string; deleted: boolean } {
  const plus = lines.find((l) => l.startsWith('+++ '))
  const minus = lines.find((l) => l.startsWith('--- '))
  const deleted = plus === '+++ /dev/null'
  const fromHeader = /^diff --git a\/.* b\/(.*)$/.exec(lines[0] ?? '')?.[1] ?? ''
  const path = deleted && minus ? stripPrefix(minus) : plus ? stripPrefix(plus) : fromHeader
  return { path, deleted }
}

/** Walks hunks, collecting RIGHT-side line numbers and counting changed lines. */
function scanHunks(lines: readonly string[]): { rightLines: Set<number>; addedLines: Set<number>; changed: number } {
  const rightLines = new Set<number>()
  const addedLines = new Set<number>()
  let right = 0
  let inHunk = false
  let changed = 0
  for (const line of lines) {
    const hunk = HUNK.exec(line)
    if (hunk) {
      right = Number(hunk[1])
      inHunk = true
    } else if (!inHunk) {
      continue
    } else if (line.startsWith('+')) {
      addedLines.add(right)
      rightLines.add(right++)
      changed++
    } else if (line.startsWith('-')) {
      changed++
    } else if (line.startsWith(' ')) {
      rightLines.add(right++)
    }
  }
  return { rightLines, addedLines, changed }
}

/**
 * Splits a unified diff (as produced by `git diff` or the GitHub compare API) into per-file sections.
 *
 * @param diff - Unified diff text; may be empty.
 * @returns One {@link FileDiff} per `diff --git` section, in order. Any preamble before the first section is ignored.
 */
export function parseDiff(diff: string): readonly FileDiff[] {
  return diff
    .split(/(?=^diff --git )/m)
    .filter((chunk) => chunk.startsWith('diff --git '))
    .map((text) => {
      const lines = text.split('\n')
      return { ...pathOf(lines), ...scanHunks(lines), text }
    })
}

/**
 * Drops files whose path matches any of the given globs.
 *
 * @param files - Parsed file diffs.
 * @param skipGlobs - Glob patterns (Node `path.matchesGlob` syntax); `*` does not cross `/`. May be empty.
 * @returns The files that match none of the globs, in their original order.
 */
export function filterDiff(files: readonly FileDiff[], skipGlobs: readonly string[]): readonly FileDiff[] {
  return files.filter((f) => !skipGlobs.some((g) => matchesGlob(f.path, g)))
}

/**
 * `path.matchesGlob`, except `*` and `**` also match dot segments (`.env`, `.secrets/`). Use it only where a
 * match RAISES scrutiny (risk and security globs), never for skip lists, so a dotfile can't slip past a rule.
 *
 * @param path - Repo-relative path.
 * @param glob - Glob pattern (Node `path.matchesGlob` syntax).
 * @returns True when the path, or the path with each segment's leading dot removed, matches.
 */
export const matchesGlobDot = (path: string, glob: string): boolean => matchesGlob(path, glob) || matchesGlob(path.replace(/(^|\/)\./g, '$1'), glob)
