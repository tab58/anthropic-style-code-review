import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  defineTool,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import type { TSchema } from 'typebox'

/*
 * Pi has no sandbox: its read/grep/find/ls accept absolute paths. A prompt-injected agent could read
 * /proc/self/environ (action inputs incl. API key + token) and quote it into a public PR comment.
 * Every path argument must resolve, after symlinks, inside the repo and outside .git.
 */

/** realpath of the longest existing prefix (the target may not exist). */
async function real(p: string): Promise<string> {
  try {
    return await realpath(p)
  } catch {
    const parent = dirname(p)
    return parent === p ? p : join(await real(parent), basename(p))
  }
}

const ESCAPES_GLOB = /(^|\/)\.\.(\/|$)/

/** Rejects `pattern`/`glob` values that point outside the repo. */
function checkPatterns(args: object): string | undefined {
  for (const key of ['pattern', 'glob'] as const) {
    const v: unknown = Reflect.get(args, key)
    if (typeof v === 'string' && (ESCAPES_GLOB.test(v) || v.startsWith('/') || v.startsWith('~'))) {
      return `Invalid ${key} "${v}": search patterns must stay inside the repository.`
    }
  }
  return undefined
}

/** Rejects a `path` that resolves (after symlinks) outside `cwd` or into `.git`. */
async function checkPath(cwd: string, raw: unknown): Promise<string | undefined> {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string') return 'path must be a string'
  const outside = `Path "${raw}" is outside the repository; only repository files may be read.`
  const path = raw.replace(/^@/, '') // Pi strips a leading @
  if (path.startsWith('~')) return outside

  const root = await real(cwd)
  const rel = relative(root, await real(resolve(root, path)))
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return outside
  if (rel.split(sep).includes('.git')) return `Path "${raw}" is inside .git; read source files instead.`
  return undefined
}

/** Validates a tool call's arguments; resolves with an error message to return to the model, or undefined if allowed. */
export async function checkToolArgs(cwd: string, args: unknown): Promise<string | undefined> {
  if (typeof args !== 'object' || args === null) return 'tool arguments must be an object'
  return checkPatterns(args) ?? (await checkPath(cwd, Reflect.get(args, 'path')))
}

/** Wraps a tool so every call's arguments pass {@link checkToolArgs} first; `defineTool` erases its generics for the session. */
function confine<T extends TSchema, D>(cwd: string, def: ToolDefinition<T, D>) {
  return defineTool<T, D>({
    ...def,
    async execute(id, params, ...rest) {
      const err = await checkToolArgs(cwd, params)
      if (err) throw new Error(err)
      return def.execute(id, params, ...rest)
    },
  })
}

/** read, grep, find and ls, rooted at `cwd`, with every call's paths checked first. */
export function confinedTools(cwd: string): readonly ToolDefinition[] {
  return [
    confine(cwd, createReadToolDefinition(cwd)),
    confine(cwd, createGrepToolDefinition(cwd)),
    confine(cwd, createFindToolDefinition(cwd)),
    confine(cwd, createLsToolDefinition(cwd)),
  ]
}
