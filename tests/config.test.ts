import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockConfig } from './fixtures/mock-config.js';

// ---------------------------------------------------------------------------
// Mock node:fs so loadConfig can "find" our fake config file
// ---------------------------------------------------------------------------
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// We need to control what `import(fileUrl)` resolves to inside loadConfig.
// Since dynamic import() cannot be easily mocked, we test loadConfig indirectly
// by testing the pieces we can reach (schema validation, defineConfig, env var
// interpolation) and test loadConfig's error paths via the fs mock.

describe('config', () => {
  let QAAgentConfigSchema: typeof import('../src/core/config.js').QAAgentConfigSchema;
  let defineConfig: typeof import('../src/core/config.js').defineConfig;
  let loadConfig: typeof import('../src/core/config.js').loadConfig;
  let existsSyncMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    const fsMod = await import('node:fs');
    existsSyncMock = fsMod.existsSync as ReturnType<typeof vi.fn>;

    const configMod = await import('../src/core/config.js');
    QAAgentConfigSchema = configMod.QAAgentConfigSchema;
    defineConfig = configMod.defineConfig;
    loadConfig = configMod.loadConfig;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // defineConfig
  // -------------------------------------------------------------------------

  describe('defineConfig', () => {
    it('returns the config object unchanged', () => {
      const result = defineConfig(mockConfig);
      expect(result).toBe(mockConfig);
    });

    it('preserves all fields on the returned config', () => {
      const result = defineConfig(mockConfig);
      expect(result.app.baseUrl).toBe('http://localhost:3000');
      expect(result.github.repo).toBe('test-owner/test-repo');
      expect(result.testing.viewports).toHaveLength(2);
      expect(result.output.artifactsDir).toBe('/tmp/test-artifacts');
    });
  });

  // -------------------------------------------------------------------------
  // Zod schema validation — valid config
  // -------------------------------------------------------------------------

  describe('QAAgentConfigSchema — valid config', () => {
    it('accepts a fully populated config object', () => {
      const result = QAAgentConfigSchema.safeParse(mockConfig);
      expect(result.success).toBe(true);
    });

    it('accepts config with only required fields', () => {
      const minimal = {
        app: {
          codebasePath: '/tmp/app',
          baseUrl: 'http://localhost:3000',
          port: 3000,
        },
        context: {
          specFiles: ['spec.md'],
          sourceGlobs: ['src/**/*.ts'],
        },
        github: {
          repo: 'owner/repo',
        },
        testing: {
          viewports: [{ name: 'desktop', width: 1280, height: 720 }],
        },
        agents: {},
        output: {
          artifactsDir: './artifacts',
          testsDir: './tests',
          pageObjectsDir: './page-objects',
          plansDir: './plans',
        },
      };
      const result = QAAgentConfigSchema.safeParse(minimal);
      expect(result.success).toBe(true);
    });

    it('fills in default values for optional fields with defaults', () => {
      const minimal = {
        app: { codebasePath: '/app', baseUrl: 'http://localhost:3000', port: 3000 },
        context: { specFiles: ['s.md'], sourceGlobs: ['**/*.ts'] },
        github: { repo: 'a/b' },
        testing: { viewports: [{ name: 'd', width: 1280, height: 720 }] },
        agents: {},
        output: { artifactsDir: '.', testsDir: '.', pageObjectsDir: '.', plansDir: '.' },
      };
      const result = QAAgentConfigSchema.parse(minimal);
      expect(result.testing.maxParallel).toBe(4);
      expect(result.testing.timeout).toBe(30_000);
      expect(result.testing.retries).toBe(1);
      expect(result.agents.maxFixAgents).toBe(3);
      expect(result.agents.useWorktrees).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Zod schema validation — missing required fields
  // -------------------------------------------------------------------------

  describe('QAAgentConfigSchema — rejects missing required fields', () => {
    it('rejects config missing app', () => {
      const result = QAAgentConfigSchema.safeParse({ ...mockConfig, app: undefined });
      expect(result.success).toBe(false);
    });

    it('rejects config missing app.baseUrl', () => {
      const bad = { ...mockConfig, app: { codebasePath: '/tmp', port: 3000 } };
      const result = QAAgentConfigSchema.safeParse(bad);
      expect(result.success).toBe(false);
    });

    it('rejects config missing context.specFiles', () => {
      const bad = {
        ...mockConfig,
        context: { ...mockConfig.context, specFiles: undefined },
      };
      const result = QAAgentConfigSchema.safeParse(bad);
      expect(result.success).toBe(false);
    });

    it('rejects config with empty specFiles array', () => {
      const bad = {
        ...mockConfig,
        context: { ...mockConfig.context, specFiles: [] },
      };
      const result = QAAgentConfigSchema.safeParse(bad);
      expect(result.success).toBe(false);
    });

    it('rejects config missing github.repo', () => {
      const bad = { ...mockConfig, github: {} };
      const result = QAAgentConfigSchema.safeParse(bad);
      expect(result.success).toBe(false);
    });

    it('rejects github.repo not in owner/repo format', () => {
      const bad = { ...mockConfig, github: { repo: 'invalid-repo' } };
      const result = QAAgentConfigSchema.safeParse(bad);
      expect(result.success).toBe(false);
    });

    it('rejects invalid baseUrl (not a URL)', () => {
      const bad = { ...mockConfig, app: { ...mockConfig.app, baseUrl: 'not-a-url' } };
      const result = QAAgentConfigSchema.safeParse(bad);
      expect(result.success).toBe(false);
    });

    it('rejects empty viewports array', () => {
      const bad = { ...mockConfig, testing: { ...mockConfig.testing, viewports: [] } };
      const result = QAAgentConfigSchema.safeParse(bad);
      expect(result.success).toBe(false);
    });

    it('rejects missing output', () => {
      const result = QAAgentConfigSchema.safeParse({ ...mockConfig, output: undefined });
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Environment variable interpolation
  // -------------------------------------------------------------------------

  describe('env var interpolation', () => {
    it('replaces ${VAR_NAME} placeholders with env values', async () => {
      // We cannot easily test resolveEnvVars directly (it is not exported),
      // but we can verify the behavior through the schema + a config with
      // env var placeholders that gets parsed. We set env vars and pass the
      // raw object through schema validation after manual interpolation.

      // Simulate what loadConfig does internally:
      const envReplace = (obj: unknown): unknown => {
        if (typeof obj === 'string') {
          return obj.replace(/\$\{([^}]+)\}/g, (_m, v: string) => process.env[v] ?? '');
        }
        if (Array.isArray(obj)) return obj.map(envReplace);
        if (obj !== null && typeof obj === 'object') {
          const out: Record<string, unknown> = {};
          for (const [k, val] of Object.entries(obj as Record<string, unknown>)) {
            out[k] = envReplace(val);
          }
          return out;
        }
        return obj;
      };

      process.env.TEST_QA_EMAIL = 'test@example.com';
      process.env.TEST_QA_BASE = 'http://localhost:4000';

      const raw = {
        ...mockConfig,
        app: { ...mockConfig.app, baseUrl: '${TEST_QA_BASE}' },
        auth: {
          flows: [
            {
              name: 'admin',
              role: 'owner',
              steps: [
                { action: 'fill' as const, selector: '[name="email"]', value: '${TEST_QA_EMAIL}' },
              ],
            },
          ],
        },
      };

      const expanded = envReplace(raw) as Record<string, unknown>;
      expect((expanded as any).app.baseUrl).toBe('http://localhost:4000');
      expect((expanded as any).auth.flows[0].steps[0].value).toBe('test@example.com');

      delete process.env.TEST_QA_EMAIL;
      delete process.env.TEST_QA_BASE;
    });

    it('replaces undefined env vars with empty string', () => {
      const envReplace = (s: string) =>
        s.replace(/\$\{([^}]+)\}/g, (_m, v: string) => process.env[v] ?? '');

      delete process.env.NONEXISTENT_VAR_12345;
      const result = envReplace('prefix-${NONEXISTENT_VAR_12345}-suffix');
      expect(result).toBe('prefix--suffix');
    });
  });

  // -------------------------------------------------------------------------
  // loadConfig — error paths
  // -------------------------------------------------------------------------

  describe('loadConfig', () => {
    it('throws when config file does not exist', async () => {
      existsSyncMock.mockReturnValue(false);
      await expect(loadConfig('/nonexistent/qa-agent.config.ts')).rejects.toThrow(
        /Config file not found/,
      );
    });
  });
});
