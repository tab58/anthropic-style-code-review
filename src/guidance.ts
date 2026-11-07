import { posix } from 'node:path'
import { Type } from 'typebox'
import { Check } from 'typebox/value'
import { parse as parseYaml } from 'yaml'

/** Settings from REVIEW.md's YAML frontmatter. */
export type ReviewConfig = {
  /** Requested review depth (`quick` | `standard` | `deep`); validated later by the review module. */
  readonly depth?: string
  /** Glob patterns for paths to leave out of review. */
  readonly skipPaths: readonly string[]
  /** Maximum nits per review; a non-negative integer. */
  readonly nitCap?: number
  /** Extra globs that trigger the full security pass. */
  readonly securityPaths?: readonly string[]
  /** Extra globs whose security findings are dropped. */
  readonly securityExcludePaths?: readonly string[]
  /** Globs that force the `high` risk tier. */
  readonly riskHighPaths?: readonly string[]
  /** Approvals needed per risk tier; missing tiers keep their defaults (low 0, medium 1, high 2). */
  readonly riskApprovals?: { readonly low?: number; readonly medium?: number; readonly high?: number }
  /** Org team slug whose members are trusted authors; anyone else needs at least one approval at every tier. */
  readonly riskTrustedTeam?: string
}

/** A parsed REVIEW.md. */
export type ReviewMd = {
  /** Frontmatter settings (defaults when there is no frontmatter). */
  readonly config: ReviewConfig
  /** Markdown body: the code owners' review rules. */
  readonly body: string
}

/** A conventions file that applies to files under its directory. */
export type ConventionsFile = {
  /** Repo-relative path, e.g. `src/api/AGENTS.md`. */
  readonly path: string
  /** File contents. */
  readonly content: string
}

/** Everything the reviewers should know about this repo's rules. */
export type Guidance = {
  /** Root REVIEW.md, or undefined if the repo has none. */
  readonly review: ReviewMd | undefined
  /** AGENTS.md (or CLAUDE.md fallback) for the root and each ancestor dir of a changed file, root first. */
  readonly conventions: readonly ConventionsFile[]
}

