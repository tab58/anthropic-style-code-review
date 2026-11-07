import type { Reviewer } from '../review/index.js'
import { FINDER_SYSTEM, finderPrompt, RECHECK_SYSTEM, recheckPrompt, VERIFIER_SYSTEM, verifierPrompt } from './prompts.js'
import { createRuntime, FindingsSchema, runStructured, toFinding, VerdictSchema } from './session.js'

/** Endpoint, models and checkout for {@link createPiReviewer}. */
export type PiReviewerConfig = {
  /** OpenAI-compatible base URL, e.g. `https://ollama.com/v1`. */
  readonly baseUrl: string
  /** API key, sent as a Bearer token; kept in memory only. */
  readonly apiKey: string
  /** Model ID for finder agents. */
  readonly finderModel: string
  /** Model ID for verifier and recheck agents. */
  readonly verifierModel: string
  /** Absolute path of the repo checkout the agents may read (and nothing outside it). */
  readonly cwd: string
}

/**
 * Creates a {@link Reviewer} whose finders and verifiers are Pi agent sessions on an OpenAI-compatible API.
 * Each session has only path-confined read/grep/find/ls tools plus one terminating submit tool, and loads
 * no configuration from the repo.
 *
 * @param config - Endpoint, models and checkout path.
 * @returns A reviewer. Its methods reject with the model's API error, or when an agent never submits after one nudge.
 * @throws {@link Error} If the model registry cannot be created.
 */
export async function createPiReviewer(config: PiReviewerConfig): Promise<Reviewer> {
  const rt = await createRuntime({ baseUrl: config.baseUrl, apiKey: config.apiKey, models: [config.finderModel, config.verifierModel] })
  const verdict = (system: string, prompt: string) =>
    runStructured(rt, config.cwd, { modelId: config.verifierModel, system, prompt, toolName: 'submit_verdict', schema: VerdictSchema })

  return {
    async find(focus, input) {
      const task = { modelId: config.finderModel, system: FINDER_SYSTEM, prompt: finderPrompt(focus, input), toolName: 'submit_findings', schema: FindingsSchema }
      return (await runStructured(rt, config.cwd, task)).findings.map(toFinding)
    },
    verify: (finding, input) => verdict(VERIFIER_SYSTEM, verifierPrompt(finding, input)),
    recheck: async (issue, input) => (await verdict(RECHECK_SYSTEM, recheckPrompt(issue, input))).real,
  }
}
