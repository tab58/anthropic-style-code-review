import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { createLocalGitHub } from './local-github.js'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim()

let repo: string
let baseSha: string
let headSha: string

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'local-gh-'))
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'REVIEW.md'), 'rules')
  writeFileSync(join(repo, 'a.ts'), 'x\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'base')
  baseSha = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'checkout', '-qb', 'feature')
  writeFileSync(join(repo, 'a.ts'), 'x\ny\n')
  git(repo, 'commit', '-qam', 'Add y')
  headSha = git(repo, 'rev-parse', 'HEAD')
})

const make = (printed: string[] = []) =>
  createLocalGitHub({ repo, base: 'main', statePath: join(repo, '.git', 'review-test', `${Math.random()}.json`), print: (t) => printed.push(t) })

describe('createLocalGitHub', () => {
  it('describes HEAD vs base as the PR, titled by the commit subject', async () => {
    expect(await make().getPull()).toEqual({ number: 0, headSha, baseSha, title: 'Add y', body: '', isFork: false, draft: false })
  })

  it('diffs, checks ancestry and reads files at a ref from git', async () => {
    const gh = make()
    expect(await gh.compareDiff(baseSha, headSha)).toContain('+y')
    expect(await gh.isAncestor(baseSha, headSha)).toBe(true)
    expect(await gh.isAncestor(headSha, baseSha)).toBe(false)
    expect(await gh.isAncestor('deadbeef', headSha)).toBe(false)
    expect(await gh.readAtRef(baseSha, 'REVIEW.md')).toBe('rules')
    expect(await gh.readAtRef(baseSha, 'missing.md')).toBeUndefined()
  })

  it('persists reviews and threads, prints them without hidden markers, and resolves threads', async () => {
    const printed: string[] = []
    const gh = make(printed)
    await gh.createReview({ headSha, body: 'Summary <!-- state -->', comments: [{ path: 'a.ts', line: 2, body: 'Bug <!-- marker -->' }] })
    expect(await gh.botReviewBodies()).toEqual(['Summary <!-- state -->'])
    expect(await gh.botThreads()).toEqual([{ id: 't1', isResolved: false, path: 'a.ts', line: 2, body: 'Bug <!-- marker -->' }])
    expect(printed.join('\n')).toContain('a.ts:2')
    expect(printed.join('\n')).not.toContain('<!--')

    await gh.resolveThread('t1')
    expect((await gh.botThreads())[0]?.isResolved).toBe(true)
    await gh.setCheck({ headSha, conclusion: 'success', title: 'ok', summary: '' })
    expect(printed.at(-1)).toContain('pass')
  })
})
