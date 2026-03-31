# QA Agent — System Specification

## 1. Overview

QA Agent is a generic, AI-driven end-to-end testing framework that can be pointed at any web application to autonomously discover bugs and coordinate their resolution. It uses the **Evaluator-Optimizer** pattern (inspired by Anthropic's multi-agent architecture): separate agents for planning, generating, executing, evaluating, and fixing — preventing the self-assessment bias that plagues single-agent systems.

### Design Principles

1. **Generic** — Works with any web app. No hardcoded selectors, routes, or business logic. The agent learns the app from its codebase and specs.
2. **Separation of concerns** — The agent that writes tests never evaluates them. The agent that fixes bugs never validates its own fix.
3. **Deterministic when possible** — Use code-based checks for objective assertions (HTTP status, element visibility). Use AI judgment only for subjective evaluation (UX quality, layout correctness).
4. **Idempotent** — Every phase can be re-run safely. Tests are additive. Issues aren't duplicated. Fixes are isolated in worktrees.
5. **Observable** — Every decision logged. Screenshots on every failure. Full Playwright traces available.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     QA Agent CLI                         │
│  qa-agent plan | generate | test | fix | validate | run  │
└─────────────┬───────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────┐
│                    Orchestrator                           │
│  Coordinates phases, manages state, tracks progress       │
└──┬──────┬──────┬──────┬──────┬──────────────────────────┘
   │      │      │      │      │
   ▼      ▼      ▼      ▼      ▼
┌──────┐┌──────┐┌──────┐┌──────┐┌──────┐
│Plan  ││Gen   ││Test  ││Fix   ││Valid │
│Agent ││Agent ││Agent ││Agent ││Agent │
└──┬───┘└──┬───┘└──┬───┘└──┬───┘└──┬───┘
   │       │       │       │       │
   ▼       ▼       ▼       ▼       ▼
┌──────────────────────────────────────┐
│          Shared Infrastructure        │
│  • App Analyzer (codebase reader)     │
│  • Playwright Runner                  │
│  • GitHub Issue Manager               │
│  • Screenshot / Trace Store           │
│  • Test Plan Store (Markdown)         │
│  • Page Object Generator              │
└──────────────────────────────────────┘
```

---

## 3. Configuration

### 3.1 Project Configuration (`qa-agent.config.ts`)

```typescript
export interface QAAgentConfig {
  // Target application
  app: {
    /** Path to the app's source code root */
    codebasePath: string;
    /** Base URL for the running app */
    baseUrl: string;
    /** Command to start the app (if not already running) */
    startCommand?: string;
    /** Port the app runs on */
    port: number;
    /** Wait for this path to return 200 before starting tests */
    healthCheckPath?: string;
  };

  // Spec & context files the agent should read to understand the app
  context: {
    /** Path(s) to spec/requirements documents (Markdown, txt) */
    specFiles: string[];
    /** Path(s) to existing test plans (Markdown tables) */
    testPlanFiles?: string[];
    /** Glob patterns for source files to analyze */
    sourceGlobs: string[];
    /** Files to exclude from analysis */
    excludeGlobs?: string[];
  };

  // GitHub integration for bug reporting
  github: {
    /** GitHub repo in owner/repo format */
    repo: string;
    /** Labels to add to all created issues */
    defaultLabels?: string[];
    /** Label prefix for priority (e.g., "priority:high") */
    priorityLabelPrefix?: string;
    /** Assignees for new issues */
    assignees?: string[];
    /** Create issues in this project board column */
    projectBoard?: string;
  };

  // Test execution
  testing: {
    /** Playwright config file path (uses default if not specified) */
    playwrightConfig?: string;
    /** Viewports to test */
    viewports: Array<{ name: string; width: number; height: number }>;
    /** Max parallel browser contexts */
    maxParallel?: number;
    /** Screenshot on every step (not just failures) */
    screenshotEveryStep?: boolean;
    /** Record video of test runs */
    recordVideo?: boolean;
    /** Test timeout in ms */
    timeout?: number;
    /** Retry count for flaky detection */
    retries?: number;
  };

  // Authentication (for apps that require login)
  auth?: {
    /** Auth flows to set up before tests */
    flows: Array<{
      name: string;
      role: string;
      steps: AuthStep[];
    }>;
  };

  // Test data management
  testData?: {
    /** Command to seed test data before runs */
    seedCommand?: string;
    /** Command to reset test data after runs */
    resetCommand?: string;
    /** Database URL (for direct DB assertions) */
    databaseUrl?: string;
  };

  // Agent configuration
  agents: {
    /** Model to use for planning/generation */
    plannerModel?: string;
    /** Model to use for fix agents */
    fixerModel?: string;
    /** Model to use for validation */
    validatorModel?: string;
    /** Max concurrent fix agents */
    maxFixAgents?: number;
    /** Use git worktrees for fix isolation */
    useWorktrees?: boolean;
  };

  // Output
  output: {
    /** Directory for test artifacts (screenshots, traces, reports) */
    artifactsDir: string;
    /** Directory for generated test files */
    testsDir: string;
    /** Directory for generated page objects */
    pageObjectsDir: string;
    /** Directory for test plans */
    plansDir: string;
  };
}
```

### 3.2 Auth Steps

```typescript
type AuthStep =
  | { action: 'navigate'; url: string }
  | { action: 'fill'; selector: string; value: string }
  | { action: 'click'; selector: string }
  | { action: 'wait'; selector: string; state?: 'visible' | 'hidden' }
  | { action: 'saveStorage'; path: string };
```

### 3.3 Environment Variables (`.env`)

```bash
# Required
QA_APP_PATH=/path/to/your/app
QA_BASE_URL=http://localhost:3000
QA_GITHUB_REPO=owner/repo

# Optional
QA_GITHUB_TOKEN=ghp_...          # GitHub PAT (defaults to gh auth)
QA_ADMIN_EMAIL=admin@example.com  # For admin auth flow
QA_ADMIN_PASSWORD=secret          # For admin auth flow
QA_DB_URL=mysql://...             # For DB assertions
ANTHROPIC_API_KEY=sk-ant-...      # For AI agents
```

---

## 4. Phases

### 4.1 Plan Phase (`qa-agent plan`)

**Agent: Planner**
**Input:** Codebase + spec files + existing test plan (if any)
**Output:** `plans/test-plan.md` — Markdown tables of test scenarios

**Process:**
1. **Analyze codebase** — Read all source files matching `sourceGlobs`. Build a map of:
   - All routes/pages (from app router or file structure)
   - All components (from component directories)
   - All API endpoints (from API route files)
   - All form fields + validation rules (from validation schemas)
   - All state management (stores, contexts)
   - All business rules (from service files)
2. **Read spec files** — Extract requirements, acceptance criteria, user stories
3. **Read existing test plan** (if provided) — Use as a baseline, identify gaps
4. **Generate test scenarios** — For each route/feature, produce:
   - Happy path scenarios
   - Validation/error scenarios
   - Edge cases (boundary values, empty states, max lengths)
   - State transition scenarios
   - Cross-feature interaction scenarios
   - Responsive/viewport scenarios
5. **Categorize and prioritize** — Tag each scenario with:
   - Area (storefront, admin, checkout, etc.)
   - Priority (P0 critical, P1 high, P2 medium, P3 low)
   - Type (functional, validation, UX, accessibility, integration)
   - Viewport (desktop, mobile, both)
6. **Output** — Write structured Markdown test plan

**Test Plan Format:**
```markdown
## Area: Checkout Flow

### Sub-area: Fulfillment Selection

| ID | Scenario | Priority | Type | Viewport | Preconditions |
|----|----------|----------|------|----------|---------------|
| CF-1 | Select delivery, verify address form appears | P0 | functional | both | Cart has items |
| CF-2 | Select pickup, verify no address form | P1 | functional | both | Cart has items, pickup enabled |
...
```

### 4.2 Generate Phase (`qa-agent generate`)

**Agent: Generator**
**Input:** Test plan + codebase analysis
**Output:** Playwright test files + page objects

**Process:**
1. **Generate Page Objects** — For each unique page/component:
   - Analyze the actual DOM (via Playwright accessibility tree, not source code)
   - Create a Page Object class with:
     - Element selectors (prefer `getByRole`, `getByLabel`, `getByText` over CSS)
     - Common actions (fill form, click button, wait for state)
     - Assertions (element visible, text content, value)
   - Store in `pageObjectsDir`

2. **Generate Auth Setup** — From config auth flows:
   - Create `auth.setup.ts` that runs before all tests
   - Save browser storage state for each auth role
   - Tests load saved state instead of logging in each time

3. **Generate Test Files** — For each test plan section:
   - Group scenarios into logical test files (by area)
   - Each scenario becomes a `test()` block
   - Use page objects for all interactions
   - Include:
     - `test.describe()` for grouping
     - `test.beforeEach()` for navigation/setup
     - Assertions using Playwright's `expect()` API
     - Screenshot on key checkpoints
   - Handle test data: call `seedCommand` in `globalSetup`

4. **Generate Fixtures** — Shared test fixtures:
   - Authenticated page (admin, customer)
   - Seeded database state
   - Common test data (product IDs, valid addresses, test cards)

**Page Object Pattern:**
```typescript
// Generated: page-objects/checkout.page.ts
import { Page, expect } from '@playwright/test';

export class CheckoutPage {
  constructor(private page: Page) {}

  // Navigation
  async goto() {
    await this.page.goto('/checkout');
  }

  // Fulfillment step
  async selectDelivery() {
    await this.page.getByRole('radio', { name: /delivery/i }).click();
  }

  async selectPickup() {
    await this.page.getByRole('radio', { name: /pickup/i }).click();
  }

  async selectDate(dateText: string) {
    await this.page.getByRole('button', { name: dateText }).click();
  }

  async selectTimeSlot(timeText: string) {
    await this.page.getByRole('button', { name: new RegExp(timeText) }).click();
  }

  // Assertions
  async expectAddressFormVisible() {
    await expect(this.page.getByLabel(/street/i)).toBeVisible();
  }

  async expectAddressFormHidden() {
    await expect(this.page.getByLabel(/street/i)).not.toBeVisible();
  }
}
```

**Test File Pattern:**
```typescript
// Generated: tests/checkout-fulfillment.spec.ts
import { test, expect } from '@playwright/test';
import { CheckoutPage } from '../page-objects/checkout.page';

test.describe('Checkout — Fulfillment Selection', () => {
  let checkout: CheckoutPage;

  test.beforeEach(async ({ page }) => {
    // Seed cart with items (via localStorage or API)
    checkout = new CheckoutPage(page);
    await checkout.goto();
  });

  test('CF-1: Select delivery shows address form', async () => {
    await checkout.selectDelivery();
    await checkout.expectAddressFormVisible();
  });

  test('CF-2: Select pickup hides address form', async () => {
    await checkout.selectPickup();
    await checkout.expectAddressFormHidden();
  });
});
```

### 4.3 Test Phase (`qa-agent test`)

**Agent: Test Runner**
**Input:** Generated Playwright tests
**Output:** Test results + GitHub Issues for failures

**Process:**
1. **Pre-flight checks:**
   - Verify app is running at `baseUrl` (or start it via `startCommand`)
   - Run `seedCommand` if configured
   - Verify auth flows work

2. **Execute tests:**
   - Run `npx playwright test` with configured options
   - Capture: pass/fail, screenshots, traces, console errors, network errors
   - Retry failures once to detect flakiness (flaky = passes on retry)

3. **Triage results:**
   - **Pass** — Log success, move on
   - **Fail (consistent)** — Real bug, create issue
   - **Fail (flaky)** — Create issue with `flaky` label
   - **Error (test error, not app error)** — Create issue with `test-fix-needed` label

4. **File GitHub Issues:**
   - Check for existing open issue with same test ID (prevent duplicates)
   - Create issue with structured format (see Issue Template below)
   - Attach screenshot
   - Apply labels: area, priority, type
   - Link to test file + line number

5. **Generate report:**
   - HTML report (Playwright built-in)
   - Summary Markdown (pass/fail counts, new issues created)
   - Store in `artifactsDir`

**Issue Template:**
```markdown
## Bug: [Test ID] — [Scenario Description]

**Area:** Checkout > Fulfillment
**Priority:** P0
**Type:** Functional
**Viewport:** Desktop (1280x720)

### Steps to Reproduce
1. Navigate to /checkout with items in cart
2. Select "Local Delivery"
3. Observe address form

### Expected
Address form should appear with Street, City, State, Zip fields.

### Actual
Address form does not appear. Only the calendar is shown.

### Screenshot
![failure](./screenshots/CF-1-failure.png)

### Test Reference
`tests/checkout-fulfillment.spec.ts:15` — Test ID: `CF-1`

### Environment
- URL: http://localhost:3000
- Viewport: 1280x720
- Browser: Chromium 131
- Timestamp: 2026-03-31T14:22:00Z

---
*Filed automatically by [QA Agent](https://github.com/owner/qa-agent)*
```

### 4.4 Fix Phase (`qa-agent fix`)

**Agent: Fixer (multiple instances)**
**Input:** Open GitHub Issues with `qa-agent` label
**Output:** Fix branches with code changes

**Process:**
1. **Fetch open issues** — Query GitHub for issues labeled `qa-agent` + `bug`
2. **Prioritize** — Sort by priority label (P0 first)
3. **For each issue (up to `maxFixAgents` in parallel):**
   a. Create a git worktree branch: `fix/qa-{issue-number}`
   b. Read the issue body (steps to reproduce, expected, actual)
   c. Analyze the relevant source code
   d. Write the fix
   e. Run the specific failing test to verify
   f. If test passes: commit + push branch
   g. If test still fails: add comment to issue with findings, move on
4. **Create PR** (optional, configurable):
   - Title: `fix: [issue title]`
   - Body: Links to issue, describes fix, test result

**Important constraints:**
- Fixer agent NEVER marks its own fix as verified — that's the Validator's job
- Fixer agent NEVER closes the issue — Validator does that after re-running tests
- Each fixer works in an isolated worktree — no conflicts between parallel fixers

### 4.5 Validate Phase (`qa-agent validate`)

**Agent: Validator (separate from Fixer)**
**Input:** Fix branches + original test plan
**Output:** Validation results, issue comments, PR approvals/rejections

**Process:**
1. **For each fix branch:**
   a. Check out the branch in a worktree
   b. Run the specific test that was failing
   c. Run the full test suite (regression check)
   d. **If specific test passes AND no regressions:**
      - Comment on PR: "Validated — test passes, no regressions"
      - Comment on issue: "Fix verified"
      - Optionally auto-merge PR
   e. **If specific test still fails:**
      - Comment on PR: "Fix did not resolve the issue"
      - Request changes on PR
   f. **If regressions introduced:**
      - Comment on PR: "Fix introduces N new failures: [list]"
      - Request changes on PR
2. **Update issue status:**
   - Verified fixes: close issue
   - Failed fixes: reopen/comment with feedback for next iteration

### 4.6 Full Run (`qa-agent run`)

Executes all phases in sequence:
```
plan → generate → test → fix → validate
```

With configurable options:
- `--skip-plan` — Use existing test plan
- `--skip-generate` — Use existing test files
- `--no-fix` — Only discover bugs, don't attempt fixes
- `--no-validate` — Fix but don't validate (manual review)
- `--plan-only` — Just generate the test plan
- `--dry-run` — Generate everything but don't create issues or PRs

---

## 5. App Analyzer

The App Analyzer is the core intelligence that makes the system generic. It reads a codebase and produces a structured understanding.

### 5.1 Analysis Output

```typescript
interface AppAnalysis {
  routes: Route[];           // All navigable pages
  apiEndpoints: ApiEndpoint[]; // All API routes
  components: Component[];    // Key UI components
  forms: Form[];              // All forms with fields + validation
  stateStores: StateStore[];  // Global state (Zustand, Redux, Context)
  businessRules: Rule[];      // Extracted business logic
  authFlows: AuthFlow[];      // Authentication patterns
  dataModels: DataModel[];    // Database models / types
}

interface Route {
  path: string;
  method: 'page' | 'api';
  params?: string[];
  auth?: { required: boolean; roles?: string[] };
  description?: string;
}

interface Form {
  location: string;          // File path
  fields: FormField[];
  submitAction: string;
  validationSchema?: string; // Reference to Zod schema
}

interface FormField {
  name: string;
  type: 'text' | 'email' | 'number' | 'select' | 'checkbox' | 'radio' | 'textarea' | 'date' | 'time';
  required: boolean;
  constraints?: {
    min?: number;
    max?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    enum?: string[];
  };
}
```

### 5.2 Analysis Strategy

1. **Framework detection** — Identify Next.js, React, Vue, etc. from package.json
2. **Route discovery** — Parse file-based routing (App Router, Pages Router) or route config
3. **Schema extraction** — Parse Zod, Yup, Joi schemas for field constraints
4. **Component mapping** — Find form components, list components, detail components
5. **API mapping** — Find API handlers, extract request/response shapes
6. **State discovery** — Find Zustand stores, Redux slices, React Contexts
7. **Auth detection** — Find NextAuth, Passport, custom auth middleware
8. **DB model extraction** — Parse Prisma schema, TypeORM entities, etc.

---

## 6. GitHub Issue Manager

Handles all GitHub interaction through the `gh` CLI.

### 6.1 Responsibilities
- Create issues with structured format
- Check for duplicates before creating (by test ID in title)
- Upload screenshots as issue attachments
- Apply labels (create if missing)
- Update issues with fix status
- Close issues when fix verified
- Create PRs for fix branches

### 6.2 Label Taxonomy

```
area:storefront     area:admin        area:checkout
area:cart           area:auth         area:api
area:payments       area:inventory    area:fulfillment

priority:P0         priority:P1       priority:P2        priority:P3

type:functional     type:validation   type:ux
type:accessibility  type:integration  type:regression

status:new          status:fixing     status:fix-ready
status:validated    status:wontfix

meta:flaky          meta:test-fix-needed
```

### 6.3 Duplicate Detection

Before creating an issue, search for:
```
is:issue is:open label:qa-agent "[TEST-ID]" in:title
```
If found, add a comment with the latest failure data instead of creating a new issue.

---

## 7. Test Data Management

### 7.1 Seed/Reset Pattern

```yaml
# In qa-agent.config.ts
testData:
  seedCommand: "npx tsx scripts/qa-seed.ts"
  resetCommand: "npx tsx scripts/qa-reset.ts"
```

The QA agent expects:
- **Seed**: Creates a known-good state (products, admin users, settings, slots)
- **Reset**: Clears transactional data (orders, customers) back to seed state
- Both must be **idempotent** — safe to run multiple times

### 7.2 Test Isolation Strategy

- `globalSetup`: Run seed command once before all tests
- `globalTeardown`: Run reset command after all tests
- Tests should not depend on each other's side effects
- Tests that create orders should use unique identifiers
- DB assertions (if configured) verify server-side state

---

## 8. Reporting

### 8.1 Test Run Report

Generated after each test phase:

```markdown
# QA Agent Test Report — 2026-03-31

## Summary
- **Total scenarios:** 450
- **Passed:** 423 (94%)
- **Failed:** 22 (5%)
- **Flaky:** 5 (1%)
- **Skipped:** 0

## New Issues Created: 22
| Issue | Test ID | Area | Priority | Title |
|-------|---------|------|----------|-------|
| #45 | CF-1 | Checkout | P0 | Delivery address form not appearing |
| #46 | S-1.4.9 | Cart | P1 | Bulk minimum not enforced on decrement |
...

## Flaky Tests: 5
| Test ID | Area | Pass Rate | Notes |
|---------|------|-----------|-------|
| S-1.16.2 | Drop | 1/2 | Timing-sensitive countdown test |
...

## Fix Status
| Issue | Branch | Test Result | Regression Check |
|-------|--------|-------------|------------------|
| #45 | fix/qa-45 | PASS | 0 regressions |
| #46 | fix/qa-46 | FAIL | — |
...
```

### 8.2 Artifacts

Each test run produces:
```
artifacts/
  2026-03-31T14-22-00/
    report.html           # Playwright HTML report
    summary.md            # Markdown summary
    screenshots/          # Failure screenshots
      CF-1-failure.png
      S-1.4.9-failure.png
    traces/               # Playwright traces (zip)
      CF-1-trace.zip
    videos/               # Test recordings (if enabled)
```

---

## 9. CLI Interface

```
qa-agent <command> [options]

Commands:
  plan        Analyze codebase and generate test plan
  generate    Generate Playwright tests from test plan
  test        Run tests and file GitHub issues for failures
  fix         Launch fix agents for open issues
  validate    Validate fixes and close resolved issues
  run         Execute full pipeline (plan → generate → test → fix → validate)
  status      Show current state (open issues, fix branches, test results)

Global Options:
  --config <path>     Path to config file (default: qa-agent.config.ts)
  --verbose           Verbose logging
  --dry-run           Don't create issues/PRs, just show what would happen

Plan Options:
  --from-scratch      Ignore existing test plan, regenerate completely
  --areas <list>      Only plan for specified areas (comma-separated)

Generate Options:
  --force             Overwrite existing test files

Test Options:
  --filter <pattern>  Only run tests matching pattern
  --viewport <name>   Only run on specified viewport
  --headed            Run in headed browser (visible)
  --debug             Enable Playwright debug mode

Fix Options:
  --issue <number>    Fix a specific issue only
  --max <n>           Max concurrent fix agents (default: 3)

Validate Options:
  --branch <name>     Validate a specific fix branch
  --auto-merge        Auto-merge validated PRs
```

---

## 10. Project Structure

```
qa-agent/
├── README.md
├── package.json
├── tsconfig.json
├── qa-agent.config.ts          # User config (gitignored template)
├── qa-agent.config.example.ts  # Example config
├── .env.example
├── docs/
│   └── SPEC.md                 # This file
├── src/
│   ├── cli.ts                  # CLI entry point
│   ├── orchestrator.ts         # Phase coordinator
│   ├── agents/
│   │   ├── planner.ts          # Test plan generator
│   │   ├── generator.ts        # Playwright test generator
│   │   ├── runner.ts           # Test executor + issue filer
│   │   ├── fixer.ts            # Bug fix agent
│   │   └── validator.ts        # Fix validation agent
│   ├── core/
│   │   ├── analyzer.ts         # Codebase analyzer
│   │   ├── config.ts           # Config loader
│   │   ├── state.ts            # Run state manager
│   │   └── logger.ts           # Structured logging
│   ├── reporters/
│   │   ├── github.ts           # GitHub issue manager
│   │   ├── html.ts             # HTML report generator
│   │   └── markdown.ts         # Markdown report generator
│   └── generators/
│       ├── page-objects.ts     # Page Object generator
│       ├── test-files.ts       # Test file generator
│       └── fixtures.ts         # Test fixture generator
├── templates/
│   ├── issue.md.hbs            # GitHub issue template
│   ├── pr.md.hbs               # PR description template
│   ├── page-object.ts.hbs     # Page Object class template
│   ├── test-file.ts.hbs       # Test file template
│   └── report.md.hbs          # Report template
├── config/
│   ├── labels.json             # GitHub label definitions
│   └── playwright.base.ts     # Base Playwright config
└── tests/                      # Tests for the QA agent itself
    ├── analyzer.test.ts
    ├── github.test.ts
    └── generator.test.ts
```

---

## 11. Technology Stack

| Component | Technology |
|-----------|------------|
| Language | TypeScript |
| Test Runner | Playwright |
| AI Backend | Anthropic Claude API (via SDK) |
| GitHub Integration | `gh` CLI |
| Template Engine | Handlebars |
| CLI Framework | Commander.js |
| Config | TypeScript config file + dotenv |
| Logging | pino |

---

## 12. Example: FlourBatch Configuration

```typescript
// qa-agent.config.ts for FlourBatch
import { defineConfig } from './src/core/config';

export default defineConfig({
  app: {
    codebasePath: '../flourbatch',
    baseUrl: 'http://localhost:3000',
    startCommand: 'npm run dev',
    port: 3000,
    healthCheckPath: '/api/storefront/products',
  },

  context: {
    specFiles: [
      '../flourbatch/docs/SPEC.md',
      '../flourbatch/docs/E2E-TEST-PLAN.md',
    ],
    sourceGlobs: [
      '../flourbatch/src/**/*.{ts,tsx}',
      '../flourbatch/prisma/schema.prisma',
    ],
    excludeGlobs: [
      '**/node_modules/**',
      '**/*.test.*',
    ],
  },

  github: {
    repo: 'johnrod74/flourbatch.com',
    defaultLabels: ['qa-agent'],
    priorityLabelPrefix: 'priority',
    assignees: ['johnrod74'],
  },

  testing: {
    viewports: [
      { name: 'desktop', width: 1280, height: 720 },
      { name: 'mobile', width: 393, height: 851 },
    ],
    maxParallel: 4,
    timeout: 30000,
    retries: 1,
  },

  auth: {
    flows: [
      {
        name: 'admin-owner',
        role: 'owner',
        steps: [
          { action: 'navigate', url: '/admin/login' },
          { action: 'fill', selector: '[name="email"]', value: '${QA_ADMIN_EMAIL}' },
          { action: 'fill', selector: '[name="password"]', value: '${QA_ADMIN_PASSWORD}' },
          { action: 'click', selector: 'button[type="submit"]' },
          { action: 'wait', selector: '[data-testid="dashboard"]', state: 'visible' },
          { action: 'saveStorage', path: '.auth/admin.json' },
        ],
      },
    ],
  },

  testData: {
    seedCommand: 'npx tsx ../flourbatch/prisma/seed-prod.ts',
    resetCommand: 'npx tsx ../flourbatch/prisma/production-reset.mjs',
    databaseUrl: '${QA_DB_URL}',
  },

  agents: {
    plannerModel: 'claude-sonnet-4-6',
    fixerModel: 'claude-sonnet-4-6',
    validatorModel: 'claude-sonnet-4-6',
    maxFixAgents: 3,
    useWorktrees: true,
  },

  output: {
    artifactsDir: './artifacts',
    testsDir: './generated-tests',
    pageObjectsDir: './generated-tests/page-objects',
    plansDir: './plans',
  },
});
```

---

## 13. Development Phases

### Phase 1: Foundation (MVP)
- [ ] CLI skeleton with Commander.js
- [ ] Config loader + validation
- [ ] App Analyzer (Next.js support)
- [ ] Plan agent (generates test plan from codebase)
- [ ] Page Object generator (from Playwright accessibility tree)
- [ ] Test file generator (from test plan)
- [ ] Test runner (Playwright execution)
- [ ] GitHub issue reporter (create issues with screenshots)
- [ ] Markdown report generator

### Phase 2: Fix Loop
- [ ] Fixer agent (reads issue, writes fix in worktree)
- [ ] Validator agent (re-runs tests on fix branch)
- [ ] PR creation for verified fixes
- [ ] Issue lifecycle management (open → fixing → validated → closed)

### Phase 3: Intelligence
- [ ] Multi-framework support (Vue, Svelte, etc.)
- [ ] AI-powered visual regression (screenshot comparison)
- [ ] Flaky test detection and quarantine
- [ ] Test plan diff (only generate new tests for changed code)
- [ ] Learning from past runs (which areas produce most bugs)

### Phase 4: Scale
- [ ] Parallel test plan generation per area
- [ ] CI/CD integration (GitHub Actions workflow)
- [ ] Scheduled runs (cron)
- [ ] Dashboard UI for results
- [ ] Webhook triggers (run on PR)
