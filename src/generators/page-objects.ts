/**
 * Page Object Generator — creates Playwright Page Object classes from
 * the codebase analysis.
 *
 * Spec reference: Section 4.2 (Generate Phase — Page Objects)
 */

import { join, basename } from 'node:path';
import type { QAAgentConfig } from '../core/config.js';
import type { AppAnalysis, Route, Form, FormField } from '../core/analyzer.js';
import { writeFileSafe } from '../core/fs-utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a route path like /admin/orders/:id to a PascalCase class name. */
function routeToClassName(routePath: string): string {
  return (
    routePath
      .replace(/^\//, '')
      .replace(/\/$/, '')
      .split('/')
      .filter((seg) => !seg.startsWith(':'))
      .map((seg) => seg.replace(/[^a-zA-Z0-9]/g, ''))
      .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
      .join('') || 'Home'
  ) + 'Page';
}

/** Convert a route path to a safe file name. */
function routeToFileName(routePath: string): string {
  const name = routePath
    .replace(/^\//, '')
    .replace(/\/$/, '')
    .replace(/\//g, '-')
    .replace(/:/g, '')
    .replace(/[^a-zA-Z0-9-]/g, '') || 'home';
  return `${name}.page.ts`;
}

/** Convert a field name to a human-readable label for getByLabel. */
function fieldNameToLabel(name: string): string {
  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]/g, ' ')
    .trim()
    .toLowerCase();
}

/** Capitalize the first letter of a string. */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Generate a method name from a field name. */
function fieldToMethodName(fieldName: string, prefix: string): string {
  const camel = fieldName.replace(/[_-](\w)/g, (_, c) => c.toUpperCase());
  return prefix + capitalize(camel);
}

/** Find forms that are likely associated with a given route. */
function findFormsForRoute(routePath: string, forms: Form[]): Form[] {
  // Heuristic: match forms whose location includes parts of the route path
  const routeSegments = routePath
    .replace(/^\//, '')
    .split('/')
    .filter((s) => !s.startsWith(':') && s.length > 0);

  if (routeSegments.length === 0) return [];

  return forms.filter((form) => {
    const formLocation = form.location.toLowerCase();
    return routeSegments.some((seg) => formLocation.includes(seg.toLowerCase()));
  });
}

/** Generate selector strategy for a form field. */
function generateFieldSelector(field: FormField): string {
  switch (field.type) {
    case 'select':
      return `this.page.getByLabel(/${fieldNameToLabel(field.name)}/i)`;
    case 'checkbox':
      return `this.page.getByRole('checkbox', { name: /${fieldNameToLabel(field.name)}/i })`;
    case 'radio':
      return `this.page.getByRole('radio', { name: /${fieldNameToLabel(field.name)}/i })`;
    case 'textarea':
      return `this.page.getByRole('textbox', { name: /${fieldNameToLabel(field.name)}/i })`;
    default:
      return `this.page.getByLabel(/${fieldNameToLabel(field.name)}/i)`;
  }
}

// ---------------------------------------------------------------------------
// Page Object generation
// ---------------------------------------------------------------------------

/** Generate a single Page Object class as a TypeScript string. */
function generatePageObjectClass(
  route: Route,
  associatedForms: Form[],
  baseUrl: string,
): string {
  const className = routeToClassName(route.path);
  const lines: string[] = [];

  lines.push(`import { type Page, type Locator, expect } from '@playwright/test';`);
  lines.push('');
  lines.push(`export class ${className} {`);
  lines.push(`  readonly page: Page;`);
  lines.push('');
  lines.push(`  constructor(page: Page) {`);
  lines.push(`    this.page = page;`);
  lines.push(`  }`);
  lines.push('');

  // goto() method
  const gotoPath = route.path.replace(/:(\w+)\*?/g, (_, param) => `\${${param}}`);
  if (route.params && route.params.length > 0) {
    const paramArgs = route.params.map((p) => `${p}: string`).join(', ');
    lines.push(`  /** Navigate to ${route.path} */`);
    lines.push(`  async goto(${paramArgs}) {`);
    lines.push(`    await this.page.goto(\`${gotoPath}\`);`);
    lines.push(`  }`);
  } else {
    lines.push(`  /** Navigate to ${route.path} */`);
    lines.push(`  async goto() {`);
    lines.push(`    await this.page.goto('${route.path}');`);
    lines.push(`  }`);
  }
  lines.push('');

  // Form interaction methods
  const allFields: FormField[] = [];
  for (const form of associatedForms) {
    for (const field of form.fields) {
      // Deduplicate by name
      if (!allFields.some((f) => f.name === field.name)) {
        allFields.push(field);
      }
    }
  }

  if (allFields.length > 0) {
    lines.push(`  // --- Form interactions ---`);
    lines.push('');

    for (const field of allFields) {
      const selector = generateFieldSelector(field);

      switch (field.type) {
        case 'checkbox':
          lines.push(`  /** Toggle the ${field.name} checkbox */`);
          lines.push(`  async ${fieldToMethodName(field.name, 'toggle')}() {`);
          lines.push(`    await ${selector}.click();`);
          lines.push(`  }`);
          lines.push('');
          lines.push(`  /** Check if ${field.name} is checked */`);
          lines.push(`  async ${fieldToMethodName(field.name, 'expectChecked')}() {`);
          lines.push(`    await expect(${selector}).toBeChecked();`);
          lines.push(`  }`);
          break;

        case 'radio':
          lines.push(`  /** Select the ${field.name} radio option */`);
          lines.push(`  async ${fieldToMethodName(field.name, 'select')}(value: string) {`);
          lines.push(`    await this.page.getByRole('radio', { name: new RegExp(value, 'i') }).click();`);
          lines.push(`  }`);
          break;

        case 'select':
          lines.push(`  /** Select a value in the ${field.name} dropdown */`);
          lines.push(`  async ${fieldToMethodName(field.name, 'select')}(value: string) {`);
          lines.push(`    await ${selector}.selectOption(value);`);
          lines.push(`  }`);
          break;

        default:
          lines.push(`  /** Fill the ${field.name} field */`);
          lines.push(`  async ${fieldToMethodName(field.name, 'fill')}(value: string) {`);
          lines.push(`    await ${selector}.fill(value);`);
          lines.push(`  }`);
          break;
      }
      lines.push('');
    }

    // Submit method
    lines.push(`  /** Click the submit/save button */`);
    lines.push(`  async submit() {`);
    lines.push(`    await this.page.getByRole('button', { name: /submit|save|confirm|continue|send|add|create|update|sign in|log in/i }).click();`);
    lines.push(`  }`);
    lines.push('');
  }

  // Generic click method
  lines.push(`  /** Click a button by its visible text */`);
  lines.push(`  async clickButton(name: string | RegExp) {`);
  lines.push(`    await this.page.getByRole('button', { name }).click();`);
  lines.push(`  }`);
  lines.push('');

  // Click link method
  lines.push(`  /** Click a link by its visible text */`);
  lines.push(`  async clickLink(name: string | RegExp) {`);
  lines.push(`    await this.page.getByRole('link', { name }).click();`);
  lines.push(`  }`);
  lines.push('');

  // --- Assertion methods ---
  lines.push(`  // --- Assertions ---`);
  lines.push('');

  lines.push(`  /** Assert the page URL matches the expected path */`);
  lines.push(`  async expectUrl(path: string | RegExp) {`);
  lines.push(`    if (typeof path === 'string') {`);
  lines.push(`      await expect(this.page).toHaveURL(new RegExp(path.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&')));`);
  lines.push(`    } else {`);
  lines.push(`      await expect(this.page).toHaveURL(path);`);
  lines.push(`    }`);
  lines.push(`  }`);
  lines.push('');

  lines.push(`  /** Assert that a specific text is visible on the page */`);
  lines.push(`  async expectText(text: string | RegExp) {`);
  lines.push(`    await expect(this.page.getByText(text).first()).toBeVisible();`);
  lines.push(`  }`);
  lines.push('');

  lines.push(`  /** Assert that an element with a specific role and name is visible */`);
  lines.push(`  async expectVisible(role: string, name?: string | RegExp) {`);
  lines.push(`    const locator = name`);
  lines.push(`      ? this.page.getByRole(role as any, { name })`);
  lines.push(`      : this.page.getByRole(role as any);`);
  lines.push(`    await expect(locator.first()).toBeVisible();`);
  lines.push(`  }`);
  lines.push('');

  lines.push(`  /** Assert that an element with a specific role and name is NOT visible */`);
  lines.push(`  async expectHidden(role: string, name?: string | RegExp) {`);
  lines.push(`    const locator = name`);
  lines.push(`      ? this.page.getByRole(role as any, { name })`);
  lines.push(`      : this.page.getByRole(role as any);`);
  lines.push(`    await expect(locator).not.toBeVisible();`);
  lines.push(`  }`);
  lines.push('');

  lines.push(`  /** Assert page title */`);
  lines.push(`  async expectTitle(title: string | RegExp) {`);
  lines.push(`    await expect(this.page).toHaveTitle(title);`);
  lines.push(`  }`);
  lines.push('');

  // Field-specific assertions
  for (const field of allFields) {
    const selector = generateFieldSelector(field);
    lines.push(`  /** Assert ${field.name} field is visible */`);
    lines.push(`  async ${fieldToMethodName(field.name, 'expectVisible')}() {`);
    lines.push(`    await expect(${selector}).toBeVisible();`);
    lines.push(`  }`);
    lines.push('');

    if (field.type !== 'checkbox' && field.type !== 'radio') {
      lines.push(`  /** Assert ${field.name} field has a specific value */`);
      lines.push(`  async ${fieldToMethodName(field.name, 'expectValue')}(value: string) {`);
      lines.push(`    await expect(${selector}).toHaveValue(value);`);
      lines.push(`  }`);
      lines.push('');
    }
  }

  // Screenshot helper
  lines.push(`  /** Take a screenshot with a descriptive name */`);
  lines.push(`  async screenshot(name: string) {`);
  lines.push(`    await this.page.screenshot({ path: \`screenshots/\${name}.png\`, fullPage: true });`);
  lines.push(`  }`);

  lines.push('}');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Generate Page Object TypeScript files for each route discovered in the analysis.
 *
 * @param analysis - The codebase analysis result
 * @param config - QA Agent configuration
 * @returns List of generated file paths
 */
export async function generatePageObjects(
  analysis: AppAnalysis,
  config: QAAgentConfig,
): Promise<string[]> {
  const outDir = config.output.pageObjectsDir;

  const generatedFiles: string[] = [];
  const pageRoutes = analysis.routes.filter((r) => r.method === 'page');

  // Track class names to avoid duplicates
  const usedNames = new Set<string>();

  for (const route of pageRoutes) {
    let fileName = routeToFileName(route.path);
    const className = routeToClassName(route.path);

    // Skip if we already generated a page object with this name
    if (usedNames.has(className)) continue;
    usedNames.add(className);

    // Find associated forms
    const associatedForms = findFormsForRoute(route.path, analysis.forms);

    const content = generatePageObjectClass(route, associatedForms, config.app.baseUrl);
    const filePath = join(outDir, fileName);

    writeFileSafe(filePath, content);
    generatedFiles.push(filePath);
  }

  // Generate an index file that re-exports all page objects
  if (generatedFiles.length > 0) {
    const indexLines: string[] = [
      '// Auto-generated index — re-exports all page objects',
      '',
    ];
    for (const file of generatedFiles) {
      const name = basename(file, '.ts');
      indexLines.push(`export * from './${name}.js';`);
    }
    const indexPath = join(outDir, 'index.ts');
    writeFileSafe(indexPath, indexLines.join('\n') + '\n');
    generatedFiles.push(indexPath);
  }

  return generatedFiles;
}
