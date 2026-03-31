/**
 * Layout Checker — Playwright-based programmatic checks for common layout issues.
 *
 * These run inside Playwright tests and catch objective layout problems:
 * - Element overlap detection (bounding box intersection)
 * - Horizontal overflow (content wider than viewport)
 * - Minimum touch target sizes (44x44px for mobile)
 * - Text truncation detection (scrollWidth > clientWidth)
 */

import type { Page, Locator } from '@playwright/test';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LayoutIssue {
  type: 'overlap' | 'overflow' | 'small-target' | 'truncation';
  description: string;
  elements: string[];
}

interface BoundingRect {
  selector: string;
  x: number;
  y: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

// ---------------------------------------------------------------------------
// Overlap Detection
// ---------------------------------------------------------------------------

/**
 * Check if two bounding boxes overlap.
 */
function boxesOverlap(a: BoundingRect, b: BoundingRect): boolean {
  return !(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y);
}

/**
 * Calculate overlap area between two boxes (0 if no overlap).
 */
function overlapArea(a: BoundingRect, b: BoundingRect): number {
  const xOverlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x));
  const yOverlap = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y));
  return xOverlap * yOverlap;
}

/**
 * Get bounding rect for a locator, labeled with a description.
 */
async function getBoundingRect(locator: Locator, label: string): Promise<BoundingRect | null> {
  const box = await locator.boundingBox();
  if (!box) return null;
  return {
    selector: label,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    right: box.x + box.width,
    bottom: box.y + box.height,
  };
}

/**
 * Check a list of important elements for overlaps with each other.
 * Pass labeled locators — elements that should NOT overlap.
 *
 * @param pairs - Array of [label, locator] pairs to check
 * @param minOverlapPx - Minimum overlap area in pixels to flag (default 100)
 * @returns Array of overlap issues found
 *
 * @example
 * ```ts
 * const issues = await checkOverlaps([
 *   ['Logo', page.locator('header img')],
 *   ['Page title', page.locator('h1')],
 *   ['Navigation', page.locator('nav')],
 * ]);
 * ```
 */
export async function checkOverlaps(
  pairs: Array<[string, Locator]>,
  minOverlapPx: number = 100,
): Promise<LayoutIssue[]> {
  const issues: LayoutIssue[] = [];

  // Get all bounding rects
  const rects: BoundingRect[] = [];
  for (const [label, locator] of pairs) {
    const rect = await getBoundingRect(locator, label);
    if (rect && rect.width > 0 && rect.height > 0) {
      rects.push(rect);
    }
  }

  // Check each pair for overlap
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (boxesOverlap(rects[i], rects[j])) {
        const area = overlapArea(rects[i], rects[j]);
        if (area >= minOverlapPx) {
          issues.push({
            type: 'overlap',
            description: `"${rects[i].selector}" overlaps "${rects[j].selector}" by ${Math.round(area)}px²`,
            elements: [rects[i].selector, rects[j].selector],
          });
        }
      }
    }
  }

  return issues;
}

/**
 * Check if the page has horizontal overflow (content wider than viewport).
 */
export async function checkHorizontalOverflow(page: Page): Promise<LayoutIssue[]> {
  const issues: LayoutIssue[] = [];

  const overflow = await page.evaluate(() => {
    return document.documentElement.scrollWidth > document.documentElement.clientWidth;
  });

  if (overflow) {
    const widths = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    issues.push({
      type: 'overflow',
      description: `Page has horizontal overflow: content is ${widths.scrollWidth}px wide but viewport is ${widths.clientWidth}px`,
      elements: ['document'],
    });
  }

  return issues;
}

/**
 * Check interactive elements for minimum touch target size (44x44px per WCAG).
 * Only relevant for mobile viewports.
 */
export async function checkTouchTargets(page: Page, minSize: number = 44): Promise<LayoutIssue[]> {
  const issues: LayoutIssue[] = [];

  const smallTargets = await page.evaluate((min) => {
    const results: Array<{ tag: string; text: string; width: number; height: number }> = [];
    const interactiveElements = document.querySelectorAll('a, button, input, select, textarea, [role="button"]');

    for (const el of interactiveElements) {
      const rect = el.getBoundingClientRect();
      // Skip hidden elements
      if (rect.width === 0 || rect.height === 0) continue;
      // Skip elements outside viewport
      if (rect.top > window.innerHeight || rect.bottom < 0) continue;

      if (rect.width < min || rect.height < min) {
        const text = (el.textContent || '').trim().slice(0, 30);
        results.push({
          tag: el.tagName.toLowerCase(),
          text,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
    }
    return results;
  }, minSize);

  for (const target of smallTargets) {
    issues.push({
      type: 'small-target',
      description: `${target.tag} "${target.text}" is ${target.width}x${target.height}px (min ${minSize}x${minSize}px)`,
      elements: [`${target.tag}:${target.text}`],
    });
  }

  return issues;
}

/**
 * Check for text truncation (elements where content is clipped).
 */
export async function checkTextTruncation(page: Page): Promise<LayoutIssue[]> {
  const issues: LayoutIssue[] = [];

  const truncated = await page.evaluate(() => {
    const results: Array<{ tag: string; text: string; scrollW: number; clientW: number }> = [];
    const textElements = document.querySelectorAll('h1, h2, h3, h4, p, span, a, button, label');

    for (const el of textElements) {
      const htmlEl = el as HTMLElement;
      // Check if text is clipped
      if (htmlEl.scrollWidth > htmlEl.clientWidth + 2) {
        const text = (htmlEl.textContent || '').trim().slice(0, 50);
        if (text.length > 0) {
          results.push({
            tag: el.tagName.toLowerCase(),
            text,
            scrollW: htmlEl.scrollWidth,
            clientW: htmlEl.clientWidth,
          });
        }
      }
    }
    return results;
  });

  for (const item of truncated) {
    issues.push({
      type: 'truncation',
      description: `Text truncated in ${item.tag}: "${item.text}..." (${item.scrollW}px content in ${item.clientW}px container)`,
      elements: [`${item.tag}:${item.text}`],
    });
  }

  return issues;
}

/**
 * Run all layout checks on the current page state.
 */
export async function runLayoutChecks(
  page: Page,
  overlapPairs?: Array<[string, Locator]>,
  options?: { checkMobileTouchTargets?: boolean },
): Promise<LayoutIssue[]> {
  const allIssues: LayoutIssue[] = [];

  // Check overlaps if pairs provided
  if (overlapPairs && overlapPairs.length > 0) {
    allIssues.push(...await checkOverlaps(overlapPairs));
  }

  // Check horizontal overflow
  allIssues.push(...await checkHorizontalOverflow(page));

  // Check touch targets (mobile only)
  if (options?.checkMobileTouchTargets) {
    allIssues.push(...await checkTouchTargets(page));
  }

  // Check text truncation
  allIssues.push(...await checkTextTruncation(page));

  return allIssues;
}
