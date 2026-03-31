import type { AgentFn, ValidateResult } from '../orchestrator.js';

/**
 * Validator agent — checks out fix branches, re-runs failing tests, and
 * performs regression checks. This agent is deliberately separate from the
 * fixer to avoid self-assessment bias.
 *
 * This is a placeholder implementation. The real agent will run the full
 * test suite on each fix branch and comment on PRs/issues with results.
 */
export const validateAgent: AgentFn<ValidateResult> = async (_ctx) => {
  // TODO: implement validator agent
  throw new Error('Validator agent not yet implemented');
};
