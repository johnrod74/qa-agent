import type { AgentFn, TestResult } from '../orchestrator.js';

/**
 * Test runner agent — executes Playwright tests, triages results, and
 * files GitHub issues for failures.
 *
 * This is a placeholder implementation. The real agent will run Playwright,
 * capture screenshots/traces, detect flaky tests, and create issues.
 */
export const testAgent: AgentFn<TestResult> = async (_ctx) => {
  // TODO: implement test runner agent
  throw new Error('Test runner agent not yet implemented');
};
