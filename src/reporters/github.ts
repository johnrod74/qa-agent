import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';
import { execFile } from '../core/exec.js';

// ---------------------------------------------------------------------------
// Resolve paths relative to this file (for templates and config)
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** All template variables for the issue body Handlebars template. */
export interface IssueData {
  testId: string;
  title: string;
  area: string;
  priority: string;
  type: string;
  viewport: string;
  steps: string[];
  expected: string;
  actual: string;
  screenshotPath?: string;
  consoleErrors?: string[];
  testFile: string;
  testLine: number;
  baseUrl: string;
  viewportWidth: number;
  viewportHeight: number;
  browser: string;
  timestamp: string;
  githubRepo: string;
}

/** GitHub configuration subset used by the reporter. */
export interface GitHubConfig {
  repo: string;
  defaultLabels?: string[];
  priorityLabelPrefix?: string;
  assignees?: string[];
  projectBoard?: string;
}

/** Label definition as stored in config/labels.json. */
interface LabelDef {
  name: string;
  color: string;
  description: string;
}

// ---------------------------------------------------------------------------
// GitHubReporter
// ---------------------------------------------------------------------------

/**
 * Manages all GitHub interactions for the QA Agent: creating/updating issues,
 * managing labels, and commenting on issues/PRs.
 *
 * All `gh` CLI invocations use `execFile` with array arguments to prevent
 * shell injection vulnerabilities.
 */
export class GitHubReporter {
  private readonly repo: string;
  private readonly defaultLabels: string[];
  private readonly assignees: string[];
  private issueTemplate: Handlebars.TemplateDelegate | null = null;

  constructor(config: GitHubConfig) {
    this.repo = config.repo;
    this.defaultLabels = config.defaultLabels ?? ['qa-agent'];
    this.assignees = config.assignees ?? [];
  }

  // -------------------------------------------------------------------------
  // Label management
  // -------------------------------------------------------------------------

  /**
   * Read config/labels.json and create any labels that don't already exist
   * in the target GitHub repository.
   */
  async ensureLabels(): Promise<void> {
    const labelsPath = resolve(PROJECT_ROOT, 'config', 'labels.json');
    let labelDefs: LabelDef[];

    try {
      const raw = readFileSync(labelsPath, 'utf-8');
      const parsed = JSON.parse(raw) as { labels: LabelDef[] };
      labelDefs = parsed.labels;
    } catch {
      // labels.json not found or invalid — skip
      return;
    }

    // Fetch existing labels from the repo
    let existingNames: Set<string>;
    try {
      const { stdout } = await execFile('gh', [
        'label', 'list',
        '--repo', this.repo,
        '--json', 'name',
        '--limit', '200',
      ]);
      const existing = JSON.parse(stdout) as Array<{ name: string }>;
      existingNames = new Set(existing.map((l) => l.name));
    } catch {
      existingNames = new Set();
    }

    // Create missing labels
    for (const label of labelDefs) {
      if (existingNames.has(label.name)) continue;

      try {
        await execFile('gh', [
          'label', 'create', label.name,
          '--repo', this.repo,
          '--color', label.color,
          '--description', label.description,
          '--force',
        ]);
      } catch {
        // Label creation failed — non-fatal, continue
      }
    }
  }

  // -------------------------------------------------------------------------
  // Issue search
  // -------------------------------------------------------------------------

