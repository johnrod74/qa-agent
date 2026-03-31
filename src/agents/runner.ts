import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import type { AgentFn, TestResult } from '../orchestrator.js';
import type { QAAgentConfig } from '../core/config.js';
import { execFile } from '../core/exec.js';
import { GitHubReporter } from '../reporters/github.js';
import { generateMarkdownReport } from '../reporters/markdown.js';
import { generateHtmlReport } from '../reporters/html.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Summary of a single issue filed during a test run. */
export interface IssueSummary {
  issueNumber: number;
  testId: string;
  title: string;
  area: string;
  priority: string;
}

/** Aggregated result of a full test run. */
export interface TestRunResult {
  total: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  issues: IssueSummary[];
  startedAt: string;
  completedAt: string;
}

// ---------------------------------------------------------------------------
// Playwright JSON report types (subset we parse)
// ---------------------------------------------------------------------------

interface PlaywrightJsonSuite {
  title: string;
  file?: string;
  suites?: PlaywrightJsonSuite[];
  specs?: PlaywrightJsonSpec[];
}

interface PlaywrightJsonSpec {
  title: string;
  file: string;
  line: number;
  column: number;
  tests: PlaywrightJsonTest[];
}

interface PlaywrightJsonTest {
  projectName: string;
  results: PlaywrightJsonTestResult[];
  status: 'expected' | 'unexpected' | 'flaky' | 'skipped';
}

interface PlaywrightJsonTestResult {
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  duration: number;
  error?: { message?: string; stack?: string };
  attachments?: Array<{
    name: string;
    path?: string;
    contentType: string;
  }>;
  retry: number;
}

interface PlaywrightJsonReport {
  config: { rootDir: string };
  suites: PlaywrightJsonSuite[];
}

// ---------------------------------------------------------------------------
// Internal: parsed failure info
// ---------------------------------------------------------------------------

interface FailureInfo {
  testId: string;
  title: string;
  file: string;
  line: number;
  error: string;
  screenshotPath?: string;
  isFlaky: boolean;
}

// ---------------------------------------------------------------------------
// TestRunner
// ---------------------------------------------------------------------------

/**
 * Executes Playwright tests, triages results (bug vs. flaky), files GitHub
 * issues for consistent failures, and produces summary reports.
 */
