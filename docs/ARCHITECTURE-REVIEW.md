# Architecture Review — QA Agent Specification

**Reviewer:** Architecture Agent
**Date:** 2026-03-31
**Spec Reviewed:** `docs/SPEC.md`
**Code Reviewed:** All files under `src/`, `config/`, `templates/`, and project root

---

## 1. Interface Consistency

### 1.1 QAAgentConfig (Section 3 vs. Sections 4-6)

**NOTE — Config matches well between spec and implementation.**
The Zod schema in `src/core/config.ts` faithfully mirrors the TypeScript interface in Section 3.1 of the spec. All fields, optionality, and nesting are consistent. The `defineConfig` helper provides type safety for config authoring.

**WARNING — `defineConfig` import path mismatch.**
The spec example (Section 12) imports from `'./src/core/config'`, but the example config file (`qa-agent.config.example.ts`) imports from `'./src/core/config'` using the type-only import (`import type { QAAgentConfig }`), bypassing `defineConfig` entirely. The example config should use `defineConfig` to match the spec and get runtime validation, or the spec should note both patterns.

**WARNING — CLI command-specific options not plumbed to agents.**
The CLI parses options like `--from-scratch`, `--areas`, `--force`, `--filter`, `--viewport`, `--headed`, `--debug`, `--issue`, `--max`, `--branch`, and `--auto-merge`, but none of these are passed through to the `Orchestrator` or to agent functions. The `AgentContext` interface only provides `config`, `logger`, and `state`. These command-specific options are silently ignored at runtime.

### 1.2 AppAnalysis (Section 5 vs. Plan/Generate agents)

**BLOCKER — AppAnalysis interface not exported or implemented anywhere.**
Section 5 defines `AppAnalysis`, `Route`, `Form`, `FormField`, and related interfaces, but these types exist only in the spec Markdown. They are not defined in any TypeScript source file. The Plan and Generate agents will need to consume this type, but there is no contract for them to code against. This must be added to `src/core/analyzer.ts` (which the spec calls for in Section 10 but does not yet exist).

**WARNING — Sub-interfaces incomplete.**
The spec defines `Route`, `Form`, and `FormField` in detail but only names `ApiEndpoint`, `Component`, `StateStore`, `Rule`, `AuthFlow`, and `DataModel` without defining their shapes. Any agent that produces or consumes `AppAnalysis` cannot be built until these are specified.

### 1.3 TestRunResult / IssueData / FixResult / ValidationResult

**NOTE — Orchestrator defines its own result types, which partially overlap with spec.**
The orchestrator defines `PlanResult`, `GenerateResult`, `TestResult`, `FixResult`, and `ValidateResult`. These are reasonable but differ from some names used in the spec's prose (e.g., the spec mentions `TestRunResult` in the reporting section, but the code uses `TestResult`). This is acceptable as long as names are stabilized before agents are built.

**WARNING — No shared `IssueData` type.**
The spec describes a rich issue body (test ID, area, priority, steps, expected, actual, screenshot, console errors, environment). The Handlebars template in `templates/issue.md.hbs` expects these as template variables (`testId`, `title`, `area`, `steps`, `screenshotPath`, `consoleErrors`, etc.), but there is no TypeScript interface defining this shape. Without it, the runner agent and the GitHub reporter will have an implicit contract that can drift.

### 1.4 AuthStep Types

**NOTE — AuthStep covers all patterns used in the example config.**
The five auth actions (`navigate`, `fill`, `click`, `wait`, `saveStorage`) cover basic form-login flows.

**WARNING — Missing auth patterns for real-world apps.**
The spec does not cover:
- **OAuth/SSO flows** (redirect to external IdP, callback handling)
- **MFA/2FA** (TOTP codes, SMS codes, security keys)
- **API-token based auth** (set a cookie or header directly, skip UI login)
- **Session injection** (load an existing session token without running the login flow)

For the FlourBatch use case (NextAuth with email/password), the current steps suffice. But the spec claims the system is "generic" and "works with any web app." Apps using OAuth or MFA will not be supportable without additional auth step types.

---

## 2. Data Flow Gaps

### 2.1 Plan --> Generate

**BLOCKER — Test plan format is human-readable but not machine-parseable.**
The plan phase outputs Markdown tables (Section 4.1). The generate phase must parse these tables to produce test files. The spec does not define:
- A formal schema for the Markdown table columns (are they always `ID | Scenario | Priority | Type | Viewport | Preconditions`?)
- How to parse hierarchical grouping (`## Area:` / `### Sub-area:`)
- How `Preconditions` map to `test.beforeEach()` setup code
- What happens if the planner AI produces slightly different column headers or formatting