  /**
   * Search for an existing open issue with the given test ID in its title.
   *
   * @param testId - The test ID to search for (e.g., "CF-1").
   * @returns The issue number if found, or null.
   */
  async findExistingIssue(testId: string): Promise<number | null> {
    try {
      const { stdout } = await execFile('gh', [
        'issue', 'list',
        '--repo', this.repo,
        '--search', `"${testId}" in:title`,
        '--label', 'qa-agent',
        '--state', 'open',
        '--json', 'number',
        '--limit', '1',
      ]);

      const issues = JSON.parse(stdout) as Array<{ number: number }>;
      return issues.length > 0 ? issues[0].number : null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Issue creation
  // -------------------------------------------------------------------------

  /**
   * Create a new GitHub issue with the rendered Handlebars template body.
   *
   * @param data - Template variables for the issue body.
   * @param labels - Labels to apply to the issue.
   * @param assignees - Assignees for the issue (overrides constructor default).
   * @returns The created issue number.
   */
  async createIssue(
    data: IssueData,
    labels?: string[],
    assignees?: string[],
  ): Promise<number> {
    const body = this.renderIssueBody(data);
    const title = `Bug: ${data.testId} — ${data.title}`;
    const issueLabels = labels ?? this.defaultLabels;
    const issueAssignees = assignees ?? this.assignees;

    const args: string[] = [
      'issue', 'create',
      '--repo', this.repo,
      '--title', title,
      '--body', body,
    ];

    // Add labels
    for (const label of issueLabels) {
      args.push('--label', label);
    }

    // Add assignees
    for (const assignee of issueAssignees) {
      args.push('--assignee', assignee);
    }

    const { stdout } = await execFile('gh', args);

    // gh issue create outputs the issue URL; extract the number
    const match = stdout.trim().match(/\/issues\/(\d+)/);
    if (match) {
      return parseInt(match[1], 10);
    }

    // Fallback: try to parse as a number directly
    const num = parseInt(stdout.trim(), 10);
    if (!isNaN(num)) return num;

    throw new Error(`Could not parse issue number from gh output: ${stdout}`);
  }

  // -------------------------------------------------------------------------
  // Issue updates
  // -------------------------------------------------------------------------

  /**
   * Add a comment to an existing issue.
   *
   * @param issueNumber - The issue number to comment on.
   * @param comment - The comment body (Markdown).
   */
  async addComment(issueNumber: number, comment: string): Promise<void> {
    await execFile('gh', [
      'issue', 'comment', String(issueNumber),
      '--repo', this.repo,
      '--body', comment,
    ]);
  }

  /**
   * Close an issue.
   *
   * @param issueNumber - The issue number to close.
   */
  async closeIssue(issueNumber: number): Promise<void> {
    await execFile('gh', [
      'issue', 'close', String(issueNumber),
      '--repo', this.repo,
    ]);
  }

  /**
   * Update labels on an issue: add and/or remove specific labels.
   *
   * @param issueNumber - The issue number to update.
   * @param add - Labels to add.
   * @param remove - Labels to remove.
   */
  async updateLabels(
    issueNumber: number,
    add?: string[],
    remove?: string[],
  ): Promise<void> {
    const args: string[] = [
      'issue', 'edit', String(issueNumber),
      '--repo', this.repo,
    ];

    if (add && add.length > 0) {
      args.push('--add-label', add.join(','));
    }

    if (remove && remove.length > 0) {
      args.push('--remove-label', remove.join(','));
    }

    if (add?.length || remove?.length) {
      await execFile('gh', args);
    }
  }

  // -------------------------------------------------------------------------
  // Template rendering
  // -------------------------------------------------------------------------

  /**
   * Render the issue body using the Handlebars template at
   * templates/issue.md.hbs.
   */
  private renderIssueBody(data: IssueData): string {
    if (!this.issueTemplate) {
      const templatePath = resolve(PROJECT_ROOT, 'templates', 'issue.md.hbs');
      try {
        const source = readFileSync(templatePath, 'utf-8');
        this.issueTemplate = Handlebars.compile(source);
      } catch {
        // Template file missing — fall back to inline rendering
        return this.renderFallbackBody(data);
      }
    }

    return this.issueTemplate(data);
  }

  /**
   * Fallback issue body rendering when the Handlebars template is unavailable.
   */
  private renderFallbackBody(data: IssueData): string {
    const lines: string[] = [
      `## Bug: ${data.testId} — ${data.title}`,
      '',
      `**Area:** ${data.area}`,
      `**Priority:** ${data.priority}`,
      `**Type:** ${data.type}`,
      `**Viewport:** ${data.viewport}`,
      '',
      '### Steps to Reproduce',
      ...data.steps.map((s, i) => `${i + 1}. ${s}`),
      '',
      '### Expected',
      data.expected,
      '',
      '### Actual',
      data.actual,
      '',
    ];

    if (data.screenshotPath) {
      lines.push('### Screenshot', `![failure](${data.screenshotPath})`, '');
    }

    if (data.consoleErrors && data.consoleErrors.length > 0) {
      lines.push('### Console Errors', '```', ...data.consoleErrors, '```', '');
    }

    lines.push(
      '### Test Reference',
      `\`${data.testFile}:${data.testLine}\` — Test ID: \`${data.testId}\``,
      '',
      '### Environment',
      `- URL: ${data.baseUrl}`,
      `- Viewport: ${data.viewportWidth}x${data.viewportHeight}`,
      `- Browser: ${data.browser}`,
      `- Timestamp: ${data.timestamp}`,
      '',
      '---',
      `*Filed automatically by [QA Agent](https://github.com/${data.githubRepo})*`,
    );

    return lines.join('\n');
  }
}
