import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeReadFile, writeFileSafe } from './fs-utils.js';

// ---------------------------------------------------------------------------
// Run state types
// ---------------------------------------------------------------------------

/** Phase identifiers in execution order. */
export type Phase = 'plan' | 'generate' | 'test' | 'fix' | 'validate' | 'complete';

/** Result for a single test scenario. */
export interface TestResultEntry {
  testId: string;
  scenario: string;
  status: 'passed' | 'failed' | 'flaky' | 'skipped';
  duration?: number;
  error?: string;
  screenshot?: string;
}

/** Record of a GitHub issue created by the agent. */
export interface IssueEntry {
  issueNumber: number;
  testId: string;
  title: string;
  url: string;
}

/** Record of a fix branch created by the fixer agent. */
export interface FixBranchEntry {
  branch: string;
  issueNumber: number;
  status: 'pending' | 'verified' | 'rejected';
}

/** Persistent state for a single QA Agent run. */
export interface RunState {
  /** Unique identifier for this run. */
  runId: string;
  /** ISO-8601 timestamp when the run started. */
  startedAt: string;
  /** Current phase of execution. */
  phase: Phase;
  /** Phases that have been completed successfully. */
  completedPhases: Phase[];
  /** Individual test results from the test phase. */
  testResults: TestResultEntry[];
  /** GitHub issues created during this run. */
  issuesCreated: IssueEntry[];
  /** Fix branches created during this run. */
  fixBranches: FixBranchEntry[];
  /** Plan phase summary. */
  plan?: { scenarioCount: number; generatedAt: string };
  /** Test phase summary. */
  tests?: {
    total: number;
    passed: number;
    failed: number;
    flaky: number;
    executedAt: string;
  };
  /** Validation phase summary. */
  validation?: { verified: number; rejected: number; regressions: number };
}

// ---------------------------------------------------------------------------
// State manager
// ---------------------------------------------------------------------------

const STATE_FILENAME = '.qa-state.json';

/**
 * Manages persistent run state stored as JSON in the artifacts directory.
 *
 * The state file tracks which phase the run is in and aggregates results
 * from each phase so the orchestrator can resume or report progress.
 */
export class StateManager {
  private readonly statePath: string;
  private current: RunState | null = null;
  private dirty = false;

  constructor(private readonly artifactsDir: string) {
    this.statePath = join(artifactsDir, STATE_FILENAME);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initialise a fresh run, discarding any previous state.
   * @returns The new RunState.
   */
  init(): RunState {
    this.current = {
      runId: randomUUID(),
      startedAt: new Date().toISOString(),
      phase: 'plan',
      completedPhases: [],
      testResults: [],
      issuesCreated: [],
      fixBranches: [],
    };
    this.save();
    return this.current;
  }

  /**
   * Load existing run state from disk.
   * @returns The persisted RunState, or `null` if no state file exists.
   */
  load(): RunState | null {
    if (!existsSync(this.statePath)) {
      return null;
    }
    const raw = safeReadFile(this.statePath);
    if (!raw) return null;
    try {
      this.current = JSON.parse(raw) as RunState;
      return this.current;
    } catch {
      return null;
    }
  }

  /**
   * Persist the current run state to disk, creating the artifacts directory
   * if it does not already exist.
   */
  save(): void {
    if (!this.current) return;
    this.dirty = false;
    writeFileSafe(this.statePath, JSON.stringify(this.current, null, 2));
  }

  // -------------------------------------------------------------------------
  // Phase management
  // -------------------------------------------------------------------------

  /**
   * Transition to a new phase and persist the change.
   * If the previous phase is not already in `completedPhases`, it is added.
   */
  setPhase(phase: Phase): RunState {
    if (!this.current) {
      return this.init();
    }

    // Mark the previous phase as completed (if it was a real phase).
    const prev = this.current.phase;
    if (prev !== phase && prev !== 'complete' && !this.current.completedPhases.includes(prev)) {
      this.current.completedPhases.push(prev);
    }

    this.current.phase = phase;
    this.save();
    return this.current;
  }

  // -------------------------------------------------------------------------
  // Result accumulators
  // -------------------------------------------------------------------------

  /**
   * Append a test result entry. Marks state as dirty; call `save()`
   * after the batch of additions is complete.
   */
  addTestResult(result: TestResultEntry): void {
    if (!this.current) return;
    this.current.testResults.push(result);
    this.dirty = true;
  }

  /**
   * Record a GitHub issue created by the agent. Marks state as dirty;
   * call `save()` after the batch of additions is complete.
   */
  addIssue(issue: IssueEntry): void {
    if (!this.current) return;
    this.current.issuesCreated.push(issue);
    this.dirty = true;
  }

  /**
   * Record a fix branch created by the fixer agent. Marks state as dirty;
   * call `save()` after the batch of additions is complete.
   */
  addFixBranch(branch: FixBranchEntry): void {
    if (!this.current) return;
    this.current.fixBranches.push(branch);
    this.dirty = true;
  }

  /** Returns true if there are unsaved changes. */
  get isDirty(): boolean {
    return this.dirty;
  }

  // -------------------------------------------------------------------------
  // Convenience
  // -------------------------------------------------------------------------

  /** Return the in-memory state (may be null if neither init nor load was called). */
  get state(): RunState | null {
    return this.current;
  }
}
