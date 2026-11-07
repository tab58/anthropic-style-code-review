# Anthropic-Style Code Review

A GitHub Action that reviews PRs the way described in
[How the Claude Code team does code review](https://claude.dev/blog/solving-code-review-at-anthropic/):

1. Several **finder agents** hunt for bugs in parallel. Each focuses on one area: logic, edge cases, concurrency/state, or API contracts.
2. Every finding needs a file, a line and quoted evidence. Style, cleanup and diagnostic findings are dropped.
3. Findings are deduped. The same bug class is reported once, with every location it appears.
4. Several **verifier agents vote** on each finding. Only findings that win the vote get posted.
5. Survivors are posted as one PR review (always `COMMENT`, never an approval). Each inline comment is tagged **Important**, **Nit** or **Pre-existing**, and the summary starts with a count.
6. A check run (`anthropic-style-code-review`) fails while any **Important** thread is unresolved.
7. A separate **security review** runs on every PR (see [Security review](#security-review)), with its own gate check `anthropic-style-code-review/security`.

**Convergence rules:**
- Pushes after the first review only review the new commits.
- Fixed findings are resolved automatically.
- A finding is never posted twice.
- After 3 rounds the action posts a "step back" note and stops.

Agents run on the [Pi](https://github.com/earendil-works/pi) SDK against any OpenAI-compatible API (default: Ollama Cloud). Each agent is sandboxed:
- **Read-only tools:** only `read`, `grep`, `find` and `ls`. No bash, no edits.
- **No repo config:** Pi does not load the repo's `.pi/` config, extensions or skills.
- **Trusted guidance:** REVIEW.md, AGENTS.md and CLAUDE.md are read from the **base** branch, so a PR can't rewrite its own review rules.

## Using it in your project

Setup takes about five minutes. The action is published at `tab58/anthropic-style-code-review`; pin `@v1` (see [Releasing](#releasing)). In the examples, `YOUR_ORG/your-project` stands for your own repository.

### 1. Make the action reachable

- **Public action repo:** nothing to do.
- **Private action repo:** in the *action's* repo, open **Settings → Actions → General → Access**. Allow access from repositories in your organization (or your user account).

### 2. Add your provider API key as a secret

In the project that should get reviews, open **Settings → Secrets and variables → Actions → New repository secret**. Create `PROVIDER_API_KEY` holding your OpenAI-compatible API key (for example an Ollama Cloud key from ollama.com/settings/keys). Or use the CLI:

```sh
gh secret set PROVIDER_API_KEY --repo YOUR_ORG/your-project
```

Use an organization secret to share one key across many repos.

### 3. Add the workflow

Create `.github/workflows/review.yml` in your project:

```yaml
name: Code review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  pull_request_review:
    types: [submitted, dismissed]
  pull_request_review_comment:
    types: [created, edited]
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
  # One queue per PR. A new push (or dispatch) cancels an in-flight review; review events never do.
  group: review-${{ github.event.pull_request.number || inputs.pr_number }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' || github.event_name == 'workflow_dispatch' }}

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
      - uses: tab58/anthropic-style-code-review@v1
        with:
          provider_api_key: ${{ secrets.PROVIDER_API_KEY }}
          pr_number: ${{ inputs.pr_number }}
```

What each part does:

| Part | Why |
|---|---|
| `pull_request` | Reviews new PRs. Each later push gets a review of only the new commits |
| `pull_request_review` | Recounts the checks when someone submits or dismisses a review (approvals). No LLM calls, takes seconds |
| `pull_request_review_comment` | Recounts the checks when someone replies `/resolve <reason>` to a finding. No LLM calls |
| `workflow_dispatch` | Manual run with a PR number, used for fork PRs (see below) |
| `permissions` | The minimum the action needs: read code, post reviews, create the check run |
| `concurrency` | A new push cancels a review that's still running, so you never pay for a stale one. Review events queue behind a running review instead of racing it |
| `if:` | Fork PRs don't get secrets, so the job is skipped for them instead of failing |
| `actions/checkout` with the head SHA | The agents read the PR's code from disk. `persist-credentials: false` keeps the token off disk |

### 4. Pick your provider and models (optional)

The defaults use Ollama Cloud with `glm-5.3` for finders and `deepseek-v4.1-flash` for verifiers. Any OpenAI-compatible endpoint that supports tool calling works:

```yaml
      - uses: tab58/anthropic-style-code-review@v1
        with:
          provider_api_key: ${{ secrets.PROVIDER_API_KEY }}
          pr_number: ${{ inputs.pr_number }}
          base_url: https://your-provider.example.com/v1
          finder_model: your-strong-coding-model
          verifier_model: a-cheaper-model-from-another-family
          max_concurrency: 10   # set to your provider's concurrent-request limit
```

Each agent session sends one request at a time, so `max_concurrency` equals the number of concurrent LLM requests. A Standard review runs about 4 + 3×findings sessions per round. If you set the limit higher than your provider allows, rejected requests are retried with backoff, so reviews get slower but don't fail.

### 5. Make the check block merges

The action posts findings; the merge block comes from GitHub:

1. Open a test PR once, so the checks exist.
2. Go to **Settings → Rules → Rulesets** (or **Settings → Branches** for classic branch protection) for your default branch.
3. Enable **Require status checks to pass** and add `anthropic-style-code-review` and `anthropic-style-code-review/security`.

From then on, a PR can't merge while any **Important** finding or any **Security · High/Medium** finding it introduced is open. Nits and pre-existing findings never block. A finding stops blocking when:

- **You fix it.** The next push re-checks open findings, and a verifier quorum marks fixed ones resolved.
- **Someone with write access replies `/resolve <reason>`** in the thread, e.g. `/resolve false positive: the id is validated by the router`. The reason is required. The checks recount within seconds.
- **The thread is resolved on GitHub.** Clicking **Resolve conversation** has no workflow event either, so it also counts on the next run.

The default `GITHUB_TOKEN` usually can't resolve threads. When a fix is confirmed but the bot can't close the thread, the action records it as fixed (it stops blocking) and the summary asks a human to click resolve.

### 6. Tune it with REVIEW.md (optional)

Add a `REVIEW.md` at the repo root to tell the reviewer what matters in your codebase, which paths to skip, and how deep to go. See [REVIEW.md](#reviewmd) below. Changes take effect only after they're merged, because the action reads it from the base branch.

### 7. Try it

Open a PR. Within a few minutes you should see:

- a review from `github-actions[bot]` whose summary starts with a count (`**2 issues found** (1 important, 1 nit)` or `**No issues found.**`)
- inline comments tagged **Important**, **Nit** or **Pre-existing**
- the `anthropic-style-code-review` check, red while Important threads are open

Push a fix and the next review covers only the new commits. Threads it confirms are fixed get resolved automatically.

### Fork PRs

Fork PRs are skipped automatically, because they get no secrets and can't post. To review one, read the diff first: the review runs the fork's code checkout with your API key available. Then run:

```sh
gh workflow run review.yml --repo YOUR_ORG/your-project -f pr_number=123
```

### Posting as a GitHub App (optional)

The default `GITHUB_TOKEN` can post reviews and checks, but GitHub won't let it resolve review threads. Fixed findings are still recorded as fixed and stop blocking, but their threads stay visually open. To have the bot resolve them, and to give it its own name, post as a GitHub App:

1. Create an app (**Org settings → Developer settings → GitHub Apps → New**). Turn off the webhook. Repository permissions: **Checks**, **Issues** and **Pull requests** read & write; **Contents** read-only.
2. Generate a private key, then install the app on the repo.
3. Save the App ID and the key as secrets, e.g. `REVIEW_APP_ID` and `REVIEW_APP_KEY` (`gh secret set REVIEW_APP_KEY < key.pem`).
4. Mint a token in the job and pass it in, with `bot_login` set to the app's bot login:

```yaml
    steps:
      - uses: actions/create-github-app-token@v2
        id: app
        with:
          app-id: ${{ secrets.REVIEW_APP_ID }}
          private-key: ${{ secrets.REVIEW_APP_KEY }}
      - uses: actions/checkout@v5
        with:
          ref: ${{ github.event.pull_request.head.sha || format('refs/pull/{0}/head', inputs.pr_number) }}
          persist-credentials: false
      - uses: tab58/anthropic-style-code-review@v1
        with:
          provider_api_key: ${{ secrets.PROVIDER_API_KEY }}
          github_token: ${{ steps.app.outputs.token }}
          bot_login: your-app-slug[bot]
```

The action recognizes its own reviews and threads by `bot_login`. After switching identities, it starts PRs that are already open over at round 1.

### Pinning a version

- `@v1` follows compatible releases.
- For supply-chain safety, pin a full commit SHA instead: `uses: tab58/anthropic-style-code-review@<sha> # v1.0.0`.

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Job skipped | The PR is from a fork (use `workflow_dispatch`), or the `if:` line was changed |
| Run succeeded but no review | The log says why: draft PR, `HEAD already reviewed`, `No reviewable changes` (everything matched `skip_paths`), or the round cap was reached |
| "Review skipped: diff too large" | Raise `max_diff_lines`, or add generated/vendored paths to `skip_paths` |
| `Resource not accessible by integration` (403) | The `permissions:` block is missing, or your org restricts workflow permissions (**Settings → Actions → General → Workflow permissions**) |
| `Input required and not supplied: provider_api_key` | The `PROVIDER_API_KEY` secret is missing or not available to this repo |
| `model error: …` in the warnings | The model ID or `base_url` is wrong, or the provider rejected the request. Check them against your provider's model list |
| Reviews are slow or requests are rejected | `max_concurrency` is above your provider's limit; lower it |
| Check stays red after resolving a thread | Thread resolution has no workflow event. Reply `/resolve <reason>` instead (instant), or re-run the latest job |
| `/resolve` didn't count | The replier needs write access, the reply must start with `/resolve` followed by a reason (a bare `/resolve` doesn't count), and the workflow needs the `pull_request_review_comment` trigger |
| Reviews posted as a different user aren't recognized | You passed a custom `github_token`; set `bot_login` to that identity's login |

## Releasing

Consumers need a tagged release whose `dist/` is committed:

```sh
npm run all                          # typecheck, lint, test, rebuild dist/
git add -A && git commit -m "release: v1.0.0"
git tag v1.0.0 && git tag -f v1      # move the major tag to the new release
git push && git push origin v1.0.0 && git push -f origin v1   # force only the moving v1 tag
```

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
| `security_review` | `on` | `off` disables the security pass and its check |
| `security_finder_model` / `security_verifier_model` | `finder_model` / `verifier_model` | Upgrade security models independently (e.g. a stronger verifier) |
| `risk_tiers` | `off` | `on` assesses a risk tier, labels the PR `risk:<tier>`, and publishes the approvals gate. See [Risk-tier approvals](#risk-tier-approvals) |
| `check_name` | `anthropic-style-code-review` | Bug gate name; the others are `<check_name>/security` and `<check_name>/approvals` |

## Security review

A second find → vote pass, focused on vulnerabilities an attacker can actually exploit:

- **Every PR gets a quick pass** (2 general security finders). The diff gets a **full pass** (4 specialists: injection, authn/authz, secrets & crypto, code execution & data exposure) when it touches security-sensitive paths (auth, sessions, tokens, crypto, admin, `.github/workflows/`, Dockerfiles, dependency manifests, infrastructure) or adds code that reaches dangerous sinks (shell exec, `eval`, SQL built from strings, `innerHTML`, unsafe deserialization). `depth: deep` always uses the full pass.
- **Every finding needs an exploit path:** attacker-controlled source → sink line → concrete exploit → impact. Findings without one are dropped.
- **Verifiers vote on exploitability** (2 of 3 must agree), and the median of their ratings sets the severity: **High**, **Medium** or **Low**.
- **Excluded as chronic false positives:** denial of service, resource exhaustion, missing rate limits, generic missing input validation, open redirects, regex DoS, and anything in docs or test files.
- **Gate:** `anthropic-style-code-review/security` fails while any High or Medium vulnerability *introduced by the PR* is unresolved. Low and **Pre-existing** findings are posted but never block. A finding on a line the PR added always counts as introduced, whatever the model says.
- **Fails closed:** the gate also stays red while the latest commits haven't been security-reviewed:
  - **The pass failed, or votes were left undecided** (e.g. provider errors). The bug review still posts, and the security pass retries on the next run (or when you re-run the job).
  - **The diff exceeded `max_diff_lines`, or the review is paused at the round cap.** A human has to review and override.
- **Blocking findings always get a thread.** A High/Medium finding outside the diff is anchored to the nearest changed line, so resolving it is explicit.

Like Anthropic's own security-review action, this is **not hardened against a determined attacker**. A malicious diff can try to talk the agents out of flagging it, so keep fork PRs on manual dispatch.

## Risk-tier approvals

Opt-in (`risk_tiers: on`). Each PR gets a tier, and the tier sets how many humans must approve it, so routine changes don't wait on reviewers and risky ones get two:

| Tier | Approvals | When (default rules) |
|---|---|---|
| **low** | 0 | Docs, tests, or source changes that only touch comments (Go, TS/JS, Python, SQL and other common languages), 200 changed lines or fewer |
| **medium** | 1 | Any other source change, security-sensitive paths or code (the signals that trigger the full security pass), more than 200 changed lines, or an Important bug was found |
| **high** | 2 | CI workflow files, `risk_high_paths` (list the paths your owners always want two people on), a High/Medium security finding introduced, or the review was skipped (diff too large, round cap) |

- **The rules set a floor; an LLM can only raise it.** One classifier session (on `verifier_model`) can bump a PR up for risks the rules can't see, such as billing logic in an innocently named file. It can never lower the tier, so a diff can't talk itself down to `low`. If the classifier fails, the tier is at least medium.
- **Tiers never go down within a PR.** The highest tier any push reached sticks, together with its reasons.
- **What counts as an approval:** each person's latest review is an approval on the current head commit, from someone with write access who isn't the PR author or a bot. A new push resets approvals.
- **Output:** a `risk:<tier>` label, a `Risk: …` line in the review summary, and the `anthropic-style-code-review/approvals` check listing the reasons and who approved.
- On each push, the check is published first with the PR's current tier (medium for a new PR), so the PR isn't mergeable while the review runs.

To enforce it:

1. Add `risk_tiers: on` to the action's `with:`.
2. Keep the `pull_request_review` trigger and the per-PR `concurrency` group from the workflow above. Approvals then recount the check in seconds, without calling the LLM, and never race a review that's still running.
3. Add `issues: write` to `permissions:` (for the label).
4. In branch protection, set **Required approvals to 0** and require the `anthropic-style-code-review/approvals` check.

> **Do both parts of step 4.** With 0 required approvals and the approvals check not required, nothing blocks a merge.

### Hardening: don't let a PR branch forge the checks

With `pull_request`, GitHub runs the workflow file **from the PR branch**, with the repo's secrets. Anyone with write access can push a branch whose workflow copies the app key (or uses `GITHUB_TOKEN`) and posts a green `…/approvals` check. When the checks are required, close that:

1. **Run only the copy of the workflow on the default branch.** Trigger reviews with `pull_request_target` (types `opened, synchronize, reopened`) instead of `pull_request`. The action only reads the checked-out PR code through sandboxed read-only tools and never executes it; keep `persist-credentials: false` on the checkout.
2. **Keep the secrets in an environment that only the default branch can deploy from.** Put `provider_api_key` and the app credentials in an environment (e.g. `ai-review`) with a deployment-branch policy of `main` only, add `environment: ai-review` to the job, and delete the repo-level copies. A branch's own workflow can then neither read them nor use the environment.
3. **Relay review events.** `pull_request_review` and `pull_request_review_comment` also run the PR branch's copy, so they can't get the secrets. Put them in a secret-free relay workflow (`permissions: {}`) that does nothing, and have the main workflow run on `workflow_run` of that relay (conclusion `success`), passing `pr_number: ${{ github.event.workflow_run.pull_requests[0].number }}`. `workflow_run` runs are gate-only: they recount the checks without LLM calls.
4. **Require the checks from your app only.** In the ruleset's required status checks, set the source of `…/approvals` (and `…/security`) to your GitHub App, so a check with the same name posted by any other identity doesn't count.

Known limits:
- Only the PR author is excluded. Someone who pushed commits to the branch can still approve it.
- Fork PRs never get the check until a maintainer dispatches a review, so they stay blocked. That's the safe direction.
- Approvals are re-counted on review events, not when someone's repo permission changes.

## REVIEW.md

The action reads `REVIEW.md` from the repo root on the base branch. It is written for code owners: what failure looks like in this repo, and what to ignore.

```markdown
---
depth: deep            # quick | standard | deep
skip_paths: ["docs/**", "**/*.lock", "**/__generated__/**"]
nit_cap: 1
security_paths: ["src/billing/**"]        # also trigger the full security pass
security_exclude_paths: ["vendor/**"]     # never report security findings here
risk_high_paths: ["db/migrations/**"]     # always the high risk tier
risk_approvals: { low: 0, medium: 1, high: 2 }   # approvals per tier (with risk_tiers: on)
---
- Config files: a wrong value that silently misroutes traffic is Important.
- Never flag missing comments or naming.
```

AGENTS.md (or CLAUDE.md, if there's no AGENTS.md) is loaded from the root and from every directory above a changed file. Each one applies to the files under its directory.

## Running locally (no GitHub)

Review any local branch with the real agents. Nothing is posted; the review is printed to the terminal:

```sh
git clone https://github.com/tab58/anthropic-style-code-review && cd anthropic-style-code-review && npm ci
PROVIDER_API_KEY=... npm run local -- --repo ../my-project --base main
```

- Reviews `base...HEAD`, **committed changes only**. The agents read the working tree, so commit first for accurate line numbers.
- Rounds, posted findings and threads persist in `<repo>/.git/anthropic-style-code-review/state.json`. Re-running after new commits behaves like a push (incremental review, auto-resolve, no repeats). Add `--reset` to start over.
- Options: `--depth quick|standard|deep`, `--title "PR title"`, `--no-security`, `--risk` (prints the tier; locally nobody can approve, so the approvals check fails unless the tier needs 0). Env: `PROVIDER_BASE_URL`, `FINDER_MODEL`, `VERIFIER_MODEL`, `CONCURRENCY`.
- **Fully offline:** run `ollama serve`, `ollama pull <a tool-calling coding model>`, then set `PROVIDER_BASE_URL=http://localhost:11434/v1`, `PROVIDER_API_KEY=ollama` and both model variables to that model.

## Development

```sh
npm run all                       # typecheck + lint (module boundaries) + tests + bundle to dist/
PROVIDER_API_KEY=... npm run eval # real models against eval/cases: recall, false positives, risk tiers
```

Rerun `npm run eval` whenever prompts, models or presets change. Add a case under `eval/cases/` (`before/`, `after/`, `expected.json`) for every bug that slipped past review.