**Recommendation:** Either (a) define a strict JSON intermediate format between plan and generate, or (b) have the generate agent re-read the plan via AI rather than regex parsing. Option (a) is more deterministic; option (b) is more resilient to format drift but adds API cost.

### 2.2 Generate --> Test

**WARNING — Page object discovery is implicit.**
The spec says generated tests import page objects (e.g., `import { CheckoutPage } from '../page-objects/checkout.page'`). But the generate agent must know:
- What page objects already exist (to avoid regenerating or conflicting)
- The exact file names and export names of page objects
- That `pageObjectsDir` is a sibling of `testsDir` (the import path `../page-objects/` assumes this)

The config allows `testsDir` and `pageObjectsDir` to be set independently, so they could be in unrelated directories. If `testsDir = './tests'` and `pageObjectsDir = './po'`, the generated import paths would be wrong.

### 2.3 Test --> Fix

**WARNING — Fixer agent's code-discovery strategy is underspecified.**
Section 4.4 says the fixer reads the issue body and "analyzes the relevant source code." But the spec does not define:
- How the fixer locates the relevant source files (the issue template has test file/line but not the app source file)
- Whether the fixer receives the `AppAnalysis` from the plan phase or must re-analyze
- How to handle bugs in server-side code (API routes, middleware) vs. client-side code (components)
- Scope boundaries: what files is the fixer allowed to modify?

Without this, the fixer agent could attempt to modify any file, including test files, config files, or unrelated code.

### 2.4 Fix --> Validate

**NOTE — Mostly well-defined.**
The validator checks out the fix branch, runs the specific failing test, then runs the full suite. The fix branch name convention (`fix/qa-{issue-number}`) and the issue-to-test-ID mapping (stored in issue body) provide a clear link.

**WARNING — No mechanism to identify which specific test to re-run.**
The issue body contains `testFile:testLine` and a test ID, but the validator needs to translate this into a Playwright `--grep` pattern or file filter. The spec does not define how the test ID in the issue maps to a Playwright test name. If the test name is `'CF-1: Select delivery shows address form'`, the validator would need to grep for `CF-1`, but this convention is not enforced.

---

## 3. Error Handling Strategy

### 3.1 App Not Running During Test Phase

**WARNING — Health check exists but failure handling is vague.**
The config has `healthCheckPath` and `startCommand`, and Section 4.3 says "verify app is running at `baseUrl` (or start it via `startCommand`)." But the spec does not address:
- What happens if `startCommand` fails (exit code != 0)?
- Timeout for the health check (how long to wait before giving up)?
- What if the app starts but the health check endpoint returns non-200?
- What if the app crashes mid-test-run?
- Whether the agent should stop the app after tests complete (if it started it)

### 3.2 Anthropic API Rate Limiting

**BLOCKER — No retry/backoff strategy specified.**
The plan, fix, and validate phases all call the Anthropic API. The spec does not mention:
- Retry logic for 429 (rate limit) or 529 (overloaded) responses
- Exponential backoff parameters
- Maximum retry count before aborting
- Whether to checkpoint progress so a rate-limited run can resume

Given that a full run could make dozens to hundreds of API calls (especially for fix agents working in parallel), rate limiting is almost guaranteed to occur. Without a strategy, the system will crash on the first 429.

### 3.3 GitHub API Failures

**WARNING — No error handling for `gh` CLI failures.**
The spec delegates all GitHub interaction to the `gh` CLI (Section 6). But:
- `gh` may not be installed or authenticated
- The repo may not exist or the token may lack permissions
- Creating issues can fail (network, rate limits, validation)
- The spec does not define whether GitHub failures should abort the run or be logged and skipped

**NOTE — GitHub API rate limits are 5,000 requests/hour for authenticated users.** A run that files 100+ issues with screenshots could approach this limit, especially with duplicate-checking queries per issue.

### 3.4 Playwright Test Hangs

**NOTE — Timeout is configurable (`testing.timeout`).**
Playwright has its own timeout mechanism. However, the spec does not address:
- A global timeout for the entire test phase (what if there are 1,000 tests at 30s each?)
- How to handle Playwright process crashes (segfault, OOM)
- Whether hung tests should be killed and reported as failures or errors

