import type { ArtifactFulfilment, RuntimeArtifact } from '@noodle-borg/compiler';
import type { CredentialBroker } from './broker/types.js';
import { resolveVariableEnvironment } from './business-variables.js';
import type {
  CallerIdentity,
  ConnectorCallHost,
  ConnectorRegistry,
  ExecutionTraceSink,
} from './connector/types.js';
import { preflightFulfilmentSignatures } from './connector-snapshot.js';
import type { FrozenCustomerRoutes } from './customer-routing.js';
import { preflightFulfilmentCustomerRoutes } from './customer-routing.js';
import { type EvalScope, ExpressionEvalError, evaluateCondition } from './eval/evaluate.js';
import type { InvocationContext } from './invocation-context.js';
import type { OperationCoordinationPort } from './operation-coordination.js';
import type { OperationEvidencePort } from './operation-evidence.js';
import { createHost, fail, runOperation } from './operation-execution.js';
import { evalExprMap } from './operation-validation.js';
import { AllowAllPolicy } from './policy/allow-all.js';
import type { PolicyGate } from './policy/types.js';
import type { ExecutionResult } from './result.js';
import { attachResultMeta, splitResultMeta } from './result-meta.js';
import {
  admitSuccessfulToolResult,
  latchToolDispatchAdmission,
  type ToolDispatchHook,
} from './tool-dispatch.js';

export {
  createHost,
  prepareOperationAction,
  runOperation,
} from './operation-execution.js';
export {
  evalExprMap,
  validateAgainstSchema,
  validateAgainstSchemaWithDefaults,
} from './operation-validation.js';

/** A flow fulfilment (the `flow` arm of the artifact's fulfilment union). */
type FlowFulfilment = Extract<ArtifactFulfilment, { kind: 'flow' }>;

/**
 * The collaborators the runtime needs to fulfil a tool call. Note there is deliberately no inbound
 * token here: the execution plane never sees or forwards an MCP/OAuth bearer token — downstream
 * credentials come only from the broker (docs/SPEC.md "Auth And Identity";
 * [ADR 0005](../../../docs/decisions/0005-runtime-execution-boundary.md)).
 */
export interface ExecuteDeps {
  readonly connectors: ConnectorRegistry;
  readonly broker: CredentialBroker;
  readonly policy?: PolicyGate;
  readonly env?: Record<string, unknown> | (() => Promise<Record<string, unknown>>);
  readonly caller?: CallerIdentity;
  /** Transport-owned admission attribution; absent network means public native writes must refuse. */
  readonly publicAdmission?: { readonly network: string; readonly visitor?: string };
  /** Verified customer IdP issuer, kept outside caller/expression scope for credential isolation. */
  readonly customerIssuer?: string;
  /** Request-local validated customer connector routes, kept separate from caller/expression scope. */
  readonly customerRoutes?: FrozenCustomerRoutes;
  readonly tenantId?: string;
  readonly deploymentId?: string;
  /** Trusted adapter invocation/confirmation identity; never read from tool input or expression scope. */
  readonly invocationId?: string;
  readonly operationEvidence?: OperationEvidencePort;
  readonly operationCoordination?: OperationCoordinationPort;
  /** Hosting snapshot: operator configuration and original connected-account generations. */
  readonly executionBinding?: {
    readonly revision: string;
    readonly connections: Readonly<Record<string, string>>;
  };
  /** Immutable facts resolved once for this invocation and exposed only through `${context...}`. */
  readonly context?: InvocationContext;
  readonly trace?: ExecutionTraceSink;
  /** Host-owned cancellation; TimeoutError denotes a hard execution deadline. Never caller payload. */
  readonly signal?: AbortSignal;
  /** Deployment-bound knowledge search (ADR 0202); absent means no knowledge tools serve. */
  readonly knowledgeSearch?: KnowledgeSearchPort;
}

/** One retrieval hit as the generated `search_<name>` tool returns it. */
export interface KnowledgeSearchHit {
  readonly id: string;
  readonly title: string;
  readonly excerpt: string;
  readonly sourceKind: 'document' | 'site';
  readonly uri?: string | undefined;
}

/**
 * Deployment-bound knowledge retrieval port (structural; the service adapts its executor).
 * `enabled` gates listing as well as calls — a disabled surface lists no knowledge tools.
 */
