import type { CatalogConnector } from './catalog/types.js';
import type { CustomerEndpointPolicy } from './customer-endpoint.js';
import type { CompileError } from './errors.js';
import type { DeclaredConnectorRef } from './fulfilment-emit.js';
import type { Manifest } from './manifest/schema.js';

export type CustomerRoutingSurface = 'tool' | 'resource' | 'prompt' | 'ambient';

type Auth = NonNullable<Manifest['server']['auth']>;

export interface CustomerOperationRouting {
  readonly directEndpoint?: string;
  readonly dependencies: readonly string[];
  readonly actionDependencies: readonly string[];
}

/**
 * Collects the customer endpoints reachable from manifest fulfilments and validates that auth has
 * an exact, issuer-local claim projection for each one. The collector is compile-request-local:
 * neither a claim value nor a resolved URL can enter the artifact.
 */
export class CustomerRoutingCollector {
  readonly #auth: Auth | undefined;
  readonly #errors: CompileError[];
  readonly #endpoints = new Map<string, CustomerEndpointPolicy>();

  constructor(auth: Auth | undefined, errors: CompileError[]) {
    this.#auth = auth;
    this.#errors = errors;
  }

  recordOperation(
    connectorAlias: string,
    connectorRef: DeclaredConnectorRef,
    connector: CatalogConnector,
    operation: string,
    usePath: string,
    surface: CustomerRoutingSurface,
    confirmationRequired: boolean,
  ): CustomerOperationRouting | undefined {
    const routing = connector.customerRouting;
    if (routing === undefined) return undefined;

    const endpoints = routing.operationEndpoints[operation] ?? [];
    const dependencies = [...new Set(endpoints)].sort();
    const declaredActionDependencies = [
      ...new Set(routing.operationActionEndpoints[operation] ?? []),
    ].sort();
    const dependencySet = new Set(dependencies);
    const operationType = connector.operations[operation]?.type;
    const inconsistentActionRouting =
      declaredActionDependencies.some((key) => !dependencySet.has(key)) ||
      (operationType === 'action' &&
        (declaredActionDependencies.length !== dependencies.length ||
          dependencies.some((key) => !declaredActionDependencies.includes(key))));
    if (inconsistentActionRouting) {
      this.#errors.push({
        code: 'customer_endpoint_routing_inconsistent',
        path: usePath,
        message:
          'connector catalog action-route metadata is inconsistent with its operation signature and endpoint dependencies',
      });
    }
    if (endpoints.length === 0) return undefined;

    for (const key of endpoints) {
      if (!Object.hasOwn(routing.endpoints, key)) continue;
      const policy = routing.endpoints[key];
      if (policy === undefined) continue;
      const existing = this.#endpoints.get(key);
      if (existing !== undefined && !samePolicy(existing, policy)) {
        this.#errors.push({
          code: 'customer_endpoint_policy_conflict',
          path: usePath,
          message: `customer endpoint "${key}" has conflicting policies across reachable connector operations`,
        });
        continue;
      }
      this.#endpoints.set(key, policy);
    }

    // Treat an action signature as authoritative even when a stale/malformed catalog omitted the
    // redundant action map. Compilation still fails above, while this conservative projection keeps
    // any diagnostic artifact path from weakening confirmation or route binding.
    const actionDependencies =
      operationType === 'action' ? dependencies : declaredActionDependencies;
    if (actionDependencies.length > 0 && !confirmationRequired) {
      this.#errors.push({
        code: 'customer_endpoint_action_unsupported',
        path: usePath,
        message:
          'customer-routed action operations require a tool with annotations.confirm set to true',
      });
    }

    if (surface !== 'tool') {
      this.#errors.push({
        code: 'customer_endpoint_surface_unsupported',
        path: usePath,
        message: `customer-routed ${surface} fulfilment is not supported in this release`,
      });
    }

    if (connectorRef.binding !== undefined) {
      this.#errors.push({
        code: 'customer_endpoint_credential_source_unsupported',
        path: `connectors.${connectorAlias}.binding.connection.source`,
        message:
          'customer-routed connectors use connector-declared delegated token exchange or no auth; manifest connection sources are unsupported',
      });
    }

    const directEndpoint = routing.directEndpoint;
    return {
      dependencies,
      actionDependencies,
      ...(directEndpoint !== undefined && endpoints.includes(directEndpoint)
        ? { directEndpoint }
        : {}),
    };
  }

  finalize(): Readonly<Record<string, CustomerEndpointPolicy>> | undefined {
    const expected = [...this.#endpoints.keys()].sort();
    const auth = this.#auth;

    if (auth === undefined) {
      if (expected.length > 0) {
        this.#errors.push({
          code: 'customer_endpoint_auth_required',
          path: 'server.auth',
          message: 'customer endpoint routing requires direct or federated OIDC authentication',
        });
      }
      return endpointTable(this.#endpoints);
    }

    if (auth.kind === 'bridge') {
      if (expected.length > 0) {
        this.#errors.push({
          code: 'customer_endpoint_bridge_unsupported',
          path: 'server.auth',
          message: 'managed auth bridges cannot project customer endpoint routing claims',
        });
      }
      return endpointTable(this.#endpoints);
    }

    if (auth.kind === 'federatedOidc') {
      auth.issuers.forEach((issuer, index) => {
        validateMapping(
          expected,
          issuer.routing?.endpoints,
          `server.auth.issuers.${index}.routing.endpoints`,
          this.#errors,
        );
      });
      return endpointTable(this.#endpoints);
    }

    const routing = 'routing' in auth ? auth.routing : undefined;
    validateMapping(expected, routing?.endpoints, 'server.auth.routing.endpoints', this.#errors);
    return endpointTable(this.#endpoints);
  }
}

function validateMapping(
  expected: readonly string[],
  mappings: Readonly<Record<string, { readonly claim: string }>> | undefined,
  path: string,
  errors: CompileError[],
): void {
  const actual = Object.keys(mappings ?? {}).sort();
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);

  for (const key of expected) {
    if (actualSet.has(key)) continue;
    errors.push({
      code: 'customer_endpoint_mapping_required',
      path: `${path}.${key}`,
      message: `authentication must map customer endpoint "${key}" to an exact claim path`,
      expected: key,
    });
  }

  for (const key of actual) {
    if (expectedSet.has(key)) continue;
    errors.push({
      code: 'customer_endpoint_unknown_mapping',
      path: `${path}.${key}`,
      message: `authentication maps unknown or unused customer endpoint "${key}"`,
      got: key,
    });
  }
}

function endpointTable(
  endpoints: ReadonlyMap<string, CustomerEndpointPolicy>,
): Readonly<Record<string, CustomerEndpointPolicy>> | undefined {
  if (endpoints.size === 0) return undefined;
  const table: Record<string, CustomerEndpointPolicy> = Object.create(null);
  for (const [key, policy] of [...endpoints.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    table[key] = policy;
  }
  return table;
}

function samePolicy(left: CustomerEndpointPolicy, right: CustomerEndpointPolicy): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