export class TestRunner {
  /**
   * Run the full test cycle: pre-flight health check, Playwright execution,
   * result triage, issue filing, and report generation.
   */
  async run(config: QAAgentConfig, logger: import('pino').Logger): Promise<TestRunResult> {
    const startedAt = new Date().toISOString();

    // Ensure artifacts directory exists
    const artifactsDir = config.output.artifactsDir;
    if (!existsSync(artifactsDir)) {
      mkdirSync(artifactsDir, { recursive: true });
    }

    // 1. Pre-flight health check
    logger.info('Pre-flight: checking app availability');
    let appProcess: ChildProcess | null = null;

    const healthUrl = config.app.baseUrl + (config.app.healthCheckPath ?? '/');
    const isReachable = await this.pollUrl(healthUrl, 3, 2000);

    if (!isReachable) {
      if (config.app.startCommand) {
        logger.info({ cmd: config.app.startCommand }, 'App not reachable — starting via startCommand');
        appProcess = this.spawnApp(config);
        // Wait for app to become reachable
        const started = await this.pollUrl(healthUrl, 30, 2000);
        if (!started) {
          throw new Error(
            `App failed to become reachable at ${healthUrl} after starting`,
          );
        }
        logger.info('App started and reachable');
      } else {
        throw new Error(
          `App not reachable at ${healthUrl} and no startCommand configured`,
        );
      }
    } else {
      logger.info('App is reachable');
    }

    // 2. Run seed command if configured
    if (config.testData?.seedCommand) {
      logger.info({ cmd: config.testData.seedCommand }, 'Running seed command');
      try {
        const [cmd, ...args] = config.testData.seedCommand.split(' ');
        await execFile(cmd, args, { cwd: config.app.codebasePath, timeout: 60_000 });
      } catch (err) {
        logger.warn({ err }, 'Seed command failed — continuing anyway');
      }
    }

    // 3. Execute Playwright tests
    logger.info('Executing Playwright tests');
    const jsonOutputPath = join(artifactsDir, 'playwright-results.json');
    const htmlReportDir = join(artifactsDir, 'playwright-report');

    const playwrightArgs = [
      'playwright', 'test',
      '--reporter', `json,html`,
    ];

    if (config.testing.playwrightConfig) {
      playwrightArgs.push('--config', config.testing.playwrightConfig);
    }

    if (config.testing.retries != null) {
      playwrightArgs.push('--retries', String(config.testing.retries));
    }

    if (config.testing.timeout != null) {
      playwrightArgs.push('--timeout', String(config.testing.timeout));
    }

    if (config.testing.maxParallel != null) {
      playwrightArgs.push('--workers', String(config.testing.maxParallel));
    }

    let jsonReport: PlaywrightJsonReport;

    try {
      const env = {
        ...process.env,
        PLAYWRIGHT_JSON_OUTPUT_NAME: jsonOutputPath,
        PLAYWRIGHT_HTML_REPORT: htmlReportDir,
      };

      // npx might exit non-zero when tests fail — that's expected
      const { stdout } = await execFile('npx', playwrightArgs, {
        cwd: config.output.testsDir,
        env,
        timeout: 10 * 60_000, // 10 minutes max
        maxBuffer: 50 * 1024 * 1024, // 50MB
      }).catch(async (err: { stdout?: string; stderr?: string; code?: number }) => {
        // Playwright exits non-zero when tests fail. We still want the JSON.
        if (existsSync(jsonOutputPath)) {
          return { stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
        }
        throw err;
      });

      // Read the JSON report file
      if (!existsSync(jsonOutputPath)) {
        // If JSON file wasn't written, try parsing stdout
        throw new Error('Playwright JSON output not found');
      }
      const jsonRaw = readFileSync(jsonOutputPath, 'utf-8');
      jsonReport = JSON.parse(jsonRaw) as PlaywrightJsonReport;
    } catch (err) {
      logger.error({ err }, 'Playwright execution failed');
      throw new Error(`Failed to execute Playwright tests: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 4. Parse results
    logger.info('Parsing Playwright results');
    const { passed, failed, flaky, skipped, failures, total } = this.parseResults(jsonReport);

    logger.info({ total, passed, failed, flaky, skipped }, 'Test results parsed');

    // 5. Triage and file issues
    const issues: IssueSummary[] = [];
    let duplicates = 0;

    if (failures.length > 0) {
      logger.info({ count: failures.length }, 'Filing issues for failures');
      const reporter = new GitHubReporter(config.github);

      // Ensure labels exist
      await reporter.ensureLabels().catch((err) => {
        logger.warn({ err }, 'Failed to ensure labels — continuing');
      });

      for (const failure of failures) {
        // Check for existing issue
        const existing = await reporter.findExistingIssue(failure.testId).catch(() => null);

        if (existing) {
          logger.info({ testId: failure.testId, issueNumber: existing }, 'Duplicate issue found — adding comment');
          await reporter.addComment(
            existing,
            `Test **${failure.testId}** failed again at ${new Date().toISOString()}.\n\n` +
            `Error: \`${failure.error.substring(0, 200)}\``,
          ).catch((err) => {
            logger.warn({ err, issueNumber: existing }, 'Failed to add comment to existing issue');
          });
          duplicates++;
          continue;
        }

        // Determine area and priority from test ID
        const area = this.inferArea(failure.testId, failure.file);
        const priority = failure.isFlaky ? 'P3' : 'P1';

        // Build labels
        const labels = [
          ...(config.github.defaultLabels ?? ['qa-agent']),
          `status:new`,
        ];
        if (area) labels.push(`area:${area}`);
        labels.push(`priority:${priority}`);
        if (failure.isFlaky) labels.push('meta:flaky');

        const issueData = {
          testId: failure.testId,
          title: failure.title,
          area: area ?? 'unknown',
          priority,
          type: 'functional',
          viewport: 'desktop',
          steps: [
            `Navigate to the page under test`,
            `Execute test scenario: ${failure.title}`,
            `Observe failure`,
          ],
          expected: 'Test should pass',
          actual: failure.error.substring(0, 500),
          screenshotPath: failure.screenshotPath,
          consoleErrors: [],
          testFile: failure.file,
          testLine: failure.line,
          baseUrl: config.app.baseUrl,
          viewportWidth: config.testing.viewports[0]?.width ?? 1280,
          viewportHeight: config.testing.viewports[0]?.height ?? 720,
          browser: 'Chromium',
          timestamp: new Date().toISOString(),
          githubRepo: config.github.repo,
        };

        try {
          const issueNumber = await reporter.createIssue(issueData, labels, config.github.assignees);
          issues.push({
            issueNumber,
            testId: failure.testId,
            title: failure.title,
            area: area ?? 'unknown',
            priority,
          });
          logger.info({ testId: failure.testId, issueNumber }, 'Issue created');
        } catch (err) {
          logger.error({ err, testId: failure.testId }, 'Failed to create issue');
        }
      }
    }

