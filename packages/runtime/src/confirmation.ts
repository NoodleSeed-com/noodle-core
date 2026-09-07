import type { ArtifactFulfilment, RuntimeArtifact } from '@noodle-borg/compiler';
import {
  analyzeEligibleActions,
  countTrailingEligibleOperations,
  isActionOperation,
  validateConfirmationFlow,
} from './confirmation-analysis.js';
import {
  artifactIdentity,
  confirmationRequired,
  sameArtifact,
} from './confirmation-continuation.js';
import { validatePreparedCustomerRoutes } from './confirmation-customer-routes.js';
import { preflightFulfilmentSignatures, withConnectorSnapshot } from './connector-snapshot.js';
import { preflightFulfilmentCustomerRoutes } from './customer-routing.js';
import { validateElicitationContent } from './elicitation-response.js';
import { ExpressionEvalError, evaluateCondition } from './eval/evaluate.js';
import {
  createHost,
  type ExecuteToolDeps,
  evalExprMap,
  prepareOperationAction,
  resolveEnv,
  runOperation,
  scopeFor,
  validateAgainstSchema,
} from './execute.js';
import { AllowAllPolicy } from './policy/allow-all.js';
import type {
  ConfirmationPreparationResult,
  ElicitationResponse,
  ExecutionError,
  InteractiveExecutionResult,
  PreparedOperationAction,
  PreparedToolContinuation,
  ToolPreparationContinuation,
} from './result.js';
import { attachResultMeta, splitResultMeta } from './result-meta.js';
import { admitToolDispatch, latchToolDispatchAdmission } from './tool-dispatch.js';

type FlowFulfilment = Extract<ArtifactFulfilment, { kind: 'flow' }>;

/**
 * Evaluate the pure prefix of a confirmable tool. Connector operations are an absolute suspension
 * boundary: this function either requests input, returns a prepared confirmation, or fails before
 * invoking one.
 */
export async function prepareToolForConfirmation(
  artifact: RuntimeArtifact,
  toolName: string,
  input: unknown,
  deps: ExecuteToolDeps,
): Promise<ConfirmationPreparationResult> {
  if (artifact.resolution !== 'resolved') {
    return failPreparation('shape_only_artifact', 'runtime refuses to serve a shape-only artifact');
  }
  const tool = artifact.tools.find((candidate) => candidate.name === toolName);
  if (!tool) return failPreparation('unknown_tool', `no tool named "${toolName}"`);
  const invocationDeps = withConnectorSnapshot(deps);
  const preflightError = preflightFulfilmentSignatures(tool.fulfilment, invocationDeps.connectors);
  if (preflightError) return { status: 'failed', error: preflightError };
  const routeError = preflightFulfilmentCustomerRoutes(
    tool.fulfilment,
    invocationDeps.customerRoutes,
  );
  if (routeError) return { status: 'failed', error: routeError };
  if (tool.fulfilment.kind === 'flow') {
    const invalid = validateConfirmationFlow(tool.fulfilment, invocationDeps);
    if (invalid) return { status: 'failed', error: invalid };
  }
  const env = await resolveEnv(invocationDeps);
  if (tool.fulfilment.kind === 'operation') {
    const prepared = prepareOperationAction(
      tool.fulfilment.operationRef,
      tool.fulfilment.args,
      scopeFor(input, {}, env, invocationDeps),
      invocationDeps,
      'args',
    );
    if (!prepared.ok) return { status: 'failed', error: prepared.error };
    return confirmationRequired(artifact, toolName, input, 0, {}, {}, env, {
      prepared: prepared.action,
      review: prepared.review,
    });
  }
  return runPreparation(artifact, toolName, tool.fulfilment, input, 0, {}, {}, env, invocationDeps);
}

