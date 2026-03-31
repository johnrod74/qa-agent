/**
 * Planner Agent — analyzes the target codebase and generates a structured
 * test plan using Claude AI.
 *
 * Spec reference: Section 4.1 (Plan Phase)
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { QAAgentConfig } from '../core/config.js';
import type { AppAnalysis, Route, ApiEndpoint, Form, DataModel } from '../core/analyzer.js';
import type { AgentFn, PlanResult } from '../orchestrator.js';
import { withRetry } from '../core/api-retry.js';
import { parseTestPlanMarkdown } from '../core/test-plan.js';
import type { TestPlan } from '../core/test-plan.js';

// ---------------------------------------------------------------------------
// PlannerAgent class
// ---------------------------------------------------------------------------

export class PlannerAgent {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(private readonly config: QAAgentConfig) {
    this.client = new Anthropic();
    this.model = config.agents.plannerModel ?? 'claude-sonnet-4-6';
  }

  /**
   * Generate a comprehensive test plan from a codebase analysis.
   *
   * @param analysis - Structured analysis of the target application
   * @param existingPlan - Optional existing test plan to use as baseline
   * @returns Markdown test plan content and structured JSON plan
   */
  async generatePlan(analysis: AppAnalysis, existingPlan?: string): Promise<{ markdown: string; plan: TestPlan }> {
    const prompt = this.buildPrompt(analysis, existingPlan);
    const systemPrompt = this.buildSystemPrompt();

    const response = await withRetry(() =>
      this.client.messages.create({
        model: this.model,
        max_tokens: 16384,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
      }),
    );

    // Extract text from response
    const planMarkdown = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    // Write the Markdown plan
    const plansDir = this.config.output.plansDir;
    mkdirSync(plansDir, { recursive: true });
    const planPath = join(plansDir, 'test-plan.md');
    writeFileSync(planPath, planMarkdown, 'utf-8');

    // Parse into structured JSON and validate
    const plan = parseTestPlanMarkdown(planMarkdown);

    // Write the JSON version for deterministic downstream consumption
    const jsonPath = join(plansDir, 'test-plan.json');
    writeFileSync(jsonPath, JSON.stringify(plan, null, 2), 'utf-8');

    return { markdown: planMarkdown, plan };
  }

  // -------------------------------------------------------------------------
  // Prompt builders
  // -------------------------------------------------------------------------

  private buildSystemPrompt(): string {
    return `You are an expert QA engineer generating a comprehensive end-to-end test plan for a web application.

Your task is to produce a structured Markdown test plan with tables covering every testable scenario.

## Output format

The plan MUST use this exact Markdown structure:

\`\`\`
# Test Plan — [App Name]

Generated: [date]

## Area: [Area Name]

### Sub-area: [Sub-area Name]

| ID | Scenario | Priority | Type | Viewport | Preconditions |
|----|----------|----------|------|----------|---------------|
| XX-1 | Description of the scenario | P0 | functional | both | Preconditions |
| XX-2 | Another scenario | P1 | validation | desktop | None |
\`\`\`

## Rules

1. **IDs** — Use a short prefix for the area (e.g., CF for Checkout Flow, S for Storefront, AD for Admin Dashboard) followed by a number.
2. **Priority** — P0 (critical path), P1 (high — common user flows), P2 (medium — edge cases), P3 (low — cosmetic/minor).
3. **Type** — functional, validation, ux, accessibility, integration, regression.
4. **Viewport** — desktop, mobile, or both.
5. **Preconditions** — Any state required before the test (e.g., "Cart has items", "Logged in as admin").
6. **Coverage** — For each form, include: happy path, each validation rule, empty submission, boundary values. For each page, include: initial load, navigation, dynamic content. For each API, include: success response, error responses, auth requirements.
7. **Be thorough** — Generate at least one scenario per route, per form field validation, per API endpoint method.
8. **Cross-feature scenarios** — Include tests that span multiple areas (e.g., "Add to cart then checkout").`;
  }

  private buildPrompt(analysis: AppAnalysis, existingPlan?: string): string {
    const sections: string[] = [];

    sections.push('# Application Analysis\n');

    // App info
    sections.push(`Base URL: ${this.config.app.baseUrl}`);
    sections.push(`Port: ${this.config.app.port}\n`);

    // Routes
    if (analysis.routes.length > 0) {
      sections.push('## Routes (Navigable Pages)\n');
      sections.push(this.formatRoutes(analysis.routes));
    }

    // API Endpoints
    if (analysis.apiEndpoints.length > 0) {
      sections.push('## API Endpoints\n');
      sections.push(this.formatApiEndpoints(analysis.apiEndpoints));
    }

    // Forms with fields and constraints
    if (analysis.forms.length > 0) {
      sections.push('## Forms & Validation\n');
      sections.push(this.formatForms(analysis.forms));
    }

    // Data models
    if (analysis.dataModels.length > 0) {
      sections.push('## Data Models\n');
      sections.push(this.formatDataModels(analysis.dataModels));
    }

    // Business rules
    if (analysis.businessRules.length > 0) {
      sections.push('## Business Rules\n');
      for (const rule of analysis.businessRules) {
        sections.push(`- **${rule.type}**: ${rule.description} (${rule.location})`);
      }
      sections.push('');
    }

    // Auth flows
    if (analysis.authFlows.length > 0) {
      sections.push('## Authentication Flows\n');
      for (const flow of analysis.authFlows) {
        sections.push(`- **${flow.provider}** (${flow.type})${flow.loginPath ? ` — Login: ${flow.loginPath}` : ''}`);
      }
      sections.push('');
    }

    // State stores
    if (analysis.stateStores.length > 0) {
      sections.push('## State Management\n');
      for (const store of analysis.stateStores) {
        sections.push(`- **${store.name}** (${store.type}): keys=[${store.keys.join(', ')}]`);
      }
      sections.push('');
    }

    // Components
    if (analysis.components.length > 0) {
      sections.push('## Key Components\n');
      const grouped = new Map<string, typeof analysis.components>();
      for (const comp of analysis.components) {
        const group = comp.type;
        if (!grouped.has(group)) grouped.set(group, []);
        grouped.get(group)!.push(comp);
      }
      for (const [type, comps] of grouped) {
        sections.push(`### ${type}`);
        for (const comp of comps) {
          sections.push(`- ${comp.name}${comp.props ? ` (props: ${comp.props.join(', ')})` : ''}`);
        }
        sections.push('');
      }
    }

    // Spec files content
    if (this.config.context.specFiles.length > 0) {
      sections.push('## Specification Documents\n');
      for (const specFile of this.config.context.specFiles) {
        if (existsSync(specFile)) {
          const content = readFileSync(specFile, 'utf-8');
          // Truncate very large spec files
          const truncated = content.length > 20000 ? content.slice(0, 20000) + '\n\n... (truncated)' : content;
          sections.push(`### ${specFile}\n`);
          sections.push(truncated);
          sections.push('');
        }
      }
    }

    // Existing plan as baseline
    if (existingPlan) {
      sections.push('## Existing Test Plan (use as baseline, identify gaps)\n');
      sections.push(existingPlan);
      sections.push('');
      sections.push('**Instructions:** Update and expand this plan. Keep existing scenario IDs stable. Add new scenarios for any gaps you identify. Mark any scenarios that should be removed with ~~strikethrough~~.');
    } else {
      sections.push('**Instructions:** Generate a comprehensive test plan covering all routes, forms, APIs, and business rules. Be thorough — cover happy paths, validation errors, edge cases, and cross-feature interactions.');
    }

    // Viewports
    sections.push('\n## Configured Viewports\n');
    for (const vp of this.config.testing.viewports) {
      sections.push(`- ${vp.name}: ${vp.width}x${vp.height}`);
    }

    return sections.join('\n');
  }

  private formatRoutes(routes: Route[]): string {
    const lines: string[] = [];
    const pages = routes.filter((r) => r.method === 'page');
    const apis = routes.filter((r) => r.method === 'api');

    if (pages.length > 0) {
      lines.push('### Pages\n');
      lines.push('| Path | Params | Auth Required | Roles |');
      lines.push('|------|--------|---------------|-------|');
      for (const route of pages) {
        const params = route.params?.join(', ') || '—';
        const authReq = route.auth?.required ? 'Yes' : 'No';
        const roles = route.auth?.roles?.join(', ') || '—';
        lines.push(`| ${route.path} | ${params} | ${authReq} | ${roles} |`);
      }
      lines.push('');
    }

    if (apis.length > 0) {
      lines.push('### API Routes\n');
      for (const route of apis) {
        lines.push(`- \`${route.path}\`${route.params ? ` (params: ${route.params.join(', ')})` : ''}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private formatApiEndpoints(endpoints: ApiEndpoint[]): string {
    const lines: string[] = [];
    lines.push('| Path | Methods | File |');
    lines.push('|------|---------|------|');
    for (const ep of endpoints) {
      lines.push(`| ${ep.path} | ${ep.methods.join(', ')} | ${ep.filePath} |`);
    }
    lines.push('');
    return lines.join('\n');
  }

  private formatForms(forms: Form[]): string {
    const lines: string[] = [];
    for (const form of forms) {
      lines.push(`### Form: ${form.submitAction} (${form.location})\n`);
      if (form.validationSchema) {
        lines.push(`Validation schema: \`${form.validationSchema}\`\n`);
      }
      lines.push('| Field | Type | Required | Constraints |');
      lines.push('|-------|------|----------|-------------|');
      for (const field of form.fields) {
        const constraints: string[] = [];
        if (field.constraints) {
          if (field.constraints.min !== undefined) constraints.push(`min=${field.constraints.min}`);
          if (field.constraints.max !== undefined) constraints.push(`max=${field.constraints.max}`);
          if (field.constraints.minLength !== undefined) constraints.push(`minLength=${field.constraints.minLength}`);
          if (field.constraints.maxLength !== undefined) constraints.push(`maxLength=${field.constraints.maxLength}`);
          if (field.constraints.pattern) constraints.push(`pattern=/${field.constraints.pattern}/`);
          if (field.constraints.enum) constraints.push(`enum=[${field.constraints.enum.join(', ')}]`);
        }
        lines.push(`| ${field.name} | ${field.type} | ${field.required ? 'Yes' : 'No'} | ${constraints.join('; ') || '—'} |`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  private formatDataModels(models: DataModel[]): string {
    const lines: string[] = [];
    for (const model of models) {
      lines.push(`### ${model.name}\n`);
      lines.push('| Field | Type | Required | Relation |');
      lines.push('|-------|------|----------|----------|');
      for (const field of model.fields) {
        lines.push(`| ${field.name} | ${field.type} | ${field.required ? 'Yes' : 'No'} | ${field.relation || '—'} |`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// AgentFn export (used by the Orchestrator)
// ---------------------------------------------------------------------------

/**
 * Plan agent — analyzes the target codebase and generates a test plan.
 * This is the AgentFn-compatible wrapper around PlannerAgent.
 */
export const planAgent: AgentFn<PlanResult> = async (ctx) => {
  const { analyzeApp } = await import('../core/analyzer.js');

  ctx.logger.info('Analyzing codebase...');
  const analysis = await analyzeApp(ctx.config);
  ctx.logger.info(
    {
      routes: analysis.routes.length,
      apiEndpoints: analysis.apiEndpoints.length,
      forms: analysis.forms.length,
      models: analysis.dataModels.length,
    },
    'Codebase analysis complete',
  );

  // Load existing test plan if available
  let existingPlan: string | undefined;
  if (ctx.config.context.testPlanFiles && ctx.config.context.testPlanFiles.length > 0) {
    for (const planFile of ctx.config.context.testPlanFiles) {
      if (existsSync(planFile)) {
        existingPlan = (existingPlan ?? '') + readFileSync(planFile, 'utf-8') + '\n\n';
      }
    }
  }

  ctx.logger.info('Generating test plan with Claude...');
  const planner = new PlannerAgent(ctx.config);
  const { plan } = await planner.generatePlan(analysis, existingPlan);

  const planPath = join(ctx.config.output.plansDir, 'test-plan.md');
  const jsonPath = join(ctx.config.output.plansDir, 'test-plan.json');
  ctx.logger.info(
    { scenarioCount: plan.totalScenarios, planPath, jsonPath },
    'Test plan generated',
  );

  return { scenarioCount: plan.totalScenarios, planPath };
};
