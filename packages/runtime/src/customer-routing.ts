import { createHash } from 'node:crypto';
import {
  type ArtifactFulfilment,
  type CustomerEndpointPolicy,
  normalizeCustomerEndpointPolicy,
  type ResolvedOperationRef,
  resolveCustomerEndpointBaseUrl,
} from '@noodle-borg/compiler';
import type { ExecutionError } from './result.js';

export interface CustomerRouteBinding {
  readonly key: string;
  readonly fingerprint: string;
}

export interface CustomerConnectorRoute extends CustomerRouteBinding {
  readonly baseUrl: string;
}

export interface CustomerRouteRequirement {
  readonly connectorId: string;
  readonly connectorVersion: string;
  readonly key: string;
}

export type FrozenCustomerRoute =
  | {
      readonly available: true;
      readonly baseUrl: string;
      readonly policy: CustomerEndpointPolicy;
    }
  | {
      readonly available: false;
      readonly policy?: CustomerEndpointPolicy;
    };

export interface FrozenCustomerRoutes {
  readonly endpoints: Readonly<Record<string, FrozenCustomerRoute>>;
}

/**
 * Validate and freeze only the endpoint claims declared by one runtime artifact.
 *
 * Invalid claims deliberately become an indistinguishable unavailable state. This function never throws
 * and never retains the caller-owned raw claim map.
 */
export function freezeCustomerRoutes(
  declarations: Readonly<Record<string, CustomerEndpointPolicy>> | undefined,
  raw: Readonly<Record<string, string>> | undefined,
): FrozenCustomerRoutes {
  const endpoints = Object.create(null) as Record<string, FrozenCustomerRoute>;
  let keys: string[];
  try {
    keys = Object.keys(declarations ?? {}).sort();
  } catch {
    return frozenRoutes(endpoints);
  }
  for (const key of keys) {
    let policy: CustomerEndpointPolicy | undefined;
    try {
      policy = frozenPolicy(normalizeCustomerEndpointPolicy(declarations?.[key]));
      const value = raw !== undefined && Object.hasOwn(raw, key) ? raw[key] : undefined;
      const resolved = resolveCustomerEndpointBaseUrl(value, policy);
      endpoints[key] = Object.freeze(
        resolved.ok
          ? { available: true, baseUrl: resolved.baseUrl, policy }
          : { available: false, policy },
      );
    } catch {
      endpoints[key] = Object.freeze(
        policy === undefined ? { available: false } : { available: false, policy },
      );
    }
  }
  return frozenRoutes(endpoints);
}

function frozenRoutes(endpoints: Record<string, FrozenCustomerRoute>): FrozenCustomerRoutes {
  return Object.freeze({
    endpoints: Object.freeze(endpoints),
  });
}

/**
 * Resolve the connector-specific safe route from an immutable request snapshot.
 *
 * `undefined` means the operation is static; `null` means its declared customer route is unavailable.
 */
export function resolveCustomerConnectorRoute(
  routes: FrozenCustomerRoutes | undefined,
  ref: ResolvedOperationRef,
): CustomerConnectorRoute | null | undefined {
  const key = ref.customerEndpoint;
  if (key === undefined) return undefined;
  const route = routes?.endpoints[key];
  if (route?.available !== true) return null;
  const binding = resolveCustomerRouteBinding(routes, {
    connectorId: ref.connectorId,
    connectorVersion: ref.connectorVersion,
    key,
  });
  if (binding === null) return null;
  return Object.freeze({
    ...binding,
    baseUrl: route.baseUrl,
  });
}

/** Fail closed when any customer endpoint reachable from one fulfilment is unavailable. */
export function preflightFulfilmentCustomerRoutes(
  fulfilment: ArtifactFulfilment,
  routes: FrozenCustomerRoutes | undefined,
): ExecutionError | null {
  const refs =
    fulfilment.kind === 'operation'
      ? [fulfilment.operationRef]
      : fulfilment.steps.flatMap((step) => (step.kind === 'operation' ? [step.operationRef] : []));
  for (const ref of refs) {
    if (ref.resolved === true && !operationCustomerRoutesAvailable(ref, routes)) {
      return unavailableCustomerRouteError();
    }
  }
  return null;
}

