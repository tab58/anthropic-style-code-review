import { describe, expect, it, vi } from 'vitest'
import { parseDiff } from '../../src/diff.js'
import {
  approvers,
  assessRisk,
  classifyRisk,
  maxTier,
  type PullReview,
  requiredApprovals,
  type RiskClassifier,
  type RiskSignals,
} from '../../src/risk/index.js'

const diffOf = (path: string, lines = 1, text = 'x') =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${lines} @@\n${Array.from({ length: lines }, () => `+${text}`).join('\n')}\n`

const signals = (diff: string, over: Partial<RiskSignals> = {}): RiskSignals => ({
  files: parseDiff(diff),
  highPaths: [],
  securityPaths: [],
  blockingSecurity: false,
  importantBug: false,
  skipped: false,
  ...over,
})

describe('maxTier', () => {
  it('returns the highest tier, low when given none', () => {
    expect(maxTier()).toBe('low')
    expect(maxTier('low', 'high', 'medium')).toBe('high')
    expect(maxTier('medium', undefined, 'low')).toBe('medium')
  })
})

describe('assessRisk', () => {
  it('is low for small docs- and test-only changes', () => {
    const r = assessRisk(signals(diffOf('README.md') + diffOf('docs/guide.txt') + diffOf('test/a.test.ts') + diffOf('src/x.spec.ts')))
    expect(r).toEqual({ tier: 'low', reasons: ['docs, tests and comments only'] })
  })

  const edit = (path: string, minus: readonly string[], plus: readonly string[]) =>
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${minus.length + 1} +1,${plus.length + 1} @@\n ctx\n${[...minus.map((l) => `-${l}`), ...plus.map((l) => `+${l}`)].join('\n')}\n`

  it.each([
    ['go line comment', 'utils/map.go', ['// Keys returns the keys'], ['// Keys returns the keys, in unspecified order.']],
    ['ts block comment', 'src/a.ts', [], ['/**', ' * Does a thing.', ' */']],
    ['python comment and blank line', 'app/x.py', [], ['# note', '']],
    ['sql comment', 'db/q.sql', ['-- old'], ['-- new']],
  ])('is low when source changes only touch comments (%s)', (_, path, minus, plus) => {
    expect(assessRisk(signals(edit(path, minus, plus)))).toEqual({ tier: 'low', reasons: ['docs, tests and comments only'] })
  })

  it.each([
    ['code next to a comment', 'a.go', [], ['// note', 'x := 1']],
    ['a Go pointer write', 'a.go', [], ['*p = 1']],
    ['a C preprocessor line', 'a.c', [], ['#include <x.h>']],
    ['a file type without known comment syntax', 'a.yaml', [], ['# note']],
    ['a comment marker inside a string', 'a.go', [], ['s := "// not a comment"']],
  ])('is medium when a comment-looking change is really code (%s)', (_, path, minus, plus) => {
    expect(assessRisk(signals(edit(path, minus, plus))).tier).toBe('medium')
  })

  it('is low for an empty diff', () => {
    expect(assessRisk(signals('')).tier).toBe('low')
  })

  it('is medium for any source change', () => {
    const r = assessRisk(signals(diffOf('src/ui.ts')))
    expect(r.tier).toBe('medium')
    expect(r.reasons).toEqual(['changes source: src/ui.ts'])
  })

  it('is medium for more than 200 changed lines, even in docs', () => {
    const r = assessRisk(signals(diffOf('docs/a.md', 201)))
    expect(r).toEqual({ tier: 'medium', reasons: ['201 changed lines (> 200)'] })
    expect(assessRisk(signals(diffOf('docs/a.md', 200))).tier).toBe('low')
  })

  it('is medium when an Important bug was posted', () => {
    expect(assessRisk(signals(diffOf('README.md'), { importantBug: true }))).toEqual({ tier: 'medium', reasons: ['an Important bug was found'] })
  })

  it('is medium (not high) for paths or code that escalate the security pass, even docs-like ones', () => {
    expect(assessRisk(signals(diffOf('src/auth/login.ts')))).toEqual({ tier: 'medium', reasons: ['security-sensitive paths or code', 'changes source: src/auth/login.ts'] })
    expect(assessRisk(signals(diffOf('src/run.ts', 1, 'child_process.exec(cmd)'))).tier).toBe('medium')
    expect(assessRisk(signals(diffOf('docs/session.md'))).reasons).toContain('security-sensitive paths or code')
    expect(assessRisk(signals(diffOf('src/pay.ts'), { securityPaths: ['src/pay.ts'] })).reasons).toContain('security-sensitive paths or code')
  })

  it('is high for CI workflow files', () => {
    expect(assessRisk(signals(diffOf('.github/workflows/ci.yml')))).toEqual({ tier: 'high', reasons: ['changes CI workflows: .github/workflows/ci.yml'] })
    expect(assessRisk(signals(diffOf('.github/workflows/release.yaml'))).tier).toBe('high')
    expect(assessRisk(signals(diffOf('.github/dependabot.yml'))).tier).toBe('medium')
  })

  it('matches risk_high_paths and security_paths against dotfiles and dot-directories', () => {
    expect(assessRisk(signals(diffOf('config/.prod.env'), { highPaths: ['config/**'] })).tier).toBe('high')
    expect(assessRisk(signals(diffOf('src/.secrets/x.ts'), { securityPaths: ['src/**'] })).reasons).toContain('security-sensitive paths or code')
  })

  it('is high for risk_high_paths, blocking security findings, or a skipped review', () => {
    expect(assessRisk(signals(diffOf('db/schema.sql'), { highPaths: ['db/**'] })).reasons).toContain('matches risk_high_paths: db/schema.sql')
    expect(assessRisk(signals(diffOf('README.md'), { blockingSecurity: true }))).toEqual({ tier: 'high', reasons: ['a High/Medium security finding was introduced'] })
    expect(assessRisk(signals(diffOf('README.md'), { skipped: true }))).toEqual({ tier: 'high', reasons: ['automated review did not run on these commits'] })
  })

  it('lists every reason at the winning tier only', () => {
    const r = assessRisk(signals(diffOf('.github/workflows/ci.yml'), { blockingSecurity: true, importantBug: true }))
    expect(r.tier).toBe('high')
    expect(r.reasons).toEqual(['changes CI workflows: .github/workflows/ci.yml', 'a High/Medium security finding was introduced'])
  })

  it('names at most 3 files per reason', () => {
    const r = assessRisk(signals(['a', 'b', 'c', 'd'].map((n) => diffOf(`src/${n}.ts`)).join('')))
    expect(r.reasons).toEqual(['changes source: src/a.ts, src/b.ts, src/c.ts and 1 more'])
  })
})

