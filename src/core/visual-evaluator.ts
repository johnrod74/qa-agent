/**
 * Visual UX Evaluator — uses Claude Vision to analyze screenshots for UX issues.
 *
 * This goes beyond functional testing to catch:
 * - Element overlaps (logo covering text, overlapping buttons)
 * - Text readability (truncated, clipped, or obscured content)
 * - Layout breaks (misaligned elements, overflow, horizontal scroll)
 * - Visual hierarchy issues (important content below the fold, poor contrast)
 * - Responsive design problems (elements off-screen, tiny touch targets)
 * - Missing or broken images
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { withRetry } from './api-retry.js';
import { createLogger } from './logger.js';

const logger = createLogger('visual-evaluator');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VisualIssue {
  /** Severity: critical (blocks usage), major (hurts UX), minor (cosmetic) */
  severity: 'critical' | 'major' | 'minor';
  /** What category of visual issue */
  category: 'overlap' | 'truncation' | 'alignment' | 'overflow' | 'contrast' | 'broken-image' | 'spacing' | 'responsive' | 'other';
  /** Human-readable description of the issue */
  description: string;
  /** Where on the page (e.g., "top-left, header area") */
  location: string;
  /** Suggested fix if obvious */
  suggestion?: string;
}

export interface VisualEvaluationResult {
  /** The screenshot that was evaluated */
  screenshotPath: string;
  /** Page or test context */
  context: string;
  /** Issues found */
  issues: VisualIssue[];
  /** Overall UX score 1-10 */
  score: number;
  /** Summary of the evaluation */
  summary: string;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const EVALUATION_PROMPT = `You are a senior UX designer and QA engineer reviewing a screenshot of a web application. Analyze the screenshot for visual and UX issues.

Look specifically for:

1. **Element Overlaps**: Any element covering/overlapping another element (logos covering text, buttons overlapping, images covering content, fixed headers hiding content)
2. **Text Issues**: Truncated text, text overflow, unreadable text (too small, poor contrast), text clipped by containers
3. **Layout Problems**: Misaligned elements, inconsistent spacing, elements overflowing their containers, horizontal scrollbar on content
4. **Visual Hierarchy**: Important content hidden below the fold, call-to-action buttons not prominent enough, confusing information flow
5. **Responsive Issues**: Elements appearing off-screen, touch targets too small (< 44px), content not adapted to viewport
6. **Broken Visuals**: Missing images (broken image icons), placeholder text still visible, loading spinners stuck
7. **Spacing & Alignment**: Uneven margins/padding, elements not properly centered, inconsistent gaps between items

Respond with a JSON object (no markdown code fences, just raw JSON):
{
  "issues": [
    {
      "severity": "critical|major|minor",
      "category": "overlap|truncation|alignment|overflow|contrast|broken-image|spacing|responsive|other",
      "description": "Clear description of what's wrong",
      "location": "Where on the page this occurs",
      "suggestion": "How to fix it (optional)"
    }
  ],
  "score": 8,
  "summary": "One-paragraph overall assessment"
}

If there are no issues, return an empty issues array with a score of 10.
Be thorough but practical — only flag things a real user would notice or that affect usability.`;

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate a screenshot for visual/UX issues using Claude Vision.
 *
 * @param screenshotPath - Path to the PNG screenshot
 * @param context - Description of what page/state this screenshot represents
 * @param apiKey - Anthropic API key (optional, falls back to ANTHROPIC_API_KEY env var)
 */
export async function evaluateScreenshot(
  screenshotPath: string,
  context: string,
  apiKey?: string,
): Promise<VisualEvaluationResult> {
  const client = new Anthropic({ apiKey });

  // Read screenshot as base64
  const imageBuffer = readFileSync(screenshotPath);
  const base64Image = imageBuffer.toString('base64');
  const mediaType = screenshotPath.endsWith('.png') ? 'image/png' : 'image/jpeg';

  logger.info({ screenshot: basename(screenshotPath), context }, 'Evaluating screenshot for UX issues');

  const response = await withRetry(() =>
    client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: base64Image,
              },
            },
            {
              type: 'text',
              text: `${EVALUATION_PROMPT}\n\nContext: This is a screenshot of "${context}".`,
            },
          ],
        },
      ],
    }),
  );

  // Parse response
  const textContent = response.content.find((c) => c.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    logger.warn('No text response from visual evaluation');
    return {
      screenshotPath,
      context,
      issues: [],
      score: 0,
      summary: 'Evaluation failed — no response from AI',
    };
  }

  try {
    const parsed = JSON.parse(textContent.text) as {
      issues: VisualIssue[];
      score: number;
      summary: string;
    };

    const result: VisualEvaluationResult = {
      screenshotPath,
      context,
      issues: parsed.issues || [],
      score: parsed.score || 0,
      summary: parsed.summary || '',
    };

    if (result.issues.length > 0) {
      logger.warn(
        { issueCount: result.issues.length, score: result.score, context },
        `Found ${result.issues.length} visual issue(s) (score: ${result.score}/10)`,
      );
    } else {
      logger.info({ score: result.score, context }, 'No visual issues found');
    }

    return result;
  } catch {
    logger.error({ raw: textContent.text.slice(0, 200) }, 'Failed to parse visual evaluation response');
    return {
      screenshotPath,
      context,
      issues: [],
      score: 0,
      summary: `Evaluation parse error — raw: ${textContent.text.slice(0, 200)}`,
    };
  }
}

/**
 * Evaluate multiple screenshots in parallel.
 */
export async function evaluateScreenshots(
  screenshots: Array<{ path: string; context: string }>,
  apiKey?: string,
): Promise<VisualEvaluationResult[]> {
  // Process in batches of 3 to avoid rate limiting
  const batchSize = 3;
  const results: VisualEvaluationResult[] = [];

  for (let i = 0; i < screenshots.length; i += batchSize) {
    const batch = screenshots.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map((s) => evaluateScreenshot(s.path, s.context, apiKey)),
    );
    results.push(...batchResults);
  }

  return results;
}

/**
 * Format visual evaluation results as a Markdown report section.
 */
export function formatVisualReport(results: VisualEvaluationResult[]): string {
  const lines: string[] = [];
  lines.push('## Visual UX Evaluation\n');

  const totalIssues = results.reduce((sum, r) => sum + r.issues.length, 0);
  const avgScore = results.length > 0
    ? (results.reduce((sum, r) => sum + r.score, 0) / results.length).toFixed(1)
    : 'N/A';

  lines.push(`**Pages evaluated:** ${results.length}`);
  lines.push(`**Total visual issues:** ${totalIssues}`);
  lines.push(`**Average UX score:** ${avgScore}/10\n`);

  for (const result of results) {
    lines.push(`### ${result.context}\n`);
    lines.push(`**Score:** ${result.score}/10`);
    lines.push(`**Summary:** ${result.summary}\n`);

    if (result.issues.length > 0) {
      lines.push('| Severity | Category | Description | Location |');
      lines.push('|----------|----------|-------------|----------|');
      for (const issue of result.issues) {
        lines.push(`| ${issue.severity} | ${issue.category} | ${issue.description} | ${issue.location} |`);
      }
      lines.push('');
    } else {
      lines.push('No issues found.\n');
    }
  }

  return lines.join('\n');
}
