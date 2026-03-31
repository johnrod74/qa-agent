import type { AgentFn, GenerateResult } from '../orchestrator.js';

/**
 * Generator agent — creates Playwright test files and page objects from
 * the test plan and codebase analysis.
 *
 * This is a placeholder implementation. The real agent will use Claude to
 * generate page objects, auth setup, test files, and shared fixtures.
 */
export const generateAgent: AgentFn<GenerateResult> = async (_ctx) => {
  // TODO: implement generate agent
  throw new Error('Generate agent not yet implemented');
};