    // 6. Generate reports
    const completedAt = new Date().toISOString();
    const runResult: TestRunResult = {
      total,
      passed,
      failed,
      flaky,
      skipped,
      issues,
      startedAt,
      completedAt,
    };

    // Markdown summary
    try {
      const markdownPath = join(artifactsDir, 'summary.md');
      const markdown = generateMarkdownReport(runResult, issues);
      const { writeFileSync } = await import('node:fs');
      writeFileSync(markdownPath, markdown, 'utf-8');
      logger.info({ path: markdownPath }, 'Markdown report written');
    } catch (err) {
      logger.warn({ err }, 'Failed to write markdown report');
    }

    // HTML report (copy Playwright's)
    try {
      await generateHtmlReport(config);
      logger.info('HTML report generated');
    } catch (err) {
      logger.warn({ err }, 'Failed to generate HTML report');
    }

    // Clean up spawned app
    if (appProcess) {
      appProcess.kill('SIGTERM');
      logger.info('Stopped spawned app process');
    }

    return runResult;
  }

  // -------------------------------------------------------------------------
  // Private: health check
  // -------------------------------------------------------------------------

  /**
   * Poll a URL until it returns an OK response.
   *
   * @param url          - The URL to poll.
   * @param maxAttempts  - Maximum number of attempts.
   * @param delayMs      - Milliseconds to wait between attempts.
   */
  private async pollUrl(url: string, maxAttempts: number, delayMs: number): Promise<boolean> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
        if (response.ok) return true;
      } catch {
        // Connection refused or timeout — retry
      }
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Private: app spawning
  // -------------------------------------------------------------------------

  /**
   * Spawn the target app as a background child process.
   */
  private spawnApp(config: QAAgentConfig): ChildProcess {
    const [cmd, ...args] = config.app.startCommand!.split(' ');
    const child = spawn(cmd, args, {
      cwd: config.app.codebasePath,
      stdio: 'pipe',
      detached: false,
      env: { ...process.env },
    });

    child.on('error', (err) => {
      // Log but don't crash — the health check will catch it
      console.error(`App process error: ${err.message}`);
    });

    return child;
  }

  // -------------------------------------------------------------------------
  // Private: result parsing
  // -------------------------------------------------------------------------

  /**
   * Walk the Playwright JSON report and extract counts and failure details.
   */
  private parseResults(report: PlaywrightJsonReport): {
    total: number;
    passed: number;
    failed: number;
    flaky: number;
    skipped: number;
    failures: FailureInfo[];
  } {
    let total = 0;
    let passed = 0;
    let failed = 0;
    let flaky = 0;
    let skipped = 0;
    const failures: FailureInfo[] = [];

    const walkSuite = (suite: PlaywrightJsonSuite) => {
      if (suite.specs) {
        for (const spec of suite.specs) {
          for (const test of spec.tests) {
            total++;

            switch (test.status) {
              case 'expected':
                passed++;
                break;

              case 'skipped':
                skipped++;
                break;

              case 'flaky':
                flaky++;
                failures.push(this.extractFailure(spec, test, true));
                break;

              case 'unexpected':
                failed++;
                failures.push(this.extractFailure(spec, test, false));
                break;
            }
          }
        }
      }

      if (suite.suites) {
        for (const child of suite.suites) {
          walkSuite(child);
        }
      }
    };

    for (const suite of report.suites) {
      walkSuite(suite);
    }

    return { total, passed, failed, flaky, skipped, failures };
  }

  /**
   * Extract failure details from a Playwright spec + test entry.
   */
  private extractFailure(
    spec: PlaywrightJsonSpec,
    test: PlaywrightJsonTest,
    isFlaky: boolean,
  ): FailureInfo {
    // Find the first failed result for error details
    const failedResult = test.results.find(
      (r) => r.status === 'failed' || r.status === 'timedOut',
    );

    const error = failedResult?.error?.message ?? failedResult?.error?.stack ?? 'Unknown error';

    // Find screenshot attachment
    const screenshot = failedResult?.attachments?.find(
      (a) => a.contentType.startsWith('image/') && a.path,
    );

    // Derive a test ID from the file path and title
    const testId = this.deriveTestId(spec.file, spec.title);

    return {
      testId,
      title: spec.title,
      file: spec.file,
      line: spec.line,
      error,
      screenshotPath: screenshot?.path,
      isFlaky,
    };
  }

  /**
   * Derive a short test ID from file path and spec title.
   * e.g., "checkout-fulfillment.spec.ts" + "Select delivery" => "checkout-fulfillment/Select delivery"
   */
  private deriveTestId(file: string, title: string): string {
    const base = file.replace(/\.spec\.ts$/, '').replace(/^.*\//, '');
    return `${base}/${title}`.replace(/\s+/g, '-').substring(0, 80);
  }

  /**
   * Infer the application area from a test ID or file path.
   */
  private inferArea(testId: string, file: string): string | null {
    const combined = `${testId} ${file}`.toLowerCase();
    const areaMap: Record<string, string> = {
      checkout: 'checkout',
      cart: 'cart',
      admin: 'admin',
      auth: 'auth',
      login: 'auth',
      storefront: 'storefront',
      product: 'storefront',
      payment: 'payments',
      stripe: 'payments',
      api: 'api',
      inventory: 'inventory',
      fulfillment: 'fulfillment',
      delivery: 'fulfillment',
      pickup: 'fulfillment',
    };

    for (const [keyword, area] of Object.entries(areaMap)) {
      if (combined.includes(keyword)) return area;
    }

    return null;
  }
}

// ---------------------------------------------------------------------------
// Agent function export (satisfies orchestrator contract)
// ---------------------------------------------------------------------------

/**
 * Test runner agent — executes Playwright tests, triages results, and
 * files GitHub issues for failures.
 */
export const testAgent: AgentFn<TestResult> = async (ctx) => {
  const runner = new TestRunner();
  const result = await runner.run(ctx.config, ctx.logger);

  // Map TestRunResult to the TestResult interface expected by orchestrator.
  // `duplicates` = failures that matched an existing open issue and were
  // not filed as new issues, i.e. total failures minus newly created issues.
  const newIssues = result.issues.length;
  const totalFailures = result.failed + result.flaky;
  return {
    total: result.total,
    passed: result.passed,
    failed: result.failed,
    flaky: result.flaky,
    issuesCreated: newIssues,
    duplicates: totalFailures - newIssues,
    issueIds: result.issues.map((i) => i.issueNumber),
  };
};
