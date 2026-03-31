import type { QAAgentConfig } from './src/core/config';

/**
 * Example QA Agent configuration for FlourBatch.
 * Copy to qa-agent.config.ts and customize for your project.
 */
const config: QAAgentConfig = {
  app: {
    codebasePath: '../flourbatch',
    baseUrl: 'http://localhost:3000',
    startCommand: 'npm run dev',
    port: 3000,
    healthCheckPath: '/api/storefront/products',
  },

  context: {
    specFiles: [
      '../flourbatch/docs/SPEC.md',
      '../flourbatch/docs/E2E-TEST-PLAN.md',
    ],
    sourceGlobs: [
      '../flourbatch/src/**/*.{ts,tsx}',
      '../flourbatch/prisma/schema.prisma',
    ],
    excludeGlobs: [
      '**/node_modules/**',
      '**/*.test.*',
    ],
  },

  github: {
    repo: 'johnrod74/flourbatch.com',
    defaultLabels: ['qa-agent'],
    priorityLabelPrefix: 'priority',
    assignees: ['johnrod74'],
  },

  testing: {
    viewports: [
      { name: 'desktop', width: 1280, height: 720 },
      { name: 'mobile', width: 393, height: 851 },
    ],
    maxParallel: 4,
    timeout: 30000,
    retries: 1,
  },

  auth: {
    flows: [
      {
        name: 'admin-owner',
        role: 'owner',
        steps: [
          { action: 'navigate', url: '/admin/login' },
          { action: 'fill', selector: '[name="email"]', value: '${QA_ADMIN_EMAIL}' },
          { action: 'fill', selector: '[name="password"]', value: '${QA_ADMIN_PASSWORD}' },
          { action: 'click', selector: 'button[type="submit"]' },
          { action: 'wait', selector: 'text=Dashboard', state: 'visible' },
          { action: 'saveStorage', path: '.auth/admin.json' },
        ],
      },
    ],
  },

  testData: {
    seedCommand: 'npx tsx ../flourbatch/prisma/seed-prod.ts',
    resetCommand: 'npx tsx ../flourbatch/prisma/production-reset.mjs',
  },

  agents: {
    plannerModel: 'claude-sonnet-4-6',
    fixerModel: 'claude-sonnet-4-6',
    validatorModel: 'claude-sonnet-4-6',
    maxFixAgents: 3,
    useWorktrees: true,
  },

  output: {
    artifactsDir: './artifacts',
    testsDir: './generated-tests',
    pageObjectsDir: './generated-tests/page-objects',
    plansDir: './plans',
  },
};

export default config;