/** Resume the pure preparation prefix with one accepted, declined, or cancelled input response. */
export async function resumeToolPreparation(
  artifact: RuntimeArtifact,
  continuation: ToolPreparationContinuation,
  response: ElicitationResponse,
  deps: ExecuteToolDeps,
): Promise<ConfirmationPreparationResult> {
  if (artifact.resolution !== 'resolved') {
    return failPreparation('shape_only_artifact', 'runtime refuses to serve a shape-only artifact');
  }
  if (
    continuation.kind !== 'confirmation_preparation' ||
    continuation.version !== 1 ||
    !sameArtifact(artifact, continuation)
  ) {
    return failPreparation('invalid_continuation', 'tool continuation does not match the artifact');
  }
  if (response.action !== 'accept') return { status: 'stopped', action: response.action };
  const validated = validateElicitationContent(
    response.content ?? {},
    continuation.pending.requestedSchema,
    `steps.${continuation.pending.id}`,
  );
  if (!validated.ok) return { status: 'failed', error: validated.error };
  const tool = artifact.tools.find((candidate) => candidate.name === continuation.toolName);
  if (tool?.fulfilment.kind !== 'flow') {
    return failPreparation('invalid_continuation', 'continued tool is unavailable');
  }
  const invocationDeps = withConnectorSnapshot(deps);
  const preflightError = preflightFulfilmentSignatures(tool.fulfilment, invocationDeps.connectors);
  if (preflightError) return { status: 'failed', error: preflightError };
  const routeError = preflightFulfilmentCustomerRoutes(
    tool.fulfilment,
    invocationDeps.customerRoutes,
  );
  if (routeError) return { status: 'failed', error: routeError };
  const invalid = validateConfirmationFlow(tool.fulfilment, invocationDeps);
  if (invalid) return { status: 'failed', error: invalid };
  const responseContent = validated.value;
  return runPreparation(
    artifact,
    continuation.toolName,
    tool.fulfilment,
    continuation.input,
    continuation.nextStepIndex,
    { ...continuation.completedSteps, [continuation.pending.id]: responseContent },
    { ...continuation.elicited, [continuation.pending.id]: responseContent },
    { ...continuation.env },
    invocationDeps,
  );
}

/**
 * Execute a previously prepared tool after approval. The whole flow is checked again before the
 * first operation; a forged or drifted continuation can therefore never reach a late elicitation
 * after performing a side effect.
 */
export async function executePreparedTool(
  artifact: RuntimeArtifact,
  continuation: PreparedToolContinuation,
  deps: ExecuteToolDeps,
): Promise<InteractiveExecutionResult> {
  if (artifact.resolution !== 'resolved') {
    return failInteractive('shape_only_artifact', 'runtime refuses to serve a shape-only artifact');
  }
  if (
    continuation.kind !== 'prepared_confirmation' ||
    continuation.version !== 1 ||
    !sameArtifact(artifact, continuation)
  ) {
    return failInteractive('invalid_continuation', 'tool continuation does not match the artifact');
  }
  const tool = artifact.tools.find((candidate) => candidate.name === continuation.toolName);
  if (!tool) return failInteractive('invalid_continuation', 'continued tool is unavailable');
  const inputError = validateAgainstSchema(
    continuation.input,
    tool.inputSchema,
    'input',
    'arg_invalid',
    'tool input',
  );
  if (inputError) return { status: 'failed', error: inputError };
  const invocationDeps = withConnectorSnapshot(deps);
  const preflightError = preflightFulfilmentSignatures(tool.fulfilment, invocationDeps.connectors);
  if (preflightError) return { status: 'failed', error: preflightError };
  if (tool.fulfilment.kind === 'operation') {
    if (continuation.nextStepIndex !== 0 || Object.keys(continuation.completedSteps).length > 0) {
      return failInteractive('invalid_continuation', 'prepared tool state is invalid');
    }
    if (continuation.reviewedAction === undefined) {
      return failInteractive('invalid_continuation', 'prepared action review is missing');
    }
    const routeBindingError = validatePreparedCustomerRoutes(
      tool.fulfilment.operationRef,
      continuation.reviewedAction,
      invocationDeps.customerRoutes,
      tool.fulfilment.operationRef.resolved === true
        ? invocationDeps.connectors
            .resolve(tool.fulfilment.operationRef)
            ?.signature(tool.fulfilment.operationRef.operation)?.type
        : undefined,
    );
    if (routeBindingError) return { status: 'failed', error: routeBindingError };
    const routeError = preflightFulfilmentCustomerRoutes(
      tool.fulfilment,
      invocationDeps.customerRoutes,
    );
    if (routeError) return { status: 'failed', error: routeError };
    const env = { ...continuation.env };
    const policy = invocationDeps.policy ?? new AllowAllPolicy();
    const dispatchAdmission = latchToolDispatchAdmission(
      invocationDeps.beforeDispatch,
      invocationDeps.signal,
    );
    const result = await runOperation(
      tool.fulfilment.operationRef,
      tool.fulfilment.args,
      scopeFor(continuation.input, {}, env, invocationDeps),
      tool.name,
      invocationDeps,
      policy,
      createHost(tool.name, invocationDeps, policy, env, [], dispatchAdmission),
      env,
      'args',
      'output',
      continuation.reviewedAction,
      dispatchAdmission,
    );
    return result.ok
      ? { status: 'completed', output: result.output }
      : { status: 'failed', error: result.error };
  }
  const invalid = validateConfirmationFlow(tool.fulfilment, invocationDeps);
  if (invalid) return { status: 'failed', error: invalid };
  if (
    continuation.nextStepIndex < 0 ||
    continuation.nextStepIndex > tool.fulfilment.steps.length ||
    tool.fulfilment.steps.slice(continuation.nextStepIndex).some((step) => step.kind === 'elicit')
  ) {
    return failInteractive(
      'invalid_continuation',
      'prepared tool state crosses an elicitation boundary',
    );
  }
  const hasPreparedOperation = tool.fulfilment.steps
    .slice(continuation.nextStepIndex)
    .some((step) => step.kind === 'operation');
  if (hasPreparedOperation !== (continuation.reviewedAction !== undefined)) {
    return failInteractive(
      'invalid_continuation',
      'prepared action review does not match the flow',
    );
  }
  const initialScope = scopeFor(
    continuation.input,
    continuation.completedSteps,
    continuation.env,
    invocationDeps,
  );
  const actionAnalysis = analyzeEligibleActions(
    tool.fulfilment,
    continuation.nextStepIndex,
    continuation.completedSteps,
    initialScope,
    invocationDeps,
  );
  if (!actionAnalysis.ok) return { status: 'failed', error: actionAnalysis.error };
  if (actionAnalysis.flowHasActions && actionAnalysis.eligibleIndexes.length !== 1) {
    return failInteractive(
      'invalid_confirmation_flow',
      'confirmable conditional flows must resolve exactly one eligible action',
    );
  }
  if (continuation.reviewedAction !== undefined) {
    const reviewedStep = tool.fulfilment.steps[continuation.nextStepIndex];
    if (reviewedStep?.kind !== 'operation') {
      return failInteractive('invalid_continuation', 'prepared action review is invalid');
    }
    const routeBindingError = validatePreparedCustomerRoutes(
      reviewedStep.operationRef,
      continuation.reviewedAction,
      invocationDeps.customerRoutes,
      reviewedStep.operationRef.resolved === true
        ? invocationDeps.connectors
            .resolve(reviewedStep.operationRef)
            ?.signature(reviewedStep.operationRef.operation)?.type
        : undefined,
    );
    if (routeBindingError) return { status: 'failed', error: routeBindingError };
  }
  const routeError = preflightFulfilmentCustomerRoutes(
    tool.fulfilment,
    invocationDeps.customerRoutes,
  );
  if (routeError) return { status: 'failed', error: routeError };
  return runPreparedFlow(
    continuation.toolName,
    tool.fulfilment,
    continuation.input,
    continuation.nextStepIndex,
    { ...continuation.completedSteps },
    { ...continuation.env },
    invocationDeps,
    continuation.reviewedAction,
  );
}

