/**
 * Fixture Generator — generates shared Playwright fixtures, auth setup,
 * global setup/teardown, and a playwright.config.ts for the generated test suite.
 *
 * Spec reference: Section 4.2 (Generate Phase — Fixtures)
 */

import { join } from 'node:path';
import type { QAAgentConfig } from '../core/config.js';
import { writeFileSafe } from '../core/fs-utils.js';

// ---------------------------------------------------------------------------
// Auth setup generator
// ---------------------------------------------------------------------------

/**
 * Generate auth.setup.ts from the config's auth flows.
 * This file runs before all tests to save authenticated browser state.
 */
function generateAuthSetup(config: QAAgentConfig): string {
  const flows = config.auth?.flows ?? [];
  if (flows.length === 0) {
    return [
      '// No auth flows configured — this file is a no-op.',
      `import { test as setup } from '@playwright/test';`,
      '',
      `setup('no auth required', async () => {`,
      `  // No authentication flows configured.`,
      `});`,
      '',
    ].join('\n');
  }

  const lines: string[] = [];
  lines.push(`import { test as setup, expect } from '@playwright/test';`);
  lines.push('');

  for (const flow of flows) {
    lines.push(`setup('authenticate as ${flow.name} (${flow.role})', async ({ page }) => {`);

    for (const step of flow.steps) {
      switch (step.action) {
        case 'navigate':
          lines.push(`  await page.goto('${step.url}');`);
          break;
        case 'fill':
          lines.push(`  await page.locator('${step.selector}').fill('${step.value}');`);
          break;
        case 'click':
          lines.push(`  await page.locator('${step.selector}').click();`);
          break;
        case 'wait':
          if (step.state === 'hidden') {
            lines.push(`  await page.locator('${step.selector}').waitFor({ state: 'hidden' });`);
          } else {
            lines.push(`  await page.locator('${step.selector}').waitFor({ state: 'visible' });`);
          }
          break;
        case 'saveStorage':
          lines.push(`  await page.context().storageState({ path: '${step.path}' });`);
          break;
      }
    }

    lines.push(`});`);
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Global setup generator
// ---------------------------------------------------------------------------

/**
 * Generate global-setup.ts that runs the seed command before all tests.
 */
function generateGlobalSetup(config: QAAgentConfig): string {
  const seedCommand = config.testData?.seedCommand;

  const lines: string[] = [];
  lines.push(`import { execSync } from 'node:child_process';`);
  lines.push('');
  lines.push(`/**`);
  lines.push(` * Global setup — runs once before the entire test suite.`);
  lines.push(` * Seeds the database to a known-good state.`);
  lines.push(` *`);
  lines.push(` * DATA ISOLATION NOTE: This seed runs once globally, not per-worker.`);
  lines.push(` * If you enable fullyParallel in playwright.config.ts, you must implement`);
  lines.push(` * a per-worker data isolation strategy to avoid conflicts. Options include:`);
  lines.push(` *   - Per-worker database schemas (e.g., worker_0, worker_1, ...)`);
  lines.push(` *   - Transaction rollback after each test`);
  lines.push(` *   - Unique test data per worker using workerInfo.workerIndex`);
  lines.push(` */`);
  lines.push(`async function globalSetup() {`);
  lines.push(`  console.log('[qa-agent] Running global setup...');`);

  if (seedCommand) {
    lines.push('');
    lines.push(`  // Seed test data`);
    lines.push(`  try {`);
    lines.push(`    console.log('[qa-agent] Seeding database: ${seedCommand}');`);
    lines.push(`    execSync('${seedCommand}', { stdio: 'inherit', timeout: 120_000 });`);
    lines.push(`    console.log('[qa-agent] Database seeded successfully.');`);
    lines.push(`  } catch (error) {`);
    lines.push(`    console.error('[qa-agent] Seed command failed:', error);`);
    lines.push(`    throw error;`);
    lines.push(`  }`);
  } else {
    lines.push('');
    lines.push(`  // No seed command configured.`);
    lines.push(`  console.log('[qa-agent] No seed command configured — skipping.');`);
  }

  lines.push(`}`);
  lines.push('');
  lines.push(`export default globalSetup;`);
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Global teardown generator
// ---------------------------------------------------------------------------

/**
 * Generate global-teardown.ts that runs the reset command after all tests.
 */
function generateGlobalTeardown(config: QAAgentConfig): string {
  const resetCommand = config.testData?.resetCommand;

  const lines: string[] = [];
  lines.push(`import { execSync } from 'node:child_process';`);
  lines.push('');
  lines.push(`/**`);
  lines.push(` * Global teardown — runs once after the entire test suite.`);
  lines.push(` * Resets transactional data back to the seed state.`);
  lines.push(` */`);
  lines.push(`async function globalTeardown() {`);
  lines.push(`  console.log('[qa-agent] Running global teardown...');`);

  if (resetCommand) {
    lines.push('');
    lines.push(`  // Reset test data`);
    lines.push(`  try {`);
    lines.push(`    console.log('[qa-agent] Resetting database: ${resetCommand}');`);
    lines.push(`    execSync('${resetCommand}', { stdio: 'inherit', timeout: 120_000 });`);
    lines.push(`    console.log('[qa-agent] Database reset successfully.');`);
    lines.push(`  } catch (error) {`);
    lines.push(`    console.error('[qa-agent] Reset command failed:', error);`);
    lines.push(`    // Don\\'t throw on teardown — tests already ran`);
    lines.push(`  }`);
  } else {
    lines.push('');
    lines.push(`  // No reset command configured.`);
    lines.push(`  console.log('[qa-agent] No reset command configured — skipping.');`);
  }

  lines.push(`}`);
  lines.push('');
  lines.push(`export default globalTeardown;`);
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Playwright config generator
// ---------------------------------------------------------------------------

/**
 * Generate a playwright.config.ts tailored for the generated test suite.
 */
function generatePlaywrightConfig(config: QAAgentConfig): string {
  const hasAuth = config.auth?.flows && config.auth.flows.length > 0;
  const hasSeed = !!config.testData?.seedCommand;
  const hasReset = !!config.testData?.resetCommand;

  const lines: string[] = [];
  lines.push(`import { defineConfig, devices } from '@playwright/test';`);
  lines.push(`import { rmSync } from 'node:fs';`);
  lines.push('');
  lines.push(`// Wipe artifacts before each run — only latest screenshots survive`);
  lines.push(`try { rmSync('./artifacts', { recursive: true, force: true }); } catch {}`);
  lines.push(`try { rmSync('../artifacts/html-report', { recursive: true, force: true }); } catch {}`);
  lines.push(`try { rmSync('../test-results', { recursive: true, force: true }); } catch {}`);
  lines.push('');
  lines.push(`/**`);
  lines.push(` * Playwright configuration — auto-generated by QA Agent.`);
  lines.push(` * Tailored for the target application at ${config.app.baseUrl}`);
  lines.push(` */`);
  lines.push(`export default defineConfig({`);
  lines.push(`  testDir: '.',`);
  lines.push(`  timeout: ${config.testing.timeout ?? 30_000},`);
  lines.push(`  retries: ${config.testing.retries ?? 1},`);
  lines.push(`  workers: ${config.testing.maxParallel ?? 4},`);
  lines.push(`  // Sequential by default to avoid test data conflicts in shared databases.`);
  lines.push(`  // For parallel execution, the app needs per-worker data isolation`);
  lines.push(`  // (e.g., per-worker DB schemas, transaction rollback, or isolated seed data).`);
  lines.push(`  fullyParallel: false,`);
  lines.push('');
  lines.push(`  reporter: [`);
  lines.push(`    ['list'],`);
  lines.push(`    ['html', { open: 'never', outputFolder: '${config.output.artifactsDir}/html-report' }],`);
  lines.push(`    ['json', { outputFile: '${config.output.artifactsDir}/results.json' }],`);
  lines.push(`  ],`);
  lines.push('');
  lines.push(`  use: {`);
  lines.push(`    baseURL: '${config.app.baseUrl}',`);
  lines.push(`    trace: 'on-first-retry',`);
  lines.push(`    screenshot: '${config.testing.screenshotEveryStep ? 'on' : 'only-on-failure'}',`);

  if (config.testing.recordVideo) {
    lines.push(`    video: 'on-first-retry',`);
  }

  lines.push(`    actionTimeout: 10_000,`);
  lines.push(`    navigationTimeout: 15_000,`);
  lines.push(`  },`);
  lines.push('');

  // Global setup/teardown
  if (hasSeed) {
    lines.push(`  globalSetup: './global-setup.ts',`);
  }
  if (hasReset) {
    lines.push(`  globalTeardown: './global-teardown.ts',`);
  }
  lines.push('');

  // Projects — one per viewport, plus optional auth setup
  lines.push(`  projects: [`);

  if (hasAuth) {
    lines.push(`    {`);
    lines.push(`      name: 'auth-setup',`);
    lines.push(`      testMatch: 'auth.setup.ts',`);
    lines.push(`    },`);
    lines.push('');
  }

  for (const viewport of config.testing.viewports) {
    lines.push(`    {`);
    lines.push(`      name: '${viewport.name}',`);

    if (hasAuth) {
      lines.push(`      dependencies: ['auth-setup'],`);
    }

    lines.push(`      use: {`);
    lines.push(`        viewport: { width: ${viewport.width}, height: ${viewport.height} },`);

    // Use mobile device emulation for small viewports
    if (viewport.width < 768) {
      lines.push(`        ...devices['iPhone 14'],`);
      lines.push(`        viewport: { width: ${viewport.width}, height: ${viewport.height} },`);
    }

    // If there's an auth flow, use the saved storage state
    if (hasAuth) {
      const adminFlow = config.auth!.flows.find((f) =>
        f.role === 'owner' || f.role === 'admin',
      );
      if (adminFlow) {
        const saveStep = adminFlow.steps.find((s) => s.action === 'saveStorage');
        if (saveStep && saveStep.action === 'saveStorage') {
          lines.push(`        storageState: '${saveStep.path}',`);
        }
      }
    }

    lines.push(`      },`);
    lines.push(`    },`);
    lines.push('');
  }

  lines.push(`  ],`);

  // Web server (start the app if configured)
  if (config.app.startCommand) {
    lines.push('');
    lines.push(`  webServer: {`);
    lines.push(`    command: '${config.app.startCommand}',`);
    lines.push(`    port: ${config.app.port},`);
    lines.push(`    reuseExistingServer: true,`);
    lines.push(`    timeout: 60_000,`);
    if (config.app.healthCheckPath) {
      lines.push(`    url: '${config.app.baseUrl}${config.app.healthCheckPath}',`);
    }
    lines.push(`  },`);
  }

  lines.push(`});`);
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Generate all fixture files for the test suite:
 * - auth.setup.ts (auth flows)
 * - global-setup.ts (seed command)
 * - global-teardown.ts (reset command)
 * - playwright.config.ts (Playwright configuration)
 *
 * @param config - QA Agent configuration
 * @returns List of generated file paths
 */
export async function generateFixtures(config: QAAgentConfig): Promise<string[]> {
  const testsDir = config.output.testsDir;
  const generatedFiles: string[] = [];

  // Auth setup
  const authContent = generateAuthSetup(config);
  const authPath = join(testsDir, 'auth.setup.ts');
  writeFileSafe(authPath, authContent);
  generatedFiles.push(authPath);

  // Global setup
  const globalSetupContent = generateGlobalSetup(config);
  const globalSetupPath = join(testsDir, 'global-setup.ts');
  writeFileSafe(globalSetupPath, globalSetupContent);
  generatedFiles.push(globalSetupPath);

  // Global teardown
  const globalTeardownContent = generateGlobalTeardown(config);
  const globalTeardownPath = join(testsDir, 'global-teardown.ts');
  writeFileSafe(globalTeardownPath, globalTeardownContent);
  generatedFiles.push(globalTeardownPath);

  // Playwright config
  const playwrightConfigContent = generatePlaywrightConfig(config);
  const playwrightConfigPath = join(testsDir, 'playwright.config.ts');
  writeFileSafe(playwrightConfigPath, playwrightConfigContent);
  generatedFiles.push(playwrightConfigPath);

  return generatedFiles;
}
