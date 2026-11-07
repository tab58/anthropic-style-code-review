import { type Static, type TSchema, Type } from 'typebox'
import { Check } from 'typebox/value'
import type { PullReview, RiskTier } from './risk/index.js'
import { RISK_TIERS } from './risk/index.js'
import type { BotThread, GitHub } from './workflow/index.js'

/** The two Octokit calls this client uses. `getOctokit(token)` satisfies it via a thin adapter. */
export interface GitHubApi {
  /** REST request, e.g. `request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {...})`. Rejects with `status` on HTTP errors. */
  request(route: string, params?: Readonly<Record<string, unknown>>): Promise<{ readonly data: unknown }>
  /** GraphQL query or mutation; resolves with the `data` object. */
  graphql(query: string, variables?: Readonly<Record<string, unknown>>): Promise<unknown>
}

/** Collaborators and PR coordinates for {@link createGitHubClient}. */
export type GitHubClientConfig = {
  /** Octokit-compatible API. */
  readonly api: GitHubApi
  /** Repository owner. */
  readonly owner: string
  /** Repository name. */
  readonly repo: string
  /** Pull request number. */
  readonly prNumber: number
  /** REST login of the identity posting reviews, e.g. `github-actions[bot]`; `[bot]` suffix optional. */
  readonly botLogin: string
  /** Values to redact from anything posted (API key, token); values shorter than 8 characters are ignored. */
  readonly secrets: readonly string[]
}

const PullSchema = Type.Object({
  number: Type.Integer(),
  title: Type.String(),
  body: Type.Union([Type.String(), Type.Null()]),
  draft: Type.Optional(Type.Boolean()),
  user: Type.Optional(Type.Union([Type.Object({ login: Type.String() }), Type.Null()])),
  head: Type.Object({ sha: Type.String(), repo: Type.Union([Type.Object({ full_name: Type.String() }), Type.Null()]) }),
  base: Type.Object({ sha: Type.String(), repo: Type.Object({ full_name: Type.String() }) }),
})
const CompareSchema = Type.Object({ status: Type.String() })
const ReviewSchema = Type.Object({ body: Type.Union([Type.String(), Type.Null()]), user: Type.Union([Type.Object({ login: Type.String() }), Type.Null()]) })
const PullReviewSchema = Type.Object({
  state: Type.Union([Type.Literal('APPROVED'), Type.Literal('CHANGES_REQUESTED'), Type.Literal('COMMENTED'), Type.Literal('DISMISSED'), Type.Literal('PENDING')]),
  commit_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  user: Type.Union([Type.Object({ login: Type.String(), type: Type.Optional(Type.String()) }), Type.Null()]),
})
const PermissionSchema = Type.Object({ permission: Type.String() })
const WRITE_PERMISSIONS = new Set(['admin', 'maintain', 'write'])
const ThreadsSchema = Type.Object({
  repository: Type.Object({
    pullRequest: Type.Union([
      Type.Null(),
      Type.Object({
        reviewThreads: Type.Object({
          pageInfo: Type.Object({ hasNextPage: Type.Boolean(), endCursor: Type.Union([Type.String(), Type.Null()]) }),
          nodes: Type.Array(
            Type.Object({
              id: Type.String(),
              isResolved: Type.Boolean(),
              path: Type.String(),
              line: Type.Union([Type.Integer(), Type.Null()]),
              comments: Type.Object({
                nodes: Type.Array(Type.Object({ body: Type.String(), author: Type.Union([Type.Object({ login: Type.String() }), Type.Null()]) })),
              }),
            }),
          ),
        }),
      }),
    ]),
  }),
})

const THREADS_QUERY = `query($owner: String!, $repo: String!, $pr: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved path line comments(first: 1) { nodes { body author { login } } } }
      }
    }
  }
}`
const RESOLVE_MUTATION = 'mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }'
const PAGE_SIZE = 100

/** Validates an API response against `schema`, throwing a clear error naming the call on mismatch. */
function expect<S extends TSchema>(schema: S, value: unknown, what: string): Static<S> {
  if (!Check(schema, value)) throw new Error(`Unexpected GitHub response for ${what}`)
  return value
}