describe('requiredApprovals', () => {
  it('defaults to 0/1/2 and applies overrides per tier', () => {
    expect([requiredApprovals('low'), requiredApprovals('medium'), requiredApprovals('high')]).toEqual([0, 1, 2])
    expect(requiredApprovals('medium', { medium: 0 })).toBe(0)
    expect(requiredApprovals('high', { medium: 0 })).toBe(2)
    expect(requiredApprovals('high', {})).toBe(2)
  })
})

describe('approvers', () => {
  const review = (login: string, state: PullReview['state'], over: Partial<PullReview> = {}): PullReview => ({ login, isBot: false, state, commitId: 'h', ...over })
  const pr = { headSha: 'h', author: 'alice' }

  it('returns users whose latest decisive review approved the head commit', () => {
    expect(approvers([review('bob', 'APPROVED'), review('carol', 'APPROVED')], pr)).toEqual(['bob', 'carol'])
  })

  it('ignores the author, bots, stale commits and empty input', () => {
    expect(approvers([], pr)).toEqual([])
    expect(approvers([review('alice', 'APPROVED'), review('ci[bot]', 'APPROVED', { isBot: true }), review('bob', 'APPROVED', { commitId: 'old' })], pr)).toEqual([])
  })

  it('lets the latest decisive review win; comments do not undo an approval', () => {
    expect(approvers([review('bob', 'APPROVED'), review('bob', 'CHANGES_REQUESTED')], pr)).toEqual([])
    expect(approvers([review('bob', 'CHANGES_REQUESTED'), review('bob', 'APPROVED')], pr)).toEqual(['bob'])
    expect(approvers([review('bob', 'APPROVED'), review('bob', 'COMMENTED'), review('bob', 'PENDING')], pr)).toEqual(['bob'])
    expect(approvers([review('bob', 'APPROVED'), review('bob', 'DISMISSED')], pr)).toEqual([])
  })

  it('counts a user once, ignoring login case for the author', () => {
    expect(approvers([review('bob', 'APPROVED'), review('bob', 'APPROVED'), review('Alice', 'APPROVED')], pr)).toEqual(['bob'])
  })
})

describe('classifyRisk', () => {
  const floor = { tier: 'medium' as const, reasons: ['changes source: src/a.ts'] }
  const input = { diff: 'd', intent: 'i', floor }
  const classifier = (out: Awaited<ReturnType<RiskClassifier['classifyRisk']>>): RiskClassifier => ({ classifyRisk: vi.fn(async () => out) })

  it('raises the floor and adds the classifier reasons', async () => {
    const c = classifier({ tier: 'high', reasons: ['changes billing math'] })
    expect(await classifyRisk(c, input)).toEqual({ tier: 'high', reasons: ['changes source: src/a.ts', 'classifier: changes billing math'] })
    expect(c.classifyRisk).toHaveBeenCalledWith(input)
  })

  it('never lowers the floor', async () => {
    expect(await classifyRisk(classifier({ tier: 'low', reasons: ['trivial'] }), input)).toEqual(floor)
  })

  it('keeps the floor reasons when the classifier agrees', async () => {
    expect(await classifyRisk(classifier({ tier: 'medium', reasons: ['ok'] }), input)).toEqual(floor)
  })

  it('falls back to at least medium when the classifier fails', async () => {
    const failing: RiskClassifier = { classifyRisk: vi.fn().mockRejectedValue(new Error('429')) }
    expect(await classifyRisk(failing, { ...input, floor: { tier: 'low', reasons: ['docs and tests only'] } })).toEqual({
      tier: 'medium',
      reasons: ['docs and tests only', 'risk classifier failed (429); assumed at least medium'],
    })
    const rejectsString: RiskClassifier = { classifyRisk: vi.fn().mockRejectedValue('down') }
    expect((await classifyRisk(rejectsString, { ...input, floor: { tier: 'high', reasons: ['x'] } })).tier).toBe('high')
  })
})
