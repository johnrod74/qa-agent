import type { AgentFn, PlanResult } from '../orchestrator.js';

/**
 * Plan agent — analyzes the target codebase and generates a test plan.
 *
 * This is a placeholder implementation. The real agent will use Claude to
 * read spec files, analyze source code, and produce a structured test plan.
 */
export const planAgent: AgentFn<PlanResult> = async (_ctx) => {
  // TODO: implement plan agent
  throw new Error('Plan agent not yet implemented');
};
