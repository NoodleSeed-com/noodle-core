import type { ArtifactFulfilment, RuntimeArtifact } from '@noodle-borg/compiler';
import { resolveVariableEnvironment, validateVariableContinuation } from './business-variables.js';
import { preflightFulfilmentCustomerRoutes } from './customer-routing.js';
import { validateElicitationContent } from './elicitation-response.js';
import { ExpressionEvalError, evaluateCondition } from './eval/evaluate.js';
import {
  createHost,
  type ExecuteToolDeps,
  evalExprMap,
  resolveEnv,
  runFulfilment,
  runOperation,
  scopeFor,
} from './execute.js';
import { AllowAllPolicy } from './policy/allow-all.js';
import type {
  ElicitationResponse,
  ExecutionError,
  ExecutionResult,
  InteractiveExecutionResult,
  ToolContinuation,
} from './result.js';
import { attachResultMeta, splitResultMeta } from './result-meta.js';
import { admitToolDispatch, latchToolDispatchAdmission } from './tool-dispatch.js';

type FlowFulfilment = Extract<ArtifactFulfilment, { kind: 'flow' }>;

/** Execute a tool until it completes, fails, or reaches an `elicit` step. */
export async function executeToolInteractive(
  artifact: RuntimeArtifact,
  toolName: string,
  input: unknown,
  deps: ExecuteToolDeps,
): Promise<InteractiveExecutionResult> {
  if (artifact.resolution !== 'resolved') {
    return interactiveFail('shape_only_artifact', 'runtime refuses to serve a shape-only artifact');
  }
  const tool = artifact.tools.find((candidate) => candidate.name === toolName);
  if (!tool) return interactiveFail('unknown_tool', `no tool named "${toolName}"`);
  const variables = resolveVariableEnvironment(
    artifact.server.variables ?? [],
    await resolveEnv(deps),
    toolName,
  );
  if (!variables.ok) return { status: 'failed', error: variables.error };
  deps = { ...deps, env: variables.env };
  if (tool.fulfilment.kind !== 'flow' || !tool.fulfilment.steps.some((s) => s.kind === 'elicit')) {
    return toInteractive(
      await runFulfilment(tool.fulfilment, input, toolName, deps, deps.beforeDispatch),
    );
  }
  const invalid = invalidInteractiveFlow(tool.fulfilment);
  if (invalid) return invalid;
  const routeError = preflightFulfilmentCustomerRoutes(tool.fulfilment, deps.customerRoutes);
  if (routeError !== null) return { status: 'failed', error: routeError };
  const env = await resolveEnv(deps);
  return runInteractiveFlow(artifact, toolName, tool.fulfilment, input, 0, {}, [], env, deps);
}

/** Resume one server-held continuation with the user's reviewed response. */
export async function resumeTool(
  artifact: RuntimeArtifact,
  continuation: ToolContinuation,
  response: ElicitationResponse,
  deps: ExecuteToolDeps,
): Promise<InteractiveExecutionResult> {
  if (!sameArtifact(artifact, continuation) || continuation.version !== 1) {
    return interactiveFail('invalid_continuation', 'tool continuation does not match the artifact');
  }
  if (response.action !== 'accept') return { status: 'stopped', action: response.action };
  if ((artifact.server.variables?.length ?? 0) > 0) {
    const variables = resolveVariableEnvironment(
      artifact.server.variables ?? [],
      await resolveEnv(deps),
      continuation.toolName,
    );
    const configurationError = validateVariableContinuation(artifact, continuation.env, variables);
    if (configurationError) return { status: 'failed', error: configurationError };
  }
  const validated = validateElicitationContent(
    response.content ?? {},
    continuation.pending.requestedSchema,
    `steps.${continuation.pending.id}`,
  );
  if (!validated.ok) return { status: 'failed', error: validated.error };
  const tool = artifact.tools.find((candidate) => candidate.name === continuation.toolName);
  if (tool?.fulfilment.kind !== 'flow') {
    return interactiveFail('invalid_continuation', 'continued tool is unavailable');
  }
  const invalid = invalidInteractiveFlow(tool.fulfilment);
  if (invalid) return invalid;
  const routeError = preflightFulfilmentCustomerRoutes(tool.fulfilment, deps.customerRoutes);
  if (routeError !== null) return { status: 'failed', error: routeError };
  const steps = {
    ...continuation.completedSteps,
    [continuation.pending.id]: validated.value,
  };
  return runInteractiveFlow(
    artifact,
    continuation.toolName,
    tool.fulfilment,
    continuation.input,
    continuation.nextStepIndex,
    steps,
    continuation.resultMetas.map((meta) => ({ ...meta })),
    { ...continuation.env },
    deps,
  );
}

