import { describe, expect, it } from 'vitest'
import { filterDiff, parseDiff } from '../src/diff.js'

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 line1
-old2
+new2
+new3
 line4
\\ No newline at end of file
@@ -20,2 +21,2 @@ function foo() {
 ctx21
-gone
+here22
diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-bye
diff --git a/docs/x.md b/docs/renamed.md
similarity index 90%
rename from docs/x.md
rename to docs/renamed.md
--- a/docs/x.md
+++ b/docs/renamed.md
@@ -1 +1 @@
-a
+b
`

describe('parseDiff', () => {
  const files = parseDiff(DIFF)

  it('finds every file with its new path', () => {
    expect(files.map((f) => f.path)).toEqual(['src/a.ts', 'old.ts', 'docs/renamed.md'])
  })

  it('records RIGHT-side commentable lines (added + context)', () => {
    expect([...files[0]!.rightLines].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 21, 22])
  })

  it('records added lines separately from context lines', () => {
    expect([...files[0]!.addedLines].sort((a, b) => a - b)).toEqual([2, 3, 22])
    expect(files[1]!.addedLines.size).toBe(0)
  })

  it('counts changed lines', () => {
    expect(files.map((f) => f.changed)).toEqual([5, 1, 2])
  })

  it('marks deleted files with no commentable lines', () => {
    expect(files[1]).toMatchObject({ deleted: true })
    expect(files[1]!.rightLines.size).toBe(0)
  })

  it('round-trips file text', () => {
    expect(files.map((f) => f.text).join('')).toBe(DIFF)
  })

  it('returns [] for empty diff', () => {
    expect(parseDiff('')).toEqual([])
  })
})

describe('filterDiff', () => {
  it('drops files matching skip globs', () => {
    const kept = filterDiff(parseDiff(DIFF), ['docs/**', '*.ts'])
    expect(kept.map((f) => f.path)).toEqual(['src/a.ts'])
  })

  it('keeps everything without globs', () => {
    expect(filterDiff(parseDiff(DIFF), [])).toHaveLength(3)
  })
})
