import type { QAAgentConfig } from '../../src/core/config.js';

/**
 * A valid mock QAAgentConfig object for use in tests.
 * All required fields are populated with sensible defaults.
 */
export const mockConfig: QAAgentConfig = {
  app: {
    codebasePath: '/tmp/test-app',
    baseUrl: 'http://localhost:3000',
    startCommand: 'npm run dev',
    port: 3000,
    healthCheckPath: '/api/health',
  },

  context: {
    specFiles: ['/tmp/test-app/docs/SPEC.md'],
    testPlanFiles: ['/tmp/test-app/docs/test-plan.md'],
    sourceGlobs: ['/tmp/test-app/src/**/*.{ts,tsx}'],
    excludeGlobs: ['**/node_modules/**'],
  },

  github: {
    repo: 'test-owner/test-repo',
    defaultLabels: ['qa-agent'],
    priorityLabelPrefix: 'priority',
    assignees: ['test-owner'],
  },

  testing: {
    viewports: [
      { name: 'desktop', width: 1280, height: 720 },
      { name: 'mobile', width: 393, height: 851 },
    ],
    maxParallel: 4,
    screenshotEveryStep: false,
    recordVideo: false,
    timeout: 30000,
    retries: 1,
  },

  auth: {
    flows: [
      {
        name: 'admin',
        role: 'owner',
        steps: [
          { action: 'navigate', url: '/admin/login' },
          { action: 'fill', selector: '[name="email"]', value: 'admin@test.com' },
          { action: 'fill', selector: '[name="password"]', value: 'secret' },
          { action: 'click', selector: 'button[type="submit"]' },
          { action: 'wait', selector: '[data-testid="dashboard"]', state: 'visible' },
          { action: 'saveStorage', path: '.auth/admin.json' },
        ],
      },
    ],
  },

  testData: {
    seedCommand: 'npx tsx scripts/seed.ts',
    resetCommand: 'npx tsx scripts/reset.ts',
    databaseUrl: 'mysql://localhost:3306/testdb',
  },

  agents: {
    plannerModel: 'claude-sonnet-4-6',
    fixerModel: 'claude-sonnet-4-6',
    validatorModel: 'claude-sonnet-4-6',
    maxFixAgents: 3,
    useWorktrees: true,
  },

  output: {
    artifactsDir: '/tmp/test-artifacts',
    testsDir: '/tmp/test-artifacts/tests',
    pageObjectsDir: '/tmp/test-artifacts/page-objects',
    plansDir: '/tmp/test-artifacts/plans',
  },
};
