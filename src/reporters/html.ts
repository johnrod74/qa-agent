import { existsSync, mkdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import type { QAAgentConfig } from '../core/config.js';

// ---------------------------------------------------------------------------
// HTML report generator
// ---------------------------------------------------------------------------

/**
 * Copy Playwright's built-in HTML report to the QA Agent artifacts directory.
 *
 * Playwright generates an HTML report in the directory specified by the
 * `PLAYWRIGHT_HTML_REPORT` environment variable (or `playwright-report/`
 * by default). This function copies that report into the configured
 * artifacts directory so all run outputs are co-located.
 *
 * @param config - The QA Agent configuration.
 * @param sourceDir - Override the Playwright HTML report source directory.
 *                    Defaults to `{artifactsDir}/playwright-report`.
 */
export function generateHtmlReport(
  config: QAAgentConfig,
  sourceDir?: string,
): void {
  const artifactsDir = config.output.artifactsDir;
  const source = sourceDir ?? join(artifactsDir, 'playwright-report');
  const destination = join(artifactsDir, 'report-html');

  // If the Playwright HTML report exists, copy it to our artifacts
  if (existsSync(source)) {
    if (!existsSync(destination)) {
      mkdirSync(destination, { recursive: true });
    }

    cpSync(source, destination, { recursive: true });
  }

  // If Playwright didn't generate a report (e.g., all tests passed with
  // no HTML reporter configured), this is a no-op. The Playwright JSON
  // report and our Markdown summary are the primary artifacts.
}
