import type { ExprMap, OperationSignature, ResolvedOperationRef } from '@noodle-borg/compiler';
import { sanitizeConnectorFailureDetails } from './connector/failure-details.js';
import { type ConnectorCallHost, isConnectorInvocationError } from './connector/types.js';
import {
  preflightOperationCustomerRoutes,
  resolveCustomerActionRouteBindings,
  resolveCustomerConnectorRoute,
} from './customer-routing.js';
import { type EvalScope, ExpressionEvalError } from './eval/evaluate.js';
import type { ExecuteDeps } from './execute.js';
import { acquireOperationCredential } from './operation-credential.js';
import { checkSignature, evalExprMap, validateAgainstSchema } from './operation-validation.js';
import type { PolicyContext, PolicyGate } from './policy/types.js';
import { samePreparedAction } from './prepared-action-match.js';
import type {
  ConfirmationActionReview,
  ExecutionError,
  ExecutionResult,
  PreparedOperationAction,
} from './result.js';
import { splitResultMeta } from './result-meta.js';
import { cloneRoutedOutput } from './routed-output-guard.js';
import { admitToolDispatch, type ToolDispatchHook } from './tool-dispatch.js';

/**
 * Run one connector operation end to end: resolve the connector, verify the signature has not
 * drifted, gate with policy, evaluate + validate arguments, mint a downstream credential, invoke,
 * redact, and validate the output. Shared by single-operation fulfilment and flow operation steps.
 */
/** @internal Shared with the suspension-aware flow executor. */
export async function runOperation(
  ref: ResolvedOperationRef | { resolved: false },
  argsAst: ExprMap,
  scope: EvalScope,
  toolName: string,
  deps: ExecuteDeps,
  policy: PolicyGate,
  host: ConnectorCallHost,
  env: Record<string, string>,
  argsPath: string,
  outputPath: string,
  reviewedAction?: PreparedOperationAction,
  beforeDispatch?: ToolDispatchHook,
): Promise<ExecutionResult> {
  const prepared = prepareOperationAction(ref, argsAst, scope, deps, argsPath);
  if (!prepared.ok) {
    if (reviewedAction !== undefined && prepared.error.code === 'connector_route_unavailable') {
      return fail(
        'invalid_continuation',
        'Customer connector route no longer matches the prepared action.',
      );
    }
    return { ok: false, error: prepared.error };
  }
  if (ref.resolved === true) {
    const routeError = preflightOperationCustomerRoutes(ref, deps.customerRoutes);
    if (routeError !== null) return { ok: false, error: routeError };
  }
  if (reviewedAction !== undefined && !samePreparedAction(prepared.action, reviewedAction)) {
    return fail(
      'invalid_continuation',
      'prepared connector arguments no longer match the reviewed action',
      argsPath,
    );
  }
  if (ref.resolved !== true)
    return fail('shape_only_artifact', 'operation reference is unresolved');
  return invokeOperation(
    ref,
    prepared.action.arguments,
    prepared.signature,
    toolName,
    deps,
    policy,
    host,
    env,
    argsPath,
    outputPath,
    beforeDispatch,
  );
}

type PreparedOperationActionResult =
  | {
      readonly ok: true;
      readonly action: PreparedOperationAction;
      readonly review: ConfirmationActionReview;
      readonly signature: OperationSignature;
    }
  | { readonly ok: false; readonly error: ExecutionError };

/** Resolve and validate an operation without policy, credentials, connector I/O, or side effects. */
export function prepareOperationAction(
  ref: ResolvedOperationRef | { resolved: false },
  argsAst: ExprMap,
  scope: EvalScope,
  deps: ExecuteDeps,
  argsPath: string,
  additionalOperationCount = 0,
): PreparedOperationActionResult {
  if (ref.resolved !== true) {
    return {
      ok: false,
      error: { code: 'shape_only_artifact', message: 'operation reference is unresolved' },
    };
  }
  const connector = deps.connectors.resolve(ref);
  if (!connector) {
    return {
      ok: false,
      error: {
        code: 'connector_unavailable',
        message: `no connector for ${ref.connectorId}@${ref.connectorVersion}`,
      },
    };
  }
  const signature = connector.signature(ref.operation);
  const drift = checkSignature(ref, signature);
  if (drift) return { ok: false, error: drift };
  const exactSignature = signature as OperationSignature;
  let evaluated: Record<string, unknown>;
  try {
    evaluated = evalExprMap(argsAst, scope, argsPath);
  } catch (error) {
    if (error instanceof ExpressionEvalError) {
      return {
        ok: false,
        error:
          error.path === undefined
            ? { code: 'expression_error', message: error.message }
            : { code: 'expression_error', message: error.message, path: error.path },
      };
    }
    throw error;
  }
  const argError = validateAgainstSchema(
    evaluated,
    exactSignature.input,
    argsPath,
    'arg_invalid',
    'argument',
  );
  if (argError) return { ok: false, error: argError };
  const customerRoutes = resolveCustomerActionRouteBindings(
    deps.customerRoutes,
    ref,
    exactSignature.type,
  );
  if (customerRoutes === null) {
    return {
      ok: false,
      error: {
        code: 'connector_route_unavailable',
        message: 'Customer connector route is unavailable.',
      },
    };
  }
  const action = {
    connectorId: ref.connectorId,
    connectorVersion: ref.connectorVersion,
    operation: ref.operation,
    ...(ref.credentialBinding ?? {}),
    arguments: evaluated,
  };
  return {
    ok: true,
    signature: exactSignature,
    action: {
      ...action,
      ...(customerRoutes.length === 0 ? {} : { customerRoutes }),
    },
    review: {
      ...action,
      inputSchema: exactSignature.input,
      additionalOperationCount,
    },
  };
}

