#!/usr/bin/env node

import { Command } from 'commander';
import { loadConfig } from './core/config.js';
import { createLogger } from './core/logger.js';
import { StateManager } from './core/state.js';
import { Orchestrator } from './orchestrator.js';
import type { CliOptions } from './orchestrator.js';

const program = new Command();

program
  .name('qa-agent')
  .description(
    'Autonomous AI-driven E2E testing agent — discovers bugs, files issues, coordinates fixes',
  )
  .version('0.1.0');

// ---------------------------------------------------------------------------
// Shared options
// ---------------------------------------------------------------------------

/**
 * Attach the three global options (--config, --verbose, --dry-run) to a
 * command so every sub-command has consistent flags.
 */
function addGlobalOptions(cmd: Command): Command {
  return cmd
    .option('--config <path>', 'Path to config file', 'qa-agent.config.ts')
    .option('--verbose', 'Verbose logging', false)
    .option('--dry-run', "Don't create issues/PRs, just show what would happen", false);
}

/** Resolve config + logger from shared global options. */
async function setup(opts: { config: string; verbose: boolean }) {
  const logger = createLogger('qa-agent', opts.verbose);
  const config = await loadConfig(opts.config);
  return { config, logger };
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

addGlobalOptions(
  program
    .command('plan')
    .description('Analyze codebase and generate test plan')
    .option('--from-scratch', 'Ignore existing test plan, regenerate completely', false)
    .option('--areas <list>', 'Only plan for specified areas (comma-separated)'),
).action(async (opts) => {
  const { config, logger } = await setup(opts);
  const cliOptions: CliOptions = {
    fromScratch: opts.fromScratch,
    areas: opts.areas,
  };
  const orchestrator = new Orchestrator(config, logger, cliOptions);
  await orchestrator.runPlan();
});

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------

addGlobalOptions(
  program
    .command('generate')
    .description('Generate Playwright tests from test plan')
    .option('--force', 'Overwrite existing test files', false)
    .option('--discover', 'Run DOM discovery before generating tests', false),
).action(async (opts) => {
  const { config, logger } = await setup(opts);
  const cliOptions: CliOptions = {
    force: opts.force,
    discover: opts.discover,
  };
  const orchestrator = new Orchestrator(config, logger, cliOptions);
  await orchestrator.runGenerate();
});

// ---------------------------------------------------------------------------
// test
// ---------------------------------------------------------------------------

addGlobalOptions(
  program
    .command('test')
    .description('Run tests and file GitHub issues for failures')
    .option('--filter <pattern>', 'Only run tests matching pattern')
    .option('--viewport <name>', 'Only run on specified viewport')
    .option('--headed', 'Run in headed browser (visible)', false)
    .option('--debug', 'Enable Playwright debug mode', false),
).action(async (opts) => {
  const { config, logger } = await setup(opts);
  const cliOptions: CliOptions = {
    filter: opts.filter,
    viewport: opts.viewport,
    headed: opts.headed,
    debug: opts.debug,
  };
  const orchestrator = new Orchestrator(config, logger, cliOptions);
  await orchestrator.runTest();
});

// ---------------------------------------------------------------------------
// fix
// ---------------------------------------------------------------------------

addGlobalOptions(
  program
    .command('fix')
    .description('Launch fix agents for open issues')
    .option('--issue <number>', 'Fix a specific issue only')
    .option('--max <n>', 'Max concurrent fix agents', '3'),
).action(async (opts) => {
  const { config, logger } = await setup(opts);
  const cliOptions: CliOptions = {
    issueNumber: opts.issue ? Number(opts.issue) : undefined,
    maxFixAgents: opts.max ? Number(opts.max) : undefined,
  };
  const orchestrator = new Orchestrator(config, logger, cliOptions);
  await orchestrator.runFix();
});

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

addGlobalOptions(
  program
    .command('validate')
    .description('Validate fixes and close resolved issues')
    .option('--branch <name>', 'Validate a specific fix branch')
    .option('--auto-merge', 'Auto-merge validated PRs', false),
).action(async (opts) => {
  const { config, logger } = await setup(opts);
  const cliOptions: CliOptions = {
    branch: opts.branch,
    autoMerge: opts.autoMerge,
  };
  const orchestrator = new Orchestrator(config, logger, cliOptions);
  await orchestrator.runValidate();
});

// ---------------------------------------------------------------------------
// run  (full pipeline)
// ---------------------------------------------------------------------------

addGlobalOptions(
  program
    .command('run')
    .description('Execute full pipeline (plan -> generate -> test -> fix -> validate)')
    .option('--skip-plan', 'Use existing test plan', false)
    .option('--skip-generate', 'Use existing test files', false)
    .option('--no-fix', "Only discover bugs, don't attempt fixes")
    .option('--no-validate', "Fix but don't validate (manual review)")
    .option('--plan-only', 'Just generate the test plan', false)
    .option('--discover', 'Run DOM discovery before generating tests', false),
).action(async (opts) => {
  const { config, logger } = await setup(opts);
  const cliOptions: CliOptions = {
    discover: opts.discover,
  };
  const orchestrator = new Orchestrator(config, logger, cliOptions);
  await orchestrator.runAll({
    skipPlan: opts.skipPlan,
    skipGenerate: opts.skipGenerate,
    noFix: opts.fix === false, // Commander stores --no-fix as fix: false
    noValidate: opts.validate === false,
    planOnly: opts.planOnly,
    dryRun: opts.dryRun,
    cliOptions,
  });
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

addGlobalOptions(
  program.command('status').description('Show current run state and progress'),
).action(async (opts) => {
  const { config } = await setup(opts);
  const stateManager = new StateManager(config.output.artifactsDir);
  const state = stateManager.load();

  if (!state) {
    console.log('No active run found. Run `qa-agent plan` to start.');
    return;
  }

  console.log('\n  QA Agent — Run Status');
  console.log('  ─────────────────────────────────');
  console.log(`  Run ID:     ${state.runId}`);
  console.log(`  Started:    ${state.startedAt}`);
  console.log(`  Phase:      ${state.phase}`);
  console.log(`  Completed:  ${state.completedPhases.length > 0 ? state.completedPhases.join(', ') : '(none)'}`);

  if (state.plan) {
    console.log(`\n  Plan:       ${state.plan.scenarioCount} scenarios (${state.plan.generatedAt})`);
  }
  if (state.tests) {
    console.log(
      `  Tests:      ${state.tests.passed}/${state.tests.total} passed, ` +
        `${state.tests.failed} failed, ${state.tests.flaky} flaky`,
    );
  }
  if (state.issuesCreated.length > 0) {
    console.log(`  Issues:     ${state.issuesCreated.length} created`);
  }
  if (state.fixBranches.length > 0) {
    const verified = state.fixBranches.filter((b) => b.status === 'verified').length;
    console.log(`  Fixes:      ${state.fixBranches.length} branches (${verified} verified)`);
  }
  if (state.validation) {
    console.log(
      `  Validation: ${state.validation.verified} verified, ` +
        `${state.validation.rejected} rejected, ${state.validation.regressions} regressions`,
    );
  }
  if (state.testResults.length > 0) {
    console.log(`  Results:    ${state.testResults.length} test result entries`);
  }
  console.log();
});

// ---------------------------------------------------------------------------
// Parse & run
// ---------------------------------------------------------------------------

program.parse();
