/**
 * Test File Generator — parses the Markdown test plan and produces
 * Playwright spec files grouped by area.
 *
 * Spec reference: Section 4.2 (Generate Phase — Test Files)
 */

import { join, relative, basename } from 'node:path';
import type { QAAgentConfig } from '../core/config.js';
import { parseTestPlanMarkdown } from '../core/test-plan.js';
import type { TestScenario } from '../core/test-plan.js';
import { writeFileSafe } from '../core/fs-utils.js';
import type { PageDiscovery, PageElement } from '../core/dom-discovery.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AreaGroup {
  area: string;
  subArea: string;
  scenarios: TestScenario[];
}

/**
 * Group scenarios by area and sub-area for spec file organization.
 */
function groupByArea(scenarios: TestScenario[]): AreaGroup[] {
  const groups = new Map<string, AreaGroup>();

  for (const scenario of scenarios) {
    const key = `${scenario.area}::${scenario.subArea}`;
    if (!groups.has(key)) {
      groups.set(key, { area: scenario.area, subArea: scenario.subArea, scenarios: [] });
    }
    groups.get(key)!.scenarios.push(scenario);
  }

  return Array.from(groups.values());
}

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------

/** Convert an area name to a safe file name. */
function areaToFileName(area: string, subArea: string): string {
  const areaSlug = area
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const subSlug = subArea === 'Default'
    ? ''
    : '-' + subArea.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${areaSlug}${subSlug}.spec.ts`;
}

/** Find the page object import path for a scenario based on area name. */
function findPageObjectImport(
  area: string,
  pageObjectPaths: string[],
  testsDir: string,
  pageObjectsDir: string,
): { importPath: string; className: string } | null {
  // Try to match a page object file name to the area name
  const areaSlug = area.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const areaWords = area.toLowerCase().split(/\s+/);

  for (const poPath of pageObjectPaths) {
    const poFileName = basename(poPath, '.ts').replace('.page', '');
    const poNameLower = poFileName.toLowerCase();

    // Check if any area word matches the page object name
    const matches = areaWords.some(
      (word) => poNameLower.includes(word) || word.includes(poNameLower),
    );

    if (matches) {
      const relPath = relative(testsDir, poPath).replace(/\.ts$/, '.js').replace(/\\/g, '/');
      const importPath = relPath.startsWith('.') ? relPath : './' + relPath;
      // Derive class name from file name
      const className = poFileName
        .split('-')
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join('') + 'Page';
      return { importPath, className };
    }
  }

  return null;
}

/**
 * Find the best matching PageDiscovery for an area name by checking
 * path segments and page titles.
 */
function findDiscoveryForArea(
  area: string,
  discoveries: PageDiscovery[],
): PageDiscovery | null {
  const areaLower = area.toLowerCase();
  const areaWords = areaLower.split(/\s+/);

  for (const disc of discoveries) {
    const pathLower = disc.path.toLowerCase();
    const titleLower = disc.title.toLowerCase();

    // Check if any area word matches the path or title
    const matches = areaWords.some(
      (word) => pathLower.includes(word) || titleLower.includes(word),
    );

    if (matches) return disc;
  }

  return null;
}

/**
 * Generate a comment block with discovered selectors for a page.
 */
function generateDiscoveryComment(discovery: PageDiscovery): string[] {
  const lines: string[] = [];
  lines.push(`  // --- Discovered selectors (from DOM discovery) ---`);
  lines.push(`  // Page title: ${discovery.title}`);

  if (discovery.buttons.length > 0) {
    lines.push(`  // Buttons:`);
    for (const btn of discovery.buttons.slice(0, 10)) {
      lines.push(`  //   ${btn.selector}`);
    }
  }
  if (discovery.inputs.length > 0) {
    lines.push(`  // Inputs:`);
    for (const input of discovery.inputs.slice(0, 10)) {
      lines.push(`  //   ${input.selector}`);
    }
  }
  if (discovery.links.length > 0) {
    lines.push(`  // Links:`);
    for (const link of discovery.links.slice(0, 10)) {
      lines.push(`  //   ${link.selector}`);
    }
  }
  if (discovery.forms.length > 0) {
    for (const form of discovery.forms) {
      lines.push(`  // Form "${form.name}":`);
      for (const field of form.fields) {
        lines.push(`  //   ${field.selector}`);
      }
    }
  }
  lines.push(`  // --- End discovered selectors ---`);
  return lines;
}