async function runPreparation(
  artifact: RuntimeArtifact,
  toolName: string,
  flow: FlowFulfilment,
  input: unknown,
  startIndex: number,
  steps: Record<string, unknown>,
  elicited: Record<string, unknown>,
  env: Record<string, string>,
  deps: ExecuteToolDeps,
): Promise<ConfirmationPreparationResult> {
  try {
    for (let index = startIndex; index < flow.steps.length; index += 1) {
      const step = flow.steps[index];
      if (!step) continue;
      const scope = scopeFor(input, steps, env, deps);
      if (step.if && !evaluateCondition(step.if, scope, `steps.${step.id}.if`)) continue;
      if (step.kind === 'operation') {
        const actionAnalysis = analyzeEligibleActions(flow, index, steps, scope, deps);
        if (!actionAnalysis.ok) return { status: 'failed', error: actionAnalysis.error };
        const additionalOperations = countTrailingEligibleOperations(flow, index, steps, scope);
        if (!additionalOperations.ok) {
          return { status: 'failed', error: additionalOperations.error };
        }
        const prepared = prepareOperationAction(
          step.operationRef,
          step.args,
          scope,
          deps,
          `steps.${step.id}.args`,
          additionalOperations.count,
        );
        if (!prepared.ok) return { status: 'failed', error: prepared.error };
        if (
          actionAnalysis.flowHasActions &&
          (actionAnalysis.eligibleIndexes.length !== 1 ||
            actionAnalysis.eligibleIndexes[0] !== index ||
            !isActionOperation(step.operationRef, prepared.signature.type))
        ) {
          return failPreparation(
            'invalid_confirmation_flow',
            'confirmable conditional flows must resolve exactly one eligible action',
            `steps.${step.id}`,
          );
        }
        return confirmationRequired(artifact, toolName, input, index, steps, elicited, env, {
          prepared: prepared.action,
          review: prepared.review,
        });
      }
      if (step.kind === 'map') {
        steps[step.id] = evalExprMap(step.value, scope, `steps.${step.id}`);
        continue;
      }
      const request = {
        id: step.id,
        message: step.message,
        requestedSchema: step.requestedSchema,
      } as const;
      return {
        status: 'input_required',
        request,
        continuation: {
          kind: 'confirmation_preparation',
          version: 1,
          artifact: artifactIdentity(artifact),
          toolName,
          input,
          nextStepIndex: index + 1,
          completedSteps: { ...steps },
          elicited: { ...elicited },
          env: { ...env },
          pending: request,
        },
      };
    }
    const finalScope = scopeFor(input, steps, env, deps);
    const actionAnalysis = analyzeEligibleActions(flow, startIndex, steps, finalScope, deps);
    if (!actionAnalysis.ok) return { status: 'failed', error: actionAnalysis.error };
    if (actionAnalysis.flowHasActions && actionAnalysis.eligibleIndexes.length !== 1) {
      return failPreparation(
        'invalid_confirmation_flow',
        'confirmable conditional flows must resolve exactly one eligible action',
      );
    }
    return confirmationRequired(artifact, toolName, input, flow.steps.length, steps, elicited, env);
  } catch (error) {
    if (error instanceof ExpressionEvalError) {
      return failPreparation('expression_error', error.message, error.path);
    }
    throw error;
  }
}

