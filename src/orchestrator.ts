import type pino from 'pino';
import type { QAAgentConfig } from './core/config.js';
import { StateManager } from './core/state.js';
import type { RunState } from './core/state.js';

// ---------------------------------------------------------------------------
// Agent function signatures
//
// These define the contracts that agent implementations (built by another
// agent) must satisfy. Each agent receives the full config, a logger, and
// the current run state, and returns an updated partial state.
// ---------------------------------------------------------------------------

/** Result returned by the planner agent. */
export interface PlanResult {
  scenarioCount: number;
  planPath: string;
}

/** Result returned by the generator agent. */
export interface GenerateResult {
  testFiles: string[];
  pageObjects: string[];
}

/** Result returned by the test runner agent. */
export interface TestResult {
  total: number;
  passed: number;
  failed: number;
  flaky: number;
  issuesCreated: number;
  duplicates: number;
  issueIds: number[];
}

/** Result returned by the fixer agent. */
export interface FixResult {
  attempted: number;
  succeeded: number;
  branches: string[];
}

/** Result returned by the validator agent. */
export interface ValidateResult {
  verified: number;
  rejected: number;
  regressions: number;
}

/** CLI options that agents may need to adapt their behaviour. */
export interface CliOptions {
  fromScratch?: boolean;
  areas?: string;
  force?: boolean;
  filter?: string;
  viewport?: string;
  headed?: boolean;
  debug?: boolean;
  issueNumber?: number;
  maxFixAgents?: number;
  branch?: string;
  autoMerge?: boolean;
}

/** Common context passed to every agent function. */
export interface AgentContext {
  config: QAAgentConfig;
  logger: pino.Logger;
  state: RunState;
  cliOptions: CliOptions;
}

/**
 * Function signature every agent must implement.
 * The type parameter `T` is the phase-specific result.
 */
export type AgentFn<T> = (ctx: AgentContext) => Promise<T>;

// ---------------------------------------------------------------------------
// Run options (maps to CLI flags on `qa-agent run`)
// ---------------------------------------------------------------------------

/** Options that control which phases execute during a full run. */
export interface RunOptions {
  /** Use existing test plan — skip planning. */
  skipPlan?: boolean;
  /** Use existing test files — skip generation. */
  skipGenerate?: boolean;
  /** Don't attempt fixes after testing. */
  noFix?: boolean;
  /** Don't validate fixes (manual review). */
  noValidate?: boolean;
  /** Only generate the test plan, then stop. */
  planOnly?: boolean;
  /** Generate artifacts but don't create issues or PRs. */
  dryRun?: boolean;
  /** CLI-specific options forwarded to agent functions. */
  cliOptions?: CliOptions;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Coordinates the five-phase QA pipeline:
 *   plan -> generate -> test -> fix -> validate
 *
 * Each phase delegates to a dedicated agent module. The orchestrator manages
 * state persistence so runs can be resumed if interrupted. Errors in any
 * phase are logged but do not prevent subsequent phases from executing.
 */
export class Orchestrator {
  private readonly stateManager: StateManager;
  private readonly cliOptions: CliOptions;

  constructor(
    private readonly config: QAAgentConfig,
    private readonly logger: pino.Logger,
    cliOptions: CliOptions = {},
  ) {
    this.stateManager = new StateManager(config.output.artifactsDir);
    this.cliOptions = cliOptions;
  }

  // -----------------------------------------------------------------------
  // Full pipeline
  // -----------------------------------------------------------------------

  /**
   * Execute the full QA pipeline with the given options.
   * Phases can be selectively skipped via `RunOptions`.
   */
  async runAll(options: RunOptions = {}): Promise<void> {
    // Merge any cliOptions from RunOptions into the instance-level cliOptions
    if (options.cliOptions) {
      Object.assign(this.cliOptions, options.cliOptions);
    }
    this.logger.info({ runOptions: options }, 'Starting QA Agent run');

    if (!options.skipPlan) {
      await this.runPlan();
    } else {
      this.logger.info('Skipping plan phase (--skip-plan)');
    }

    if (options.planOnly) {
      this.logger.info('Plan-only mode — stopping after plan phase');
      return;
    }

    if (!options.skipGenerate) {
      await this.runGenerate();
    } else {
      this.logger.info('Skipping generate phase (--skip-generate)');
    }

    await this.runTest();

    if (!options.noFix) {
      await this.runFix();
    } else {
      this.logger.info('Skipping fix phase (--no-fix)');
    }

    if (!options.noFix && !options.noValidate) {
      await this.runValidate();
    } else {
      this.logger.info('Skipping validate phase (--no-validate)');
    }

    this.stateManager.setPhase('complete');
    this.logger.info('QA Agent run complete');
  }

