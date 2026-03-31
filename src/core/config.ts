import { z } from 'zod';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import 'dotenv/config';

// ---------------------------------------------------------------------------
// Auth step types (spec §3.2)
// ---------------------------------------------------------------------------

const AuthStepSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('navigate'), url: z.string() }),
  z.object({ action: z.literal('fill'), selector: z.string(), value: z.string() }),
  z.object({ action: z.literal('click'), selector: z.string() }),
  z.object({
    action: z.literal('wait'),
    selector: z.string(),
    state: z.enum(['visible', 'hidden']).optional(),
  }),
  z.object({ action: z.literal('saveStorage'), path: z.string() }),
]);

export type AuthStep = z.infer<typeof AuthStepSchema>;

// ---------------------------------------------------------------------------
// Viewport schema
// ---------------------------------------------------------------------------

const ViewportSchema = z.object({
  name: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

// ---------------------------------------------------------------------------
// Full config schema (spec §3.1)
// ---------------------------------------------------------------------------

const QAAgentConfigSchema = z.object({
  app: z.object({
    /** Path to the app's source code root */
    codebasePath: z.string(),
    /** Base URL for the running app */
    baseUrl: z.string().url(),
    /** Command to start the app (if not already running) */
    startCommand: z.string().optional(),
    /** Port the app runs on */
    port: z.number().int().positive(),
    /** Wait for this path to return 200 before starting tests */
    healthCheckPath: z.string().optional(),
  }),

  context: z.object({
    /** Path(s) to spec/requirements documents */
    specFiles: z.array(z.string()).min(1),
    /** Path(s) to existing test plans */
    testPlanFiles: z.array(z.string()).optional(),
    /** Glob patterns for source files to analyze */
    sourceGlobs: z.array(z.string()).min(1),
    /** Files to exclude from analysis */
    excludeGlobs: z.array(z.string()).optional(),
  }),

  github: z.object({
    /** GitHub repo in owner/repo format */
    repo: z.string().regex(/^[^/]+\/[^/]+$/, 'Must be in owner/repo format'),
    /** Labels to add to all created issues */
    defaultLabels: z.array(z.string()).optional(),
    /** Label prefix for priority */
    priorityLabelPrefix: z.string().optional(),
    /** Assignees for new issues */
    assignees: z.array(z.string()).optional(),
    /** Project board column */
    projectBoard: z.string().optional(),
  }),

  testing: z.object({
    /** Playwright config file path */
    playwrightConfig: z.string().optional(),
    /** Viewports to test */
    viewports: z.array(ViewportSchema).min(1),
    /** Max parallel browser contexts */
    maxParallel: z.number().int().positive().optional().default(4),
    /** Screenshot on every step */
    screenshotEveryStep: z.boolean().optional().default(false),
    /** Record video of test runs */
    recordVideo: z.boolean().optional().default(false),
    /** Test timeout in ms */
    timeout: z.number().int().positive().optional().default(30_000),
    /** Retry count for flaky detection */
    retries: z.number().int().nonnegative().optional().default(1),
  }),

  auth: z
    .object({
      flows: z.array(
        z.object({
          name: z.string(),
          role: z.string(),
          steps: z.array(AuthStepSchema),
        }),
      ),
    })
    .optional(),

  testData: z
    .object({
      seedCommand: z.string().optional(),
      resetCommand: z.string().optional(),
      databaseUrl: z.string().optional(),
    })
    .optional(),

  agents: z.object({
    /** Model to use for planning/generation */
    plannerModel: z.string().optional().default('claude-sonnet-4-6'),
    /** Model to use for fix agents */
    fixerModel: z.string().optional().default('claude-sonnet-4-6'),
    /** Model to use for validation */
    validatorModel: z.string().optional().default('claude-sonnet-4-6'),
    /** Max concurrent fix agents */
    maxFixAgents: z.number().int().positive().optional().default(3),
    /** Use git worktrees for fix isolation */
    useWorktrees: z.boolean().optional().default(true),
  }),

  output: z.object({
    /** Directory for test artifacts */
    artifactsDir: z.string(),
    /** Directory for generated test files */
    testsDir: z.string(),
    /** Directory for generated page objects */
    pageObjectsDir: z.string(),
    /** Directory for test plans */
    plansDir: z.string(),
  }),
});

/** Full configuration type for a QA Agent project. */
export type QAAgentConfig = z.infer<typeof QAAgentConfigSchema>;

// ---------------------------------------------------------------------------
// Helper: defineConfig (identity with type-check)
// ---------------------------------------------------------------------------

/**
 * Type-safe helper for authoring `qa-agent.config.ts`.
 * Returns the config object unchanged — provides autocomplete + validation at load time.
 */
export function defineConfig(config: QAAgentConfig): QAAgentConfig {
  return config;
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

/** Default config file name to search for in cwd. */
const DEFAULT_CONFIG_FILENAME = 'qa-agent.config.ts';

/**
 * Resolve environment-variable placeholders (e.g. `${QA_ADMIN_EMAIL}`) in
 * string values throughout the config object.
 */
function resolveEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
      return process.env[varName] ?? '';
    });
  }
  if (Array.isArray(obj)) {
    return obj.map(resolveEnvVars);
  }
  if (obj !== null && typeof obj === 'object') {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      resolved[key] = resolveEnvVars(value);
    }
    return resolved;
  }
  return obj;
}

