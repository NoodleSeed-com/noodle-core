import type { OperationSignature } from '@noodle-borg/compiler';
import {
  type Connector,
  type ConnectorCall,
  ConnectorInvocationError,
  type OperationCoordinationDeclaration,
} from '@noodle-borg/runtime';
import {
  type ComputeEngine,
  ComputeError,
  type ComputeHost,
  type ComputeLimits,
  type ComputeModule,
  type ComputeTimings,
  DEFAULT_LIMITS,
} from './engine.js';

export interface CodeOperationCallRef {
  readonly resolved: true;
  readonly alias: string;
  readonly connectorId: string;
  readonly connectorVersion: string;
  readonly operation: string;
  readonly signatureHash: string;
  readonly customerEndpoint?: string;
}

/** One sandboxed-code operation: its declared signature and the content-addressed module that fulfils it. */
export interface CodeOperation {
  readonly signature: OperationSignature;
  readonly module: ComputeModule;
  /** Per-operation resource bounds; falls back to {@link DEFAULT_LIMITS}. */
  readonly limits?: ComputeLimits;
  /** Host operations this compute operation is allowed to call, keyed by sandbox-local name. */
  readonly calls?: Readonly<Record<string, CodeOperationCallRef>>;
  readonly coordination?: OperationCoordinationDeclaration;
}

export interface CodeConnectorConfig {
  readonly id: string;
  readonly version: string;
  readonly engine: ComputeEngine;
  readonly operations: Readonly<Record<string, CodeOperation>>;
}

/**
 * A connector whose operations run tenant-authored JavaScript in a {@link ComputeEngine} sandbox — the
 * "code as a sandboxed connector operation" escape hatch
 * ([ADR 0004](../../../docs/decisions/0004-code-as-sandboxed-connector.md)). It is a plain {@link Connector},
 * so it resolves and invokes through the runtime exactly like any other connector: typed args in (already
 * validated against the signature), typed output out (validated by the runtime), policy gate + broker
 * around it. Declared host calls are the only outbound capability: sandbox-local names map to resolved
 * connector operations and are mediated by the runtime host
 * ([ADR 0014](../../../docs/decisions/0014-compute-engine-interface.md)).
 */
export class CodeConnector implements Connector {
  readonly id: string;
  readonly version: string;
  readonly #engine: ComputeEngine;
  readonly #operations: Readonly<Record<string, CodeOperation>>;

  constructor(config: CodeConnectorConfig) {
    this.id = config.id;
    this.version = config.version;
    this.#engine = config.engine;
    this.#operations = config.operations;
  }

  signature(operation: string): OperationSignature | undefined {
    return this.#operations[operation]?.signature;
  }

  executionBoundMs(operation: string): number | undefined {
    const op = this.#operations[operation];
    return op === undefined ? undefined : (op.limits ?? DEFAULT_LIMITS).timeoutMs;
  }

  coordination(operation: string): OperationCoordinationDeclaration | undefined {
    return this.#operations[operation]?.coordination;
  }

  async invoke(call: ConnectorCall): Promise<unknown> {
    const op = this.#operations[call.operation];
    if (!op) throw new Error(`connector "${this.id}" has no operation "${call.operation}"`);
    const instance = await this.#engine.instantiate(op.module);
    let timings: ComputeTimings | undefined;
    try {
      const output = await instance.invoke(
        call.args,
        op.limits ?? DEFAULT_LIMITS,
        computeHost(op.calls ?? {}, call),
        (t) => {
          timings = t;
        },
      );
      // Queue wait and execution are recorded independently so burst head-of-line blocking is
      // observable on successful calls too, not only on the ones that fail.
      if (timings !== undefined) {
        call.trace?.record({
          kind: 'connector',
          connectorId: this.id,
          connectorVersion: this.version,
          operation: call.operation,
          queueWaitMs: timings.queueWaitMs,
          executionMs: timings.executionMs,
        });
      }
      return output;
    } catch (error) {
      throw classifyInvocationFailure(error, timings);
    } finally {
      instance.dispose();
    }
  }
}

/**
 * Re-throw sandbox time-budget failures as {@link ConnectorInvocationError} with a stable category,
 * so the runtime surfaces `connector_error` with a `timeout`/`queue_timeout` reason and records the
 * queue-wait and execution durations. A queue-expired call never started executing, so it is safely
 * retryable. All other compute failures propagate unchanged.
 */
function classifyInvocationFailure(error: unknown, timings: ComputeTimings | undefined): unknown {
  if (!(error instanceof ComputeError)) return error;
  if (error.code !== 'timeout' && error.code !== 'queue_timeout') return error;
  return new ConnectorInvocationError(error.message, {
    category: error.code,
    attempts: 1,
    ...(error.code === 'queue_timeout' ? { retryable: true } : {}),
    ...(timings === undefined
      ? {}
      : {
          queueWaitMs: Math.round(timings.queueWaitMs),
          executionMs: Math.round(timings.executionMs),
        }),
  });
}

function computeHost(
  calls: Readonly<Record<string, CodeOperationCallRef>>,
  call: ConnectorCall,
): ComputeHost {
  const host = call.host;
  return {
    ...(call.execution ? { execution: call.execution } : {}),
    ...(call.coordination ? { coordination: call.coordination } : {}),
    ...(call.resolveCoordination ? { resolveCoordination: call.resolveCoordination } : {}),
    ...(call.reportOutcome ? { reportOutcome: call.reportOutcome } : {}),
    callOperation(name, args) {
      if (!host) {
        throw new ComputeError('host_call_failed', 'host call unavailable');
      }
      const ref = calls[name];
      if (!ref) {
        throw new ComputeError('host_call_denied', `host call "${name}" is not declared`);
      }
      return host.callOperation(ref, args, `host.${name}`);
    },
  };
}
