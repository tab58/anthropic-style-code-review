import { Type } from 'typebox'
import { Check } from 'typebox/value'
import type { Severity } from '../review/index.js'
import type { RiskTier } from '../risk/index.js'
import type { SecurityLevel } from '../security/index.js'

/** Review progress for one PR, persisted as a hidden marker in the bot's review bodies. */
export type ReviewState = {
  /** Review rounds run so far (>= 1). `maxRounds + 1` means paused. */
  readonly round: number
  /** Last reviewed head SHA. */
  readonly sha: string
  /** Fingerprints of every finding posted so far. */
  readonly fingerprints: readonly string[]
  /** Last head SHA the security pass completed on; the security gate fails while it isn't HEAD. Absent before v1.1. */
  readonly securitySha?: string
  /** Risk tier so far; it never goes down within a PR. Absent until risk tiers assess the PR. */
  readonly tier?: RiskTier
  /** Why the PR has that tier. */
  readonly tierReasons?: readonly string[]
}

const STATE_RE = /<!-- anthropic-style-code-review:state (.*?) -->/g
const FINDING_RE = /<!-- anthropic-style-code-review:finding (important|pre_existing|nit) (\S+) -->/g
const StateSchema = Type.Object({
  round: Type.Integer({ minimum: 1 }),
  sha: Type.String(),
  fingerprints: Type.Array(Type.String()),
  securitySha: Type.Optional(Type.String()),
  tier: Type.Optional(Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')])),
  tierReasons: Type.Optional(Type.Array(Type.String())),
})
const SECURITY_RE = /<!-- anthropic-style-code-review:security (high|medium|low) (new|pre) (\S+) -->/g
const SEVERITIES: readonly Severity[] = ['important', 'pre_existing', 'nit']
const LEVELS: readonly SecurityLevel[] = ['high', 'medium', 'low']

/** Narrows a string to a {@link Severity}. */
const isSeverity = (s: string): s is Severity => SEVERITIES.some((v) => v === s)

/** Narrows a string to a {@link SecurityLevel}. */
const isLevel = (s: string): s is SecurityLevel => LEVELS.some((v) => v === s)

/** `>` is escaped so the JSON can never contain `-->` and close the comment early. */
export const encodeState = (s: ReviewState): string =>
  `<!-- anthropic-style-code-review:state ${JSON.stringify(s).replace(/>/g, '\\u003e')} -->`

/** Parses one marker's JSON; undefined when malformed or not a valid state. */
function parseState(json: string): ReviewState | undefined {
  try {
    const v: unknown = JSON.parse(json)
    return Check(StateSchema, v) ? v : undefined
  } catch {
    return undefined
  }
}

/** Latest valid state marker across bodies (oldest first), or undefined. */
export function decodeState(bodies: readonly string[]): ReviewState | undefined {
  return bodies
    .flatMap((b) => [...b.matchAll(STATE_RE)].map((m) => parseState(m[1] ?? '')))
    .filter((s) => s !== undefined)
    .at(-1)
}

/** Hidden marker tagging an inline comment with its severity and fingerprint. */
export const encodeFindingMarker = (severity: Severity, fingerprint: string): string =>
  `<!-- anthropic-style-code-review:finding ${severity} ${fingerprint} -->`

/** Reads the LAST finding marker in a comment (earlier ones could come from model text); undefined if none is valid. */
export function decodeFindingMarker(body: string): { readonly severity: Severity; readonly fingerprint: string } | undefined {
  const m = [...body.matchAll(FINDING_RE)].at(-1)
  const severity = m?.[1]
  const fp = m?.[2]
  return severity !== undefined && fp !== undefined && isSeverity(severity) ? { severity, fingerprint: fp } : undefined
}

/** Number of unresolved threads whose finding marker says Important. */
export const countOpenImportant = (threads: readonly { readonly isResolved: boolean; readonly body: string }[]): number =>
  threads.filter((t) => !t.isResolved && decodeFindingMarker(t.body)?.severity === 'important').length

/** Hidden marker tagging an inline security comment: level, introduced (`new`) or pre-existing (`pre`), fingerprint. */
export const encodeSecurityMarker = (level: SecurityLevel, introduced: boolean, fingerprint: string): string =>
  `<!-- anthropic-style-code-review:security ${level} ${introduced ? 'new' : 'pre'} ${fingerprint} -->`

/** Reads the LAST security marker in a comment; undefined if none is valid. */
export function decodeSecurityMarker(body: string): { readonly level: SecurityLevel; readonly introduced: boolean; readonly fingerprint: string } | undefined {
  const m = [...body.matchAll(SECURITY_RE)].at(-1)
  const level = m?.[1]
  const fp = m?.[3]
  return level !== undefined && fp !== undefined && isLevel(level) ? { level, introduced: m?.[2] === 'new', fingerprint: fp } : undefined
}

/** Number of unresolved security threads that block merge: introduced by the PR, High or Medium. */
export const countOpenSecurity = (threads: readonly { readonly isResolved: boolean; readonly body: string }[]): number =>
  threads.filter((t) => {
    const m = t.isResolved ? undefined : decodeSecurityMarker(t.body)
    return m !== undefined && m.introduced && m.level !== 'low'
  }).length
