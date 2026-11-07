import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AgentSession,
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import { type Static, type TSchema, Type } from 'typebox'
import type { Finding } from '../review/index.js'
import type { SecurityFinding } from '../security/index.js'
import { confinedTools } from './sandbox.js'

const PROVIDER = 'anthropic-style-code-review'
// ponytail: fixed per-agent wall clock; make it an input if deep reviews on huge repos hit it.
const AGENT_TIMEOUT_MS = 10 * 60_000

/** Endpoint and models for a {@link Runtime}. */
export type RuntimeConfig = {
  /** OpenAI-compatible base URL. */
  readonly baseUrl: string
  /** Bearer key; supplied at runtime, never written to disk. */
  readonly apiKey: string
  /** Model IDs to register (finder and verifier). */
  readonly models: readonly string[]
}

/** A Pi model registry for one endpoint, plus the isolated agent dir it lives in. */
export type Runtime = Awaited<ReturnType<typeof createRuntime>>

/** Finder output schema (snake_case, as the model sees it). */
export const FindingsSchema = Type.Object({
  findings: Type.Array(
    Type.Object({
      file: Type.String({ description: 'Repo-relative path' }),
      line: Type.Integer({ minimum: 1, description: 'First line, in the NEW version of the file' }),
      end_line: Type.Optional(Type.Integer({ minimum: 1 })),
      title: Type.String({ description: 'One-line summary of the defect' }),
      explanation: Type.String({ description: 'What goes wrong, when, and why' }),
      evidence: Type.String({ description: 'Code quoted exactly from the file' }),
      severity: Type.Union([Type.Literal('important'), Type.Literal('nit'), Type.Literal('pre_existing')]),
      category: Type.Union([Type.Literal('bug'), Type.Literal('style'), Type.Literal('cleanup'), Type.Literal('diagnostic')]),
      bug_class: Type.String({ description: 'Short kebab-case label for this kind of bug' }),
    }),
  ),
})

/** Verifier output schema. */
export const VerdictSchema = Type.Object({ real: Type.Boolean(), reason: Type.String() })

const Level = Type.Union([Type.Literal('high'), Type.Literal('medium'), Type.Literal('low')])

/** Security finder output schema (snake_case, as the model sees it). */
export const SecurityFindingsSchema = Type.Object({
  findings: Type.Array(
    Type.Object({
      file: Type.String({ description: 'Repo-relative path of the sink' }),
      line: Type.Integer({ minimum: 1, description: 'Sink line, in the NEW version of the file' }),
      end_line: Type.Optional(Type.Integer({ minimum: 1 })),
      title: Type.String({ description: 'One-line summary' }),
      vuln_class: Type.String({ description: 'Short kebab-case class, e.g. sql-injection' }),
      source: Type.String({ description: 'Attacker-controlled input and how it arrives' }),
      sink: Type.String({ description: 'Dangerous operation the input reaches' }),
      exploit_scenario: Type.String({ description: 'What the attacker sends and what happens' }),
      impact: Type.String({ description: 'What the attacker gains' }),
      evidence: Type.String({ description: 'Code quoted exactly from the file at the sink' }),
      severity: Level,
      introduced: Type.Boolean({ description: 'True if this PR added or changed the vulnerable path' }),
    }),
  ),
})

/** Risk classifier output schema. */
export const RiskSchema = Type.Object({
  tier: Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')]),
  reasons: Type.Array(Type.String({ description: 'One short reason per risk you found' })),
})

/** Security verifier output schema. */
export const ExploitVerdictSchema = Type.Object({ exploitable: Type.Boolean(), severity: Level, reason: Type.String() })

/** Maps one raw security finding to a {@link SecurityFinding} (normalized path, `endLine >= line`). */
export const toSecurityFinding = (f: Static<typeof SecurityFindingsSchema>['findings'][number]): SecurityFinding => ({
  file: f.file.replace(/^\.?\//, ''),
  line: f.line,
  endLine: Math.max(f.end_line ?? f.line, f.line),
  title: f.title,
  vulnClass: f.vuln_class,
  source: f.source,
  sink: f.sink,
  exploitScenario: f.exploit_scenario,
  impact: f.impact,
  evidence: f.evidence,
  severity: f.severity,
  introduced: f.introduced,
})

/** Maps one raw finder finding to a {@link Finding} (normalized path, `endLine >= line`). */
export const toFinding = (f: Static<typeof FindingsSchema>['findings'][number]): Finding => ({
  file: f.file.replace(/^\.?\//, ''),
  line: f.line,
  endLine: Math.max(f.end_line ?? f.line, f.line),
  title: f.title,
  explanation: f.explanation,
  evidence: f.evidence,
  severity: f.severity,
  category: f.category,
  bugClass: f.bug_class,
})

/** A resource loader that discovers nothing: no repo .pi/ extensions, skills or AGENTS.md; just our system prompt. */
export const sealedLoader = (systemPrompt: string): ResourceLoader => ({
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => systemPrompt,
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
})

/** Registers the endpoint's models in a temp agent dir and sets the key in memory. */
export async function createRuntime(cfg: RuntimeConfig) {
  const agentDir = await mkdtemp(join(tmpdir(), 'anthropic-style-code-review-'))
  const modelsPath = join(agentDir, 'models.json')
  const models = [...new Set(cfg.models)].map((id) => ({ id }))
  await writeFile(modelsPath, JSON.stringify({ providers: { [PROVIDER]: { baseUrl: cfg.baseUrl, api: 'openai-completions', models } } }))
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath })
  await modelRuntime.setRuntimeApiKey(PROVIDER, cfg.apiKey)
  const model = (id: string) => {
    const m = modelRuntime.getModel(PROVIDER, id)
    if (!m) throw new Error(`Model ${PROVIDER}/${id} not registered`)
    return m
  }
  return { agentDir, modelRuntime, model }
}

