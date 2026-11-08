import type { Reasoning } from './pi-reviewer/index.js'
import type { WorkflowOptions } from './workflow/index.js'

/** Where action inputs come from (e.g. `@actions/core`'s `getInput`). */
export interface InputSource {
  /** The input's value, or an empty string when unset. */
  get(name: string): string
}

/** The triggering GitHub event. */
export type EventInfo = {
  /** Event name, e.g. `pull_request`, `pull_request_review`, `pull_request_review_comment`, `workflow_dispatch`. */
  readonly name: string
  /** PR number from the event payload, when the event carries one. */
  readonly prNumber?: number
}

/** Validated action inputs. */
export type ActionInputs = {
  /** `gate` for PR review and review-comment events (no LLM calls), `review` otherwise. */
  readonly event: 'review' | 'gate'
  /** PR to act on. */
  readonly prNumber: number
  /** True only for `workflow_dispatch`, where a maintainer chose to review a fork PR. */
  readonly allowFork: boolean
  /** Provider API key; empty string on gate runs. */
  readonly apiKey: string
  /** GitHub token. */
  readonly githubToken: string
  /** OpenAI-compatible base URL. */
  readonly baseUrl: string
  /** Finder model ID. */
  readonly finderModel: string
  /** Verifier model ID. */
  readonly verifierModel: string
  /** Security finder model ID; undefined → the finder model. */
  readonly securityFinderModel: string | undefined
  /** Security verifier model ID; undefined → the verifier model. */
  readonly securityVerifierModel: string | undefined
  /** Reasoning effort for finder agents. */
  readonly finderReasoning: Reasoning
  /** Reasoning effort for verifier, recheck, exploit and risk agents. */
  readonly verifierReasoning: Reasoning
  /** Login the reviews are posted as. */
  readonly botLogin: string
  /** Workflow tuning; unset inputs are left undefined so workflow and REVIEW.md defaults apply. */
  readonly workflow: WorkflowOptions
}

/** Parses an optional integer input; undefined when unset. */
function intInput(source: InputSource, name: string, min: number): number | undefined {
  const raw = source.get(name)
  if (raw === '') return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min) throw new Error(`Input ${name} must be an integer >= ${min}, got "${raw}"`)
  return n
}

/** A required string input; throws like `@actions/core` when it is empty. */
function required(source: InputSource, name: string): string {
  const v = source.get(name)
  if (v === '') throw new Error(`Input required and not supplied: ${name}`)
  return v
}

/** `on`/`off` switch; empty means unset. */
function onOff(source: InputSource, name: string): boolean | undefined {
  const raw = source.get(name).trim().toLowerCase()
  if (raw === '') return undefined
  if (raw === 'on' || raw === 'true') return true
  if (raw === 'off' || raw === 'false') return false
  throw new Error(`Input ${name} must be on or off, got "${raw}"`)
}
const REASONING: readonly Reasoning[] = ['none', 'low', 'medium', 'high']

/** A reasoning-effort input; empty means `none`. */
function reasoningInput(source: InputSource, name: string): Reasoning {
  const raw = source.get(name).trim().toLowerCase()
  if (raw === '') return 'none'
  const level = REASONING.find((r) => r === raw)
  if (level === undefined) throw new Error(`Input ${name} must be one of ${REASONING.join(', ')}, got "${raw}"`)
  return level
}

/** Events that only recompute the merge gates. `workflow_run` is the relay for hardened setups (see README). */
const GATE_EVENTS = new Set(['pull_request_review', 'pull_request_review_comment', 'workflow_run'])

/** Workflow tuning inputs, validated. */
const workflowOptions = (source: InputSource): WorkflowOptions => ({
  depth: source.get('depth') || undefined,
  voters: intInput(source, 'voters', 1),
  votesNeeded: intInput(source, 'votes_needed', 1),
  maxRounds: intInput(source, 'max_rounds', 1),
  maxDiffLines: intInput(source, 'max_diff_lines', 1),
  maxFindings: intInput(source, 'max_findings_to_verify', 1),
  concurrency: intInput(source, 'max_concurrency', 1),
  nitCap: intInput(source, 'nit_cap', 0),
  securityReview: onOff(source, 'security_review'),
  checkName: source.get('check_name') || undefined,
  riskTiers: onOff(source, 'risk_tiers'),
})

/**
 * Reads and validates the action's inputs for an event.
 *
 * @param source - Input values (empty string = unset).
 * @param event - The triggering event; its PR number wins over the `pr_number` input.
 * @returns Validated inputs.
 * @throws {@link Error} If there is no PR number, `github_token` is empty, `provider_api_key` is empty on a review
 *   event, a numeric input is not an integer in range, or `security_review` / `risk_tiers` is not on/off.
 */
export function readInputs(source: InputSource, event: EventInfo): ActionInputs {
  const prNumber = event.prNumber ?? intInput(source, 'pr_number', 1)
  if (prNumber === undefined) throw new Error('No pull request: run on pull_request / pull_request_review, or pass pr_number.')
  const kind = GATE_EVENTS.has(event.name) ? 'gate' : 'review'
  return {
    event: kind,
    prNumber,
    allowFork: event.name === 'workflow_dispatch',
    apiKey: kind === 'review' ? required(source, 'provider_api_key') : source.get('provider_api_key'),
    githubToken: required(source, 'github_token'),
    baseUrl: source.get('base_url'),
    finderModel: source.get('finder_model'),
    verifierModel: source.get('verifier_model'),
    securityFinderModel: source.get('security_finder_model') || undefined,
    securityVerifierModel: source.get('security_verifier_model') || undefined,
    finderReasoning: reasoningInput(source, 'finder_reasoning'),
    verifierReasoning: reasoningInput(source, 'verifier_reasoning'),
    botLogin: source.get('bot_login'),
    workflow: workflowOptions(source),
  }
}