async function runPreparedFlow(
  toolName: string,
  flow: FlowFulfilment,
  input: unknown,
  startIndex: number,
  steps: Record<string, unknown>,
  env: Record<string, string>,
  deps: ExecuteToolDeps,
  reviewedAction?: PreparedOperationAction,
): Promise<InteractiveExecutionResult> {
  const policy = deps.policy ?? new AllowAllPolicy();
  const dispatchAdmission = latchToolDispatchAdmission(deps.beforeDispatch, deps.signal);
  const host = createHost(toolName, deps, policy, env, [], dispatchAdmission);
  const resultMetas: Record<string, unknown>[] = [];
  try {
    for (let index = startIndex; index < flow.steps.length; index += 1) {
      const step = flow.steps[index];
      if (!step) continue;
      const scope = scopeFor(input, steps, env, deps);
      if (step.if && !evaluateCondition(step.if, scope, `steps.${step.id}.if`)) continue;
      if (step.kind === 'elicit') {
        return failInteractive(
          'invalid_confirmation_flow',
          'confirmable flows must collect all elicited input before the first operation',
        );
      }
      if (step.kind === 'map') {
        steps[step.id] = evalExprMap(step.value, scope, `steps.${step.id}`);
        continue;
      }
      if (reviewedAction === undefined) {
        const prepared = prepareOperationAction(
          step.operationRef,
          step.args,
          scope,
          deps,
          `steps.${step.id}.args`,
        );
        if (!prepared.ok) return { status: 'failed', error: prepared.error };
        if (isActionOperation(step.operationRef, prepared.signature.type)) {
          return failInteractive(
            'invalid_confirmation_flow',
            'a second eligible action was not included in the confirmation review',
            `steps.${step.id}`,
          );
        }
      }
      const result = await runOperation(
        step.operationRef,
        step.args,
        scope,
        toolName,
        deps,
        policy,
        host,
        env,
        `steps.${step.id}.args`,
        `steps.${step.id}.output`,
        reviewedAction,
        dispatchAdmission,
      );
      if (reviewedAction !== undefined) reviewedAction = undefined;
      if (!result.ok) return { status: 'failed', error: result.error };
      const split = splitResultMeta(result.output);
      steps[step.id] = split.visible;
      if (split.meta !== undefined) resultMetas.push(split.meta);
    }
    const output = attachResultMeta(
      evalExprMap(flow.output, scopeFor(input, steps, env, deps), 'output'),
      resultMetas,
    );
    if (reviewedAction !== undefined) {
      return failInteractive('invalid_continuation', 'reviewed action was not executed');
    }
    const admissionError = await admitToolDispatch(dispatchAdmission, { toolName });
    return admissionError === null
      ? { status: 'completed', output }
      : { status: 'failed', error: admissionError };
  } catch (error) {
    if (error instanceof ExpressionEvalError) {
      return failInteractive('expression_error', error.message, error.path);
    }
    throw error;
  }
}

function failPreparation(
  code: ExecutionError['code'],
  message: string,
  path?: string,
): Extract<ConfirmationPreparationResult, { readonly status: 'failed' }> {
  return {
    status: 'failed',
    error: path === undefined ? { code, message } : { code, message, path },
  };
}

function failInteractive(
  code: ExecutionError['code'],
  message: string,
  path?: string,
): Extract<InteractiveExecutionResult, { readonly status: 'failed' }> {
  return {
    status: 'failed',
    error: path === undefined ? { code, message } : { code, message, path },
  };
}