/** Generate a Playwright spec file for a group of scenarios. */
function generateSpecFile(
  group: AreaGroup,
  pageObjectPaths: string[],
  config: QAAgentConfig,
  discoveries?: PageDiscovery[],
): string {
  const lines: string[] = [];
  const testsDir = config.output.testsDir;
  const pageObjectsDir = config.output.pageObjectsDir;

  // Imports
  lines.push(`import { test, expect } from '@playwright/test';`);

  // Try to find a matching page object
  const po = findPageObjectImport(group.area, pageObjectPaths, testsDir, pageObjectsDir);
  if (po) {
    lines.push(`import { ${po.className} } from '${po.importPath}';`);
  }
  lines.push('');

  // Group description
  const describeLabel = group.subArea !== 'Default'
    ? `${group.area} — ${group.subArea}`
    : group.area;

  lines.push(`test.describe('${escapeQuotes(describeLabel)}', () => {`);

  // Add discovered selectors as a reference comment
  const discovery = discoveries ? findDiscoveryForArea(group.area, discoveries) : null;
  if (discovery && discovery.title !== '[unreachable]') {
    lines.push(...generateDiscoveryComment(discovery));
    lines.push('');
  }

  // Add page object variable if available
  if (po) {
    lines.push(`  let pageObject: ${po.className};`);
    lines.push('');
    lines.push(`  test.beforeEach(async ({ page }) => {`);
    lines.push(`    pageObject = new ${po.className}(page);`);
    lines.push(`    await pageObject.goto();`);
    lines.push(`  });`);
  } else {
    lines.push(`  test.beforeEach(async ({ page }) => {`);
    lines.push(`    // Navigate to the relevant page`);
    lines.push(`    // TODO: Update with the correct URL for this area`);
    lines.push(`  });`);
  }
  lines.push('');

  // Generate test blocks for each scenario
  for (const scenario of group.scenarios) {
    // Add viewport annotation for mobile-only or desktop-only tests
    if (scenario.viewport.toLowerCase() === 'mobile') {
      lines.push(`  test('${escapeQuotes(scenario.id)}: ${escapeQuotes(scenario.scenario)}', async ({ page }) => {`);
      lines.push(`    // Viewport: mobile only`);
      lines.push(`    await page.setViewportSize({ width: ${getMobileWidth(config)}, height: ${getMobileHeight(config)} });`);
    } else if (scenario.viewport.toLowerCase() === 'desktop') {
      lines.push(`  test('${escapeQuotes(scenario.id)}: ${escapeQuotes(scenario.scenario)}', async ({ page }) => {`);
      lines.push(`    // Viewport: desktop only`);
    } else {
      lines.push(`  test('${escapeQuotes(scenario.id)}: ${escapeQuotes(scenario.scenario)}', async ({ page }) => {`);
    }

    // Priority and type as comments
    lines.push(`    // Priority: ${scenario.priority} | Type: ${scenario.type}`);

    // Preconditions
    if (scenario.preconditions && scenario.preconditions !== '—' && scenario.preconditions.toLowerCase() !== 'none') {
      lines.push(`    // Preconditions: ${scenario.preconditions}`);
    }

    lines.push('');

    // When discovery data is available, add concrete selector hints
    if (discovery && discovery.title !== '[unreachable]') {
      lines.push(`    // Discovered selectors available for this page — use these instead of guessing`);
      lines.push(`    // TODO: Implement test steps for "${scenario.scenario}" using discovered selectors`);
    } else {
      lines.push(`    // TODO: Implement test steps for "${scenario.scenario}"`);
    }

    // Generate basic test structure based on type
    if (scenario.type.toLowerCase() === 'validation') {
      if (discovery && discovery.forms.length > 0) {
        const form = discovery.forms[0];
        lines.push(`    // 1. Fill form with invalid data`);
        for (const field of form.fields.slice(0, 3)) {
          lines.push(`    // await page.${field.selector}.fill('invalid');`);
        }
        lines.push(`    // 2. Submit and verify error message`);
        if (discovery.buttons.length > 0) {
          lines.push(`    // await page.${discovery.buttons[0].selector}.click();`);
        }
        lines.push(`    // 3. Verify form/action was not submitted`);
      } else {
        lines.push(`    // 1. Attempt invalid action`);
        lines.push(`    // 2. Verify error message appears`);
        lines.push(`    // 3. Verify form/action was not submitted`);
      }
    } else if (scenario.type.toLowerCase() === 'functional') {
      if (discovery && discovery.buttons.length > 0) {
        lines.push(`    // 1. Set up preconditions`);
        lines.push(`    // 2. Perform the action`);
        lines.push(`    // await page.${discovery.buttons[0].selector}.click();`);
        lines.push(`    // 3. Verify expected outcome`);
      } else {
        lines.push(`    // 1. Set up preconditions`);
        lines.push(`    // 2. Perform the action`);
        lines.push(`    // 3. Verify expected outcome`);
      }
    } else if (scenario.type.toLowerCase() === 'ux') {
      lines.push(`    // 1. Navigate to the page`);
      lines.push(`    // 2. Verify visual/interaction elements`);
      if (discovery && discovery.headings.length > 0) {
        lines.push(`    // await expect(page.${discovery.headings[0].selector}).toBeVisible();`);
      }
      lines.push(`    // 3. Take screenshot for visual comparison`);
      lines.push(`    await page.screenshot({ path: 'screenshots/${scenario.id}.png' });`);
    } else if (scenario.type.toLowerCase() === 'accessibility') {
      lines.push(`    // 1. Navigate to the page`);
      lines.push(`    // 2. Verify keyboard navigation`);
      lines.push(`    // 3. Verify ARIA attributes`);
      lines.push(`    // 4. Verify focus management`);
    }

    lines.push(`  });`);
    lines.push('');
  }

  lines.push('});');

  return lines.join('\n');
}

