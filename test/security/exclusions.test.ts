import { describe, expect, it } from 'vitest'
import { exclusionReason } from '../../src/security/exclusions.js'
import type { SecurityFinding } from '../../src/security/index.js'

const f = (over: Partial<SecurityFinding> = {}): SecurityFinding => ({
  file: 'src/db.ts',
  line: 3,
  endLine: 3,
  title: 'SQL injection in getUser',
  vulnClass: 'sql-injection',
  source: 'req.query.id',
  sink: 'db.query',
  exploitScenario: "id=1 OR 1=1 dumps the table",
  impact: 'read all users',
  evidence: 'db.query(`... ${id}`)',
  severity: 'high',
  introduced: true,
  ...over,
})

describe('exclusionReason', () => {
  it('keeps a complete, in-scope finding', () => {
    expect(exclusionReason(f(), [])).toBeUndefined()
  })

  it.each([
    'denial-of-service',
    'Denial_Of_Service',
    'dos',
    'resource-exhaustion',
    'memory-exhaustion',
    'rate-limiting',
    'missing-rate-limit',
    'redos',
    'regex-injection',
    'catastrophic-backtracking',
    'open-redirect',
    'missing-input-validation',
    'lack-of-input-validation',
    'input-validation',
    'unbounded-loop',
    'infinite-loop',
  ])('excludes class %s', (vulnClass) => {
    expect(exclusionReason(f({ vulnClass }), [])).toMatch(/excluded class/)
  })

  it.each([
    ['sql-injection', 'SQL injection due to missing input validation'],
    ['command-injection', 'Command injection via unbounded user input'],
    ['path-traversal', 'Path traversal: no input validation on filename'],
    ['xss', 'Stored XSS enables DoS of the admin panel'],
  ])('never drops a real class because of its title (%s)', (vulnClass, title) => {
    expect(exclusionReason(f({ vulnClass, title }), [])).toBeUndefined()
  })

  it('scans code under docs/ (only markdown is excluded)', () => {
    expect(exclusionReason(f({ file: 'docs/server/api.ts' }), [])).toBeUndefined()
  })

  it.each(['README.md', 'docs/setup.md', 'test/db.ts', 'tests/x.py', 'src/__tests__/a.ts', 'src/db.test.ts', 'src/db.spec.js', 'pkg/db_test.go'])(
    'excludes docs/test path %s',
    (file) => {
      expect(exclusionReason(f({ file }), [])).toMatch(/excluded path/)
    },
  )

  it('excludes extra paths from REVIEW.md', () => {
    expect(exclusionReason(f({ file: 'vendor/lib.js' }), ['vendor/**'])).toMatch(/excluded path/)
  })

  it.each([
    [{ source: '' }],
    [{ sink: '  ' }],
    [{ exploitScenario: '' }],
  ])('excludes findings without an exploit path %j', (over) => {
    expect(exclusionReason(f(over), [])).toMatch(/no exploit path/)
  })
})