/** One structured agent task: which model, prompts and submit tool. */
export type StructuredTask<S extends TSchema> = {
  /** Short name for logs, e.g. `finder:logic` or `verify src/a.ts:12 "Title"`. */
  readonly label: string
  /** Model ID. */
  readonly modelId: string
  /** System prompt. */
  readonly system: string
  /** User prompt. */
  readonly prompt: string
  /** Name of the terminating submit tool. */
  readonly toolName: string
  /** Schema the submit tool's arguments are validated against. */
  readonly schema: S
}

/** Opens a sealed, read-only session whose only extra tool is `submit`. */
async function openSession(rt: Runtime, cwd: string, task: StructuredTask<TSchema>, submit: ReturnType<typeof defineTool>) {
  const { session } = await createAgentSession({
    cwd,
    agentDir: rt.agentDir,
    modelRuntime: rt.modelRuntime,
    model: rt.model(task.modelId),
    thinkingLevel: 'off',
    resourceLoader: sealedLoader(task.system),
    // Built-ins off; read/grep/find/ls come back path-confined to the repo.
    noTools: 'builtin',
    customTools: [...confinedTools(cwd), submit],
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 4, baseDelayMs: 2000 } }),
  })
  return session
}

/** Why a session ended without submitting: the model's API error if any, else a missing-tool message. */
function failureReason(session: AgentSession, toolName: string): Error {
  const last = session.messages.findLast((m) => m.role === 'assistant')
  const err = last && 'errorMessage' in last ? last.errorMessage : undefined
  return new Error(err ? `model error: ${err}` : `agent ended without calling ${toolName}`)
}

/** Sink for per-agent progress lines. */
export type AgentLog = (line: string) => void

/** A string field of an untyped tool-args object, flattened to one line and shortened. */
function arg(args: unknown, key: string): string | undefined {
  const v: unknown = typeof args === 'object' && args !== null ? Reflect.get(args, key) : undefined
  if (typeof v !== 'string' && typeof v !== 'number') return undefined
  const s = String(v).replace(/\s+/g, ' ')
  return s.length > 80 ? `${s.slice(0, 77)}...` : s
}

/** `grep "pattern" in path`, `read path:offset`, `ls path`. */
function describeCall(tool: string, args: unknown): string {
  const pattern = arg(args, 'pattern')
  const path = arg(args, 'path')
  const offset = arg(args, 'offset')
  const target = [pattern === undefined ? undefined : `"${pattern}"`, path === undefined ? undefined : `${pattern === undefined ? '' : 'in '}${path}${offset ? `:${offset}` : ''}`]
  return [tool, ...target.filter((t) => t !== undefined)].join(' ')
}

/** Logs one session's tool calls, failed tools and retries; returns the unsubscribe function and a tool counter. */
function watch(session: AgentSession, task: StructuredTask<TSchema>, log: AgentLog) {
  let calls = 0
  const off = session.subscribe((e) => {
    if (e.type === 'tool_execution_start' && e.toolName !== task.toolName) {
      calls++
      log(`  ${task.label} ${describeCall(e.toolName, e.args)}`)
    } else if (e.type === 'tool_execution_end' && e.isError && e.toolName !== task.toolName) {
      log(`  ${task.label} ✗ ${e.toolName} failed`)
    } else if (e.type === 'auto_retry_start') {
      log(`  ${task.label} ⟳ retry ${e.attempt}/${e.maxAttempts} in ${Math.round(e.delayMs / 1000)}s (${e.errorMessage})`)
    }
  })
  return { off, calls: () => calls }
}

/** Whole seconds since `start`. */
const since = (start: number) => `${Math.round((Date.now() - start) / 1000)}s`

/**
 * Runs one agent session until it calls the submit tool, nudging once if it answers in prose
 * (we can't rely on tool_choice; Ollama, among others, lacks it).
 */
export async function runStructured<S extends TSchema>(rt: Runtime, cwd: string, task: StructuredTask<S>, log: AgentLog = () => {}): Promise<Static<S>> {
  let result: Static<S> | undefined
  const submit = defineTool({
    name: task.toolName,
    label: task.toolName,
    description: 'Submit your final answer. Call exactly once, as your last action.',
    parameters: task.schema,
    async execute(_id, params) {
      result = params
      return { content: [{ type: 'text', text: 'Recorded.' }], details: {}, terminate: true }
    },
  })
  const start = Date.now()
  log(`▶ ${task.label} (${task.modelId})`)
  const session = await openSession(rt, cwd, task, submit)
  const watcher = watch(session, task, log)
  const timer = setTimeout(() => void session.abort(), AGENT_TIMEOUT_MS)
  try {
    await session.prompt(task.prompt)
    if (result === undefined) {
      log(`  ${task.label} answered in prose; nudging it to submit`)
      await session.prompt(`Call ${task.toolName} now with your final answer. Do not reply with prose.`)
    }
    if (result === undefined) throw failureReason(session, task.toolName)
    log(`✔ ${task.label} ${since(start)}, ${watcher.calls()} tool call${watcher.calls() === 1 ? '' : 's'}`)
    return result
  } catch (e) {
    log(`✗ ${task.label} failed after ${since(start)}: ${e instanceof Error ? e.message : String(e)}`)
    throw e
  } finally {
    clearTimeout(timer)
    watcher.off()
    session.dispose()
  }
}
