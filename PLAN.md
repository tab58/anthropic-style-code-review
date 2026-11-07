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
| Triggers | `pull_request` (opened, synchronize, ready_for_review, reopened), `pull_request_review` (submitted, dismissed) and `pull_request_review_comment` (created, edited) recount only; `workflow_dispatch` (pr_number). GitHub Actions has no trigger for resolving a thread or reacting, so those count on the next run; a `/resolve <reason>` reply recounts instantly |
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
8. **Check run**: compute the conclusion from the unresolved bot threads. A `pull_request_review` event
   only recomputes the check (no LLM calls); thread resolution has no Actions event, so it waits for a re-run or push.

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

---

# Phase 2: Security review

A second find → vote pass focused on exploitable vulnerabilities, posted in the same review, with its own merge-gate check. Modeled on the article's "security review is a separate pass; open findings from either review block merge", plus the false-positive rules of Anthropic's open-source [claude-code-security-review](https://github.com/anthropics/claude-code-security-review).

## Decisions

| Topic | Decision |
|---|---|
| When | **Every PR.** A quick pass by default; a **full pass** when the diff touches risky paths or patterns (see Escalation) or the bug-review depth is `deep` |
| Output | Same PR review as the bug findings. Inline comments tagged **Security · High/Medium/Low**, with **Pre-existing** added when the PR didn't introduce the vulnerability |
| Gate | New check `<check_name>/security`. It fails while any unresolved **High or Medium** security thread *introduced by this PR* is open. Low is informational. Required separately in branch protection |
| Verification | A finding needs an **exploit path**: attacker-controlled source → path → vulnerable sink line → impact. A finding without one is dropped before voting. Voters judge *exploitability*; the same majority rule applies; each voter also assigns a severity, and the **median** of the "real" votes becomes the final severity |
| Hard exclusions (dropped by rules before voting) | DoS / resource exhaustion / rate limiting; generic missing input validation; open redirect; regex DoS; anything in docs or test files (`*.md`, `docs/**`, `test/**`, `tests/**`, `**/*.test.*`, `**/*.spec.*`, `**/*_test.*`) |
| Pre-existing vulnerabilities | Posted and tagged Pre-existing; they **never block** |
| Models | New inputs `security_finder_model` / `security_verifier_model`, defaulting to `finder_model` / `verifier_model` |

## Depth

| Pass | Finders | Voters | Needed |
|---|---|---|---|
| quick (default) | 2 × `security-general` | 3 | 2 |
| full | `injection` (SQL/NoSQL/shell/template/path traversal/XXE), `authz` (authn bypass, privilege escalation, session/JWT, IDOR), `secrets-crypto` (hardcoded secrets, weak crypto/randomness, cert validation), `exposure-execution` (unsafe deserialization, eval, XSS, sensitive data in logs or responses, CI workflow / dependency risks) | 3 | 2 |

Voting stays at 3/2 even on quick: precision comes from verification, and security findings are few, so the voter cost is small.

### Escalation to full (default rules; REVIEW.md frontmatter `security_paths` adds globs)

- **Paths:** `**/*auth*/**`, `**/*login*`, `**/*session*`, `**/*token*`, `**/*crypto*`, `**/*secret*`, `**/*password*`, `**/*permission*`, `**/*acl*`, `**/*admin*`, `.github/workflows/**`, `**/Dockerfile*`, dependency manifests and lockfiles (`package.json`, `*.lock`, `go.mod`, `requirements*.txt`, `pyproject.toml`, `Cargo.toml`, …), infrastructure (`**/*.tf`, `**/k8s/**`, `**/helm/**`).
- **Added-line patterns:** process execution (`exec`, `spawn`, `subprocess`, `os.system`, `child_process`), `eval`/`Function(`, raw SQL built with strings or templates, `innerHTML`/`dangerouslySetInnerHTML`, `pickle`/`yaml.load`/`unserialize`, `crypto`/`random` used for tokens.

## Pipeline (per round, alongside the bug review)

1. Choose quick or full via escalation (pure function over the diff).
2. **Finders** return `{ file, line, end_line, title, vuln_class, source, sink, exploit_scenario, impact, evidence, severity: high|medium|low, introduced: bool }`.
3. **Rules filter:** drop excluded classes and paths; drop findings with no `source`, `sink` or `exploit_scenario`; drop findings outside the diff, already posted, or without evidence (same as the bug review).
4. **Dedupe:** overlapping lines or the same `vuln_class`, same logic as the bug review.
5. **Vote:** each voter returns `{ exploitable, severity, reason }`. Keep the finding if exploitable votes ≥ needed; final severity = median of the exploitable votes.
6. **Post:** in the same `createReview` call as the bug findings. The summary's first line counts both, e.g. `**2 issues found** (1 important, 1 nit) · **1 security finding** (1 high)`.
7. **Auto-resolve:** the existing quorum recheck also covers security threads.
8. **Checks:** the bug gate is unchanged; the new security gate counts open `introduced` High/Medium security threads.

## Architecture changes

- **New module `src/security/`**: `runSecurityReview(reviewer: SecurityReviewer, request)`, the `SecurityReviewer` interface, `SecurityFinding`, `chooseSecurityDepth(files, extraPaths)`, plus internal `exclusions.ts` and `escalation.ts`.
- **New shared module `src/consensus.ts`**: generic `dedupe` / `tally` / `rank` extracted from `review/voting.ts`, so both reviews use one implementation.
- **Shared limiter:** `ReviewRequest.concurrency` becomes an injected `limit: Limiter`, so both passes run in parallel without exceeding `max_concurrency` together.
- **`pi-reviewer/`**: `createPiReviewer` returns `Reviewer & SecurityReviewer`, adding security prompts, schemas and the `submit_security_findings` / `submit_exploitability` tools.
- **`workflow/`**:
  - runs both passes in the same round;
  - adds the security marker `<!-- anthropic-style-code-review:security <high|medium|low> <new|pre> <fp> -->` (the existing bug marker regex ignores it, so the bug gate is unaffected);
  - security fingerprints prefixed `sec:`, kept in the same state;
  - adds a second `setCheck`.
- **`GitHub` interface:** `CheckRun` gains a `name` field, so one client can publish both checks. Today the name is fixed in the client config.
- **Inputs:** `security_finder_model`, `security_verifier_model`, `security_review` (`on` | `off`, default `on`).
- **REVIEW.md frontmatter:** `security_paths` (extra escalation globs) and `security_exclude_paths` (extra exclusion globs).

## Eval

Add cases:
- **Positives:** string-concatenated SQL, shell injection via `child_process`, a hardcoded API key in source, missing authorization on an admin route.
- **Negatives (must stay clean):** a parameterized query, a fake key in a test fixture (excluded), an unbounded loop (DoS, excluded).

Extend `expected.json` with `security: [{ file, line, severity }]` and report security recall and false positives separately.

## Build order (TDD)

1. Extract `consensus.ts` from `review/voting.ts` (behavior unchanged; existing tests move with it), and switch `ReviewRequest` to an injected limiter.
2. `security/escalation.ts` + `security/exclusions.ts`: pure functions, exhaustive tests.
3. `security/security.ts`: `runSecurityReview` with a fake `SecurityReviewer`.
4. `pi-reviewer` security prompts and schemas; extend the fake-SSE integration test.
5. `workflow`: both passes in one round, the marker, combined summary, second check; extend the workflow tests.
6. `inputs.ts` + `action.yml` + README (inputs, the new required check, the REVIEW.md keys).
7. Eval cases; run on Ollama Cloud; tune prompts until security recall is 100% with 0 false positives on the fixture set.
8. Release `v1.1.0` (additive inputs, so it's backward compatible) and move the `v1` tag.

## Status

Built: 359 tests passing. On the live eval (quick depth, Ollama Cloud), security recall is 4/4 with 0 false positives, and the bug eval still passes.

Changes after code review:
- **Exclusions:** match the normalized vulnerability *class* only, never the free-text title (a title like "SQL injection due to missing input validation" was being dropped). Code under `docs/` is scanned; only `*.md` is excluded.
- **Separate security completion:** state now records `securitySha`, the last head the security pass completed on.
  - Bug and security ranges are tracked independently.
  - A failed or undecided security pass no longer discards the bug review; it retries on the next run.
  - The security gate fails closed whenever `securitySha` ≠ HEAD: a failed pass, an oversized diff, the round cap, or a PR first reviewed before v1.1.
- **Introduced is decided by the diff:** a finding on a line the PR added is forced to `introduced: true` before fingerprinting.
- **Security fingerprints** include `introduced`.
- **Blocking findings outside the diff** are anchored to the nearest changed line. After a 422, blocking comments are retried one review each.
- **Escalation:** matches camelCase names (`userAuth`, `LoginController`) but not `author`; skips lines over 2,000 characters; scans hunk content only.

## Risks

- **Existing `@v1` users** get the security pass by default (`security_review: on`). That means new LLM spend, a new `/security` check (not required unless they add it), and, for PRs first reviewed before v1.1, a red security check until the next push. Call this out in the release notes.
- **Prompt injection is worse here.** A malicious diff can try to talk voters out of a real vulnerability. Mitigations: the finder sees the diff only as untrusted data, voters must cite the sink line, and auto-resolve needs a quorum. Like Anthropic's action, this is **not hardened against a determined attacker**; forks stay manual-dispatch only.
- **Escalation heuristics miss things.** A vulnerability outside the risky paths gets only the quick pass (2 general finders). Accepted: quick still runs on every PR.
- **Cost.** Quick adds about 2 + 3×findings sessions per round; full adds about 4 + 3×findings.

---

# Phase 3: Risk-tier approvals

Each PR gets a risk tier, and the tier sets how many human approvals it needs before merge. This is the article's "a classifier decides whether a change needs zero, one or two human approvers". GitHub branch protection only supports a fixed approval count per branch, so the variable count is enforced by a third check run.

## Decisions

| Topic | Decision |
|---|---|
| Default | **Off, opt-in** with `risk_tiers: on`. Existing `@v1` users are unaffected |
| Tiers → approvals | **low 0 · medium 1 · high 2**. Overridable through `risk_approvals: { low, medium, high }` in REVIEW.md frontmatter |
| Who decides | **The rules set a floor, and the LLM may only raise it.** The deterministic rules compute a minimum tier; one classifier call can raise the tier but never lower it, so prompt injection in a diff can't talk a PR down to `low` |
| Stickiness | **Never goes down within a PR.** The stored tier is the max of every round's tier, kept in the state marker. A non-deterministic classifier can't flip it, and a scary PR can't be trimmed to `low` and then grown back |
| Enforcement | New check **`<check_name>/approvals`**. It fails until the PR has N qualifying approvals. The repo sets branch protection to 0 required reviews and requires this check. A `risk:<tier>` label goes on the PR, and the check summary gives the reasons |
| Qualifying approval | Each user's latest non-comment review is `APPROVED` **and** was given on the **current head SHA** (so a push resets approvals). The user has write, maintain or admin permission, is not the PR author, and is not a bot |
| Repo overrides | REVIEW.md frontmatter `risk_high_paths: [globs]` forces high. It's read from the base branch, so a PR can't loosen its own rules |

## Rule floor (pure function over the full PR diff plus the round's results)

- **High** if any of these:
  - a CI workflow file (`.github/workflows/**`) changed;
  - `risk_high_paths` matches;
  - a High or Medium security finding was introduced this round;
  - the review was skipped (diff over `max_diff_lines`) or paused at the round cap.
- **Medium** if any of these: the security pass escalated to full (`needsFullPass`: auth, crypto, payments, infra, dependency manifests, or risky added code); more than 200 changed lines; any changed file that isn't docs or tests (`*.md`, `docs/**`, test globs); an Important bug finding was posted this round.
- **Low** otherwise: a small change to docs and tests only.

Notes:
- The bug and security gates already block on open findings, so `low` doesn't re-check them. Findings raise the tier only because a PR that introduced a vulnerability deserves human eyes even after the fix, and stickiness keeps that.
- Security-sensitive paths were originally high. Following the article (sensitive areas are medium; high is "a small set of paths"), they are now medium, and the classifier can still raise a genuinely risky change. Owners list their own always-two-people paths in `risk_high_paths`.
- With the defaults, almost every code PR is at least medium. Repos that want a zero-approval path for small code changes can set `risk_approvals: { medium: 0 }`.

## Classifier

- One Pi session using `verifier_model`, with read-only tools confined to the checkout (same sandbox as the reviewers).
- Input: the PR diff, title and body, the rule floor and its reasons.
- It submits `{ tier, reasons[] }` through a terminating `submit_risk` tool.
- Final tier = `max(floor, classifier, stored tier)`.
- **Failure handling:** if the call fails or returns invalid output, the tier is `max(floor, medium, stored)`, the failure is noted in the check summary, and the run doesn't fail.
- The prompt states that the diff is untrusted data and that the answer can only raise the floor (code enforces this anyway).

## Pipeline

**Review runs** (`pull_request` opened or synchronize):
1. Publish the approvals check right away with the stored tier, at least `medium` on the first round. This way a fresh push is never mergeable while the classifier runs.
2. Run the bug and security passes as today.
3. Compute the floor from the full PR diff, the escalation result and this round's findings, then run the classifier.
4. Store `tier` and `tierReasons` in the state marker, set the `risk:<tier>` label (removing other `risk:*` labels), add one line to the summary (`Risk: **high** (2 approvals): touches .github/workflows/…`), and republish the approvals check.

**Gate runs** (`pull_request_review` submitted or dismissed):
- Read the stored tier, count qualifying approvals and republish the approvals check.
- No LLM call, and no API key needed.
- A PR without a stored tier (reviewed before tiers were enabled) is treated as `medium` until the next review run.

## Architecture changes

- **New module `src/risk/`**:
  - `assessRisk(signals, overrides): RiskFloor`, a pure function;
  - `classifyRisk(classifier: RiskClassifier, input, floor): Promise<RiskAssessment>`;
  - `countApprovals(reviews, headSha, author, permissionOf): number`;
  - `requiredApprovals(tier, overrides)`;
  - types `RiskTier`, `RiskAssessment`, `RiskClassifier`.
  - It reuses `needsFullPass` from `security/`.
- **`pi-reviewer/`:** `createPiReviewer` also implements `RiskClassifier` (adds a prompt, a schema and the `submit_risk` tool).
- **`GitHub` interface** gains:
  - `pullReviews()`: paginated `GET /pulls/{n}/reviews`, returning `{ user, userType, state, commitId }`;
  - `permissionOf(login)`: `GET /collaborators/{login}/permission`, cached per run;
  - `setLabels(add, removePrefix)`.
- **`workflow/`:**
  - the state marker gains optional `tier` and `tierReasons`;
  - `publishGates` publishes the third check when tiers are on;
  - `reviewRound` calls the risk step after the passes.
- **Inputs:** `risk_tiers` (`on` | `off`, default `off`). `inputs.ts` maps the `pull_request_review` event to a `gate` run.
- **REVIEW.md frontmatter:** `risk_high_paths`, `risk_approvals`.
- **Workflow permissions:** add `issues: write`, which labels need. README: add `pull_request_review: [submitted, dismissed]` to the triggers.

## Eval

- Extend `expected.json` with an optional `risk: low|medium|high`, and report tier accuracy.
- Add two cases: a docs-only change (low) and a workflow file edit (high).
- The existing cases get the expected tier: the bug cases medium, the sec cases high.

## Build order (TDD)

1. `risk/` pure functions: `assessRisk`, `requiredApprovals`, `countApprovals` (stale SHA, author, bot, read-only user, dismissed, latest-review-wins), with exhaustive tests.
2. `classifyRisk` with a fake classifier: raise-only, failure fallback, invalid tier.
3. `GitHub` client: `pullReviews`, `permissionOf`, `setLabels`, tested with the fake `GitHubApi`.
4. `pi-reviewer` risk prompt, schema and tool; extend the fake-SSE integration test.
5. `workflow`:
   - state fields;
   - early check on push;
   - risk step after the passes;
   - summary line and label;
   - the third check in `publishGates`;
   - gate runs on `pull_request_review`.
6. `inputs.ts`, `action.yml`, README (setup: branch protection to 0 approvals, the required check, the trigger, the `issues: write` permission), and the local CLI (`--risk`).
7. Eval cases; live run.
8. Release `v1.2.0`, together with the pending security release decision.

## Status

Built: 417 tests passing. Live eval (quick depth, Ollama Cloud): 13 of 13 tiers right, with bug and security recall both 100%.

Classifier tuning:
- **Database reads:** the first prompt raised a parameterized lookup-by-email to high. The prompt now says database reads and new endpoints that reuse existing auth are medium, and high needs a specific costly or irreversible failure.
- **Defects:** that rule then pushed a buggy-but-ordinary change (a missing await) to high. The prompt now says to judge the kind of change, not its defects, because bugs have their own gate.

Changes after code review:
- **Stale tier on a new head (the bypass):** a stored tier counts only when `state.sha` is the current head. On a newer, unassessed head it is at least medium, so a push after a `low` round never starts with a green approvals check, even if the review run then crashes.
- **Dotfiles:** `risk_high_paths` and `security_paths` also match dot segments (`config/.prod.env`), through `matchesGlobDot`. It is used only where a match raises scrutiny, never for `skip_paths`.
- **Invalid base REVIEW.md:** publishes a failing approvals check that names the error, instead of leaving an old verdict in place.
- **Race between review and approval runs:** the README now puts every run for a PR in one concurrency group, where only pushes and dispatches cancel.
- **Accepted limits (documented):**
  - only the PR author is excluded, not other pushers;
  - fork PRs stay blocked until a maintainer dispatches;
  - permission changes aren't re-checked until the next review event;
  - a rename's old path isn't checked against the path rules.

## Risks

- **Misconfiguration silently weakens review.** If a repo sets branch protection to 0 approvals but forgets to require the `/approvals` check, nothing blocks. The README must spell out both steps. The check summary also says "not enforced unless required".
- **`GITHUB_TOKEN` limits.**
  - The permission lookup needs `metadata: read`, which `GITHUB_TOKEN` always has.
  - Reviews on fork PRs run with a read-only token, consistent with same-repo-only.
  - Checks created by `GITHUB_TOKEN` don't trigger other workflows, which is fine.
- **Gate race.** An approval submitted while a review run is mid-flight is counted by the gate run. The review run's final republish recounts, so whichever finishes last is correct, because both read live reviews.
- **Approval reset on every push** adds friction to iterative PRs. It's the safer default and matches the article; a later `risk_keep_approvals` input could relax it.
- **Classifier cost:** one cheap-model session per round.
