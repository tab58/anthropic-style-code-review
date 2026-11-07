# PLAN: anthropic-style-code-review GitHub Action (OpenAI-compatible + Pi)

Replicates the core of the review system in
[How the Claude Code team does code review](https://claude.dev/blog/solving-code-review-at-anthropic/):
parallel bug finders → verifiers vote on each finding → survivors ranked by severity → inline PR comments,
with convergence rules so agent authors and the agent reviewer don't loop forever.

## Decisions

| Topic | Decision |
|---|---|
| Scope | Core review only. Out of scope: security pass, risk-tier approval, nightly scans, CI eval |
| LLM | Ollama Cloud, OpenAI-compatible (`https://ollama.com/v1`, `Authorization: Bearer <provider_api_key>`). Any OpenAI-compatible endpoint works via `base_url` |
| Harness | Pi SDK in-process (`@earendil-works/pi-coding-agent`, `createAgentSession`) |
| Agent tools | `read, grep, find, ls` only (no bash, edit, write, or MCP) + a terminating `submit_*` tool with a schema |
| Models | `finder_model` default `glm-5.3`; `verifier_model` default `deepseek-v4.1-flash` (a different family, for independent votes) |
| Concurrency | `max_concurrency` input, default 3, user-tuned to the provider. Semaphore over agent sessions; Pi's built-in agent retry (4×, exponential from 2s) handles queue-full/429/5xx |
| Triggers | `pull_request` (opened, synchronize, ready_for_review, reopened), `pull_request_review_thread` (resolved, unresolved), `workflow_dispatch` (pr_number) |
| Forks | Skipped with a notice. Maintainers can run `workflow_dispatch` manually |
| Output | One PR review, always `COMMENT` (never approve), with inline comments tagged **Important** / **Nit** / **Pre-existing**. The summary starts with a count |
| Gate | Check run `anthropic-style-code-review` fails while any unresolved bot thread is tagged Important. Nits and pre-existing findings never block |
| Guidance | `REVIEW.md` (optional YAML frontmatter) + `AGENTS.md`, falling back to `CLAUDE.md`. Nested per-directory files apply to files under them |
| Testing | Vitest unit tests (mocked LLM) + `npm run eval` (fixture diffs against real Ollama, run manually) |

Note: Ollama Cloud supports `tools` but not `tool_choice`, and its `json_schema` strict mode is unverified.
Structured output therefore goes through a terminating Pi tool whose arguments are schema-validated. The prompt
instructs the agent to call it; if the session ends without the call, retry once, then treat the agent as having no findings.

## Pipeline (one run)

1. **Context**: determine the review range. The first round reviews the full PR diff (base...head). Later rounds
   review only `lastReviewedSha...head`. Drop `skip_paths`. If the diff is larger than `max_diff_lines`, post a notice and skip.
2. **Finders** (parallel): each finder gets its focus prompt, the diff, the guidance files, and the repo on disk.
   It must return findings with file + line + evidence (a quote from the code). Findings without evidence are rejected.
3. **Dedupe**: merge findings in the same file whose line ranges overlap (keep the most severe). Group findings
   with the same `bug_class` into one finding with extra locations (flag the class, not one line).
4. **Verify**: for each deduped finding (up to `max_findings_to_verify`, most severe first), run N voter sessions
   in parallel. Each returns `{ real, reason }`. Keep the finding if `yes votes >= needed`.
5. **Filter and rank**: drop findings whose category is not `bug`. Drop fingerprints already posted. Sort
   important > pre_existing > nit. Cap nits at `nit_cap`.
6. **Post**: one review with inline comments on RIGHT-side lines in the diff. A finding whose line is outside the
   diff goes in the summary body. The summary starts with a count, e.g. `**2 issues found** (1 important, 1 nit)`
   or `**No issues found.**`
7. **Auto-clear**: on rounds ≥ 2, for each unresolved bot thread whose file changed in the new range, ask one
   verifier "is this still present at HEAD?" and resolve the thread if not.
8. **Check run**: compute the conclusion from the unresolved bot threads. A `pull_request_review_thread` event
   only recomputes the check (no LLM calls).

## Depth presets

| Preset | Finders | Voters | Needed |
|---|---|---|---|
| quick | 2 generalists | 1 | 1 |
| standard | logic, edge-cases/errors, concurrency/state, api-contract | 3 | 2 |
| deep | standard + 2 generalists | 5 | 3 |

Precedence: action inputs override the REVIEW.md frontmatter `depth`, which overrides the default (`standard`).

## Convergence

- **State**: a hidden marker in the bot's summary comment:
  `<!-- anthropic-style-code-review:state {"round":2,"sha":"abc","fingerprints":["..."]} -->`. The latest marker wins.
- **Fingerprint**: `sha1(file + bug_class)`. It ignores line numbers, so findings survive line shifts.
- **Round cap**: when `round > max_rounds` (default 3), post one "step back and reconsider the approach"
  comment, then stop running LLM reviews on that PR. The check is still recomputed.
- **Repeats**: findings are never reposted. Fixed findings are resolved automatically (step 7).

## Inputs (`action.yml`)

`provider_api_key` (required), `github_token` (default `${{ github.token }}`), `finder_model`, `verifier_model`,
`depth`, `voters` / `votes_needed` (overrides), `max_concurrency`, `max_rounds`, `max_diff_lines`
(default 3000), `max_findings_to_verify` (default 15), `nit_cap` (default 3), `base_url` (default Ollama Cloud).

REVIEW.md frontmatter: `depth`, `skip_paths` (globs), `nit_cap`.

Permissions: `contents: read`, `pull-requests: write`, `checks: write`.

## Layout

Modular since the refactor. Directory modules are imported only through `index.ts`, and ESLint `no-restricted-imports` enforces that in `src/` and `eval/`.

```
action.yml
eslint.config.js     module-boundary guard (only rule)
src/
  main.ts            composition root: readInputs → GitHub client + Pi reviewer → workflow
  inputs.ts          readInputs(): validated action inputs
  diff.ts            parseDiff(), filterDiff()
  guidance.ts        loadGuidance(), parseReviewMd(), renderGuidance() (REVIEW.md / AGENTS.md / CLAUDE.md)
  limiter.ts         createLimiter(): bounded concurrency
  github.ts          createGitHubClient(): GitHub, built on an injected 2-method GitHubApi (Octokit adapter)
  review/            runReview(reviewer, request): finders → filter → dedupe → vote → rank
    review.ts        public API, types, depth presets, resolveDepth, fingerprint
    voting.ts        dedupe, tally, rank (internal)
  pi-reviewer/       createPiReviewer(): a Reviewer on sandboxed Pi sessions
    pi-reviewer.ts   public API
    session.ts       model runtime, structured sessions, schemas (internal)
    prompts.ts       system and user prompts (internal)
    sandbox.ts       path-confined read/grep/find/ls (internal)
  workflow/          createWorkflow(): review() / gate() for one PR
    workflow.ts      public API, GitHub interface, options, outcomes, round phases
    markers.ts       hidden state/finding markers, open-Important count (internal)
    comments.ts      review and summary markdown (internal)
test/                mirrors src/ (one companion test per source file)
eval/                cases/<name>/{before,after,expected.json}, run.ts
dist/                esbuild ESM bundle (committed, required for JS actions; ncc broke `node:` requires)
```

## Build order (TDD)

1. Pure modules: `presets`, `diff`, `vote`, `state`, `gate`, `limit`. Tests first.
2. `context` (frontmatter, guidance resolution) with fs fixtures.
3. `agents`: verify the Pi SDK API against the installed package, then wrap it behind
   `runFinder(...)` / `runVoter(...)`. Orchestration tests mock these two functions.
4. `github` + `main`: orchestration tests with a mocked Octokit.
5. `action.yml`, ncc bundle, an example workflow in the README.
6. `eval/`: about 10 fixtures (seeded bugs + clean diffs), reporting recall and false positives.

## Risks

- **Weaker models than Claude** → more false positives. The voting threshold and category filter are the main
  levers; use the eval to tune them.
- **No `tool_choice`** → an agent may end without calling the submit tool. Mitigation: retry once, then count as empty.
- **Ollama queue-full rejections** → retry with backoff, and keep `max_concurrency` at or below the plan's limit.
- **Unstable `bug_class` labels** make fingerprints imperfect. Ceiling: the same bug may be reposted under a
  different label. Upgrade path: have a verifier compare against existing threads.
- **Fingerprint = file + bug class, kept forever** → a later bug of the same class in the same file is suppressed.
  Upgrade path: drop fingerprints whose thread was resolved.
- **Overlapping findings with different classes are merged** (the less severe one is dropped), to avoid duplicate posts
  when finders label the same bug differently.
- **Verifier errors count as "no"**. The finding isn't recorded, so it can come back next round.
- **Git-quoted paths** (non-ASCII or special characters) are not unquoted, so findings in those files are dropped.
- - **Cost**: Standard ≈ 4 + 3×findings sessions per round. The guardrails cap it.
