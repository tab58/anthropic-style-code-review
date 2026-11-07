import { describe, expect, it } from 'vitest'
import { loadGuidance, parseReviewMd, renderGuidance } from '../src/guidance.js'

describe('parseReviewMd', () => {
  it('parses frontmatter and body', () => {
    const md = `---\ndepth: deep\nskip_paths:\n  - "docs/**"\n  - "*.lock"\nnit_cap: 1\n---\n# Rules\nNo raw SQL.\n`
    expect(parseReviewMd(md)).toEqual({
      config: { depth: 'deep', skipPaths: ['docs/**', '*.lock'], nitCap: 1 },
      body: '# Rules\nNo raw SQL.\n',
    })
  })

  it('works without frontmatter', () => {
    expect(parseReviewMd('just rules')).toEqual({ config: { skipPaths: [] }, body: 'just rules' })
  })

  it.each([
    ['---\ndepth: 3\n---\n', /depth/],
    ['---\nskip_paths: "docs/**"\n---\n', /skip_paths/],
    ['---\nnit_cap: -1\n---\n', /nit_cap/],
    ['---\n[unclosed\n---\n', /not valid YAML/],
    ['---\n- a\n- b\n---\n', /mapping/],
    ['---\nnit_cap: 1.5\n---\n', /nit_cap/],
  ])('rejects bad frontmatter %#', (md, err) => {
    expect(() => parseReviewMd(md)).toThrow(err)
  })
})

describe('loadGuidance', () => {
  const files: Record<string, string> = {
    'REVIEW.md': '---\nnit_cap: 2\n---\nreview rules',
    'AGENTS.md': 'root agents',
    'CLAUDE.md': 'root claude (shadowed)',
    'src/CLAUDE.md': 'src claude',
    'src/api/AGENTS.md': 'api agents',
    'lib/AGENTS.md': 'lib agents (not touched)',
  }
  const repo = { read: async (p: string) => files[p] }

  it('loads REVIEW.md and AGENTS.md (falling back to CLAUDE.md) for every ancestor of a changed file', async () => {
    const g = await loadGuidance(repo, ['src/api/users.ts', 'src/util.ts', 'README.md'])
    expect(g.review).toEqual({ config: { skipPaths: [], nitCap: 2 }, body: 'review rules' })
    expect(g.conventions).toEqual([
      { path: 'AGENTS.md', content: 'root agents' },
      { path: 'src/CLAUDE.md', content: 'src claude' },
      { path: 'src/api/AGENTS.md', content: 'api agents' },
    ])
  })

  it('handles a repo with no guidance files', async () => {
    expect(await loadGuidance({ read: async () => undefined }, ['a.ts'])).toEqual({ review: undefined, conventions: [] })
  })
})

describe('parseReviewMd edge cases', () => {
  it('accepts empty text, empty frontmatter, and nit_cap 0', () => {
    expect(parseReviewMd('')).toEqual({ config: { skipPaths: [] }, body: '' })
    expect(parseReviewMd('---\n\n---\nbody')).toEqual({ config: { skipPaths: [] }, body: 'body' })
    expect(parseReviewMd('---\nnit_cap: 0\n---\n').config).toEqual({ skipPaths: [], nitCap: 0 })
  })
})

describe('loadGuidance edge cases', () => {
  it('loads no conventions for an empty path list', async () => {
    expect(await loadGuidance({ read: async (p) => (p === 'AGENTS.md' ? 'x' : undefined) }, [])).toEqual({ review: undefined, conventions: [] })
  })

  it('rejects when the reader rejects', async () => {
    await expect(loadGuidance({ read: () => Promise.reject(new Error('api down')) }, ['a.ts'])).rejects.toThrow('api down')
  })
})

describe('renderGuidance', () => {
  it('renders REVIEW.md body then each conventions file with its scope', () => {
    const out = renderGuidance({
      review: { config: { skipPaths: [] }, body: ' rules ' },
      conventions: [{ path: 'AGENTS.md', content: 'root' }, { path: 'src/AGENTS.md', content: 'src' }],
    })
    expect(out).toBe('## Review rules (REVIEW.md)\n\nrules\n\n## Conventions (AGENTS.md): apply to files under ./\n\nroot\n\n## Conventions (src/AGENTS.md): apply to files under src/\n\nsrc')
  })

  it('skips an empty REVIEW.md body and renders nothing for no guidance', () => {
    expect(renderGuidance({ review: { config: { skipPaths: [] }, body: '  ' }, conventions: [] })).toBe('')
    expect(renderGuidance({ review: undefined, conventions: [] })).toBe('')
  })
})

describe('security frontmatter', () => {
  it('parses security_paths and security_exclude_paths', () => {
    const md = '---\nsecurity_paths: ["src/billing/**"]\nsecurity_exclude_paths: ["vendor/**"]\n---\n'
    expect(parseReviewMd(md).config).toEqual({ skipPaths: [], securityPaths: ['src/billing/**'], securityExcludePaths: ['vendor/**'] })
  })

  it.each([['---\nsecurity_paths: "x"\n---\n', /security_paths/], ['---\nsecurity_exclude_paths: [1]\n---\n', /security_exclude_paths/]])(
    'rejects invalid %#',
    (md, err) => {
      expect(() => parseReviewMd(md)).toThrow(err)
    },
  )
})

describe('risk frontmatter', () => {
  it('parses risk_high_paths and a partial risk_approvals', () => {
    const md = '---\nrisk_high_paths: ["db/**"]\nrisk_approvals: { medium: 0 }\n---\n'
    expect(parseReviewMd(md).config).toEqual({ skipPaths: [], riskHighPaths: ['db/**'], riskApprovals: { medium: 0 } })
  })

  it.each([
    ['---\nrisk_high_paths: "db/**"\n---\n', /risk_high_paths must be a list of glob strings/],
    ['---\nrisk_approvals: { high: -1 }\n---\n', /risk_approvals must be a mapping/],
    ['---\nrisk_approvals: { urgent: 3 }\n---\n', /risk_approvals must be a mapping/],
    ['---\nrisk_approvals: 2\n---\n', /risk_approvals/],
  ])('rejects invalid %#', (md, err) => {
    expect(() => parseReviewMd(md)).toThrow(err)
  })
})
