import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { OperationSignature, RuntimeArtifact } from '@noodle-borg/compiler';
import {
  ConnectorInvocationError,
  type ExecuteDeps,
  InMemoryConnector,
  InMemoryConnectorRegistry,
  StaticServiceBroker,
} from '@noodle-borg/runtime';
import { buildMcpServer, type ProtocolRequestContext, type ServedArtifact } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', '..', 'compiler', 'fixtures', 'valid');

/** The committed resolved artifact: one tool `get_order` over `acme_orders@1.2.0`. */
export function resolvedArtifact(): RuntimeArtifact {
  return JSON.parse(
    readFileSync(join(fixtures, 'minimal.resolved.artifact.json'), 'utf8'),
  ) as RuntimeArtifact;
}

/** Mirrors the catalog signature so the connector's hash matches the resolved artifact. */
const getOrderSig: OperationSignature = {
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

/** Build execution deps with an in-memory `acme_orders` connector (optionally a failing one). */
export function buildDeps(
  options: { failing?: boolean; failingCategory?: 'timeout' | 'upstream_5xx' } = {},
): ExecuteDeps {
  const connector = new InMemoryConnector('acme_orders', '1.2.0', {
    get_order: {
      signature: getOrderSig,
      handler:
        options.failingCategory !== undefined
          ? () => {
              throw new ConnectorInvocationError('upstream rejected the call', {
                category: options.failingCategory,
                ...(options.failingCategory === 'upstream_5xx'
                  ? { status: 503, attempts: 2, retryable: true }
                  : {}),
              });
            }
          : options.failing
            ? () => {
                throw new Error('internal connector failure');
              }
            : (args) => ({ order: { id: args.id, status: 'open' } }),
    },
  });
  return {
    connectors: new InMemoryConnectorRegistry([connector]),
    broker: new StaticServiceBroker({ token: 'svc-token' }),
  };
}

/** The resolved artifact + execution deps the wire routes to. */
export function servedArtifact(
  options: { failing?: boolean; failingCategory?: 'timeout' | 'upstream_5xx' } = {},
): ServedArtifact {
  return { artifact: resolvedArtifact(), deps: buildDeps(options) };
}

/**
 * Connect an SDK {@link Client} to the artifact-bound {@link buildMcpServer} over an in-memory transport
 * pair. `connect` performs the initialize handshake, so the returned client is ready to issue requests.
 */
export async function connectClient(options: { failing?: boolean } = {}): Promise<Client> {
  return connectClientTo(servedArtifact(options));
}

/**
 * Connect an SDK {@link Client} to an arbitrary {@link ServedArtifact} over an in-memory transport.
 * The general harness auto-approves confirmation-only form requests; interaction tests install their
 * own handlers so they can prove decline, cancel, missing-input, and capability behavior explicitly.
 */
export async function connectClientTo(
  served: ServedArtifact,
  context: ProtocolRequestContext = {},
): Promise<Client> {
  const server = buildMcpServer(served, context);
  const client = new Client(
    { name: 'test', version: '1.0.0' },
    { capabilities: { elicitation: { form: {} } } },
  );
  client.setRequestHandler(ElicitRequestSchema, (request) => {
    const confirm =
      request.params.mode !== 'url' && request.params.requestedSchema.properties.confirm;
    if (confirm?.type !== 'boolean') throw new Error('unexpected elicitation in protocol harness');
    return { action: 'accept', content: { confirm: true } };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport as Transport),
    client.connect(clientTransport as Transport),
  ]);
  return client;
}
