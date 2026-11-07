import { basename } from 'node:path'
import { matchesGlobDot } from '../diff.js'

/** Path segments that suggest security-sensitive code (auth, secrets, permissions, …), after a separator… */
const RISKY_NAME = /(^|[/._-])(auth(?!or)|oauth|login|logout|session|token|jwt|crypto|cipher|secret|password|passwd|credential|permission|acl|rbac|iam|admin)/i
/** …or as a capitalized camelCase part (`userAuth.ts`, `LoginController.ts`, `ApiToken.ts`). */
const RISKY_CAMEL = /(Auth(?!or)|OAuth|Login|Logout|Session|Token|Jwt|JWT|Crypto|Cipher|Secret|Password|Credential|Permission|Acl|Rbac|Admin)/
/** Longer added lines are minified or generated; scanning them is slow and pointless. */
const MAX_LINE = 2000

/** Build, deploy and CI files where a change can compromise the supply chain or infrastructure. */
const RISKY_GLOBS = ['.github/workflows/**', '**/Dockerfile*', '**/*.tf', '**/k8s/**', '**/helm/**', '**/*.dockerfile']

/** Dependency manifests and lockfiles. */
const MANIFEST = /^(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|go\.(mod|sum)|requirements.*\.txt|pyproject\.toml|poetry\.lock|Pipfile(\.lock)?|Cargo\.(toml|lock)|Gemfile(\.lock)?|composer\.(json|lock)|pom\.xml|build\.gradle(\.kts)?)$/

/** Added-code patterns that reach dangerous sinks. */
const RISKY_CODE = [
  /\b(child_process|execSync|execFile|spawn|subprocess|os\.system|popen|Runtime\.getRuntime)\b|\bexec\s*\(/,
  /\beval\s*\(|new Function\s*\(/,
  /\binnerHTML\b|dangerouslySetInnerHTML/,
  /\bpickle\.loads?\b|\byaml\.load\s*\(|\bunserialize\s*\(|Marshal\.load|ObjectInputStream/,
  /Math\.random\s*\(/,
  // SQL built from strings: a SQL verb plus interpolation or concatenation on the same line.
  /\b(SELECT|INSERT|UPDATE|DELETE)\b[^\n]*(\$\{|["'`]\s*\+|\+\s*["'`]|%s|\.format\(|\bf["'])|\bf["'][^"'\n]*\b(SELECT|INSERT|UPDATE|DELETE)\b/i,
]

/** True when the path itself is security-sensitive. */
const riskyPath = (path: string, extraGlobs: readonly string[]) =>
  RISKY_NAME.test(path) ||
  RISKY_CAMEL.test(path) || MANIFEST.test(basename(path)) || [...RISKY_GLOBS, ...extraGlobs].some((g) => matchesGlobDot(path, g))

/** Lines added by a file's diff (without the leading `+`), hunk content only, minified lines skipped. */
function addedLines(text: string): readonly string[] {
  const lines = text.split('\n')
  const firstHunk = lines.findIndex((l) => l.startsWith('@@'))
  if (firstHunk < 0) return []
  return lines
    .slice(firstHunk)
    .filter((l) => l.startsWith('+') && l.length <= MAX_LINE)
    .map((l) => l.slice(1))
}

/**
 * Decides whether a diff warrants the full (specialist) security pass instead of the quick one.
 *
 * @param files - Changed files with their raw diff text; may be empty.
 * @param extraGlobs - Extra security-sensitive path globs (REVIEW.md `security_paths`); may be empty.
 * @returns True if any path is sensitive or any added line reaches a dangerous sink.
 */
export function needsFullPass(files: readonly { readonly path: string; readonly text: string }[], extraGlobs: readonly string[]): boolean {
  return files.some((f) => riskyPath(f.path, extraGlobs) || addedLines(f.text).some((line) => RISKY_CODE.some((re) => re.test(line))))
}