export interface KnowledgeSearchPort {
  enabled(): Promise<boolean>;
  search(
    componentName: string,
    request: { readonly query: string; readonly limit?: number | undefined },
  ): Promise<
    | { readonly ok: true; readonly hits: readonly KnowledgeSearchHit[] }
    | {
        readonly ok: false;
        readonly reason: 'budget_exhausted' | 'not_enabled' | 'provider_error';
        readonly message: string;
      }
  >;
}

/**
 * Tool-only dependencies. Resource, prompt, and ambient fulfilments deliberately cannot dispatch
 * this hook.
 */
export interface ExecuteToolDeps extends ExecuteDeps {
  readonly beforeDispatch?: ToolDispatchHook;
}

/**
 * Execute a tool call against a resolved runtime artifact.
 *
 * This non-interactive entry point executes single-operation fulfilment and non-suspending flows
 * (ordered `operation` and `map` steps with `if` skipping). It declines a flow containing `elicit`
 * before any step runs; adapters that support suspension use `executeToolInteractive` and
 * `resumeTool`. `input` is assumed already validated against the tool's input schema by the
 * protocol adapter; the runtime independently validates evaluated connector arguments against the
 * operation signature as defense in depth.
 */
export async function executeTool(
  artifact: RuntimeArtifact,
  toolName: string,
  input: unknown,
  deps: ExecuteToolDeps,
): Promise<ExecutionResult> {
  if (artifact.resolution !== 'resolved') {
    return fail('shape_only_artifact', 'runtime refuses to serve a shape-only artifact');
  }

  const tool = artifact.tools.find((t) => t.name === toolName);
  if (!tool) return fail('unknown_tool', `no tool named "${toolName}"`);
  const variables = resolveVariableEnvironment(
    artifact.server.variables ?? [],
    await resolveEnv(deps),
    toolName,
  );
  if (!variables.ok) return variables;
  return runFulfilment(
    tool.fulfilment,
    input,
    toolName,
    { ...deps, env: variables.env },
    deps.beforeDispatch,
  );
}

/**
 * Execute a resource read against a resolved artifact. `input` is the resource's variable scope — the
 * variables extracted from a templated URI, or `{}` for a fixed resource (the protocol adapter does the
 * URI match and passes them here). Resources reuse the exact tool fulfilment engine; the protocol layer
 * maps the returned value to MCP resource `contents`.
 */
export async function executeResource(
  artifact: RuntimeArtifact,
  resourceName: string,
  input: unknown,
  deps: ExecuteDeps,
): Promise<ExecutionResult> {
  if (artifact.resolution !== 'resolved') {
    return fail('shape_only_artifact', 'runtime refuses to serve a shape-only artifact');
  }

  const resource = artifact.resources?.find((r) => r.name === resourceName);
  if (!resource) return fail('unknown_resource', `no resource named "${resourceName}"`);
  const variables = resolveVariableEnvironment(
    artifact.server.variables ?? [],
    await resolveEnv(deps),
  );
  if (!variables.ok) return variables;
  return runFulfilment(resource.fulfilment, input, resourceName, { ...deps, env: variables.env });
}

/**
 * Execute a prompt against a resolved artifact. `args` is the supplied prompt-arguments map (the
 * fulfilment's `input` scope). Prompts reuse the tool fulfilment engine; the protocol layer maps the
 * returned value to MCP prompt `messages`.
 */
export async function executePrompt(
  artifact: RuntimeArtifact,
  promptName: string,
  args: unknown,
  deps: ExecuteDeps,
): Promise<ExecutionResult> {
  if (artifact.resolution !== 'resolved') {
    return fail('shape_only_artifact', 'runtime refuses to serve a shape-only artifact');
  }

  const prompt = artifact.prompts?.find((p) => p.name === promptName);
  if (!prompt) return fail('unknown_prompt', `no prompt named "${promptName}"`);
  const variables = resolveVariableEnvironment(
    artifact.server.variables ?? [],
    await resolveEnv(deps),
  );
  if (!variables.ok) return variables;
  return runFulfilment(prompt.fulfilment, args, promptName, { ...deps, env: variables.env });
}

/**
 * Run a normalized fulfilment (single operation or non-suspending flow) against an `input` scope. Shared
 * by {@link executeTool}, {@link executeResource}, and {@link executePrompt}: the execution semantics are
 * identical across all three primitives; only where `input` comes from and how the output is mapped differ
 * (the latter at the protocol layer). `label` names the invoker for the policy context.
 */
