import type { BotThread } from './workflow.js'

/** A reply that dismisses a finding: `/resolve` followed by a reason (a bare `/resolve` doesn't count). */
export const RESOLVE_COMMAND = /^\s*\/resolve\s+\S/i

// ponytail: fixed caps keep the list to a few hundred tokens per agent; raise if long PRs lose context.
const MAX_ENTRIES = 40
const MAX_TITLE = 120
const MAX_REASON = 200

/** Where a thread stands, for the agents. */
type Status = { readonly order: number; readonly label: string }

/** One line, whitespace collapsed, cut to `max` characters. */
const oneLine = (t: string, max: number) => {
  const s = t.replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** `Important: Title` from the comment's first heading line, in the current (`### X: T`) or older (`**X**: T`) format. */
function headline(body: string): string {
  const first = body.split('\n').find((l) => l.trim() !== '' && !l.startsWith('_Reported at')) ?? ''
  return oneLine(first.replace(/^#+\s*/, '').replace(/\*\*([^*]+)\*\*/, '$1'), MAX_TITLE)
}

/** open, fixed, or dismissed (with the reason) by someone other than the PR author. */
function statusOf(t: BotThread, fixed: ReadonlySet<string>, author: string): Status {
  const self = (login: string) => login.toLowerCase() === author.toLowerCase()
  const dismissal = (t.replies ?? []).find((r) => RESOLVE_COMMAND.test(r.body) && !r.login.endsWith('[bot]') && !self(r.login))
  if (dismissal) return { order: 1, label: `dismissed: "${oneLine(dismissal.body.replace(/^\s*\/resolve\s+/i, ''), MAX_REASON)}"` }
  if (fixed.has(t.id) || (t.isResolved && !self(t.resolvedBy ?? ''))) return { order: 2, label: 'fixed' }
  return { order: 0, label: 'open' }
}

/**
 * Renders the bot's earlier findings on this PR for the agents, so they don't report them again and treat dismissed
 * ones as settled: one line each, `- [status] Severity: Title (file:line)`, open first, capped.
 *
 * @param threads - The bot's review threads on the PR.
 * @param fixed - Thread IDs recorded as fixed (including ones fixed this round).
 * @param author - PR author login; their own `/resolve` replies don't count as dismissals.
 * @returns The list, or an empty string when nothing was flagged before.
 */
export function renderPrior(threads: readonly BotThread[], fixed: ReadonlySet<string>, author: string): string {
  const entries = threads
    .map((t) => ({ t, status: statusOf(t, fixed, author) }))
    .sort((a, b) => a.status.order - b.status.order)
    .map(({ t, status }) => `- [${status.label}] ${headline(t.body)} (${t.path}${t.line === null ? '' : `:${t.line}`})`)
  if (entries.length === 0) return ''
  const more = entries.length > MAX_ENTRIES ? [`- …and ${entries.length - MAX_ENTRIES} more`] : []
  return [...entries.slice(0, MAX_ENTRIES), ...more].join('\n')
}
