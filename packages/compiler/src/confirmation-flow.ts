import type { CompileError } from './errors.js';
import type { Manifest } from './manifest/schema.js';

/**
 * Every interactive flow collects input before any connector operation, so suspension can never
 * strand an already-applied prefix. Eligible-action cardinality depends on runtime conditions, so the
 * runtime proves exactly one action before preparing or executing a confirmed conditional flow.
 */
export function validateInteractiveFlow(
  tool: Manifest['tools'][number],
  toolIndex: number,
  manifestVersion: Manifest['manifestVersion'],
  errors: CompileError[],
): void {
  const steps = tool.fulfilment.steps;
  if (steps === undefined) return;
  let operationSeen = false;
  let operationCount = 0;
  steps.forEach((step, stepIndex) => {
    if (step.use !== undefined) {
      operationSeen = true;
      operationCount += 1;
      if (manifestVersion === '1' && tool.annotations?.confirm === true && operationCount > 1) {
        errors.push({
          code: 'invalid_confirmation_flow',
          path: `tools.${toolIndex}.fulfilment.steps.${stepIndex}.use`,
          message: 'confirmed Core v1 flows may contain at most one connector operation',
        });
      }
    }
    if (operationSeen && step.elicit !== undefined) {
      errors.push({
        code: 'invalid_elicitation_flow',
        path: `tools.${toolIndex}.fulfilment.steps.${stepIndex}.elicit`,
        message: 'interactive flows must collect all elicited input before the first operation',
      });
    }
  });
  // Core v2 conditional action cardinality cannot be decided until invocation input exists. The
  // runtime validates it before preparing or executing any action.
}
