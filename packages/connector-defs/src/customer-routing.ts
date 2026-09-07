import type { CatalogCustomerRouting, CustomerEndpointPolicy } from '@noodle-borg/compiler';
import type { ConnectorCompileError } from './compile-expr.js';
import { connectorIdentityKey, operationIdentityKey } from './identity-key.js';
import type { ConnectorDef } from './schema.js';

interface OperationDependencies {
  readonly endpoints: ReadonlySet<string>;
  readonly actionEndpoints: ReadonlySet<string>;
}

function operationKey(def: ConnectorDef, operation: string): string {
  return operationIdentityKey(def.id, def.version, operation);
}

function parseCallTarget(target: string): { connectorId: string; operation: string } | undefined {
  const [connectorId, operation, extra] = target.split('.');
  if (connectorId === undefined || operation === undefined || extra !== undefined) return undefined;
  return { connectorId, operation };
}

function sorted(values: ReadonlySet<string>): readonly string[] {
  return [...values].sort();
}

function samePolicy(left: CustomerEndpointPolicy, right: CustomerEndpointPolicy): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Precompute direct and transitive customer-endpoint dependencies after call-graph validation.
 * Runtime consumers receive this data from the catalog/artifact and never rediscover connector edges.
 */
export function collectCatalogCustomerRouting(
  definitions: readonly ConnectorDef[],
  errors: ConnectorCompileError[],
): ReadonlyMap<string, CatalogCustomerRouting> {
  const byId = new Map<string, ConnectorDef | 'ambiguous'>();
  const policies = new Map<string, CustomerEndpointPolicy>();

  for (const def of definitions) {
    byId.set(def.id, byId.has(def.id) ? 'ambiguous' : def);
    if (!('http' in def) || typeof def.http.baseUrl === 'string') continue;
    const { name, policy } = def.http.baseUrl;
    const existing = policies.get(name);
    if (existing !== undefined && !samePolicy(existing, policy)) {
      errors.push({
        code: 'customer_endpoint_policy_conflict',
        path: `connectors.${def.id}.http.baseUrl.policy`,
        message: `customer endpoint "${name}" has conflicting policies`,
      });
      continue;
    }
    policies.set(name, policy);
  }

  const memo = new Map<string, OperationDependencies>();
  const visiting = new Set<string>();

  const dependenciesFor = (def: ConnectorDef, operationName: string): OperationDependencies => {
    const key = operationKey(def, operationName);
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    if (visiting.has(key)) return { endpoints: new Set(), actionEndpoints: new Set() };
    visiting.add(key);

    const operation = def.operations[operationName];
    const endpoints = new Set<string>();
    const actionEndpoints = new Set<string>();
    if ('http' in def) {
      if (typeof def.http.baseUrl !== 'string') {
        endpoints.add(def.http.baseUrl.name);
        if (operation?.type === 'action') actionEndpoints.add(def.http.baseUrl.name);
      }
    } else if (!('mcp' in def)) {
      const computeOperation = def.operations[operationName];
      if (computeOperation?.calls === undefined) {
        visiting.delete(key);
        const result = { endpoints, actionEndpoints };
        memo.set(key, result);
        return result;
      }
      for (const target of Object.values(computeOperation.calls)) {
        const parsed = parseCallTarget(target);
        if (parsed === undefined) continue;
        const targetDef = byId.get(parsed.connectorId);
        if (targetDef === undefined || targetDef === 'ambiguous') continue;
        if (targetDef.operations[parsed.operation] === undefined) continue;
        const dependency = dependenciesFor(targetDef, parsed.operation);
        for (const endpoint of dependency.endpoints) endpoints.add(endpoint);
        for (const endpoint of dependency.actionEndpoints) actionEndpoints.add(endpoint);
      }
      if (computeOperation.type === 'action') {
        actionEndpoints.clear();
        for (const endpoint of endpoints) actionEndpoints.add(endpoint);
      }
    }

    visiting.delete(key);
    const result = { endpoints, actionEndpoints };
    memo.set(key, result);
    return result;
  };

  const routingByConnector = new Map<string, CatalogCustomerRouting>();
  for (const def of definitions) {
    const operationEndpoints: Record<string, readonly string[]> = Object.create(null);
    const operationActionEndpoints: Record<string, readonly string[]> = Object.create(null);
    const connectorEndpoints = new Set<string>();
    for (const operationName of Object.keys(def.operations)) {
      const dependency = dependenciesFor(def, operationName);
      operationEndpoints[operationName] = sorted(dependency.endpoints);
      operationActionEndpoints[operationName] = sorted(dependency.actionEndpoints);
      for (const endpoint of dependency.endpoints) connectorEndpoints.add(endpoint);
    }
    if (connectorEndpoints.size === 0) continue;

    const endpoints: Record<string, CustomerEndpointPolicy> = Object.create(null);
    for (const endpoint of sorted(connectorEndpoints)) {
      const policy = policies.get(endpoint);
      if (policy !== undefined) endpoints[endpoint] = policy;
    }
    const directEndpoint =
      'http' in def && typeof def.http.baseUrl !== 'string' ? def.http.baseUrl.name : undefined;
    routingByConnector.set(connectorIdentityKey(def.id, def.version), {
      ...(directEndpoint === undefined ? {} : { directEndpoint }),
      endpoints,
      operationEndpoints,
      operationActionEndpoints,
    });
  }

  return routingByConnector;
}
