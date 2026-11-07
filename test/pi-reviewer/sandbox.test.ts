import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { checkToolArgs, confinedTools } from '../../src/pi-reviewer/sandbox.js'

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'confine-'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/a.ts'), 'x')
  await mkdir(join(root, '.git'))
  await symlink('/etc', join(root, 'escape'))
})

describe('checkToolArgs', () => {
  it.each([
    [{ path: 'src/a.ts' }],
    [{ path: './src' }],
    [{ path: 'src/missing.ts' }],
    [{}],
    [{ pattern: 'TODO', glob: '**/*.ts' }],
    [{ path: '@src/a.ts' }],
  ])('allows %j', async (args) => {
    expect(await checkToolArgs(root, args)).toBeUndefined()
  })

  it.each([
    [{ path: '/proc/self/environ' }, /outside/],
    [{ path: '@/etc/passwd' }, /outside/],
    [{ path: '~/.ssh/id_rsa' }, /outside/],
    [{ path: '../secrets' }, /outside/],
    [{ path: 'src/../../x' }, /outside/],
    [{ path: 'escape/passwd' }, /outside/],
    [{ path: '.git/config' }, /\.git/],
    [{ pattern: '../../etc/*' }, /pattern/],
    [{ pattern: '*.ts', glob: '/etc/**' }, /pattern/],
  ])('blocks %j', async (args, err) => {
    expect(await checkToolArgs(root, args)).toMatch(err)
  })
})

describe('checkToolArgs input shapes', () => {
  it.each([[null], ['str'], [42]])('rejects non-object args %j', async (args) => {
    expect(await checkToolArgs(root, args)).toMatch(/must be an object/)
  })

  it('rejects a non-string path', async () => {
    expect(await checkToolArgs(root, { path: 7 })).toMatch(/must be a string/)
  })

  it('allows an empty path (the repo root)', async () => {
    expect(await checkToolArgs(root, { path: '' })).toBeUndefined()
  })
})

describe('confinedTools', () => {
  it('provides read, grep, find and ls', () => {
    expect(confinedTools(root).map((t) => t.name)).toEqual(['read', 'grep', 'find', 'ls'])
  })

  it('refuses out-of-repo paths before running the tool, and runs allowed calls', async () => {
    const read = confinedTools(root).find((t) => t.name === 'read')
    if (!read) throw new Error('read tool missing')
    const ctx = {} as never
    await expect(read.execute('id', { path: '/etc/hosts' }, undefined, undefined, ctx)).rejects.toThrow(/outside the repository/)
    const ok = await read.execute('id', { path: 'src/a.ts' }, undefined, undefined, ctx)
    expect(JSON.stringify(ok.content)).toContain('x')
  })
})
