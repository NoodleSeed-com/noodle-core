import type { ArtifactFulfilment, CondNode } from '@noodle-borg/compiler';
import type { EvalScope } from './eval/evaluate.js';
import { ExpressionEvalError, evaluateCondition } from './eval/evaluate.js';
import type { ExecuteToolDeps } from './execute.js';
import type { ExecutionError } from './result.js';

type FlowFulfilment = Extract<ArtifactFulfilment, { kind: 'flow' }>;

export type EligibleActionAnalysis =
  | {
      readonly ok: true;
      readonly flowHasActions: boolean;
      readonly eligibleIndexes: readonly number[];
    }
  | { readonly ok: false; readonly error: ExecutionError };

export type AdditionalOperationAnalysis =
  | { readonly ok: true; readonly count: number }
  | { readonly ok: false; readonly error: ExecutionError };

export function validateConfirmationFlow(
  flow: FlowFulfilment,
  deps: ExecuteToolDeps,
): ExecutionError | null {
  let operationSeen = false;
  let unconditionalActionSeen = false;
  for (const step of flow.steps) {
    if (step.kind === 'operation') {
      operationSeen = true;
      if (step.if === undefined && step.operationRef.resolved === true) {
        const signature = deps.connectors
          .resolve(step.operationRef)
          ?.signature(step.operationRef.operation);
        if (isActionOperation(step.operationRef, signature?.type)) {
          if (unconditionalActionSeen) {
            return {
              code: 'invalid_confirmation_flow',
              message: 'confirmable flows cannot contain more than one unconditional action',
              path: `steps.${step.id}`,
            };
          }
          unconditionalActionSeen = true;
        }
      }
    }
    if (step.kind === 'elicit' && operationSeen) {
      return {
        code: 'invalid_elicitation_flow',
        message: 'interactive flows must collect all elicited input before the first operation',
        path: `steps.${step.id}`,
      };
    }
  }
  return null;
}

export function countTrailingEligibleOperations(
  flow: FlowFulfilment,
  selectedIndex: number,
  completedSteps: Readonly<Record<string, unknown>>,
  scope: EvalScope,
): AdditionalOperationAnalysis {
  let count = 0;
  for (let index = selectedIndex + 1; index < flow.steps.length; index += 1) {
    const step = flow.steps[index];
    if (step?.kind !== 'operation') continue;
    if (step.if === undefined || conditionUsesIncompleteStep(step.if, completedSteps)) {
      count += 1;
      continue;
    }
    try {
      if (evaluateCondition(step.if, scope, `steps.${step.id}.if`)) count += 1;
    } catch (error) {
      if (error instanceof ExpressionEvalError) return expressionFailure(error);
      throw error;
    }
  }
  return { ok: true, count };
}

/** Prove action cardinality without connector I/O before proposing or dispatching an action. */
export function analyzeEligibleActions(
  flow: FlowFulfilment,
  startIndex: number,
  completedSteps: Readonly<Record<string, unknown>>,
  scope: EvalScope,
  deps: ExecuteToolDeps,
): EligibleActionAnalysis {
  let flowHasActions = false;
  const operationTypes = new Map<number, 'read' | 'action'>();
  for (const [index, step] of flow.steps.entries()) {
    if (step.kind !== 'operation' || step.operationRef.resolved !== true) continue;
    const connector = deps.connectors.resolve(step.operationRef);
    const signature = connector?.signature(step.operationRef.operation);
    if (signature === undefined) {
      return {
        ok: false,
        error: {
          code: 'signature_drift',
          message: `cannot prove confirmation safety for operation "${step.operationRef.operation}"`,
          path: `steps.${step.id}`,
        },
      };
    }
    const operationType = isActionOperation(step.operationRef, signature.type) ? 'action' : 'read';
    operationTypes.set(index, operationType);
    if (operationType === 'action') flowHasActions = true;
  }

  const eligibleIndexes: number[] = [];
  for (let index = startIndex; index < flow.steps.length; index += 1) {
    const step = flow.steps[index];
    if (step?.kind !== 'operation' || operationTypes.get(index) !== 'action') continue;
    if (step.if !== undefined && conditionUsesIncompleteStep(step.if, completedSteps)) {
      return {
        ok: false,
        error: {
          code: 'invalid_confirmation_flow',
          message: 'a later action condition depends on an unreviewed operation result',
          path: `steps.${step.id}.if`,
        },
      };
    }
    try {
      if (step.if === undefined || evaluateCondition(step.if, scope, `steps.${step.id}.if`)) {
        eligibleIndexes.push(index);
      }
    } catch (error) {
      if (error instanceof ExpressionEvalError) return expressionFailure(error);
      throw error;
    }
  }
  return { ok: true, flowHasActions, eligibleIndexes };
}

export function isActionOperation(
  ref: Extract<ArtifactFulfilment, { kind: 'operation' }>['operationRef'],
  signatureType: 'read' | 'action' | undefined,
): boolean {
  return (
    signatureType === 'action' ||
    (ref.resolved === true && (ref.customerActionEndpointDependencies?.length ?? 0) > 0)
  );
}

function expressionFailure(
  error: ExpressionEvalError,
): Extract<EligibleActionAnalysis, { readonly ok: false }> {
  return {
    ok: false,
    error: {
      code: 'expression_error',
      message: error.message,
      ...(error.path === undefined ? {} : { path: error.path }),
    },
  };
}

function conditionUsesIncompleteStep(
  condition: CondNode,
  completedSteps: Readonly<Record<string, unknown>>,
): boolean {
  if (condition.kind === 'truthy') {
    return pathUsesIncompleteStep(condition.operand, completedSteps);
  }
  if (condition.op === 'not') {
    return conditionUsesIncompleteStep(condition.operand, completedSteps);
  }
  if (condition.op === 'and' || condition.op === 'or') {
    return (
      conditionUsesIncompleteStep(condition.left, completedSteps) ||
      conditionUsesIncompleteStep(condition.right, completedSteps)
    );
  }
  return (
    pathUsesIncompleteStep(condition.left, completedSteps) ||
    pathUsesIncompleteStep(condition.right, completedSteps)
  );
}

function pathUsesIncompleteStep(
  node: { readonly kind: string; readonly root?: string; readonly segments?: readonly unknown[] },
  completedSteps: Readonly<Record<string, unknown>>,
): boolean {
  if (node.kind !== 'path' || node.root !== 'steps') return false;
  const first = node.segments?.[0];
  return (
    typeof first !== 'object' ||
    first === null ||
    !('kind' in first) ||
    first.kind !== 'prop' ||
    !('name' in first) ||
    typeof first.name !== 'string' ||
    !Object.hasOwn(completedSteps, first.name)
  );
}