async function runInteractiveFlow(
  artifact: RuntimeArtifact,
  toolName: string,
  flow: FlowFulfilment,
  input: unknown,
  startIndex: number,
  steps: Record<string, unknown>,
  resultMetas: Record<string, unknown>[],
  env: Record<string, unknown>,
  deps: ExecuteToolDeps,
): Promise<InteractiveExecutionResult> {
  const policy = deps.policy ?? new AllowAllPolicy();
  const dispatchAdmission = latchToolDispatchAdmission(deps.beforeDispatch, deps.signal);
  const host = createHost(toolName, deps, policy, env, [], dispatchAdmission);
  try {
    for (let index = startIndex; index < flow.steps.length; index += 1) {
      const step = flow.steps[index];
      if (!step) continue;
      const scope = scopeFor(input, steps, env, deps);
      if (step.if && !evaluateCondition(step.if, scope, `steps.${step.id}.if`)) continue;
      if (step.kind === 'elicit') {
        const request = {
          id: step.id,
          message: step.message,
          requestedSchema: step.requestedSchema,
        } as const;
        return {
          status: 'input_required',
          request,
          continuation: {
            version: 1,
            artifact: artifactIdentity(artifact),
            toolName,
            input,
            nextStepIndex: index + 1,
            completedSteps: { ...steps },
            resultMetas: resultMetas.map((meta) => ({ ...meta })),
            env: { ...env },
            pending: request,
          },
        };
      }
      if (step.kind === 'map') {
        steps[step.id] = evalExprMap(step.value, scope, `steps.${step.id}`);
        continue;
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
        undefined,
        dispatchAdmission,
      );
      if (!result.ok) return { status: 'failed', error: result.error };
      const split = splitResultMeta(result.output);
      steps[step.id] = split.visible;
      if (split.meta !== undefined) resultMetas.push(split.meta);
    }
    const output = attachResultMeta(
      evalExprMap(flow.output, scopeFor(input, steps, env, deps), 'output'),
      resultMetas,
    );
    const admissionError = await admitToolDispatch(dispatchAdmission, { toolName });
    return admissionError === null
      ? { status: 'completed', output }
      : { status: 'failed', error: admissionError };
  } catch (error) {
    if (error instanceof ExpressionEvalError) {
      return interactiveFail('expression_error', error.message, error.path);
    }
    throw error;
  }
}

function artifactIdentity(artifact: RuntimeArtifact): ToolContinuation['artifact'] {
  return {
    manifestName: artifact.source.manifestName,
    manifestVersion: artifact.source.manifestVersion,
    serverName: artifact.server.name,
    serverVersion: artifact.server.version,
  };
}

function sameArtifact(artifact: RuntimeArtifact, continuation: ToolContinuation): boolean {
  const expected = artifactIdentity(artifact);
  return (
    expected.manifestName === continuation.artifact.manifestName &&
    expected.manifestVersion === continuation.artifact.manifestVersion &&
    expected.serverName === continuation.artifact.serverName &&
    expected.serverVersion === continuation.artifact.serverVersion
  );
}

function toInteractive(result: ExecutionResult): InteractiveExecutionResult {
  return result.ok
    ? { status: 'completed', output: result.output }
    : { status: 'failed', error: result.error };
}

function interactiveFail(
  code: ExecutionError['code'],
  message: string,
  path?: string,
): InteractiveExecutionResult {
  return {
    status: 'failed',
    error: path === undefined ? { code, message } : { code, message, path },
  };
}

/** Defense in depth for artifacts compiled before the interactive-flow invariant existed. */
function invalidInteractiveFlow(flow: FlowFulfilment): InteractiveExecutionResult | null {
  let operationSeen = false;
  for (const step of flow.steps) {
    if (step.kind === 'operation') operationSeen = true;
    if (step.kind === 'elicit' && operationSeen) {
      return interactiveFail(
        'invalid_elicitation_flow',
        'interactive flows must collect all elicited input before the first operation',
        `steps.${step.id}`,
      );
    }
  }
  return null;
}