/** HTTP status of an Octokit-style error, if any. */
const statusOf = (e: unknown): number | undefined =>
  typeof e === 'object' && e !== null && 'status' in e && typeof e.status === 'number' ? e.status : undefined

/** GraphQL reports bots without the `[bot]` suffix that REST uses. */
const sameLogin = (a: string, b: string) => a.replace(/\[bot\]$/, '') === b.replace(/\[bot\]$/, '')

/** Replaces every configured secret with `***`. Defense in depth: an agent quoting a secret never reaches a public comment. */
const redactor = (secrets: readonly string[]) => (t: string) =>
  secrets.filter((s) => s.length >= 8).reduce((acc, s) => acc.split(s).join('***'), t)

/** Fetches the PR. */
async function getPull(c: GitHubClientConfig) {
  const { data } = await c.api.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner: c.owner, repo: c.repo, pull_number: c.prNumber })
  const pr = expect(PullSchema, data, 'pulls.get')
  return {
    number: pr.number,
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    title: pr.title,
    body: pr.body ?? '',
    author: pr.user?.login ?? '',
    isFork: pr.head.repo?.full_name !== pr.base.repo.full_name,
    draft: pr.draft ?? false,
  }
}

/** True when `ancestor...head` compares as ahead/identical; false for unknown or unrelated SHAs (404/422). */
async function isAncestor(c: GitHubClientConfig, ancestor: string, head: string): Promise<boolean> {
  try {
    const { data } = await c.api.request('GET /repos/{owner}/{repo}/compare/{basehead}', { owner: c.owner, repo: c.repo, basehead: `${ancestor}...${head}`, per_page: 1 })
    const { status } = expect(CompareSchema, data, 'compare')
    return status === 'ahead' || status === 'identical'
  } catch (e) {
    const status = statusOf(e)
    if (status === 404 || status === 422) return false
    throw e
  }
}

/** A text response (diff or raw file), or undefined on 404 when `allowMissing`. */
async function requestText(c: GitHubClientConfig, route: string, params: Record<string, unknown>, allowMissing: boolean): Promise<string | undefined> {
  try {
    const { data } = await c.api.request(route, { owner: c.owner, repo: c.repo, ...params })
    return expect(Type.String(), data, route)
  } catch (e) {
    if (allowMissing && statusOf(e) === 404) return undefined
    throw e
  }
}

/** Every review on the PR (all pages), each validated against `item`, oldest first. */
async function listReviews<S extends TSchema>(c: GitHubClientConfig, item: S): Promise<readonly Static<S>[]> {
  const out: Static<S>[] = []
  for (let page = 1; ; page++) {
    const { data } = await c.api.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', { owner: c.owner, repo: c.repo, pull_number: c.prNumber, per_page: PAGE_SIZE, page })
    const reviews = expect(Type.Array(item), data, 'pulls.listReviews')
    out.push(...reviews)
    if (reviews.length < PAGE_SIZE) return out
  }
}

/** All review bodies posted by the bot, oldest first (paginated). */
async function botReviewBodies(c: GitHubClientConfig): Promise<readonly string[]> {
  return (await listReviews(c, ReviewSchema)).filter((r) => r.user && sameLogin(r.user.login, c.botLogin)).map((r) => r.body ?? '')
}

/** Every review on the PR, oldest first; reviews by deleted users are dropped. */
async function pullReviews(c: GitHubClientConfig): Promise<readonly PullReview[]> {
  return (await listReviews(c, PullReviewSchema)).flatMap((r) => (r.user ? [{ login: r.user.login, isBot: r.user.type === 'Bot', state: r.state, commitId: r.commit_id ?? '' }] : []))
}

/** True when `login` has write, maintain or admin permission; false for non-collaborators (404). */
async function canApprove(c: GitHubClientConfig, login: string): Promise<boolean> {
  try {
    const { data } = await c.api.request('GET /repos/{owner}/{repo}/collaborators/{username}/permission', { owner: c.owner, repo: c.repo, username: login })
    return WRITE_PERMISSIONS.has(expect(PermissionSchema, data, 'collaborators.permission').permission)
  } catch (e) {
    if (statusOf(e) === 404) return false
    throw e
  }
}

