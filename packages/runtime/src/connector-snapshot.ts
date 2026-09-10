import {
  type ArtifactFulfilment,
  computeSignatureHash,
  type OperationSignature,
  type ResolvedOperationRef,
} from '@noodle-borg/compiler';
import type { Connector, ConnectorRegistry } from './connector/types.js';
import type { ExecuteToolDeps } from './execute.js';
import type { OperationCoordinationDeclaration } from './operation-coordination.js';
import type { ExecutionError } from './result.js';

/** Capture connector identity and operation signatures once for one runtime API invocation. */
export function withConnectorSnapshot(deps: ExecuteToolDeps): ExecuteToolDeps {
  const resolved = new Map<string, Connector | undefined>();
  const wrapped = new Map<string, Connector | undefined>();
  const registry: ConnectorRegistry = {
    resolve(ref) {
      const key = `${ref.connectorId}@${ref.connectorVersion}`;
      if (wrapped.has(key)) return wrapped.get(key);
      let connector: Connector | undefined;
      if (resolved.has(key)) {
        connector = resolved.get(key);
      } else {
        connector = deps.connectors.resolve(ref);
        resolved.set(key, connector);
      }
      if (connector === undefined) {
        wrapped.set(key, undefined);
        return undefined;
      }
      const signatures = new Map<string, OperationSignature | undefined>();
      const executionBounds = new Map<string, number | undefined>();
      const coordinations = new Map<string, OperationCoordinationDeclaration | undefined>();
      const snapshot: Connector = {
        id: connector.id,
        version: connector.version,
        signature(operation) {
          if (!signatures.has(operation)) {
            const live = connector.signature(operation);
            const captured: OperationSignature | undefined =
              live === undefined ? undefined : deepFreeze(structuredClone(live));
            signatures.set(operation, captured);
          }
          return signatures.get(operation);
        },
        executionBoundMs(operation) {
          if (!executionBounds.has(operation))
            executionBounds.set(operation, connector.executionBoundMs?.(operation));
          return executionBounds.get(operation);
        },
        coordination(operation) {
          if (!coordinations.has(operation)) {
            const live = connector.coordination?.(operation);
            coordinations.set(
              operation,
              live === undefined ? undefined : deepFreeze(structuredClone(live)),
            );
          }
          return coordinations.get(operation);
        },
        invoke(call) {
          return connector.invoke(call);
        },
      };
      wrapped.set(key, snapshot);
      return snapshot;
    },
  };
  return { ...deps, connectors: registry };
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function preflightFulfilmentSignatures(
  fulfilment: ArtifactFulfilment,
  connectors: ConnectorRegistry,
): ExecutionError | null {
  const operations =
    fulfilment.kind === 'operation'
      ? [{ ref: fulfilment.operationRef, path: 'args' }]
      : fulfilment.steps
          .filter((step) => step.kind === 'operation')
          .map((step) => ({ ref: step.operationRef, path: `steps.${step.id}` }));
  for (const operation of operations) {
    const error = preflightOperationSignature(operation.ref, connectors, operation.path);
    if (error) return error;
  }
  return null;
}

function preflightOperationSignature(
  ref: ResolvedOperationRef | { readonly resolved: false },
  connectors: ConnectorRegistry,
  path: string,
): ExecutionError | null {
  if (ref.resolved !== true) {
    return { code: 'shape_only_artifact', message: 'operation reference is unresolved', path };
  }
  const connector = connectors.resolve(ref);
  if (connector === undefined) {
    return {
      code: 'connector_unavailable',
      message: `no connector for ${ref.connectorId}@${ref.connectorVersion}`,
      path,
    };
  }
  const signature = connector.signature(ref.operation);
  if (
    signature === undefined ||
    computeSignatureHash(ref.operation, signature) !== ref.signatureHash
  ) {
    return {
      code: 'signature_drift',
      message: `connector operation signature drifted for "${ref.operation}"`,
      path,
    };
  }
  return null;
}