/**
 * Invoke a resolved connector operation with already-evaluated arguments. This is the shared path for
 * manifest operation steps and host-mediated sandbox calls.
 */
async function invokeOperation(
  ref: ResolvedOperationRef,
  args: Readonly<Record<string, unknown>>,
  sig: OperationSignature,
  toolName: string,
  deps: ExecuteDeps,
  policy: PolicyGate,
  host: ConnectorCallHost,
  env: Record<string, string>,
  argsPath: string,
  outputPath: string,
  beforeDispatch?: ToolDispatchHook,
): Promise<ExecutionResult> {
  const callKey = operationKey(ref);
  if (hostCallStack(host).includes(callKey)) {
    return fail(
      'circular_call_dependency',
      `circular connector operation call detected at ${callKey}`,
      outputPath,
    );
  }
  hostCallStack(host).push(callKey);
  try {
    const connector = deps.connectors.resolve(ref);
    if (!connector) {
      return fail(
        'connector_unavailable',
        `no connector for ${ref.connectorId}@${ref.connectorVersion}`,
      );
    }
    const customerRoute = resolveCustomerConnectorRoute(deps.customerRoutes, ref);
    if (customerRoute === null) {
      return fail('connector_route_unavailable', 'Customer connector route is unavailable.');
    }

    const context: PolicyContext = {
      toolName,
      connectorId: ref.connectorId,
      connectorVersion: ref.connectorVersion,
      operation: ref.operation,
      ...(ref.credentialBinding ?? {}),
      ...(deps.tenantId !== undefined ? { tenantId: deps.tenantId } : {}),
      ...(deps.deploymentId !== undefined ? { deploymentId: deps.deploymentId } : {}),
    };

    let decision: Awaited<ReturnType<PolicyGate['before']>>;
    try {
      decision = await policy.before(context);
    } catch {
      return fail('policy_error', 'policy before hook failed');
    }
    if (!decision.allow) return fail('policy_denied', decision.reason);

    const acquired = await acquireOperationCredential(ref, deps, customerRoute);
    if (!acquired.ok) return { ok: false, error: acquired.error };
    const { credential } = acquired;
    let connectorArgs: Readonly<Record<string, unknown>>;
    try {
      connectorArgs = structuredClone(args);
    } catch {
      return fail('arg_invalid', 'connector arguments could not be safely isolated', argsPath);
    }

    const admissionError = await admitToolDispatch(beforeDispatch, { toolName });
    if (admissionError !== null) return { ok: false, error: admissionError };

    let output: unknown;
    try {
      output = await connector.invoke({
        operation: ref.operation,
        args: connectorArgs,
        env,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        credential,
        ...(ref.credentialBinding === undefined
          ? {}
          : { credentialPresentation: ref.credentialBinding.presentation }),
        ...(deps.caller !== undefined ? { caller: deps.caller } : {}),
        ...(customerRoute === undefined ? {} : { route: customerRoute }),
        host,
        ...(deps.trace === undefined ? {} : { trace: deps.trace }),
      });
    } catch (error) {
      const hostCall = hostCallErrorSnapshot(error);
      if (hostCall !== undefined) {
        return fail(hostCall.code, hostCall.message, hostCall.path);
      }
      if (isConnectorInvocationError(error)) {
        const failureDetails = sanitizeConnectorFailureDetails(error, {
          includeResponseExcerpt: customerRoute === undefined,
        });
        deps.trace?.record({
          kind: 'connector',
          connectorId: ref.connectorId,
          connectorVersion: ref.connectorVersion,
          operation: ref.operation,
          ...failureDetails,
        });
        // Attribution keeps the sanitized classification (never the excerpt) so analytics can name
        // the failing connector/operation/stage while the wire result stays generic (#1309).
        const status = statusClass(failureDetails.status);
        return fail('connector_error', `connector failed for operation "${ref.operation}"`, {
          ...(failureDetails.category === undefined ? {} : { reason: failureDetails.category }),
          connector: {
            connectorId: ref.connectorId,
            connectorVersion: ref.connectorVersion,
            operation: ref.operation,
            ...(failureDetails.category === undefined ? {} : { category: failureDetails.category }),
            ...(status === undefined ? {} : { statusClass: status }),
            ...(failureDetails.attempts === undefined ? {} : { attempts: failureDetails.attempts }),
            ...(failureDetails.retryable === undefined
              ? {}
              : { retryable: failureDetails.retryable }),
          },
        });
      }
      // Normalize connector failures; never surface backend internals or credentials.
      return fail('connector_error', `connector failed for operation "${ref.operation}"`, {
        connector: {
          connectorId: ref.connectorId,
          connectorVersion: ref.connectorVersion,
          operation: ref.operation,
        },
      });
    }

    if (customerRoute !== undefined) {
      const cloned = cloneRoutedOutput(output, customerRoute.baseUrl);
      if (!cloned.ok) {
        return fail('connector_error', `connector failed for operation "${ref.operation}"`);
      }
      output = cloned.value;
    }

    let redacted: unknown;
    try {
      redacted = await policy.after(context, output);
    } catch {
      return fail('policy_error', 'policy after hook failed');
    }

    // Projection metadata is a reserved runtime envelope, not part of the connector's visible output
    // contract. Validate the visible value deeply while preserving policy-processed metadata for the
    // flow/result projection channel.
    const outputError = validateAgainstSchema(
      splitResultMeta(redacted).visible,
      sig.output,
      outputPath,
      'output_invalid',
      'output field',
    );
    if (outputError) return { ok: false, error: outputError };

    return { ok: true, output: redacted };
  } finally {
    hostCallStack(host).pop();
  }
}