/** Adds `risk:<tier>` and removes the other tier labels (missing ones are fine). */
async function setRiskLabel(c: GitHubClientConfig, tier: RiskTier): Promise<void> {
  const issue = { owner: c.owner, repo: c.repo, issue_number: c.prNumber }
  await c.api.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', { ...issue, labels: [`risk:${tier}`] })
  for (const other of RISK_TIERS.filter((t) => t !== tier)) {
    await c.api.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', { ...issue, name: `risk:${other}` }).catch((e: unknown) => {
      if (statusOf(e) !== 404) throw e
    })
  }
}

/** One page of review threads; throws when the PR does not exist. */
async function threadsPage(c: GitHubClientConfig, after: string | null) {
  const data = await c.api.graphql(THREADS_QUERY, { owner: c.owner, repo: c.repo, pr: c.prNumber, after })
  const pr = expect(ThreadsSchema, data, 'reviewThreads').repository.pullRequest
  if (!pr) throw new Error(`Pull request #${c.prNumber} not found in ${c.owner}/${c.repo}`)
  return pr.reviewThreads
}

/** Threads whose first comment is by the bot (paginated). */
async function botThreads(c: GitHubClientConfig): Promise<readonly BotThread[]> {
  const out: BotThread[] = []
  let after: string | null = null
  do {
    const { nodes, pageInfo } = await threadsPage(c, after)
    for (const t of nodes) {
      const author = t.comments.nodes[0]?.author
      if (author && sameLogin(author.login, c.botLogin)) {
        out.push({ id: t.id, isResolved: t.isResolved, path: t.path, line: t.line, body: t.comments.nodes[0]?.body ?? '' })
      }
    }
    after = pageInfo.hasNextPage ? pageInfo.endCursor : null
  } while (after)
  return out
}

/**
 * Creates the GitHub client the review workflow uses, scoped to one PR.
 *
 * @param config - The Octokit-compatible API, PR coordinates, bot identity, check name and secrets to redact.
 * @returns A {@link GitHub} implementation. Methods reject with the API's error (carrying `status`), or with
 *   "Unexpected GitHub response" when a response does not match the expected shape. Implements {@link GitHub}.
 */
export function createGitHubClient(config: GitHubClientConfig): GitHub {
  const { api, owner, repo, prNumber } = config
  const redact = redactor(config.secrets)
  const permissions = new Map<string, Promise<boolean>>()
  return {
    getPull: () => getPull(config),
    compareDiff: async (base, head) =>
      (await requestText(config, 'GET /repos/{owner}/{repo}/compare/{basehead}', { basehead: `${base}...${head}`, mediaType: { format: 'diff' } }, false)) ?? '',
    isAncestor: (ancestor, head) => isAncestor(config, ancestor, head),
    readAtRef: (ref, path) => requestText(config, 'GET /repos/{owner}/{repo}/contents/{path}', { path, ref, mediaType: { format: 'raw' } }, true),
    botReviewBodies: () => botReviewBodies(config),
    botThreads: () => botThreads(config),
    pullReviews: () => pullReviews(config),
    canApprove(login) {
      const hit = permissions.get(login) ?? canApprove(config, login)
      permissions.set(login, hit)
      return hit
    },
    setRiskLabel: (tier) => setRiskLabel(config, tier),
    async createReview({ headSha, body, comments }) {
      await api.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
        owner,
        repo,
        pull_number: prNumber,
        commit_id: headSha,
        event: 'COMMENT', // findings, never approvals
        body: redact(body),
        comments: comments.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT', body: redact(c.body) })),
      })
    },
    async resolveThread(id) {
      await api.graphql(RESOLVE_MUTATION, { id })
    },
    async setCheck({ name, headSha, conclusion, title, summary }) {
      await api.request('POST /repos/{owner}/{repo}/check-runs', { owner, repo, name, head_sha: headSha, status: 'completed', conclusion, output: { title, summary } })
    },
  }
}