/** Read access to repository files at a fixed ref. */
export interface RepoFiles {
  /** Returns the file's text, or undefined if it does not exist. Should target the BASE ref so a PR cannot rewrite its own rules. */
  read(path: string): Promise<string | undefined>
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
const FrontmatterSchema = Type.Object({
  depth: Type.Optional(Type.String()),
  skip_paths: Type.Optional(Type.Array(Type.String())),
  nit_cap: Type.Optional(Type.Integer({ minimum: 0 })),
  security_paths: Type.Optional(Type.Array(Type.String())),
  security_exclude_paths: Type.Optional(Type.Array(Type.String())),
  risk_high_paths: Type.Optional(Type.Array(Type.String())),
  risk_approvals: Type.Optional(
    Type.Object(
      { low: Type.Optional(Type.Integer({ minimum: 0 })), medium: Type.Optional(Type.Integer({ minimum: 0 })), high: Type.Optional(Type.Integer({ minimum: 0 })) },
      { additionalProperties: false },
    ),
  ),
  risk_trusted_team: Type.Optional(Type.String({ minLength: 1 })),
})

/** Parses YAML, rethrowing errors with a REVIEW.md-specific message. */
function parseFrontmatterYaml(yaml: string): unknown {
  try {
    return parseYaml(yaml) ?? {}
  } catch (e) {
    throw new Error(`REVIEW.md frontmatter is not valid YAML: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Explains which frontmatter field is invalid. */
function frontmatterError(raw: unknown): Error {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return new Error('REVIEW.md frontmatter must be a mapping')
  const field = (['depth', 'skip_paths', 'nit_cap', 'security_paths', 'security_exclude_paths', 'risk_high_paths', 'risk_approvals', 'risk_trusted_team'] as const).find((k) => {
    const v: unknown = Reflect.get(raw, k)
    return v !== undefined && !Check(FrontmatterSchema.properties[k], v)
  })
  const globs = 'a list of glob strings'
  const expected = {
    depth: 'a string',
    skip_paths: globs,
    nit_cap: 'a non-negative integer',
    security_paths: globs,
    security_exclude_paths: globs,
    risk_high_paths: globs,
    risk_approvals: 'a mapping of low/medium/high to non-negative integers',
    risk_trusted_team: 'a team slug',
  } as const
  return new Error(field ? `REVIEW.md ${field} must be ${expected[field]}` : 'REVIEW.md frontmatter is invalid')
}

/**
 * Parses REVIEW.md, splitting optional YAML frontmatter from the markdown body.
 *
 * @param text - REVIEW.md contents; may be empty or have no frontmatter.
 * @returns The validated settings and the body. Without frontmatter: `skipPaths: []` and the whole text as body.
 * @throws {@link Error} If the frontmatter is not valid YAML, not a mapping, or has a mistyped field.
 */
export function parseReviewMd(text: string): ReviewMd {
  const match = FRONTMATTER.exec(text)
  if (!match) return { config: { skipPaths: [] }, body: text }

  const raw = parseFrontmatterYaml(match[1] ?? '')
  if (!Check(FrontmatterSchema, raw)) throw frontmatterError(raw)
  return {
    config: {
      skipPaths: raw.skip_paths ?? [],
      ...(raw.depth !== undefined && { depth: raw.depth }),
      ...(raw.nit_cap !== undefined && { nitCap: raw.nit_cap }),
      ...(raw.security_paths !== undefined && { securityPaths: raw.security_paths }),
      ...(raw.security_exclude_paths !== undefined && { securityExcludePaths: raw.security_exclude_paths }),
      ...(raw.risk_high_paths !== undefined && { riskHighPaths: raw.risk_high_paths }),
      ...(raw.risk_approvals !== undefined && { riskApprovals: raw.risk_approvals }),
      ...(raw.risk_trusted_team !== undefined && { riskTrustedTeam: raw.risk_trusted_team }),
    },
    body: text.slice(match[0].length),
  }
}

/** The root ('') plus every ancestor directory of `file`. */
const ancestors = (file: string): string[] => {
  const parts = posix.dirname(file).split('/').filter((p) => p !== '.')
  return ['', ...parts.map((_, i) => parts.slice(0, i + 1).join('/'))]
}

/** AGENTS.md in `dir`, else CLAUDE.md, else undefined. */
async function conventionsIn(repo: RepoFiles, dir: string): Promise<ConventionsFile | undefined> {
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const path = posix.join(dir, name)
    const content = await repo.read(path)
    if (content !== undefined) return { path, content }
  }
  return undefined
}

/**
 * Loads REVIEW.md and the conventions files relevant to a set of changed paths.
 *
 * @param repo - Repository reader; pass one bound to the PR's base ref.
 * @param changedPaths - Repo-relative paths changed by the PR; when empty, no conventions files are loaded.
 * @returns The guidance, conventions ordered root first then by depth and name.
 * @throws {@link Error} If REVIEW.md has invalid frontmatter, or if `repo.read` rejects.
 */
export async function loadGuidance(repo: RepoFiles, changedPaths: readonly string[]): Promise<Guidance> {
  const reviewText = await repo.read('REVIEW.md')
  const dirs = [...new Set(changedPaths.flatMap(ancestors))].sort(
    (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b),
  )
  const found = await Promise.all(dirs.map((dir) => conventionsIn(repo, dir)))
  return {
    review: reviewText === undefined ? undefined : parseReviewMd(reviewText),
    conventions: found.filter((c) => c !== undefined),
  }
}

/**
 * Renders guidance as markdown sections for a reviewer prompt.
 *
 * @param g - Loaded guidance.
 * @returns REVIEW.md's body (if non-empty) followed by each conventions file, or an empty string when there is nothing.
 */
export function renderGuidance(g: Guidance): string {
  const sections = [
    ...(g.review?.body.trim() ? [`## Review rules (REVIEW.md)\n\n${g.review.body.trim()}`] : []),
    ...g.conventions.map((c) => `## Conventions (${c.path}): apply to files under ${posix.dirname(c.path)}/\n\n${c.content.trim()}`),
  ]
  return sections.join('\n\n')
}