/** @internal Shared with the suspension-aware flow executor. */
export function createHost(
  toolName: string,
  deps: ExecuteDeps,
  policy: PolicyGate,
  env: Record<string, string>,
  callStack: string[],
  beforeDispatch?: ToolDispatchHook,
): ConnectorCallHost {
  const host: ConnectorCallHost & { readonly [CALL_STACK]: string[] } = {
    [CALL_STACK]: callStack,
    async callOperation(ref, args, path) {
      const connector = deps.connectors.resolve(ref);
      if (!connector) throw new HostCallError('connector_unavailable', 'connector unavailable');

      const signature = connector.signature(ref.operation);
      const drift = checkSignature(ref, signature);
      if (drift) throw new HostCallError(drift.code, drift.message, drift.path);
      const sig = signature as OperationSignature;

      const argError = validateAgainstSchema(
        args,
        sig.input,
        `${path}.args`,
        'arg_invalid',
        'argument',
      );
      if (argError) throw new HostCallError(argError.code, argError.message, argError.path);

      const result = await invokeOperation(
        ref,
        args,
        sig,
        toolName,
        deps,
        policy,
        this,
        env,
        `${path}.args`,
        `${path}.output`,
        beforeDispatch,
      );
      if (!result.ok) {
        throw new HostCallError(result.error.code, result.error.message, result.error.path);
      }
      return result.output;
    },
  };
  return host;
}

const CALL_STACK = Symbol('noodle.connectorCallStack');

function operationKey(ref: ResolvedOperationRef): string {
  return JSON.stringify([ref.connectorId, ref.connectorVersion, ref.operation]);
}

function hostCallStack(host: ConnectorCallHost): string[] {
  return (host as ConnectorCallHost & { [CALL_STACK]: string[] })[CALL_STACK];
}

/** Internal control-flow error used to carry normalized runtime failures into host-call callbacks. */
const hostCallErrors = new WeakMap<
  object,
  Readonly<{
    code: ExecutionError['code'];
    message: string;
    path?: string;
  }>
>();

class HostCallError extends Error {
  readonly code: ExecutionError['code'];
  readonly path: string | undefined;

  constructor(code: ExecutionError['code'], message: string, path?: string) {
    super(message);
    this.name = 'HostCallError';
    this.code = code;
    this.path = path;
    hostCallErrors.set(
      this,
      Object.freeze({
        code,
        message,
        ...(path === undefined ? {} : { path }),
      }),
    );
  }
}

function hostCallErrorSnapshot(
  value: unknown,
): Readonly<{ code: ExecutionError['code']; message: string; path?: string }> | undefined {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
    ? hostCallErrors.get(value)
    : undefined;
}

/** Upstream status class for retained attribution; the exact status stays out of analytics. */
function statusClass(status: number | undefined): '4xx' | '5xx' | undefined {
  if (status === undefined) return undefined;
  if (status >= 500 && status <= 599) return '5xx';
  if (status >= 400 && status <= 499) return '4xx';
  return undefined;
}

export function fail(
  code: ExecutionError['code'],
  message: string,
  pathOrDetails?: string | Pick<ExecutionError, 'reason' | 'fix' | 'next' | 'connector'>,
): ExecutionResult {
  if (typeof pathOrDetails === 'string') {
    return { ok: false, error: { code, message, path: pathOrDetails } };
  }
  return { ok: false, error: { code, message, ...pathOrDetails } };
}
