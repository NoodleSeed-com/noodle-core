import type {
  OperationSignature,
  ResolvedOperationRef,
  RuntimeArtifact,
} from '@noodle-borg/compiler';
import { vi } from 'vitest';
import type { CredentialBroker, CredentialRequest } from '../src/broker/types.js';
import type { Connector, ConnectorCall } from '../src/connector/types.js';
import { freezeCustomerRoutes } from '../src/customer-routing.js';
import type { PolicyContext, PolicyGate } from '../src/policy/types.js';
import { artifact, SERVICE_CREDENTIAL } from './execute-fixtures.js';

const EMPTY_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;
export const SIGNATURE: OperationSignature = {
  type: 'read',
  input: EMPTY_SCHEMA,
  output: EMPTY_SCHEMA,
};

export const ROUTE_URL = 'https://tenant.api.noodleseed.dev/v1';

export function routedArtifact(): RuntimeArtifact {
  return artifact('customer-routing.artifact.json');
}

export function operationRef(value = routedArtifact()): ResolvedOperationRef {
  const fulfilment = value.tools[0]?.fulfilment;
  if (fulfilment?.kind !== 'operation' || fulfilment.operationRef.resolved !== true) {
    throw new Error('expected routed operation fixture');
  }
  return fulfilment.operationRef;
}

export function harness(
  options: {
    raw?: Readonly<Record<string, string>>;
    customerRoutes?: ReturnType<typeof freezeCustomerRoutes>;
    caller?: { readonly subject: string };
  } = {},
) {
  const served = routedArtifact();
  const calls: ConnectorCall[] = [];
  const requests: CredentialRequest[] = [];
  const contexts: PolicyContext[] = [];
  const connector: Connector = {
    id: 'customer_records',
    version: '1.0.0',
    signature: () => SIGNATURE,
    invoke(call) {
      calls.push(call);
      return {};
    },
  };
  const broker: CredentialBroker = {
    async getCredential(request) {
      requests.push(request);
      return SERVICE_CREDENTIAL;
    },
  };
  const policy: PolicyGate = {
    before: vi.fn(async (context) => {
      contexts.push(context);
      return { allow: true };
    }),
    after: vi.fn(async (_context, output) => output),
  };
  const routes =
    options.customerRoutes ??
    freezeCustomerRoutes(served.customerEndpoints, options.raw ?? { customer_api: ROUTE_URL });
  return {
    artifact: served,
    calls,
    requests,
    contexts,
    connector,
    broker,
    policy,
    routes,
    deps: {
      connectors: { resolve: () => connector },
      broker,
      policy,
      customerRoutes: routes,
      ...(options.caller === undefined ? {} : { caller: options.caller }),
    },
  };
}
