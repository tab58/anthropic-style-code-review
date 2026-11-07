# Anthropic-Style Code Review

A GitHub Action that reviews PRs the way described in
[How the Claude Code team does code review](https://claude.dev/blog/solving-code-review-at-anthropic/):

1. Several **finder agents** hunt for bugs in parallel. Each focuses on one area: logic, edge cases, concurrency/state, or API contracts.
2. Every finding needs a file, a line and quoted evidence. Style, cleanup and diagnostic findings are dropped.
3. Findings are deduped. The same bug class is reported once, with every location it appears.
4. Several **verifier agents vote** on each finding. Only findings that win the vote get posted.
5. Survivors are posted as one PR review (always `COMMENT`, never an approval). Each inline comment is tagged **Important**, **Nit** or **Pre-existing**, and the summary starts with a count.
6. A check run (`anthropic-style-code-review`) fails while any **Important** thread is unresolved.

**Convergence rules:**
- Pushes after the first review only review the new commits.
- Fixed findings are resolved automatically.
- A finding is never posted twice.
- After 3 rounds the action posts a "step back" note and stops.

Agents run on the [Pi](https://github.com/earendil-works/pi) SDK against any OpenAI-compatible API (default: Ollama Cloud). Each agent is sandboxed:
- **Read-only tools:** only `read`, `grep`, `find` and `ls`. No bash, no edits.
- **No repo config:** Pi does not load the repo's `.pi/` config, extensions or skills.
- **Trusted guidance:** REVIEW.md, AGENTS.md and CLAUDE.md are read from the **base** branch, so a PR can't rewrite its own review rules.

## Usage

`.github/workflows/review.yml`:

```yaml
name: Code review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  pull_request_review_thread:
    types: [resolved, unresolved]
  workflow_dispatch:
    inputs:
      pr_number:
        description: PR to review (use for fork PRs after reading the diff)
        required: true

permissions:
  contents: read
  pull-requests: write
  checks: write

concurrency:
  # A new push cancels an in-flight review; resolving a thread never does.
  group: review-${{ github.event_name == 'pull_request_review_thread' && 'gate' || 'run' }}-${{ github.event.pull_request.number || inputs.pr_number }}
  cancel-in-progress: true

jobs:
  review:
    # Fork PRs get no secrets: skip them unless a maintainer dispatches manually.
    if: github.event_name == 'workflow_dispatch' || github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v5
        with:
          ref: ${{ github.event.pull_request.head.sha || format('refs/pull/{0}/head', inputs.pr_number) }}
          persist-credentials: false
      - uses: YOUR_ORG/anthropic-style-code-review@v1
        with:
          provider_api_key: ${{ secrets.PROVIDER_API_KEY }}
          pr_number: ${{ inputs.pr_number }}
```

Then make the `anthropic-style-code-review` check required in branch protection.

**Concurrency:** each agent session sends one request at a time, so `max_concurrency` equals the number of concurrent LLM requests. Set it to whatever your provider allows. A Standard review runs about 4 + 3×findings sessions.

## Inputs

| Input | Default | |
|---|---|---|
| `provider_api_key` | (required for reviews) | API key for the OpenAI-compatible endpoint at `base_url` |
| `finder_model` | `glm-5.3` | Model for the bug finders |
| `verifier_model` | `deepseek-v4.1-flash` | Model for the voters. A different model family gives more independent votes |
| `depth` | `standard` | `quick` (2 finders, 1 vote), `standard` (4 specialist finders, 2 of 3 votes), `deep` (6 finders, 3 of 5 votes) |
| `voters` / `votes_needed` | preset | Override the voting setup |
| `max_concurrency` | `3` | Max agent sessions running at once |
| `max_rounds` | `3` | Review rounds before the "step back" note |
| `max_diff_lines` | `3000` | Skip the review when more lines than this changed |
| `max_findings_to_verify` | `15` | Cap on findings sent to voting |
| `nit_cap` | `3` | Max nits per review |
| `base_url` | `https://ollama.com/v1` | Any OpenAI-compatible endpoint |
| `bot_login` | `github-actions[bot]` | Change this if you pass a different `github_token` |

## REVIEW.md

The action reads `REVIEW.md` from the repo root on the base branch. It is written for code owners: what failure looks like in this repo, and what to ignore.

```markdown
---
depth: deep            # quick | standard | deep
skip_paths: ["docs/**", "**/*.lock", "**/__generated__/**"]
nit_cap: 1
---
- Config files: a wrong value that silently misroutes traffic is Important.
- Never flag missing comments or naming.
```

AGENTS.md (or CLAUDE.md, if there's no AGENTS.md) is loaded from the root and from every directory above a changed file. Each one applies to the files under its directory.

## Development

```sh
npm run all                       # typecheck + lint (module boundaries) + tests + bundle to dist/
PROVIDER_API_KEY=... npm run eval # real models against eval/cases, prints recall + false positives
```

Rerun `npm run eval` whenever prompts, models or presets change. Add a case under `eval/cases/` (`before/`, `after/`, `expected.json`) for every bug that slipped past review.
