import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StateManager } from '../src/core/state.js';
import type { TestResultEntry, IssueEntry, FixBranchEntry, RunState } from '../src/core/state.js';

// ---------------------------------------------------------------------------
// Mock node:fs so we never touch the real filesystem
// ---------------------------------------------------------------------------
vi.mock('node:fs', () => {
  const store: Record<string, string> = {};
  return {
    existsSync: vi.fn((p: string) => p in store),
    readFileSync: vi.fn((p: string) => {
      if (!(p in store)) throw new Error(`ENOENT: ${p}`);
      return store[p];
    }),
    writeFileSync: vi.fn((p: string, data: string) => {
      store[p] = data;
    }),
    mkdirSync: vi.fn(),
    // expose store for test introspection
    __store: store,
  };
});

// Also mock crypto.randomUUID for deterministic IDs
vi.mock('node:crypto', () => ({
  randomUUID: vi.fn(() => 'test-uuid-1234'),
}));

describe('StateManager', () => {
  const ARTIFACTS_DIR = '/tmp/test-artifacts';
  let sm: StateManager;
  let fsStore: Record<string, string>;

  beforeEach(async () => {
    const fsMod = (await import('node:fs')) as any;
    fsStore = fsMod.__store;
    // Clear the in-memory store between tests
    for (const key of Object.keys(fsStore)) {
      delete fsStore[key];
    }
    sm = new StateManager(ARTIFACTS_DIR);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // init
  // -------------------------------------------------------------------------

  describe('init', () => {
    it('creates a fresh state with default values', () => {
      const state = sm.init();

      expect(state.runId).toBe('test-uuid-1234');
      expect(state.phase).toBe('plan');
      expect(state.completedPhases).toEqual([]);
      expect(state.testResults).toEqual([]);
      expect(state.issuesCreated).toEqual([]);
      expect(state.fixBranches).toEqual([]);
      expect(state.startedAt).toBeDefined();
    });

    it('persists the state to disk on init', () => {
      sm.init();
      const statePath = `${ARTIFACTS_DIR}/.qa-state.json`;
      expect(fsStore[statePath]).toBeDefined();
      const persisted = JSON.parse(fsStore[statePath]) as RunState;
      expect(persisted.runId).toBe('test-uuid-1234');
    });
  });

  // -------------------------------------------------------------------------
  // setPhase
  // -------------------------------------------------------------------------

  describe('setPhase', () => {
    it('updates the current phase', () => {
      sm.init();
      const state = sm.setPhase('generate');
      expect(state.phase).toBe('generate');
    });

    it('adds the previous phase to completedPhases', () => {
      sm.init();
      sm.setPhase('generate');
      const state = sm.setPhase('test');
      expect(state.completedPhases).toContain('plan');
      expect(state.completedPhases).toContain('generate');
      expect(state.phase).toBe('test');
    });

    it('does not duplicate completed phases', () => {
      sm.init();
      sm.setPhase('generate');
      sm.setPhase('generate'); // same phase twice
      const state = sm.setPhase('test');
      const planCount = state.completedPhases.filter((p) => p === 'plan').length;
      expect(planCount).toBe(1);
    });

    it('initialises state if called before init', () => {
      const state = sm.setPhase('test');
      // setPhase on uninitialised manager calls init() internally
      expect(state.runId).toBeDefined();
      expect(state.phase).toBe('plan'); // init sets phase to 'plan'
    });
  });

  // -------------------------------------------------------------------------
  // addTestResult
  // -------------------------------------------------------------------------

  describe('addTestResult', () => {
    it('adds entries to the testResults array', () => {
      sm.init();

      const entry: TestResultEntry = {
        testId: 'CF-1',
        scenario: 'Select delivery shows address form',
        status: 'passed',
        duration: 1500,
      };

      sm.addTestResult(entry);
      expect(sm.state!.testResults).toHaveLength(1);
      expect(sm.state!.testResults[0]).toEqual(entry);
    });

    it('accumulates multiple results', () => {
      sm.init();

      sm.addTestResult({
        testId: 'CF-1',
        scenario: 'Test A',
        status: 'passed',
      });
      sm.addTestResult({
        testId: 'CF-2',
        scenario: 'Test B',
        status: 'failed',
        error: 'Element not found',
      });

      expect(sm.state!.testResults).toHaveLength(2);
      expect(sm.state!.testResults[1].status).toBe('failed');
    });

    it('does nothing if state is not initialised', () => {
      // No init() call — state is null
      sm.addTestResult({
        testId: 'X',
        scenario: 'should be ignored',
        status: 'passed',
      });
      expect(sm.state).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // addIssue
  // -------------------------------------------------------------------------

  describe('addIssue', () => {
    it('adds entries to the issuesCreated array', () => {
      sm.init();

      const issue: IssueEntry = {
        issueNumber: 42,
        testId: 'CF-1',
        title: 'Address form not appearing',
        url: 'https://github.com/owner/repo/issues/42',
      };

      sm.addIssue(issue);
      expect(sm.state!.issuesCreated).toHaveLength(1);
      expect(sm.state!.issuesCreated[0]).toEqual(issue);
    });

    it('accumulates multiple issues', () => {
      sm.init();

      sm.addIssue({
        issueNumber: 1,
        testId: 'A',
        title: 'Bug A',
        url: 'https://github.com/o/r/issues/1',
      });
      sm.addIssue({
        issueNumber: 2,
        testId: 'B',
        title: 'Bug B',
        url: 'https://github.com/o/r/issues/2',
      });

      expect(sm.state!.issuesCreated).toHaveLength(2);
    });

    it('does nothing if state is not initialised', () => {
      sm.addIssue({
        issueNumber: 1,
        testId: 'X',
        title: 'ignored',
        url: 'https://example.com',
      });
      expect(sm.state).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // addFixBranch
  // -------------------------------------------------------------------------

  describe('addFixBranch', () => {
    it('adds entries to the fixBranches array', () => {
      sm.init();

      const entry: FixBranchEntry = {
        branch: 'fix/qa-42',
        issueNumber: 42,
        status: 'pending',
      };

      sm.addFixBranch(entry);
      expect(sm.state!.fixBranches).toHaveLength(1);
      expect(sm.state!.fixBranches[0]).toEqual(entry);
    });
  });

  // -------------------------------------------------------------------------
  // save / load round-trip
  // -------------------------------------------------------------------------

  describe('save and load', () => {
    it('writes JSON to disk and reads it back identically', () => {
      sm.init();
      sm.addTestResult({ testId: 'T-1', scenario: 'Test', status: 'passed' });
      sm.addIssue({
        issueNumber: 10,
        testId: 'T-2',
        title: 'Bug',
        url: 'https://github.com/o/r/issues/10',
      });

      // Save before loading from a second manager
      sm.save();

      const sm2 = new StateManager(ARTIFACTS_DIR);
      const loaded = sm2.load();

      expect(loaded).not.toBeNull();
      expect(loaded!.runId).toBe('test-uuid-1234');
      expect(loaded!.testResults).toHaveLength(1);
      expect(loaded!.issuesCreated).toHaveLength(1);
    });

    it('load returns null when no state file exists', () => {
      // Fresh manager, no init, no file on disk
      const sm2 = new StateManager('/tmp/nonexistent-dir');
      const loaded = sm2.load();
      expect(loaded).toBeNull();
    });

    it('load returns null when state file contains invalid JSON', () => {
      const statePath = `${ARTIFACTS_DIR}/.qa-state.json`;
      fsStore[statePath] = 'NOT VALID JSON {{{';

      const sm2 = new StateManager(ARTIFACTS_DIR);
      const loaded = sm2.load();
      expect(loaded).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // state getter
  // -------------------------------------------------------------------------

  describe('state getter', () => {
    it('returns null before init or load', () => {
      expect(sm.state).toBeNull();
    });

    it('returns the current state after init', () => {
      sm.init();
      expect(sm.state).not.toBeNull();
      expect(sm.state!.phase).toBe('plan');
    });
  });
});