/** @internal Shared with the ambient-context executor; not exported from the package barrel. */
export async function runFulfilment(
  fulfilment: ArtifactFulfilment,
  input: unknown,
  label: string,
  deps: ExecuteDeps,
  beforeDispatch?: ToolDispatchHook,
): Promise<ExecutionResult> {
  if (fulfilment.kind === 'flow' && !fulfilment.steps.some((step) => step.kind === 'elicit')) {
    const signatureError = preflightFulfilmentSignatures(fulfilment, deps.connectors);
    if (signatureError !== null) return { ok: false, error: signatureError };
    const routeError = preflightFulfilmentCustomerRoutes(fulfilment, deps.customerRoutes);
    if (routeError !== null) return { ok: false, error: routeError };
  }
  const policy = deps.policy ?? new AllowAllPolicy();
  const env = await resolveEnv(deps);
  const callStack: string[] = [];
  const dispatchAdmission = latchToolDispatchAdmission(beforeDispatch, deps.signal);
  const host = createHost(label, deps, policy, env, callStack, dispatchAdmission);

  let result: ExecutionResult;
  if (fulfilment.kind === 'operation') {
    const { operationRef, args } = fulfilment;
    result = await runOperation(
      operationRef,
      args,
      scopeFor(input, {}, env, deps),
      label,
      deps,
      policy,
      host,
      env,
      'args',
      'output',
      undefined,
      dispatchAdmission,
    );
  } else {
    result = await runFlow(fulfilment, input, env, label, deps, policy, host, dispatchAdmission);
  }
  return admitSuccessfulToolResult(result, dispatchAdmission, label);
}

/**
 * Execute a non-suspending flow: run each eligible step in declared order, thread step outputs into
 * the `steps` scope, then evaluate the `output` mapping. This compatibility path declines a flow
 * with an `elicit` step before any step runs, so callers cannot accidentally abandon partial work.
 */
async function runFlow(
  flow: FlowFulfilment,
  input: unknown,
  env: Record<string, unknown>,
  toolName: string,
  deps: ExecuteDeps,
  policy: PolicyGate,
  host: ConnectorCallHost,
  beforeDispatch?: ToolDispatchHook,
): Promise<ExecutionResult> {
  if (flow.steps.some((step) => step.kind === 'elicit')) {
    return fail(
      'unsupported_fulfilment',
      'flow fulfilment with elicitation requires the interactive execution API',
    );
  }

  const steps: Record<string, unknown> = {};
  const resultMetas: Record<string, unknown>[] = [];
  try {
    for (const step of flow.steps) {
      const scope = scopeFor(input, steps, env, deps);
      if (step.if && !evaluateCondition(step.if, scope, `steps.${step.id}.if`)) {
        continue; // a false `if` marks the step skipped (it produces no output)
      }
      if (step.kind === 'operation') {
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
          beforeDispatch,
        );
        if (!result.ok) return result;
        const split = splitResultMeta(result.output);
        steps[step.id] = split.visible;
        if (split.meta !== undefined) resultMetas.push(split.meta);
      } else if (step.kind === 'map') {
        steps[step.id] = evalExprMap(step.value, scope, `steps.${step.id}`);
      } else {
        // Unreachable: elicit steps are declined above. Defensive only.
        return fail('unsupported_fulfilment', `flow step "${step.id}" is not executable`);
      }
    }
    const output = evalExprMap(flow.output, scopeFor(input, steps, env, deps), 'output');
    return { ok: true, output: attachResultMeta(output, resultMetas) };
  } catch (err) {
    if (err instanceof ExpressionEvalError) return fail('expression_error', err.message, err.path);
    throw err;
  }
}

/** @internal Shared with the suspension-aware flow executor. */
export function scopeFor(
  input: unknown,
  steps: Record<string, unknown>,
  env: Record<string, unknown>,
  deps: ExecuteDeps,
): EvalScope {
  // An anonymous caller is a real principal with an opaque, deployment-scoped subject — not a person.
  // Binding it to `${user}` would let an identity-dependent expression resolve to something, which is
  // precisely the failure ADR 0201 makes unrepresentable at compile time; this is the runtime half.
  const identified = deps.caller !== undefined && deps.caller.identityKind !== 'anonymous';
  return {
    input,
    steps,
    env,
    ...(identified ? { user: deps.caller } : {}),
    ...(deps.context !== undefined ? { context: deps.context } : {}),
  };
}

/** @internal Shared with the suspension-aware flow executor. */
export async function resolveEnv(deps: ExecuteDeps): Promise<Record<string, unknown>> {
  if (deps.env === undefined) return {};
  return typeof deps.env === 'function' ? deps.env() : deps.env;
}
