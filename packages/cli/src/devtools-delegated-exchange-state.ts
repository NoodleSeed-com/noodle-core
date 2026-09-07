import type {
  LocalDevtoolsDelegatedExchangeBindingProjection,
  LocalDevtoolsDelegatedExchangeSuccess,
} from '@noodle-borg/service/local';
import type { JSONWebKeySet } from 'jose';
import type { LocalDevtoolsDelegatedExchangeTrustDocument } from './devtools-delegated-exchange-authority.js';

export interface DevtoolsDelegatedExchangeStatus {
  readonly issuer: string;
  readonly jwks: JSONWebKeySet;
  readonly trustChanged: boolean;
  readonly tenant: string;
  readonly deployment: string;
  readonly bindings: readonly {
    readonly bindingKey: string;
    readonly connectorId: string;
    readonly operation?: string;
    readonly audience: string;
    readonly verified: boolean;
  }[];
}

interface DevtoolsDelegatedExchangeAssertionContext {
  readonly tenant: string;
  readonly deployment: string;
}

interface DevtoolsDelegatedExchangeState {
  snapshot(): DevtoolsDelegatedExchangeStatus | undefined;
  replace(
    trust: LocalDevtoolsDelegatedExchangeTrustDocument | undefined,
    projections: readonly LocalDevtoolsDelegatedExchangeBindingProjection[],
    context: DevtoolsDelegatedExchangeAssertionContext | undefined,
  ): void;
  recordAttempt(projection: LocalDevtoolsDelegatedExchangeBindingProjection): void;
  markVerified(event: LocalDevtoolsDelegatedExchangeSuccess): void;
}

export function createDevtoolsDelegatedExchangeState(): DevtoolsDelegatedExchangeState {
  let current: DevtoolsDelegatedExchangeStatus | undefined;

  return {
    snapshot() {
      return current === undefined ? undefined : cloneAndFreeze(current);
    },
    replace(trust, projections, context) {
      if (projections.length === 0) {
        current = undefined;
        return;
      }
      if (trust === undefined || context === undefined) {
        throw new Error(
          'delegated-exchange projections require public trust and active assertion context',
        );
      }
      const previous = current;
      const sameIssuer = previous?.issuer === trust.issuer;
      const verified = new Set<string>();
      if (sameIssuer && previous !== undefined) {
        for (const binding of previous.bindings) {
          if (binding.verified) verified.add(binding.bindingKey);
        }
      }
      current = cloneAndFreeze({
        issuer: trust.issuer,
        jwks: trust.jwks,
        trustChanged: trust.trustChanged || (previous !== undefined && !sameIssuer),
        tenant: context.tenant,
        deployment: context.deployment,
        bindings: projections.map((projection) => ({
          bindingKey: projection.bindingKey,
          connectorId: projection.connectorId,
          ...(projection.operation === undefined ? {} : { operation: projection.operation }),
          audience: projection.audience,
          verified: verified.has(projection.bindingKey),
        })),
      });
    },
    recordAttempt(projection) {
      if (current === undefined) {
        throw new Error('delegated-exchange attempt requires active public status');
      }
      const matchingBindings = current.bindings.filter(
        (binding) =>
          binding.connectorId === projection.connectorId &&
          binding.operation === projection.operation,
      );
      if (matchingBindings.length !== 1) {
        throw new Error('delegated-exchange attempt must match exactly one public binding');
      }
      current = cloneAndFreeze({
        ...current,
        bindings: current.bindings.map((binding) =>
          binding.connectorId === projection.connectorId &&
          binding.operation === projection.operation
            ? {
                ...projection,
                verified: binding.verified && binding.bindingKey === projection.bindingKey,
              }
            : binding,
        ),
      });
    },
    markVerified(event) {
      if (
        current === undefined ||
        !current.bindings.some((binding) => binding.bindingKey === event.bindingKey)
      ) {
        return;
      }
      current = cloneAndFreeze({
        ...current,
        bindings: current.bindings.map((binding) =>
          binding.bindingKey === event.bindingKey ? { ...binding, verified: true } : binding,
        ),
      });
    },
  };
}

function cloneAndFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
