import { describe, expect, it } from 'vitest'
import { needsFullPass } from '../../src/security/escalation.js'

const file = (path: string, added: string[] = ['x']) => ({
  path,
  text: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,${added.length + 1} @@\n ctx\n${added.map((l) => `+${l}`).join('\n')}\n`,
})

describe('needsFullPass', () => {
  it('is false for no files and for ordinary code', () => {
    expect(needsFullPass([], [])).toBe(false)
    expect(needsFullPass([file('src/ui/button.tsx', ['return <b>hi</b>'])], [])).toBe(false)
  })

  it.each([
    'src/auth/login.ts',
    'lib/session.go',
    'app/models/user_password.rb',
    'api/admin/routes.py',
    'pkg/crypto/keys.ts',
    'src/permissions.ts',
    '.github/workflows/ci.yml',
    'Dockerfile',
    'deploy/Dockerfile.prod',
    'package.json',
    'web/yarn.lock',
    'go.mod',
    'requirements-dev.txt',
    'infra/main.tf',
    'ops/k8s/deploy.yaml',
  ])('escalates on risky path %s', (path) => {
    expect(needsFullPass([file(path)], [])).toBe(true)
  })

  it.each([
    ["child_process.exec(`ls ${dir}`)"],
    ['subprocess.run(cmd, shell=True)'],
    ['os.system(cmd)'],
    ['eval(userInput)'],
    ['const f = new Function(body)'],
    ['el.innerHTML = html'],
    ['<div dangerouslySetInnerHTML={{ __html: x }} />'],
    ['data = pickle.loads(blob)'],
    ['cfg = yaml.load(text)'],
    ['$obj = unserialize($_POST["x"]);'],
    ['const token = Math.random().toString(36)'],
    ["db.query(`SELECT * FROM users WHERE id = ${id}`)"],
    ['cursor.execute("DELETE FROM t WHERE id=" + id)'],
    ['sql = f"UPDATE t SET a={a}"'],
  ])('escalates on risky added line %s', (line) => {
    expect(needsFullPass([file('src/util.ts', [line])], [])).toBe(true)
  })

  it('ignores risky patterns on removed or context lines', () => {
    const text = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,1 @@\n eval(a)\n-eval(b)\n'
    expect(needsFullPass([{ path: 'x.ts', text }], [])).toBe(false)
  })

  it('does not treat a parameterized query as risky', () => {
    expect(needsFullPass([file('src/db.ts', ["db.query('SELECT * FROM users WHERE id = $1', [id])"])], [])).toBe(false)
  })

  it.each(['src/userAuth.ts', 'app/LoginController.ts', 'lib/ApiToken.ts'])('escalates on camelCase sensitive name %s', (path) => {
    expect(needsFullPass([file(path)], [])).toBe(true)
  })

  it('does not treat "author" as auth', () => {
    expect(needsFullPass([file('src/author.ts')], [])).toBe(false)
  })

  it('skips very long added lines (minified/generated code) instead of scanning them', () => {
    expect(needsFullPass([file('dist/bundle.js', [`${'a'.repeat(5000)} eval(x)`])], [])).toBe(false)
  })

  it('treats an added line whose content starts with "++" as code, not a header', () => {
    expect(needsFullPass([file('src/x.ts', ['++i; eval(code)'])], [])).toBe(true)
  })

  it('escalates on extra globs from REVIEW.md', () => {
    expect(needsFullPass([file('src/billing/charge.ts')], ['src/billing/**'])).toBe(true)
  })
})
