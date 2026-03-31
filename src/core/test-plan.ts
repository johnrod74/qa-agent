/**
 * Structured Test Plan — JSON intermediate format between planner and generator.
 *
 * This replaces fragile Markdown regex parsing with a deterministic typed format.
 * The planner writes both Markdown (human-readable) and JSON (machine-readable).
 * The generator consumes the typed TestPlan directly.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestScenario {
  id: string;
  area: string;
  subArea: string;
  scenario: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  type: 'functional' | 'validation' | 'ux' | 'accessibility' | 'integration' | 'regression';
  viewport: 'desktop' | 'mobile' | 'both';
  preconditions: string;
}

export interface TestPlan {
  generatedAt: string;
  appName: string;
  totalScenarios: number;
  scenarios: TestScenario[];
}

// ---------------------------------------------------------------------------
// Markdown → JSON parser
// ---------------------------------------------------------------------------

/**
 * Parse a Markdown test plan (with `## Area:` headers, `### Sub-area:` headers,
 * and pipe-delimited table rows) into a structured TestPlan.
 *
 * Resilient: skips malformed rows, logs warnings, never throws.
 */
export function parseTestPlanMarkdown(markdown: string): TestPlan {
  const scenarios: TestScenario[] = [];
  const lines = markdown.split('\n');

  let currentArea = 'General';
  let currentSubArea = 'Default';
  let appName = 'Unknown';

  // Try to extract app name from the title line: # Test Plan — [App Name]
  const titleMatch = markdown.match(/^#\s+Test Plan\s*[—–-]\s*(.+)/m);
  if (titleMatch) {
    appName = titleMatch[1].trim();
  }

  // Try to extract generated date
  let generatedAt = '';
  const dateMatch = markdown.match(/^Generated:\s*(.+)/m);
  if (dateMatch) {
    generatedAt = dateMatch[1].trim();
  }

  const validPriorities = new Set(['P0', 'P1', 'P2', 'P3']);
  const validTypes = new Set(['functional', 'validation', 'ux', 'accessibility', 'integration', 'regression']);
  const validViewports = new Set(['desktop', 'mobile', 'both']);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Track area headers: ## Area: XYZ
    const areaMatch = line.match(/^##\s+Area:\s*(.+)/i);
    if (areaMatch) {
      currentArea = areaMatch[1].trim();
      currentSubArea = 'Default';
      continue;
    }

    // Track sub-area headers: ### Sub-area: XYZ
    const subAreaMatch = line.match(/^###\s+(?:Sub-area|Subarea):\s*(.+)/i);
    if (subAreaMatch) {
      currentSubArea = subAreaMatch[1].trim();
      continue;
    }

    // Parse table rows (skip non-table lines)
    if (!line.startsWith('|')) continue;
    // Skip header row (contains "ID" or "Scenario")
    if (/\|\s*ID\s*\|/i.test(line)) continue;
    // Skip separator rows (contain only |, -, :, and spaces)
    if (/^\|[\s\-:|]+\|$/.test(line)) continue;

    // Parse the table row
    const cells = line
      .split('|')
      .map((c) => c.trim())
      .filter((c) => c.length > 0);

    if (cells.length < 6) {
      console.warn(`[test-plan] Skipping malformed row at line ${i + 1}: expected 6+ cells, got ${cells.length}`);
      continue;
    }

    const id = cells[0];
    const scenario = cells[1];
    const rawPriority = cells[2].toUpperCase();
    const rawType = cells[3].toLowerCase();
    const rawViewport = cells[4].toLowerCase();
    const preconditions = cells[5];

    if (!validPriorities.has(rawPriority)) {
      console.warn(`[test-plan] Skipping row at line ${i + 1}: invalid priority "${cells[2]}"`);
      continue;
    }

    if (!validTypes.has(rawType)) {
      console.warn(`[test-plan] Skipping row at line ${i + 1}: invalid type "${cells[3]}"`);
      continue;
    }

    if (!validViewports.has(rawViewport)) {
      console.warn(`[test-plan] Skipping row at line ${i + 1}: invalid viewport "${cells[4]}"`);
      continue;
    }

    scenarios.push({
      id,
      area: currentArea,
      subArea: currentSubArea,
      scenario,
      priority: rawPriority as TestScenario['priority'],
      type: rawType as TestScenario['type'],
      viewport: rawViewport as TestScenario['viewport'],
      preconditions,
    });
  }

  return {
    generatedAt: generatedAt || new Date().toISOString(),
    appName,
    totalScenarios: scenarios.length,
    scenarios,
  };
}

// ---------------------------------------------------------------------------
// JSON → Markdown converter
// ---------------------------------------------------------------------------

/**
 * Convert a structured TestPlan back to human-readable Markdown.
 */
export function testPlanToMarkdown(plan: TestPlan): string {
  const lines: string[] = [];

  lines.push(`# Test Plan — ${plan.appName}`);
  lines.push('');
  lines.push(`Generated: ${plan.generatedAt}`);
  lines.push('');

  // Group scenarios by area, then sub-area
  const areaMap = new Map<string, Map<string, TestScenario[]>>();

  for (const s of plan.scenarios) {
    if (!areaMap.has(s.area)) {
      areaMap.set(s.area, new Map());
    }
    const subMap = areaMap.get(s.area)!;
    if (!subMap.has(s.subArea)) {
      subMap.set(s.subArea, []);
    }
    subMap.get(s.subArea)!.push(s);
  }

  for (const [area, subMap] of areaMap) {
    lines.push(`## Area: ${area}`);
    lines.push('');

    for (const [subArea, scenarios] of subMap) {
      lines.push(`### Sub-area: ${subArea}`);
      lines.push('');
      lines.push('| ID | Scenario | Priority | Type | Viewport | Preconditions |');
      lines.push('|----|----------|----------|------|----------|---------------|');

      for (const s of scenarios) {
        lines.push(`| ${s.id} | ${s.scenario} | ${s.priority} | ${s.type} | ${s.viewport} | ${s.preconditions} |`);
      }

      lines.push('');
    }
  }

  return lines.join('\n');
}
