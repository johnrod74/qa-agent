import type { AgentFn, FixResult } from '../orchestrator.js';

/**
 * Fixer agent — reads open GitHub issues, analyses the relevant source code,
 * and writes fixes in isolated git worktree branches.
 *
 * This is a placeholder implementation. The real agent will use Claude to
 * understand failures, write code fixes, and verify them against the failing test.
 */
export const fixAgent: AgentFn<FixResult> = async (_ctx) => {
  // TODO: implement fixer agent
  throw new Error('Fixer agent not yet implemented');
};
