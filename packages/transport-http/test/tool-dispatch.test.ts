import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OperationSignature, RuntimeArtifact } from '@noodle-borg/compiler';
import type { ServedArtifact } from '@noodle-borg/protocol';
import {
  InMemoryConnector,
  InMemoryConnectorRegistry,
  StaticServiceBroker,
} from '@noodle-borg/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpRouter } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const artifactPath = join(
  here,
  '..',
  '..',
  'compiler',
  'fixtures',
  'valid',
  'minimal.resolved.artifact.json',
);
const signature: OperationSignature = {
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
const headers = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-11-25',
  'mcp-session-id': 'client-session-1',
  'user-agent': 'cross-client-test/1.0',
};

function target(): ServedArtifact {
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as RuntimeArtifact;
  return {
    artifact,
    deps: {
      connectors: new InMemoryConnectorRegistry([
        new InMemoryConnector('acme_orders', '1.2.0', {
          get_order: {
            signature,
            handler: (args) => ({ order: { id: args.id } }),
          },
        }),
      ]),
      broker: new StaticServiceBroker({ token: 'service-token' }),
    },
  };
}

let server: Server | undefined;

afterEach(async () => {
  if (server === undefined) return;
  await new Promise<void>((resolve, reject) =>
    server?.close((error) => (error ? reject(error) : resolve())),
  );
  server = undefined;
});

describe('hosted tool dispatch context', () => {
  it('threads validated MCP and hosted tenant facts only at connector dispatch', async () => {
    const beforeToolDispatch = vi.fn(async () => ({ allow: true as const }));
    server = createServer(
      createMcpRouter(() => Promise.resolve(undefined), {
        tenantLookup: async () => ({
          served: target(),
          deploymentId: 'orders-deployment-1',
          org: 'acme',
          app: 'orders',
          environment: 'staging',
        }),
        beforeToolDispatch,
      }),
    );
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/o/acme/orders/staging/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'request-7',
        method: 'tools/call',
        params: {
          name: 'get_order',
          arguments: { order_id: 'A1' },
          _meta: { 'openai/session': 'conversation-1' },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { isError: false } });
    expect(beforeToolDispatch).toHaveBeenCalledOnce();
    expect(beforeToolDispatch).toHaveBeenCalledWith({
      org: 'acme',
      app: 'orders',
      environment: 'staging',
      deploymentId: 'orders-deployment-1',
      toolName: 'get_order',
      toolArguments: { order_id: 'A1' },
      requestId: 'request-7',
      signal: expect.any(AbortSignal),
      requestMeta: { 'openai/session': 'conversation-1' },
      client: {
        protocolVersion: '2025-11-25',
        sessionId: 'client-session-1',
        userAgent: 'cross-client-test/1.0',
      },
    });
  });
});
