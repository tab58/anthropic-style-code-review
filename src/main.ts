import * as core from '@actions/core'
import { context, getOctokit } from '@actions/github'
import { createGitHubClient } from './github.js'
import { readInputs } from './inputs.js'
import { createPiReviewer } from './pi-reviewer/index.js'
import { createWorkflow } from './workflow/index.js'

/** Composition root: inputs → GitHub client + reviewer factory → workflow → log the outcome. */
async function main(): Promise<void> {
  const inputs = readInputs({ get: (name) => core.getInput(name) }, { name: context.eventName, prNumber: context.payload.pull_request?.number })
  for (const secret of [inputs.apiKey, inputs.githubToken]) if (secret) core.setSecret(secret)
  const workspace = process.env.GITHUB_WORKSPACE
  if (!workspace) throw new Error('GITHUB_WORKSPACE not set; check out the PR head first.')

  const octokit = getOctokit(inputs.githubToken)
  const github = createGitHubClient({
    api: { request: (route, params) => octokit.request(route, params), graphql: (query, vars) => octokit.graphql(query, vars) },
    ...context.repo,
    prNumber: inputs.prNumber,
    botLogin: inputs.botLogin,
    checkName: inputs.checkName,
    secrets: [inputs.apiKey, inputs.githubToken],
  })
  const createReviewer = () =>
    createPiReviewer({ baseUrl: inputs.baseUrl, apiKey: inputs.apiKey, finderModel: inputs.finderModel, verifierModel: inputs.verifierModel, cwd: workspace })
  const workflow = createWorkflow({ github, createReviewer, log: { info: core.info, warning: core.warning } }, inputs.workflow)

  if (inputs.event === 'gate') {
    const gate = await workflow.gate()
    core.info(`Gate: ${gate.conclusion} (${gate.openImportant} open important)`)
  } else {
    core.info((await workflow.review({ allowFork: inputs.allowFork })).message)
  }
}

main().catch((e: unknown) => core.setFailed(e instanceof Error ? e.message : String(e)))