  // -----------------------------------------------------------------------
  // Individual phases
  // -----------------------------------------------------------------------

  /** Run the plan phase — analyze codebase and generate a test plan. */
  async runPlan(): Promise<void> {
    this.logger.info('Phase: plan — analyzing codebase and generating test plan');
    const runState = this.stateManager.setPhase('plan');

    try {
      const { planAgent } = await import('./agents/planner.js');
      const result = await planAgent({ config: this.config, logger: this.logger, state: runState, cliOptions: this.cliOptions });

      runState.plan = { scenarioCount: result.scenarioCount, generatedAt: new Date().toISOString() };
      this.stateManager.save();
      this.logger.info({ scenarios: result.scenarioCount }, 'Plan phase complete');
    } catch (err) {
      this.logger.error({ err }, 'Plan phase failed');
    }
  }

  /** Run the generate phase — create Playwright tests and page objects. */
  async runGenerate(): Promise<void> {
    this.logger.info('Phase: generate — creating Playwright tests and page objects');
    const runState = this.stateManager.setPhase('generate');

    try {
      const { generateAgent } = await import('./agents/generator.js');
      const result = await generateAgent({
        config: this.config,
        logger: this.logger,
        state: runState,
        cliOptions: this.cliOptions,
      });

      this.logger.info(
        { testFiles: result.testFiles.length, pageObjects: result.pageObjects.length },
        'Generate phase complete',
      );
    } catch (err) {
      this.logger.error({ err }, 'Generate phase failed');
    }
  }

  /** Run the test phase — execute tests and file GitHub issues for failures. */
  async runTest(): Promise<void> {
    this.logger.info('Phase: test — executing Playwright tests');
    const runState = this.stateManager.setPhase('test');

    try {
      const { testAgent } = await import('./agents/runner.js');
      const result = await testAgent({ config: this.config, logger: this.logger, state: runState, cliOptions: this.cliOptions });

      runState.tests = {
        total: result.total,
        passed: result.passed,
        failed: result.failed,
        flaky: result.flaky,
        executedAt: new Date().toISOString(),
      };
      this.stateManager.save();
      this.logger.info(
        { passed: result.passed, failed: result.failed, flaky: result.flaky },
        'Test phase complete',
      );
    } catch (err) {
      this.logger.error({ err }, 'Test phase failed');
    }
  }

  /** Run the fix phase — launch fix agents for open issues. */
  async runFix(): Promise<void> {
    this.logger.info('Phase: fix — launching fix agents for open issues');
    const runState = this.stateManager.setPhase('fix');

    try {
      const { fixAgent } = await import('./agents/fixer.js');
      const result = await fixAgent({ config: this.config, logger: this.logger, state: runState, cliOptions: this.cliOptions });

      this.logger.info(
        { attempted: result.attempted, succeeded: result.succeeded },
        'Fix phase complete',
      );
    } catch (err) {
      this.logger.error({ err }, 'Fix phase failed');
    }
  }

  /** Run the validate phase — verify fixes and close resolved issues. */
  async runValidate(): Promise<void> {
    this.logger.info('Phase: validate — verifying fixes');
    const runState = this.stateManager.setPhase('validate');

    try {
      const { validateAgent } = await import('./agents/validator.js');
      const result = await validateAgent({
        config: this.config,
        logger: this.logger,
        state: runState,
        cliOptions: this.cliOptions,
      });

      runState.validation = {
        verified: result.verified,
        rejected: result.rejected,
        regressions: result.regressions,
      };
      this.stateManager.save();
      this.logger.info(
        { verified: result.verified, rejected: result.rejected },
        'Validate phase complete',
      );
    } catch (err) {
      this.logger.error({ err }, 'Validate phase failed');
    }
  }
}
