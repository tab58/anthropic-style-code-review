import type { TSchema } from 'typebox'
import type { Reviewer } from '../review/index.js'
import type { RiskClassifier } from '../risk/index.js'
import type { SecurityReviewer } from '../security/index.js'
import {
  exploitPrompt,
  FINDER_SYSTEM,
  finderPrompt,
  RECHECK_SYSTEM,
  recheckPrompt,
  RISK_SYSTEM,
  riskPrompt,
  SECURITY_FINDER_SYSTEM,
  SECURITY_VERIFIER_SYSTEM,
  securityFinderPrompt,
  VERIFIER_SYSTEM,
  verifierPrompt,
} from './prompts.js'
import {
  createRuntime,
  ExploitVerdictSchema,
  FindingsSchema,
  RiskSchema,
  type AgentLog,
  type Reasoning,
  runStructured,
  SecurityFindingsSchema,
  type StructuredTask,
  toFinding,
  toSecurityFinding,
  VerdictSchema,
} from './session.js'

// ponytail: fixed turn budgets; make them inputs if deep reviews of big diffs need more.
/** Model calls a finder may make before it must submit. */
const FINDER_TURNS = 15
/** Model calls a single-finding agent (verify, recheck, exploit, risk) may make before it must submit. */
const VERIFIER_TURNS = 6

/** `file:line` for a log label. */
const at = (l: { readonly file: string; readonly line: number }) => `${l.file}:${l.line}`

/** Endpoint, models and checkout for {@link createPiReviewer}. */
export type PiReviewerConfig = {
  /** OpenAI-compatible base URL, e.g. `https://ollama.com/v1`. */
  readonly baseUrl: string
  /** API key, sent as a Bearer token; kept in memory only. */
  readonly apiKey: string
  /** Model ID for bug finder agents. */
  readonly finderModel: string
  /** Model ID for bug verifier and recheck agents. */
  readonly verifierModel: string
  /** Model ID for security finders; defaults to `finderModel`. */
  readonly securityFinderModel?: string
  /** Model ID for security verifiers; defaults to `verifierModel`. */
  readonly securityVerifierModel?: string
  /** Reasoning effort for finder agents (bug and security). Default `none`. */
  readonly finderReasoning?: Reasoning
  /** Reasoning effort for verifier, recheck, exploit and risk agents. Default `none`. */
  readonly verifierReasoning?: Reasoning
  /** Absolute path of the repo checkout the agents may read (and nothing outside it). */
  readonly cwd: string
  /** Receives one line per agent start, tool call, retry and finish. Lines can quote model text. Default: discard. */
  readonly log?: AgentLog
}

/**
 * Creates a reviewer whose bug and security finders and verifiers are Pi agent sessions on an
 * OpenAI-compatible API. Each session has only path-confined read/grep/find/ls tools plus one terminating
 * submit tool, and loads no configuration from the repo.
 *
 * @param config - Endpoint, models and checkout path.
 * @returns A {@link Reviewer}, {@link SecurityReviewer} and {@link RiskClassifier} (on the verifier model). Its methods reject with the model's API error, or
 *   when an agent never submits after one nudge.
 * @throws {@link Error} If the model registry cannot be created.
 */
export async function createPiReviewer(config: PiReviewerConfig): Promise<Reviewer & SecurityReviewer & RiskClassifier> {
  const securityFinder = config.securityFinderModel ?? config.finderModel
  const securityVerifier = config.securityVerifierModel ?? config.verifierModel
  const rt = await createRuntime({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    models: [config.finderModel, config.verifierModel, securityFinder, securityVerifier],
  })
  // Voters and rechecks run in parallel under the same label; number repeats so their log lines can be told apart.
  const seen = new Map<string, number>()
  const numbered = (label: string) => {
    const n = (seen.get(label) ?? 0) + 1
    seen.set(label, n)
    return n === 1 ? label : `${label} #${n}`
  }
  const budgets = {
    finder: { reasoning: config.finderReasoning ?? 'none', maxTurns: FINDER_TURNS },
    verifier: { reasoning: config.verifierReasoning ?? 'none', maxTurns: VERIFIER_TURNS },
  } as const
  const run = <S extends TSchema>(role: keyof typeof budgets, task: Omit<StructuredTask<S>, 'reasoning' | 'maxTurns'>) =>
    runStructured(rt, config.cwd, { ...task, ...budgets[role], label: numbered(task.label) }, config.log)
  const verdict = (label: string, system: string, prompt: string) =>
    run('verifier', { label, modelId: config.verifierModel, system, prompt, toolName: 'submit_verdict', schema: VerdictSchema })

  return {
    async find(focus, input) {
      const task = { label: `finder:${focus}`, modelId: config.finderModel, system: FINDER_SYSTEM, prompt: finderPrompt(focus, input), toolName: 'submit_findings', schema: FindingsSchema }
      return (await run('finder', task)).findings.map(toFinding)
    },
    verify: (finding, input) => verdict(`verify ${at(finding)} "${finding.title}"`, VERIFIER_SYSTEM, verifierPrompt(finding, input)),
    recheck: async (issue, input) => (await verdict(`recheck ${issue.file}:${issue.line}`, RECHECK_SYSTEM, recheckPrompt(issue, input))).real,
    async findVulnerabilities(focus, input) {
      const task = { label: `security:${focus}`, modelId: securityFinder, system: SECURITY_FINDER_SYSTEM, prompt: securityFinderPrompt(focus, input), toolName: 'submit_security_findings', schema: SecurityFindingsSchema }
      return (await run('finder', task)).findings.map(toSecurityFinding)
    },
    judgeExploit: (finding, input) =>
      run('verifier', { label: `exploit ${at(finding)} "${finding.title}"`, modelId: securityVerifier, system: SECURITY_VERIFIER_SYSTEM, prompt: exploitPrompt(finding, input), toolName: 'submit_exploit_verdict', schema: ExploitVerdictSchema }),
    classifyRisk: (input) => run('verifier', { label: 'risk', modelId: config.verifierModel, system: RISK_SYSTEM, prompt: riskPrompt(input), toolName: 'submit_risk', schema: RiskSchema }),
  }
}
