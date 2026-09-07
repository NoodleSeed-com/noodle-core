import { createMcpHandler, type McpHttpHandler, McpServer } from '@modelcontextprotocol/server';
import {
  compileManifest,
  InMemoryCatalog,
  type Manifest,
  type OperationSignature,
  type RuntimeArtifact,
} from '@noodle-borg/compiler';
import {
  type ConnectorTraceEvent,
  type CredentialBroker,
  executeTool,
  InMemoryConnectorRegistry,
  type PolicyGate,
} from '@noodle-borg/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { McpConnector } from '../src/index.js';

const endpoint = 'http://127.0.0.1/mcp';
const signature: OperationSignature = {
  type: 'read',
  input: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false,
  },
};
const catalog = new InMemoryCatalog([
  {
    id: 'store_mcp',
    version: '1.0.0',
    kind: 'catalog',
    operations: { answer: signature },
  },
]);
const handlers: McpHttpHandler[] = [];

afterEach(async () => {
  await Promise.allSettled(handlers.splice(0).map((handler) => handler.close()));
});

function artifact(): RuntimeArtifact {
  const result = compileManifest(
    {
      manifestVersion: '1',
      server: { name: 'governed_mcp', title: 'Governed MCP', version: '1.0.0' },
      connectors: { store: { id: 'store_mcp', version: '1.0.0' } },
      tools: [
        {
          name: 'ask_store',
          description: 'Ask a store policy question.',
          inputSchema: signature.input,
          fulfilment: { use: 'store.answer', args: { query: '${input.query}' } },
        },
      ],
    } as Manifest,
    { catalog },
  );
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.artifact;
}

function successfulFetch(
  events: string[],
  observed: { authorization?: string },
): (url: string | URL, init?: RequestInit) => Promise<Response> {
  const handler = createMcpHandler(() => {
    const server = new McpServer(
      { name: 'governance-fixture', version: '1.0.0' },
      { supportedProtocolVersions: ['2026-07-28', '2025-11-25'] },
    );
    server.registerTool(
      'policy_answer',
      {
        description: 'Answer a policy question.',
        inputSchema: z.object({ query: z.string() }),
        outputSchema: z.object({ answer: z.string() }),
      },
      async ({ query }) => {
        events.push('upstream');
        return {
          structuredContent: { answer: `answer:${query}` },
          content: [],
        };
      },
    );
    return server;
  });
  handlers.push(handler);
  return async (url, init) => {
    observed.authorization = new Headers(init?.headers).get('authorization') ?? undefined;
    return handler.fetch(new Request(url, init));
  };
}

function connector(fetch: (url: string | URL, init?: RequestInit) => Promise<Response>) {
  return new McpConnector(
    {
      id: 'store_mcp',
      version: '1.0.0',
      endpoint,
      allowedOrigins: ['http://127.0.0.1'],
      auth: { kind: 'bearer' },
      operations: {
        answer: {
          upstreamTool: 'policy_answer',
          signature,
          upstreamOutputSchema: signature.output,
        },
      },
    },
    { fetch },
  );
}

describe('MCP connector runtime governance', () => {
  it('runs policy, broker credentialing, usage admission, MCP, and output policy in order', async () => {
    const events: string[] = [];
    const observed: { authorization?: string } = {};
    const policy: PolicyGate = {
      before: async () => {
        events.push('policy-before');
        return { allow: true };
      },
      after: async (_context, output) => {
        events.push('policy-after');
        return output;
      },
    };
    const broker: CredentialBroker = {
      getCredential: async () => {
        events.push('broker');
        return { token: 'broker-minted-store-token' };
      },
    };

    const result = await executeTool(
      artifact(),
      'ask_store',
      { query: 'returns' },
      {
        connectors: new InMemoryConnectorRegistry([connector(successfulFetch(events, observed))]),
        broker,
        policy,
        tenantId: 'tenant-a',
        deploymentId: 'deployment-a',
        beforeDispatch: async () => {
          events.push('admission');
          return { allow: true };
        },
      },
    );

    expect(result).toEqual({ ok: true, output: { answer: 'answer:returns' } });
    expect(events).toEqual(['policy-before', 'broker', 'admission', 'upstream', 'policy-after']);
    expect(observed.authorization).toBe('Bearer broker-minted-store-token');
  });

  it('performs no credential lookup or upstream effect when policy denies the tool', async () => {
    const upstream = vi.fn(async () => new Response(null, { status: 500 }));
    const broker = vi.fn(async () => ({ token: 'must-not-be-read' }));
    const result = await executeTool(
      artifact(),
      'ask_store',
      { query: 'returns' },
      {
        connectors: new InMemoryConnectorRegistry([connector(upstream)]),
        broker: { getCredential: broker },
        policy: {
          before: async () => ({ allow: false, reason: 'tenant policy denied' }),
          after: async (_context, output) => output,
        },
      },
    );

    expect(result).toEqual({
      ok: false,
      error: { code: 'policy_denied', message: 'tenant policy denied' },
    });
    expect(broker).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });

  it('returns a sanitized connector error while recording the stable upstream category', async () => {
    const trace: ConnectorTraceEvent[] = [];
    const result = await executeTool(
      artifact(),
      'ask_store',
      { query: 'returns' },
      {
        connectors: new InMemoryConnectorRegistry([
          connector(
            async () =>
              new Response('sensitive upstream body', {
                status: 503,
                headers: { 'content-type': 'text/plain' },
              }),
          ),
        ]),
        broker: { getCredential: async () => ({ token: 'secret-token' }) },
        trace: { record: (event) => trace.push(event) },
      },
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'connector_error',
        message: 'connector failed for operation "answer"',
        reason: 'upstream_5xx',
        connector: {
          connectorId: 'store_mcp',
          connectorVersion: '1.0.0',
          operation: 'answer',
          category: 'upstream_5xx',
          statusClass: '5xx',
          retryable: false,
        },
      },
    });
    expect(trace).toEqual([
      {
        kind: 'connector',
        connectorId: 'store_mcp',
        connectorVersion: '1.0.0',
        operation: 'answer',
        status: 503,
        category: 'upstream_5xx',
        retryable: false,
      },
    ]);
    expect(JSON.stringify({ result, trace })).not.toMatch(/sensitive|secret-token/);
  });
});
