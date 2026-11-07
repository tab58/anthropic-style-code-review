import { describe, expect, it } from 'vitest'
import { readInputs } from '../src/inputs.js'

const source = (values: Record<string, string>) => ({ get: (name: string) => values[name] ?? '' })
const base = { provider_api_key: 'k', github_token: 't', base_url: 'u', finder_model: 'f', verifier_model: 'v', bot_login: 'b', check_name: 'c' }

describe('readInputs', () => {
  it('reads a pull_request event with only required inputs', () => {
    expect(readInputs(source(base), { name: 'pull_request', prNumber: 3 })).toEqual({
      event: 'review',
      prNumber: 3,
      allowFork: false,
      apiKey: 'k',
      githubToken: 't',
      baseUrl: 'u',
      finderModel: 'f',
      verifierModel: 'v',
      securityFinderModel: undefined,
      securityVerifierModel: undefined,
      botLogin: 'b',
      workflow: {
        depth: undefined,
        voters: undefined,
        votesNeeded: undefined,
        maxRounds: undefined,
        maxDiffLines: undefined,
        maxFindings: undefined,
        concurrency: undefined,
        nitCap: undefined,
        securityReview: undefined,
        checkName: 'c',
      },
    })
  })

  it('reads every tuning input', () => {
    const all = { ...base, depth: 'deep', voters: '5', votes_needed: '3', max_rounds: '2', max_diff_lines: '100', max_findings_to_verify: '4', max_concurrency: '10', nit_cap: '0', security_review: 'off' }
    expect(readInputs(source(all), { name: 'pull_request', prNumber: 1 }).workflow).toEqual({
      depth: 'deep',
      voters: 5,
      votesNeeded: 3,
      maxRounds: 2,
      maxDiffLines: 100,
      maxFindings: 4,
      concurrency: 10,
      nitCap: 0,
      securityReview: false,
      checkName: 'c',
    })
  })

  it.each([
    ['on', true],
    ['TRUE', true],
    ['off', false],
    ['false', false],
  ])('reads security_review %s', (value, expected) => {
    expect(readInputs(source({ ...base, security_review: value }), { name: 'pull_request', prNumber: 1 }).workflow.securityReview).toBe(expected)
  })

  it('reads security model overrides', () => {
    const out = readInputs(source({ ...base, security_finder_model: 'sf', security_verifier_model: 'sv' }), { name: 'pull_request', prNumber: 1 })
    expect(out).toMatchObject({ securityFinderModel: 'sf', securityVerifierModel: 'sv' })
  })

  it('maps thread events to gate runs, which need no API key', () => {
    const out = readInputs(source({ ...base, provider_api_key: '' }), { name: 'pull_request_review_thread', prNumber: 1 })
    expect(out).toMatchObject({ event: 'gate', apiKey: '', allowFork: false })
  })

  it('allows forks only for workflow_dispatch, which takes pr_number from inputs', () => {
    expect(readInputs(source({ ...base, pr_number: '9' }), { name: 'workflow_dispatch' })).toMatchObject({ event: 'review', prNumber: 9, allowFork: true })
  })

  it('prefers the event PR number over the input', () => {
    expect(readInputs(source({ ...base, pr_number: '9' }), { name: 'pull_request', prNumber: 3 }).prNumber).toBe(3)
  })

  it.each([
    [{ ...base }, { name: 'workflow_dispatch' }, /No pull request/],
    [{ ...base, provider_api_key: '' }, { name: 'pull_request', prNumber: 1 }, /provider_api_key/],
    [{ ...base, github_token: '' }, { name: 'pull_request', prNumber: 1 }, /github_token/],
    [{ ...base, pr_number: '0' }, { name: 'workflow_dispatch' }, /pr_number/],
    [{ ...base, max_concurrency: '0' }, { name: 'pull_request', prNumber: 1 }, /max_concurrency/],
    [{ ...base, voters: 'three' }, { name: 'pull_request', prNumber: 1 }, /voters/],
    [{ ...base, nit_cap: '-1' }, { name: 'pull_request', prNumber: 1 }, /nit_cap/],
    [{ ...base, max_rounds: '1.5' }, { name: 'pull_request', prNumber: 1 }, /max_rounds/],
    [{ ...base, security_review: 'maybe' }, { name: 'pull_request', prNumber: 1 }, /security_review/],
  ])('rejects invalid inputs %#', (values, event, err) => {
    expect(() => readInputs(source(values), event)).toThrow(err)
  })
})