/** Escape single quotes in strings for use in template literals. */
function escapeQuotes(s: string): string {
  return s.replace(/'/g, "\\'");
}

/** Get mobile viewport width from config (first mobile viewport, or default). */
function getMobileWidth(config: QAAgentConfig): number {
  const mobile = config.testing.viewports.find((v) => v.name.toLowerCase().includes('mobile'));
  return mobile?.width ?? 393;
}

/** Get mobile viewport height from config. */
function getMobileHeight(config: QAAgentConfig): number {
  const mobile = config.testing.viewports.find((v) => v.name.toLowerCase().includes('mobile'));
  return mobile?.height ?? 851;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Generate Playwright test spec files from a Markdown test plan.
 *
 * @param planMarkdown - The Markdown test plan content
 * @param pageObjectPaths - Paths to generated page object files
 * @param config - QA Agent configuration
 * @param discoveries - Optional DOM discovery results for accurate selectors
 * @returns List of generated test file paths
 */
export async function generateTestFiles(
  planMarkdown: string,
  pageObjectPaths: string[],
  config: QAAgentConfig,
  discoveries?: PageDiscovery[],
): Promise<string[]> {
  const testsDir = config.output.testsDir;

  // Parse the test plan using the structured JSON intermediate format
  const testPlan = parseTestPlanMarkdown(planMarkdown);
  const scenarios = testPlan.scenarios;
  if (scenarios.length === 0) {
    return [];
  }

  // Group by area
  const groups = groupByArea(scenarios);

  const generatedFiles: string[] = [];

  for (const group of groups) {
    const fileName = areaToFileName(group.area, group.subArea);
    const content = generateSpecFile(group, pageObjectPaths, config, discoveries);
    const filePath = join(testsDir, fileName);

    writeFileSafe(filePath, content);
    generatedFiles.push(filePath);
  }

  return generatedFiles;
}