### 3.5 Git Worktree Creation Failures

**WARNING — No fallback for worktree failures.**
Section 4.4 uses git worktrees for fix isolation. The spec does not address:
- What if the repo has uncommitted changes (worktree creation fails)?
- What if the branch already exists from a previous run?
- What if disk space is insufficient?
- Cleanup strategy: when are worktrees removed?
- Fallback: if `useWorktrees: false`, what isolation mechanism is used instead? (The spec says worktrees are configurable but defines no alternative.)

### 3.6 Config File Invalid

**NOTE — Well handled.**
The `loadConfig` function validates via Zod and produces clear error messages with field paths. This is one of the better-specified error paths.

---

## 4. Security Concerns

### 4.1 Credentials in Config

**WARNING — Auth step values reference env vars but are stored in the config object after expansion.**
The `resolveEnvVars` function in `config.ts` expands `${QA_ADMIN_PASSWORD}` into the actual password value in memory. This is fine at runtime, but:
- If the config object is ever logged (e.g., `logger.debug({ config })`) the password appears in logs
- The pino logger does not have a redaction list configured
- The `RunState` does not include config, so state persistence is safe, but any debug logging of config would leak credentials

**Recommendation:** Add pino redaction paths for known sensitive fields, or strip auth step values before logging.

**NOTE — `.env` is gitignored, `.auth/` is gitignored.** This is correct.

### 4.2 Shell Injection in `gh` Commands

**BLOCKER — Issue titles and bodies are user/AI-generated and passed to `gh` CLI.**
The spec creates issues with titles like `[Test ID] - [Scenario Description]`. If the AI-generated scenario description contains shell metacharacters (backticks, `$()`, `&&`, semicolons), and the `gh` command is invoked via `child_process.exec()` with string concatenation, this is a shell injection vector.

Example: If a test scenario is named `Check $(rm -rf /) works`, and the issue title is built via string interpolation into a shell command, the result is arbitrary command execution.

**Recommendation:** Use `child_process.execFile()` or `child_process.spawn()` (which bypass the shell) instead of `exec()`. Alternatively, pass the issue body via stdin or a temp file rather than command-line arguments.

### 4.3 Screenshot Uploads to GitHub

**WARNING — Screenshots may contain sensitive data.**
When the test runner captures screenshots of failure states, these could include:
- Admin dashboard data (customer emails, addresses, order details, revenue)
- Session tokens visible in DevTools (if the test opens DevTools)
- Personally identifiable information from test data

These screenshots are uploaded to GitHub issues, which may be in a public repo.

**Recommendation:** Add a config option to disable screenshot uploads for sensitive apps, or blur/redact known sensitive regions. At minimum, document this risk.

### 4.4 Database URL in Config

**NOTE — `databaseUrl` in `testData` config.** While it uses env var expansion (`${QA_DB_URL}`), the same logging concern from 4.1 applies. Additionally, if the QA agent has direct DB access, a bug in the agent could corrupt production data if pointed at the wrong URL.

**Recommendation:** Add a safety check that `databaseUrl` does not point to a production host (e.g., reject URLs not containing `localhost`, `127.0.0.1`, or a configurable safe-host list).

---

## 5. Scalability Considerations

### 5.1 1000+ Test Scenarios

**WARNING — No test sharding or chunking strategy.**
The spec mentions `maxParallel` for browser contexts but does not address:
- How 1,000+ tests are distributed across parallel workers
- Whether Playwright's built-in sharding (`--shard`) is leveraged
- Memory limits: 1,000 tests with screenshots and traces could produce gigabytes of artifacts
- Whether the test phase should support incremental execution (run only new/changed tests)

### 5.2 Parallel Test Execution

**NOTE — Playwright handles parallelism natively.**
The `maxParallel` config maps to Playwright's `workers` option. This is reasonable for the test phase.

**WARNING — Parallel fix agents have resource contention risks.**
Multiple fix agents running simultaneously on worktrees of the same repo could:
- Compete for Anthropic API rate limits
- Attempt to modify the same files (if two bugs share a root cause)
- Overwhelm the test runner if each fixer runs the test suite to verify its fix
- Create conflicting branches if naming collides (unlikely with issue-number naming, but possible if run concurrently on stale state)

### 5.3 Large Codebase Analysis

