import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentFn, FixResult } from '../orchestrator.js';
import type { QAAgentConfig } from '../core/config.js';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Result of attempting to fix a single issue. */
export interface FixIssueResult {
  issueNumber: number;
  branch: string;
  testPassed: boolean;
  committed: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// GitHub issue shape (subset we need)
// ---------------------------------------------------------------------------

interface GhIssue {
  number: number;
  title: string;
  body: string;
  labels: Array<{ name: string }>;
}

// ---------------------------------------------------------------------------
// FixerAgent — Phase 2 placeholder with structured implementation plan
// ---------------------------------------------------------------------------

/**
 * The Fixer agent reads open GitHub issues filed by the test runner,
 * analyses the relevant source code, writes fixes in isolated git
 * worktree branches, and verifies the fix against the failing test.
 *
 * **Current status: Phase 2 placeholder.**
 * The structure and interface are complete, but AI-powered code analysis
 * and fix generation are not yet implemented.
 */
export class FixerAgent {
  /**
   * Attempt to fix a single GitHub issue.
   *
   * @param issueNumber - The GitHub issue number to fix.
   * @param config - Full QA Agent configuration.
   * @returns FixIssueResult describing the outcome.
   */
  async fixIssue(
    issueNumber: number,
    config: QAAgentConfig,
    logger: import('pino').Logger,
  ): Promise<FixIssueResult> {
    const branch = `fix/qa-${issueNumber}`;

    logger.info({ issueNumber, branch }, 'Analyzing issue for fix');

    // -----------------------------------------------------------------------
    // Step 1: Read the issue from GitHub
    // -----------------------------------------------------------------------

    let issue: GhIssue;
    try {
      const { stdout } = await execFile('gh', [
        'issue', 'view', String(issueNumber),
        '--repo', config.github.repo,
        '--json', 'number,title,body,labels',
      ]);
      issue = JSON.parse(stdout) as GhIssue;
    } catch (err) {
      const msg = `Failed to fetch issue #${issueNumber}: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(msg);
      return { issueNumber, branch, testPassed: false, committed: false, error: msg };
    }

    logger.info({ issueNumber, title: issue.title }, 'Issue fetched successfully');

    // -----------------------------------------------------------------------
    // Step 2: Analyse the issue and relevant source code
    // TODO (Phase 2): Use Claude API to:
    //   a. Parse the issue body to extract:
    //      - Test file + line number from "Test Reference" section
    //      - Error message from "Actual" section
    //      - Steps to reproduce
    //   b. Read the failing test file to understand what's being tested
    //   c. Read the source file(s) related to the feature under test
    //   d. Identify the root cause of the failure
    // -----------------------------------------------------------------------

    logger.info({ issueNumber }, 'Phase 2 TODO: AI analysis of issue and source code');

    // -----------------------------------------------------------------------
    // Step 3: Create an isolated worktree branch
    // TODO (Phase 2):
    //   a. Run `git worktree add ../worktree-qa-{issueNumber} -b fix/qa-{issueNumber}`
    //   b. Work within that worktree to avoid interfering with the main checkout
    //   c. If useWorktrees is false, create a regular branch instead
    // -----------------------------------------------------------------------

    logger.info({ issueNumber, branch }, 'Phase 2 TODO: Create worktree branch');

    // -----------------------------------------------------------------------
    // Step 4: Generate and apply the fix
    // TODO (Phase 2):
    //   a. Send relevant code context + issue details to Claude
    //   b. Request a minimal, targeted fix (no unnecessary refactoring)
    //   c. Apply the generated diff to the worktree
    //   d. Validate the fix compiles (run `npm run build` or `tsc --noEmit`)
    // -----------------------------------------------------------------------

    logger.info({ issueNumber }, 'Phase 2 TODO: Generate and apply code fix');

    // -----------------------------------------------------------------------
    // Step 5: Verify the fix against the failing test
    // TODO (Phase 2):
    //   a. Run only the specific failing test: `npx playwright test --grep "testId"`
    //   b. If the test passes, the fix is good
    //   c. If it still fails, log the new error and update the issue
    // -----------------------------------------------------------------------

    logger.info({ issueNumber }, 'Phase 2 TODO: Verify fix against failing test');

    // -----------------------------------------------------------------------
    // Step 6: Commit and push
    // TODO (Phase 2):
    //   a. Stage changed files
    //   b. Commit with message: `fix: resolve QA issue #{issueNumber} — {title}`
    //   c. Push the branch
    //   d. Update the issue label from status:new to status:fixing
    //   e. Add a comment to the issue describing the fix
    // -----------------------------------------------------------------------

    logger.info({ issueNumber }, 'Phase 2 TODO: Commit and push fix branch');

    // Placeholder return — no actual fix was applied
    return {
      issueNumber,
      branch,
      testPassed: false,
      committed: false,
      error: 'Fixer agent not yet implemented (Phase 2)',
    };
  }

  /**
   * Fetch all open qa-agent issues and attempt to fix each, up to maxFixAgents.
   *
   * @param config - Full QA Agent configuration.
   * @returns Array of FixIssueResult for each attempted fix.
   */
  async fixAll(
    config: QAAgentConfig,
    logger: import('pino').Logger,
  ): Promise<FixIssueResult[]> {
    const maxAgents = config.agents.maxFixAgents ?? 3;

    // Fetch open issues labeled with qa-agent
    let issues: GhIssue[];
    try {
      const { stdout } = await execFile('gh', [
        'issue', 'list',
        '--repo', config.github.repo,
        '--label', 'qa-agent',
        '--state', 'open',
        '--json', 'number,title,body,labels',
        '--limit', '50',
      ]);
      issues = JSON.parse(stdout) as GhIssue[];
    } catch (err) {
      logger.error({ err }, 'Failed to fetch open issues');
      return [];
    }

    if (issues.length === 0) {
      logger.info('No open qa-agent issues to fix');
      return [];
    }

    // Sort by priority (P0 first)
    issues.sort((a, b) => {
      const getPriority = (i: GhIssue): number => {
        for (const label of i.labels) {
          if (label.name.startsWith('priority:P')) {
            return parseInt(label.name.replace('priority:P', ''), 10);
          }
        }
        return 9; // No priority label => lowest
      };
      return getPriority(a) - getPriority(b);
    });

    // Limit to maxFixAgents
    const toFix = issues.slice(0, maxAgents);
    logger.info(
      { total: issues.length, attempting: toFix.length, maxAgents },
      'Fixing open issues',
    );

    // TODO (Phase 2): Run fixes in parallel using Promise.allSettled
    // For now, run sequentially as a placeholder
    const results: FixIssueResult[] = [];
    for (const issue of toFix) {
      const result = await this.fixIssue(issue.number, config, logger);
      results.push(result);
    }

    return results;
  }
}

// ---------------------------------------------------------------------------
// Agent function export (satisfies orchestrator contract)
// ---------------------------------------------------------------------------

/**
 * Fixer agent — reads open GitHub issues, analyses the relevant source code,
 * and writes fixes in isolated git worktree branches.
 *
 * Phase 2 placeholder: logs analysis steps but does not generate actual fixes.
 */
export const fixAgent: AgentFn<FixResult> = async (ctx) => {
  const fixer = new FixerAgent();
  const results = await fixer.fixAll(ctx.config, ctx.logger);

  const succeeded = results.filter((r) => r.committed).length;

  return {
    attempted: results.length,
    succeeded,
    branches: results.filter((r) => r.committed).map((r) => r.branch),
  };
};
