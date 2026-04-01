/**
 * DOM Discovery — navigates to each page with Playwright, captures the
 * accessibility tree and interactive elements, and returns structured
 * page discovery data with accurate selectors.
 *
 * Used when the `--discover` flag is passed to generate/run commands.
 */

import { join } from 'node:path';
import { chromium } from '@playwright/test';
import type { Browser, Page, BrowserContext } from '@playwright/test';
import type { QAAgentConfig } from './config.js';
import type { Route } from './analyzer.js';
import { writeFileSafe } from './fs-utils.js';

// ---------------------------------------------------------------------------
// Exported interfaces
// ---------------------------------------------------------------------------

export interface PageElement {
  role: string;
  name: string;
  selector: string;
}

export interface PageDiscovery {
  path: string;
  title: string;
  headings: PageElement[];
  buttons: PageElement[];
  links: PageElement[];
  inputs: PageElement[];
  forms: { name: string; fields: PageElement[] }[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the best Playwright selector for an element given its role and name.
 * Prefers `getByRole` with name, falls back to role-only selectors.
 */
function buildSelector(role: string, name: string): string {
  if (name) {
    const escaped = name.replace(/'/g, "\\'");
    return `getByRole('${role}', { name: '${escaped}' })`;
  }
  return `getByRole('${role}')`;
}

/**
 * Extract interactive elements from the page using `page.evaluate`.
 * Returns raw element data that we transform into PageElement[].
 */
async function extractElements(page: Page): Promise<{
  headings: PageElement[];
  buttons: PageElement[];
  links: PageElement[];
  inputs: PageElement[];
  forms: { name: string; fields: PageElement[] }[];
}> {
  const rawData = await page.evaluate(() => {
    function getAccessibleName(el: Element): string {
      // aria-label takes priority
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) return ariaLabel;

      // aria-labelledby
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const labelEl = document.getElementById(labelledBy);
        if (labelEl) return labelEl.textContent?.trim() ?? '';
      }

      // For inputs, check associated label
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        const id = el.id;
        if (id) {
          const label = document.querySelector(`label[for="${id}"]`);
          if (label) return label.textContent?.trim() ?? '';
        }
        // Check placeholder as fallback
        if ('placeholder' in el && el.placeholder) return el.placeholder;
      }

      // Text content for buttons, links, headings
      return el.textContent?.trim() ?? '';
    }

    function getRole(el: Element): string {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;

      const tag = el.tagName.toLowerCase();
      if (tag === 'button' || (tag === 'input' && (el as HTMLInputElement).type === 'submit')) return 'button';
      if (tag === 'a') return 'link';
      if (tag === 'input') {
        const type = (el as HTMLInputElement).type;
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        return 'textbox';
      }
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return 'combobox';
      if (/^h[1-6]$/.test(tag)) return 'heading';
      return tag;
    }

    const result = {
      headings: [] as Array<{ role: string; name: string }>,
      buttons: [] as Array<{ role: string; name: string }>,
      links: [] as Array<{ role: string; name: string }>,
      inputs: [] as Array<{ role: string; name: string }>,
      forms: [] as Array<{ name: string; fields: Array<{ role: string; name: string }> }>,
    };

    // Headings
    document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]').forEach((el) => {
      result.headings.push({ role: 'heading', name: getAccessibleName(el) });
    });

    // Buttons
    document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]').forEach((el) => {
      result.buttons.push({ role: 'button', name: getAccessibleName(el) });
    });

    // Links
    document.querySelectorAll('a[href], [role="link"]').forEach((el) => {
      result.links.push({ role: 'link', name: getAccessibleName(el) });
    });

    // Inputs
    document.querySelectorAll('input:not([type="submit"]):not([type="button"]):not([type="hidden"]), textarea, select').forEach((el) => {
      const role = getRole(el);
      result.inputs.push({ role, name: getAccessibleName(el) });
    });

    // Forms
    document.querySelectorAll('form').forEach((form) => {
      const formName = form.getAttribute('aria-label')
        ?? form.getAttribute('name')
        ?? form.id
        ?? 'unnamed-form';
      const fields: Array<{ role: string; name: string }> = [];

      form.querySelectorAll('input:not([type="submit"]):not([type="button"]):not([type="hidden"]), textarea, select').forEach((el) => {
        const role = getRole(el);
        fields.push({ role, name: getAccessibleName(el) });
      });

      result.forms.push({ name: formName, fields });
    });

    return result;
  });

  // Transform raw data into PageElement[] with selectors
  const toPageElements = (items: Array<{ role: string; name: string }>): PageElement[] =>
    items.map((item) => ({
      role: item.role,
      name: item.name,
      selector: buildSelector(item.role, item.name),
    }));

  return {
    headings: toPageElements(rawData.headings),
    buttons: toPageElements(rawData.buttons),
    links: toPageElements(rawData.links),
    inputs: toPageElements(rawData.inputs),
    forms: rawData.forms.map((f) => ({
      name: f.name,
      fields: toPageElements(f.fields),
    })),
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export interface DiscoverOptions {
  /** Base URL of the running application */
  baseUrl: string;
  /** Routes to visit (from AppAnalysis) */
  routes: Route[];
  /** Path to Playwright storage state for authenticated pages */
  storageState?: string;
  /** Directory to save the discovery JSON */
  plansDir: string;
}

/**
 * Navigate to each route with a headless Playwright browser, capture the
 * accessibility tree and interactive elements, and return structured
 * discovery data.
 *
 * Results are also saved to `plans/dom-discovery.json`.
 */
export async function discoverPages(options: DiscoverOptions): Promise<PageDiscovery[]> {
  const { baseUrl, routes, storageState, plansDir } = options;

  // Only discover page routes, not API routes
  const pageRoutes = routes.filter((r) => r.method === 'page');

  let browser: Browser | undefined;
  const discoveries: PageDiscovery[] = [];

  try {
    browser = await chromium.launch({ headless: true });

    // Create context — use storageState if provided (for authenticated pages)
    const contextOptions: Record<string, unknown> = {};
    if (storageState) {
      contextOptions.storageState = storageState;
    }
    const context: BrowserContext = await browser.newContext(contextOptions);
    const page: Page = await context.newPage();

    for (const route of pageRoutes) {
      // Skip parameterised routes (e.g. /products/[id]) — they need specific values
      if (route.params && route.params.length > 0) {
        continue;
      }

      const url = `${baseUrl.replace(/\/$/, '')}${route.path}`;
      const discovery: PageDiscovery = {
        path: route.path,
        title: '',
        headings: [],
        buttons: [],
        links: [],
        inputs: [],
        forms: [],
      };

      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 15_000 });
        discovery.title = await page.title();

        const elements = await extractElements(page);
        discovery.headings = elements.headings;
        discovery.buttons = elements.buttons;
        discovery.links = elements.links;
        discovery.inputs = elements.inputs;
        discovery.forms = elements.forms;
      } catch {
        // Page unreachable or timed out — keep empty discovery with path noted
        discovery.title = '[unreachable]';
      }

      discoveries.push(discovery);
    }

    await context.close();
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  // Save results to disk
  const outputPath = join(plansDir, 'dom-discovery.json');
  writeFileSafe(outputPath, JSON.stringify(discoveries, null, 2));

  return discoveries;
}
