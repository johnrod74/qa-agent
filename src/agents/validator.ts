import type { AgentFn, ValidateResult } from '../orchestrator.js';
import type { QAAgentConfig } from '../core/config.js';
import { execFile } from '../core/exec.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Result of validating a single fix branch. */
export interface ValidationResult {
  branch: string;
  targetTestPassed: boolean;
  regressionCount: number;
  regressions: string[];
}

// ---------------------------------------------------------------------------
// GitHub branch/issue types (subset we need)
// ---------------------------------------------------------------------------

interface GhIssue {
  number: number;
  title: string;
  labels: Array<{ name: string }>;
}

// ---------------------------------------------------------------------------
// ValidatorAgent — Phase 2 placeholder with structured implementation plan
// ---------------------------------------------------------------------------

/**
 * The Validator agent checks out fix branches, re-runs the originally
 * failing tests, runs the full test suite for regression detection, and
 * comments on PRs/issues with results.
 *
 * Critically, the Validator is a **separate agent** from the Fixer to avoid
 * self-assessment bias (Evaluator-Optimizer pattern).
 *
 * **Current status: Phase 2 placeholder.**
 */
export class ValidatorAgent {
  /**
   * Validate a single fix branch by running the target test and
   * checking for regressions.
   *
   * @param branch - The fix branch name (e.g., "fix/qa-45").
   * @param testId - The test ID that was originally failing.
   * @param config - Full QA Agent configuration.
   * @returns ValidationResult describing the outcome.
   */
  async validateFix(
    branch: string,
    testId: string,
    config: QAAgentConfig,
    logger: import('pino').Logger,
  ): Promise<ValidationResult> {
    logger.info({ branch, testId }, 'Validating fix branch');

    // -----------------------------------------------------------------------
    // Step 1: Check out the fix branch in a worktree
    // TODO (Phase 2):
    //   a. Run `git worktree add ../validate-{branch} {branch}`
    //   b. Set up the worktree environment (npm install if needed)
    //   c. Start the app in the worktree context
    // -----------------------------------------------------------------------

    logger.info({ branch }, 'Phase 2 TODO: Check out fix branch in worktree');

    // -----------------------------------------------------------------------
    // Step 2: Run the specific failing test
    // TODO (Phase 2):
    //   a. Execute `npx playwright test --grep "{testId}"` in the worktree
    //   b. Parse results to determine if the target test now passes
    //   c. Capture screenshots/traces for comparison
    // -----------------------------------------------------------------------

    logger.info({ branch, testId }, 'Phase 2 TODO: Run target test on fix branch');

    // -----------------------------------------------------------------------
    // Step 3: Run the full test suite for regression detection
    // TODO (Phase 2):
    //   a. Execute `npx playwright test` (full suite) in the worktree
    //   b. Compare results against the last known-good baseline
    //   c. Identify any new failures that weren't present before the fix
    //   d. These are regressions introduced by the fix
    // -----------------------------------------------------------------------

    logger.info({ branch }, 'Phase 2 TODO: Run full regression suite');

    // -----------------------------------------------------------------------
    // Step 4: Report results
    // TODO (Phase 2):
    //   a. If target test passes AND no regressions:
    //      - Comment on PR: "Validated — test passes, no regressions"
    //      - Comment on issue: "Fix verified"
    //      - Update issue label to status:validated
    //      - Optionally auto-merge PR
    //      - Close the issue
    //   b. If target test still fails:
    //      - Comment on PR: "Fix did not resolve the issue"
    //      - Request changes on PR
    //   c. If regressions introduced:
    //      - Comment on PR: "Fix introduces N new failures: [list]"
    //      - Request changes on PR
    // -----------------------------------------------------------------------

    logger.info({ branch }, 'Phase 2 TODO: Report validation results');

    // -----------------------------------------------------------------------
    // Step 5: Clean up worktree
    // TODO (Phase 2):
    //   a. Stop any app process started in Step 1
    //   b. Run `git worktree remove ../validate-{branch}`
    // -----------------------------------------------------------------------

    logger.info({ branch }, 'Phase 2 TODO: Clean up validation worktree');

    // Placeholder return — no actual validation was performed
    return {
      branch,
      targetTestPassed: false,
      regressionCount: 0,
      regressions: [],
    };
  }

  /**
   * Fetch all fix branches and validate each one.
   *
   * @param config - Full QA Agent configuration.
   * @returns Array of ValidationResult for each validated branch.
   */
  async validateAll(
    config: QAAgentConfig,
    logger: import('pino').Logger,
  ): Promise<ValidationResult[]> {
    // Fetch open issues that are in "fix-ready" or "fixing" state
    let issues: GhIssue[];
    try {
      const { stdout } = await execFile('gh', [
        'issue', 'list',
        '--repo', config.github.repo,
        '--label', 'qa-agent,status:fix-ready',
        '--state', 'open',
        '--json', 'number,title,labels',
        '--limit', '50',
      ]);
      issues = JSON.parse(stdout) as GhIssue[];
    } catch (err) {
      logger.error({ err }, 'Failed to fetch fix-ready issues');
      return [];
    }

    if (issues.length === 0) {
      logger.info('No fix-ready issues to validate');
      return [];
    }

    logger.info({ count: issues.length }, 'Validating fix branches');

    // TODO (Phase 2): Extract testId from issue body
    // For now, derive branch name from issue number and use placeholder testId
    const results: ValidationResult[] = [];
    for (const issue of issues) {
      const branch = `fix/qa-${issue.number}`;
      const testId = `unknown`; // Phase 2: parse from issue body

      const result = await this.validateFix(branch, testId, config, logger);
      results.push(result);
    }

    return results;
  }
}

// ---------------------------------------------------------------------------
// Agent function export (satisfies orchestrator contract)
// ---------------------------------------------------------------------------

/**
 * Validator agent — checks out fix branches, re-runs failing tests, and
 * performs regression checks. Deliberately separate from the fixer to
 * avoid self-assessment bias.
 *
 * Phase 2 placeholder: logs validation steps but does not perform actual checks.
 */
export const validateAgent: AgentFn<ValidateResult> = async (ctx) => {
  const validator = new ValidatorAgent();
  const results = await validator.validateAll(ctx.config, ctx.logger);

  const verified = results.filter((r) => r.targetTestPassed && r.regressionCount === 0).length;
  const rejected = results.filter((r) => !r.targetTestPassed || r.regressionCount > 0).length;
  const totalRegressions = results.reduce((sum, r) => sum + r.regressionCount, 0);

  return {
    verified,
    rejected,
    regressions: totalRegressions,
  };
};