/**
 * Resolve relative file paths in the config to absolute paths, anchored to
 * the directory that contains the config file.
 */
function resolveRelativePaths(config: QAAgentConfig, configDir: string): QAAgentConfig {
  const r = (p: string) => resolve(configDir, p);

  return {
    ...config,
    app: {
      ...config.app,
      codebasePath: r(config.app.codebasePath),
    },
    context: {
      ...config.context,
      specFiles: config.context.specFiles.map(r),
      testPlanFiles: config.context.testPlanFiles?.map(r),
      sourceGlobs: config.context.sourceGlobs.map(r),
      excludeGlobs: config.context.excludeGlobs?.map(r),
    },
    output: {
      artifactsDir: r(config.output.artifactsDir),
      testsDir: r(config.output.testsDir),
      pageObjectsDir: r(config.output.pageObjectsDir),
      plansDir: r(config.output.plansDir),
    },
  };
}

/**
 * Load, validate, and return the QA Agent configuration.
 *
 * Resolution order:
 * 1. Explicit `configPath` argument
 * 2. `qa-agent.config.ts` in the current working directory
 *
 * The config file is loaded via dynamic `import()` and must have a default export.
 * Environment variable placeholders (`${VAR}`) in string values are expanded.
 * Relative paths in the config are resolved relative to the config file's directory.
 *
 * @param configPath - Optional explicit path to the config file.
 * @returns Validated QAAgentConfig.
 * @throws If the file is missing, has no default export, or fails validation.
 */
export async function loadConfig(configPath?: string): Promise<QAAgentConfig> {
  const resolvedPath = resolve(configPath ?? DEFAULT_CONFIG_FILENAME);

  if (!existsSync(resolvedPath)) {
    throw new Error(
      `Config file not found: ${resolvedPath}\n` +
        `Create a qa-agent.config.ts or pass --config <path>.`,
    );
  }

  // Dynamic import requires a file:// URL on all platforms.
  const fileUrl = pathToFileURL(resolvedPath).href;
  const mod = await import(fileUrl);
  const raw = mod.default ?? mod;

  if (!raw || typeof raw !== 'object') {
    throw new Error(`Config file must have a default export: ${resolvedPath}`);
  }

  // Expand ${ENV_VAR} placeholders.
  const expanded = resolveEnvVars(raw) as Record<string, unknown>;

  // Validate with Zod.
  const result = QAAgentConfigSchema.safeParse(expanded);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid config (${resolvedPath}):\n${issues}`);
  }

  // Resolve relative paths to absolute, anchored to the config file location.
  const configDir = dirname(resolvedPath);
  return resolveRelativePaths(result.data, configDir);
}

// Re-export the schema for programmatic use (e.g. tests).
export { QAAgentConfigSchema };
