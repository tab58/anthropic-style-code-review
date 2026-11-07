import { matchesGlob } from 'node:path'
import { normClass } from '../consensus.js'
import type { SecurityFinding } from './security.js'

/**
 * Chronic false-positive classes (after Anthropic's claude-code-security-review hard exclusions).
 * Matched against the normalized vulnerability class ONLY, never the free-text title, so a real
 * "sql-injection" titled "...missing input validation" is never dropped.
 */
const EXCLUDED_CLASS =
  /^(denial-of-service|dos|(resource|memory|cpu)-exhaustion|(missing-)?rate-limit(ing)?|unbounded-[a-z-]+|infinite-loop|redos|regex-(dos|injection|denial-of-service)|catastrophic-backtracking|open-redirect|((missing|lack-of)-)?input-validation)$/

/** Markdown and tests: fixtures with fake secrets or unsafe code are expected there. Code under docs/ is still scanned. */
const EXCLUDED_PATHS = ['**/*.md', 'test/**', 'tests/**', '**/test/**', '**/tests/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*', '**/*_test.*']

/** True when a required exploit-path field is blank. */
const blank = (s: string) => s.trim() === ''

/**
 * Why a security finding should be dropped before voting, if at all.
 *
 * @param f - The finding.
 * @param extraPaths - Extra excluded globs (REVIEW.md `security_exclude_paths`); may be empty.
 * @returns A reason (`excluded path …`, `excluded class …`, `no exploit path`), or undefined to keep it.
 */
export function exclusionReason(f: SecurityFinding, extraPaths: readonly string[]): string | undefined {
  if ([...EXCLUDED_PATHS, ...extraPaths].some((g) => matchesGlob(f.file, g))) return `excluded path ${f.file}`
  if (EXCLUDED_CLASS.test(normClass(f.vulnClass))) return `excluded class ${f.vulnClass}`
  if (blank(f.source) || blank(f.sink) || blank(f.exploitScenario)) return 'no exploit path'
  return undefined
}