**BLOCKER — No file count or size limits on codebase analysis.**
Section 4.1 says the planner reads "all source files matching `sourceGlobs`." For a monorepo with 10,000+ files:
- Sending all files to the Anthropic API will exceed context window limits
- No strategy for summarization, chunking, or progressive analysis
- No file size limits (a single 50,000-line file would break analysis)
- The `excludeGlobs` help, but the spec should define a max file count and a chunking strategy

**Recommendation:** Define a two-pass analysis: (1) index file paths and extract metadata (routes, exports) without reading full file contents, (2) deep-read only files relevant to each area/feature.

### 5.4 GitHub API Rate Limits

**WARNING — Duplicate detection queries are O(n) per issue.**
For each failing test, the system queries GitHub to check for an existing open issue (Section 6.3). With 100 failures, that is 100 search API calls before creating any issues. Combined with issue creation, screenshot uploads, and label management, a single run could make 500+ GitHub API calls.

**Recommendation:** Batch duplicate-check queries (search for multiple test IDs in a single query), and implement local caching of open issues at the start of a run.

---

## 6. Missing Pieces

### 6.1 CI/CD Integration Story

**BLOCKER — No CI/CD guidance.**
Section 13 mentions "CI/CD integration (GitHub Actions workflow)" as Phase 4, but provides no detail. For a tool that creates issues and PRs, CI/CD integration is critical to define early:
- How does the agent run in CI? (Docker image? npm global install?)
- How are secrets (API keys, GitHub token) provided?
- What triggers a run? (Push to main? Scheduled cron? Manual dispatch?)
- How does CI handle the long runtime of a full pipeline (potentially 30+ minutes)?
- What is the exit code strategy? (Non-zero on failures found? Always zero with report?)

### 6.2 Test Maintenance When App Changes

**WARNING — No incremental plan/generate strategy.**
When the target app's codebase changes:
- Must the entire test plan be regenerated from scratch?
- Can the system detect which routes/components changed and update only affected tests?
- What happens to existing generated tests that reference selectors for elements that no longer exist?
- Is there a diff mode that compares old and new `AppAnalysis` and generates delta tests?

Section 13 mentions "test plan diff" as Phase 3, but since this is fundamental to ongoing use, it should be addressed in the core spec.

### 6.3 Test Data Isolation Between Parallel Test Runs

**BLOCKER — No test data isolation strategy for parallel tests.**
Section 7.2 says "tests should not depend on each other's side effects" and "tests that create orders should use unique identifiers." But:
- The seed/reset commands run once globally, not per-worker
- Parallel tests that write to the same database will conflict (e.g., two tests both try to check out the last available delivery slot)
- No mechanism for per-test or per-worker data partitioning
- No transaction rollback or snapshot/restore strategy

This will cause flaky tests in any app with shared mutable state (which is most apps).

### 6.4 Apps Requiring Specific Seed State Per Test

**WARNING — Seed granularity is too coarse.**
The current design has one global `seedCommand` and one global `resetCommand`. But many tests need specific preconditions:
- "Cart has 3 items" requires adding items before the checkout test
- "User has existing order" requires creating an order before the order-history test
- "Inventory is at zero" requires depleting stock before the sold-out test

The spec mentions `Preconditions` in the test plan table but does not define how these translate to executable setup code. The Page Object pattern handles navigation but not data setup.

**Recommendation:** Add a fixtures or factory system that maps precondition strings to executable setup functions (API calls, DB inserts, or UI automation).

### 6.5 Flaky Test Quarantine Mechanism

**WARNING — Flaky detection exists, quarantine does not.**
Section 4.3 says flaky tests get a `meta:flaky` label on their GitHub issue. But:
- Flaky tests are not excluded from future runs (they will keep failing intermittently)
- No `@flaky` tag or skip mechanism in generated test files
- No quarantine list that the test runner checks before execution
- No re-run-only-flaky-tests mode to periodically check if flaky tests stabilize
- Section 13 mentions "Flaky test detection and quarantine" as Phase 3 but provides no design

### 6.6 Additional Missing Pieces

**WARNING — No Playwright configuration generation.**
The spec mentions `config/playwright.base.ts` in the project structure (Section 10), but this file does not exist. The test runner needs a Playwright config that integrates with the QA agent's output directories, viewports, retries, and auth setup. The spec does not define how this config is generated or how it relates to the user's optional `playwrightConfig` setting.

