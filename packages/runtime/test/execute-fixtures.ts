import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OperationSignature, RuntimeArtifact } from '@noodle-borg/compiler';
import { StaticServiceBroker } from '../src/broker/static.js';
import type { DownstreamCredential } from '../src/broker/types.js';
import { InMemoryConnector, InMemoryConnectorRegistry } from '../src/connector/in-memory.js';
import type { Connector, ConnectorCall } from '../src/connector/types.js';
import type { ExecuteDeps } from '../src/execute.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', '..', 'compiler', 'fixtures', 'valid');

export function artifact(file: string): RuntimeArtifact {
  return JSON.parse(readFileSync(join(fixtures, file), 'utf8')) as RuntimeArtifact;
}

export const resolved = (): RuntimeArtifact => artifact('minimal.resolved.artifact.json');

/** Reproduces the `acme_orders.get_order` signature so its hash matches the resolved fixture. */
export const getOrderSignature: OperationSignature = {
  type: 'read',
  input: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: { order: { type: 'object' } },
    additionalProperties: false,
  },
};

export const SERVICE_CREDENTIAL: DownstreamCredential = {
  token: 'svc-token-xyz',
  scope: 'orders:read',
};

/** Build an in-memory `acme_orders` connector whose `get_order` records what it received. */
export function ordersConnector(handler?: (call: ConnectorCall) => unknown): {
  connector: InMemoryConnector;
  calls: ConnectorCall[];
} {
  const calls: ConnectorCall[] = [];
  const connector = new InMemoryConnector('acme_orders', '1.2.0', {
    get_order: {
      signature: getOrderSignature,
      handler: (args, credential) => {
        const call: ConnectorCall = { operation: 'get_order', args, credential };
        calls.push(call);
        return handler ? handler(call) : { order: { id: args.id, status: 'open' } };
      },
    },
  });
  return { connector, calls };
}

export function deps(connector: Connector, overrides: Partial<ExecuteDeps> = {}): ExecuteDeps {
  return {
    connectors: new InMemoryConnectorRegistry([connector]),
    broker: new StaticServiceBroker(SERVICE_CREDENTIAL),
    ...overrides,
  };
}

export function recordingConnector(handler?: (call: ConnectorCall) => unknown): {
  connector: Connector;
  calls: ConnectorCall[];
} {
  const calls: ConnectorCall[] = [];
  const connector: Connector = {
    id: 'acme_orders',
    version: '1.2.0',
    signature: () => getOrderSignature,
    async invoke(call) {
      calls.push(call);
      return handler ? handler(call) : { order: { id: call.args.id, status: 'open' } };
    },
  };
  return { connector, calls };
}