/** Check one operation and every connector-declared nested endpoint before dispatch. */
export function preflightOperationCustomerRoutes(
  ref: ResolvedOperationRef,
  routes: FrozenCustomerRoutes | undefined,
): ExecutionError | null {
  return operationCustomerRoutesAvailable(ref, routes) ? null : unavailableCustomerRouteError();
}

function operationCustomerRoutesAvailable(
  ref: ResolvedOperationRef,
  routes: FrozenCustomerRoutes | undefined,
): boolean {
  try {
    const keys = new Set(ref.customerEndpointDependencies ?? []);
    for (const key of ref.customerActionEndpointDependencies ?? []) keys.add(key);
    if (ref.customerEndpoint !== undefined) keys.add(ref.customerEndpoint);
    for (const key of keys) {
      if (routes?.endpoints[key]?.available !== true) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the private, URL-blind bindings for every customer route reachable through the prepared
 * action, including connector-declared nested calls. An empty list means the action is static.
 */
export function resolveCustomerActionRouteBindings(
  routes: FrozenCustomerRoutes | undefined,
  ref: ResolvedOperationRef,
  signatureType?: 'read' | 'action',
): readonly CustomerRouteBinding[] | null {
  const bindings: CustomerRouteBinding[] = [];
  const keys = new Set(ref.customerActionEndpointDependencies ?? []);
  // A live action signature is the runtime authority. Conservatively bind every ordinary route when
  // handling a legacy or malformed artifact that omitted the additive action-dependency metadata.
  if (signatureType === 'action') {
    for (const key of ref.customerEndpointDependencies ?? []) keys.add(key);
    if (ref.customerEndpoint !== undefined) keys.add(ref.customerEndpoint);
  }
  for (const key of [...keys].sort()) {
    const binding = resolveCustomerRouteBinding(routes, {
      connectorId: ref.connectorId,
      connectorVersion: ref.connectorVersion,
      key,
    });
    if (binding === null) return null;
    bindings.push(binding);
  }
  return Object.freeze(bindings);
}

function unavailableCustomerRouteError(): ExecutionError {
  return {
    code: 'connector_route_unavailable',
    message: 'Customer connector route is unavailable.',
  };
}

/** Resolve only the URL-blind route cache/probe binding for one connector and endpoint. */
export function resolveCustomerRouteBinding(
  routes: FrozenCustomerRoutes | undefined,
  requirement: CustomerRouteRequirement,
): CustomerRouteBinding | null {
  const route = routes?.endpoints[requirement.key];
  if (route?.available !== true) return null;
  return Object.freeze({
    key: requirement.key,
    fingerprint: routeFingerprint(requirement, requirement.key, route.baseUrl, route.policy),
  });
}

function frozenPolicy(policy: CustomerEndpointPolicy): CustomerEndpointPolicy {
  if ('allowedHttpsOrigins' in policy) {
    return Object.freeze({
      allowedHttpsOrigins: Object.freeze([...policy.allowedHttpsOrigins]),
    });
  }
  return Object.freeze({
    allowedHttpsHostSuffixes: Object.freeze([...policy.allowedHttpsHostSuffixes]),
  });
}

function routeFingerprint(
  ref: Pick<ResolvedOperationRef, 'connectorId' | 'connectorVersion'>,
  key: string,
  baseUrl: string,
  policy: CustomerEndpointPolicy,
): string {
  const policyKind =
    'allowedHttpsOrigins' in policy ? 'allowedHttpsOrigins' : 'allowedHttpsHostSuffixes';
  const values =
    'allowedHttpsOrigins' in policy ? policy.allowedHttpsOrigins : policy.allowedHttpsHostSuffixes;
  const payload = [
    'customer-route',
    1,
    ref.connectorId,
    ref.connectorVersion,
    key,
    baseUrl,
    policyKind,
    [...values].sort(),
  ];
  return `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}