**WARNING — Missing template files.**
Section 10 lists five templates (`issue.md.hbs`, `pr.md.hbs`, `page-object.ts.hbs`, `test-file.ts.hbs`, `report.md.hbs`). Only `issue.md.hbs` and `pr.md.hbs` exist. The three missing templates are needed by the generate and report phases.

**NOTE — No `status:wontfix` label handling.**
The label taxonomy (Section 6.2) includes `status:wontfix`, but no phase or process describes when or how this label gets applied. This is presumably a manual action, but it should be documented.

**NOTE — No versioning strategy for generated tests.**
When the generate phase runs, it overwrites `testsDir`. If a user manually edits a generated test, the next `generate` run will destroy those edits. The `--force` flag exists but the default behavior (overwrite vs. skip existing) is not defined.

---

## Summary of Findings

### BLOCKERS (5) — Must fix before building

| # | Section | Finding |
|---|---------|---------|
| B1 | 1.2 | `AppAnalysis` and related interfaces not defined in code; agents cannot be built without them |
| B2 | 2.1 | Test plan Markdown format is not machine-parseable; no schema for plan-to-generate handoff |
| B3 | 3.2 | No API retry/backoff strategy; rate limiting will crash the system |
| B4 | 5.3 | No file count/size limits or chunking strategy for large codebase analysis |
| B5 | 6.3 | No test data isolation for parallel tests; shared mutable state will cause false flakiness |

### WARNINGS (17) — Should fix soon

| # | Section | Finding |
|---|---------|---------|
| W1 | 1.1 | Example config does not use `defineConfig`; inconsistency with spec |
| W2 | 1.1 | CLI command-specific options not plumbed to agent functions |
| W3 | 1.2 | Sub-interfaces of `AppAnalysis` only named, not defined |
| W4 | 1.3 | No shared `IssueData` TypeScript interface for issue template variables |
| W5 | 1.4 | Auth steps do not cover OAuth, MFA, or session injection |
| W6 | 2.2 | Page object import paths assume relative directory layout that config does not enforce |
| W7 | 2.3 | Fixer agent's code-discovery strategy is underspecified |
| W8 | 2.4 | No defined mapping from issue test ID to Playwright test filter |
| W9 | 3.1 | Health check timeout, failure handling, and app lifecycle not defined |
| W10 | 3.3 | No error handling strategy for `gh` CLI failures |
| W11 | 3.5 | No fallback or cleanup strategy for git worktree failures |
| W12 | 4.1 | Credentials could leak via logger if config object is logged |
| W13 | 4.3 | Screenshots uploaded to GitHub may contain sensitive data |
| W14 | 5.1 | No sharding or chunking strategy for 1000+ tests |
| W15 | 5.4 | Duplicate detection is O(n) GitHub API calls per failing test |
| W16 | 6.2 | No incremental test plan/generate strategy for app changes |
| W17 | 6.6 | Three template files and `playwright.base.ts` listed in spec but missing from repo |

### NOTES (7) — Good to know

| # | Section | Finding |
|---|---------|---------|
| N1 | 1.1 | Config Zod schema matches spec interface faithfully |
| N2 | 1.3 | Orchestrator result types are reasonable; names should be stabilized |
| N3 | 1.4 | Current auth steps sufficient for FlourBatch |
| N4 | 3.6 | Config validation error messages are clear and well-implemented |
| N5 | 4.4 | Database URL should be guarded against production hosts |
| N6 | 5.2 | Playwright handles test parallelism natively |
| N7 | 6.6 | `status:wontfix` label exists but no process uses it; document as manual |

---

## Recommended Priority Order

1. **Define `AppAnalysis` and all sub-interfaces** (B1, W3) — This unblocks both the plan and generate agents.
2. **Define plan-to-generate contract** (B2) — Choose JSON intermediate format or AI re-parsing; document the decision.
3. **Add API retry/backoff middleware** (B3) — Wrap Anthropic SDK calls with exponential backoff. This is a cross-cutting concern that every agent needs.
4. **Add codebase chunking strategy** (B4) — Define max file counts, two-pass analysis, and context window budgeting.
5. **Define test data isolation** (B5) — At minimum, document that parallel workers need separate data partitions; ideally provide a per-worker seed strategy.
6. **Add `IssueData` interface and shell injection protection** (W4, Section 4.2 BLOCKER) — Define the type and use `execFile`/`spawn` for `gh` commands.
7. **Plumb CLI options to agents** (W2) — The options are parsed but discarded; wire them through `AgentContext` or a separate options bag.
