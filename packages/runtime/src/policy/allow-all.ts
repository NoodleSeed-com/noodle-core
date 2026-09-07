import type { PolicyContext, PolicyDecision, PolicyGate } from './types.js';

/**
 * The default Phase 1 policy: allow every call and redact nothing. It exists so the execution
 * pipeline always runs gates in the right order; Phase 4 replaces it with real enforcement.
 */
export class AllowAllPolicy implements PolicyGate {
  before(_context: PolicyContext): Promise<PolicyDecision> {
    return Promise.resolve({ allow: true });
  }

  after(_context: PolicyContext, output: unknown): Promise<unknown> {
    return Promise.resolve(output);
  }
}
