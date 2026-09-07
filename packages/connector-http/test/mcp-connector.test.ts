import {
  createMcpHandler,
  inputRequired,
  type McpHttpHandler,
  McpServer,
  type PerRequestResponseMode,
} from '@modelcontextprotocol/server';
import type { OperationSignature } from '@noodle-borg/compiler';
import { ConnectorInvocationError } from '@noodle-borg/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  McpConnector,
  type McpConnectorConfig,
  type McpConnectorDependencies,
} from '../src/index.js';

const endpoint = 'http://127.0.0.1/mcp';
const credential = { token: 'upstream-service-secret' } as const;

const echoSignature: OperationSignature = {
  type: 'read',
  input: {
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: { echoed: { type: 'string' } },
    required: ['echoed'],
    additionalProperties: false,
  },
};

const textSignature: OperationSignature = {
  type: 'read',
  input: { type: 'object', properties: {}, additionalProperties: false },
  output: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
};

const handlers: McpHttpHandler[] = [];

afterEach(async () => {
  await Promise.allSettled(handlers.splice(0).map((handler) => handler.close()));
});

function serverFetch(
  register: (server: McpServer) => void,
  observed: { methods: string[]; authorization?: string; apiKey?: string },
  responseMode?: PerRequestResponseMode,
): McpConnectorDependencies['fetch'] {
  const handler = createMcpHandler(
    () => {
      const server = new McpServer(
        { name: 'connector-fixture', version: '1.0.0' },
        { supportedProtocolVersions: ['2026-07-28', '2025-11-25'] },
      );
      register(server);
      return server;
    },
    responseMode === undefined ? {} : { responseMode },
  );
  handlers.push(handler);

  return async (url, init) => {
    observed.authorization = new Headers(init?.headers).get('authorization') ?? undefined;
    observed.apiKey = new Headers(init?.headers).get('x-store-key') ?? undefined;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    if (body && typeof body === 'object' && !Array.isArray(body) && 'method' in body) {
      observed.methods.push(String(body.method));
    }
    return handler.fetch(new Request(url, init));
  };
}

function connector(
  register: (server: McpServer) => void,
  extra: Partial<McpConnectorConfig> = {},
): {
  connector: McpConnector;
  observed: { methods: string[]; authorization?: string; apiKey?: string };
} {
  const observed: { methods: string[]; authorization?: string; apiKey?: string } = { methods: [] };
  const config: McpConnectorConfig = {
    id: 'upstream',
    version: '1.0.0',
    endpoint,
    allowedOrigins: ['http://127.0.0.1'],
    auth: { kind: 'bearer' },
    operations: {
      echo: {
        upstreamTool: 'echo',
        signature: echoSignature,
        upstreamOutputSchema: echoSignature.output,
      },
    },
    ...extra,
  };
  return {
    connector: new McpConnector(config, { fetch: serverFetch(register, observed) }),
    observed,
  };
}

function registerEcho(server: McpServer): void {
  server.registerTool(
    'echo',
    {
      description: 'Echo one message.',
      inputSchema: z.object({ message: z.string() }),
      outputSchema: z.object({ echoed: z.string() }),
    },
    async ({ message }) => ({
      structuredContent: { echoed: message },
      content: [{ type: 'text', text: JSON.stringify({ echoed: message }) }],
    }),
  );
}

describe('McpConnector', () => {
  it('calls only the frozen upstream tool and returns structured content', async () => {
    const fixture = connector(registerEcho);

    await expect(
      fixture.connector.invoke({
        operation: 'echo',
        args: { message: 'hello' },
        credential,
      }),
    ).resolves.toEqual({ echoed: 'hello' });

    expect(fixture.observed.methods).toContain('tools/call');
    expect(fixture.observed.methods).not.toContain('tools/list');
    expect(fixture.observed.authorization).toBe('Bearer upstream-service-secret');
  });

  it('uses a bounded text fallback when structured content is absent', async () => {
    const fixture = connector(
      (server) => {
        server.registerTool(
          'plain',
          { description: 'Return text.', inputSchema: z.object({}) },
          async () => ({
            content: [
              { type: 'text', text: 'first' },
              { type: 'text', text: 'second' },
            ],
          }),
        );
      },
      {
        operations: { plain: { upstreamTool: 'plain', signature: textSignature } },
      },
    );

    await expect(
      fixture.connector.invoke({ operation: 'plain', args: {}, credential }),
    ).resolves.toEqual({ text: 'first\nsecond' });
  });

  it('presents a broker credential through the declared API-key header', async () => {
    const fixture = connector(registerEcho, {
      auth: { kind: 'apiKey', header: 'x-store-key' },
    });

    await expect(
      fixture.connector.invoke({
        operation: 'echo',
        args: { message: 'api-key' },
        credential,
      }),
    ).resolves.toEqual({ echoed: 'api-key' });
    expect(fixture.observed.apiKey).toBe(credential.token);
    expect(fixture.observed.authorization).toBeUndefined();
  });

  it('rejects upstream tool errors without exposing credential material', async () => {
    const fixture = connector((server) => {
      server.registerTool(
        'echo',
        {
          description: 'Fail safely.',
          inputSchema: z.object({ message: z.string() }),
          outputSchema: z.object({ echoed: z.string() }),
        },
        async () => ({
          isError: true,
          content: [{ type: 'text', text: 'Upstream refused the request.' }],
        }),
      );
    });

    const error = await fixture.connector
      .invoke({ operation: 'echo', args: { message: 'hello' }, credential })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ConnectorInvocationError);
    expect(error).toMatchObject({ category: 'upstream_4xx', retryable: false });
    expect(JSON.stringify(error)).not.toContain(credential.token);
  });

  it('rejects modern input-required interactions instead of acting as an agent', async () => {
    const fixture = connector((server) => {
      server.registerTool(
        'echo',
        {
          description: 'Request user input.',
          inputSchema: z.object({ message: z.string() }),
          outputSchema: z.object({ echoed: z.string() }),
        },
        async () =>
          inputRequired({
            inputRequests: {
              approval: inputRequired.elicit({
                message: 'Approve this operation?',
                requestedSchema: z.object({ approved: z.boolean() }),
              }),
            },
            requestState: 'opaque-state',
          }),
      );
    });

    await expect(
      fixture.connector.invoke({
        operation: 'echo',
        args: { message: 'hello' },
        credential,
      }),
    ).rejects.toMatchObject({ category: 'invalid_response', retryable: false });
  });

  it.each([
    'sampling',
    'roots',
  ] as const)('does not grant legacy %s capability to an upstream server', async (interaction) => {
    const fixture = connector(
      (server) => {
        server.registerTool(
          'echo',
          {
            description: 'Attempt a server-initiated interaction.',
            inputSchema: z.object({ message: z.string() }),
            outputSchema: z.object({ echoed: z.string() }),
          },
          async ({ message }) => {
            if (interaction === 'sampling') {
              await server.server.createMessage({
                messages: [{ role: 'user', content: { type: 'text', text: message } }],
                maxTokens: 1,
              });
            } else {
              await server.server.listRoots();
            }
            return { structuredContent: { echoed: message }, content: [] };
          },
        );
      },
      { protocol: 'legacy', timeoutMs: 50 },
    );

    const startedAt = performance.now();
    await expect(
      fixture.connector.invoke({
        operation: 'echo',
        args: { message: 'hello' },
        credential,
      }),
    ).rejects.toMatchObject({ category: 'timeout', retryable: false });
    expect(performance.now() - startedAt).toBeLessThan(300);
    expect(fixture.observed.methods).not.toContain('tools/list');
  });

  it('supports the pinned legacy era without runtime tool discovery', async () => {
    const fixture = connector(registerEcho, { protocol: 'legacy' });

    await expect(
      fixture.connector.invoke({
        operation: 'echo',
        args: { message: 'legacy' },
        credential,
      }),
    ).resolves.toEqual({ echoed: 'legacy' });
    expect(fixture.observed.methods).toContain('initialize');
    expect(fixture.observed.methods).toContain('tools/call');
    expect(fixture.observed.methods).not.toContain('tools/list');
    expect(fixture.observed.methods).not.toContain('server/discover');
  });

  it('consumes a bounded modern SSE exchange and closes normally', async () => {
    const observed: { methods: string[]; authorization?: string; apiKey?: string } = {
      methods: [],
    };
    const c = new McpConnector(
      {
        id: 'upstream',
        version: '1.0.0',
        endpoint,
        allowedOrigins: ['http://127.0.0.1'],
        protocol: 'modern',
        operations: {
          echo: {
            upstreamTool: 'echo',
            signature: echoSignature,
            upstreamOutputSchema: echoSignature.output,
          },
        },
      },
      { fetch: serverFetch(registerEcho, observed, 'sse') },
    );

    await expect(
      c.invoke({ operation: 'echo', args: { message: 'streamed' }, credential }),
    ).resolves.toEqual({ echoed: 'streamed' });
    expect(observed.methods).toContain('tools/call');
    expect(observed.methods).not.toContain('tools/list');
  });

  it('rejects redirects without following them or exposing a credential to the target', async () => {
    const requests: string[] = [];
    const c = new McpConnector(
      {
        id: 'upstream',
        version: '1.0.0',
        endpoint,
        allowedOrigins: ['http://127.0.0.1'],
        auth: { kind: 'bearer' },
        operations: {
          echo: {
            upstreamTool: 'echo',
            signature: echoSignature,
            upstreamOutputSchema: echoSignature.output,
          },
        },
      },
      {
        fetch: async (url) => {
          requests.push(String(url));
          return new Response(null, {
            status: 302,
            headers: { location: 'https://redirect-target.example/mcp' },
          });
        },
      },
    );

    await expect(
      c.invoke({ operation: 'echo', args: { message: 'hello' }, credential }),
    ).rejects.toMatchObject({ retryable: false });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toBe(endpoint);
  });

  it.each([
    { status: 401, category: 'upstream_4xx' },
    { status: 429, category: 'rate_limited' },
    { status: 503, category: 'upstream_5xx' },
  ] as const)('normalizes HTTP $status without exposing its body', async ({ status, category }) => {
    const c = new McpConnector(
      {
        id: 'upstream',
        version: '1.0.0',
        endpoint,
        allowedOrigins: ['http://127.0.0.1'],
        operations: {
          echo: {
            upstreamTool: 'echo',
            signature: echoSignature,
            upstreamOutputSchema: echoSignature.output,
          },
        },
      },
      {
        fetch: async () =>
          new Response('sensitive upstream failure body', {
            status,
            headers: {
              'content-type': 'text/plain',
              ...(status === 429 ? { 'retry-after': '7' } : {}),
            },
          }),
      },
    );

    const error = await c
      .invoke({ operation: 'echo', args: { message: 'hello' }, credential })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({
      status,
      category,
      retryable: false,
      ...(status === 429 ? { retryAfterMs: 7_000 } : {}),
    });
    expect(JSON.stringify(error)).not.toContain('sensitive upstream failure body');
  });

  it('uses the frozen upstream output schema to reject schema drift', async () => {
    const fixture = connector((server) => {
      server.registerTool(
        'echo',
        {
          description: 'Return a drifted result.',
          inputSchema: z.object({ message: z.string() }),
          outputSchema: z.object({ changed: z.string() }),
        },
        async ({ message }) => ({
          structuredContent: { changed: message },
          content: [{ type: 'text', text: JSON.stringify({ changed: message }) }],
        }),
      );
    });

    await expect(
      fixture.connector.invoke({
        operation: 'echo',
        args: { message: 'drift' },
        credential,
      }),
    ).rejects.toMatchObject({ category: 'invalid_response', retryable: false });
  });

  it('fails closed on an undeclared endpoint origin before sending credentials', async () => {
    let called = false;
    const c = new McpConnector(
      {
        id: 'upstream',
        version: '1.0.0',
        endpoint: 'https://evil.example/mcp',
        allowedOrigins: ['https://trusted.example'],
        auth: { kind: 'bearer' },
        operations: {
          echo: {
            upstreamTool: 'echo',
            signature: echoSignature,
            upstreamOutputSchema: echoSignature.output,
          },
        },
      },
      {
        fetch: async () => {
          called = true;
          return new Response(null, { status: 500 });
        },
      },
    );

    await expect(
      c.invoke({ operation: 'echo', args: { message: 'hello' }, credential }),
    ).rejects.toThrow(/disallowed origin/);
    expect(called).toBe(false);
  });

  it('enforces an inclusive decoded MCP response size limit', async () => {
    const c = new McpConnector(
      {
        id: 'upstream',
        version: '1.0.0',
        endpoint,
        allowedOrigins: ['http://127.0.0.1'],
        operations: {
          echo: {
            upstreamTool: 'echo',
            signature: echoSignature,
            upstreamOutputSchema: echoSignature.output,
          },
        },
        maxResponseBytes: 32,
      },
      {
        fetch: async () =>
          new Response('x'.repeat(33), {
            status: 200,
            headers: { 'content-type': 'application/json', 'content-length': '33' },
          }),
      },
    );

    await expect(
      c.invoke({ operation: 'echo', args: { message: 'hello' }, credential }),
    ).rejects.toMatchObject({ category: 'response_too_large', retryable: false });
  });

  it('enforces the decoded response limit when content-length is absent', async () => {
    const c = new McpConnector(
      {
        id: 'upstream',
        version: '1.0.0',
        endpoint,
        allowedOrigins: ['http://127.0.0.1'],
        operations: {
          echo: {
            upstreamTool: 'echo',
            signature: echoSignature,
            upstreamOutputSchema: echoSignature.output,
          },
        },
        maxResponseBytes: 32,
      },
      {
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('x'.repeat(33)));
                controller.close();
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      },
    );

    await expect(
      c.invoke({ operation: 'echo', args: { message: 'hello' }, credential }),
    ).rejects.toMatchObject({ category: 'response_too_large', retryable: false });
  });

  it('rejects private DNS answers through the socket-pinned egress guard', async () => {
    const c = new McpConnector(
      {
        id: 'upstream',
        version: '1.0.0',
        endpoint: 'https://mcp.example/mcp',
        allowedOrigins: ['https://mcp.example'],
        operations: {
          echo: {
            upstreamTool: 'echo',
            signature: echoSignature,
            upstreamOutputSchema: echoSignature.output,
          },
        },
      },
      {
        lookup: (_hostname, _options, callback) => {
          callback(null, [{ address: '169.254.169.254', family: 4 }]);
        },
      },
    );

    await expect(
      c.invoke({ operation: 'echo', args: { message: 'hello' }, credential }),
    ).rejects.toMatchObject({ category: 'network_error', retryable: false });
  });

  it('resolves a managed endpoint only inside its separately managed origin', async () => {
    const observed: { methods: string[]; authorization?: string; apiKey?: string } = {
      methods: [],
    };
    const c = new McpConnector(
      {
        id: 'upstream',
        version: '1.0.0',
        endpoint: '${env.SHOP_MCP_ENDPOINT}',
        allowedOrigins: ['${env.SHOP_MCP_ORIGIN}'],
        operations: {
          echo: {
            upstreamTool: 'echo',
            signature: echoSignature,
            upstreamOutputSchema: echoSignature.output,
          },
        },
      },
      { fetch: serverFetch(registerEcho, observed) },
    );

    await expect(
      c.invoke({
        operation: 'echo',
        args: { message: 'store-a' },
        credential,
        env: {
          SHOP_MCP_ENDPOINT: endpoint,
          SHOP_MCP_ORIGIN: 'http://127.0.0.1',
        },
      }),
    ).resolves.toEqual({ echoed: 'store-a' });
  });

  it('isolates four concurrent managed store endpoints and credentials on one connector instance', async () => {
    const protocol: { methods: string[]; authorization?: string; apiKey?: string } = {
      methods: [],
    };
    const baseFetch = serverFetch(registerEcho, protocol);
    const requests: Array<{ url: string; authorization?: string }> = [];
    const c = new McpConnector(
      {
        id: 'upstream',
        version: '1.0.0',
        endpoint: '${env.SHOP_MCP_ENDPOINT}',
        allowedOrigins: ['${env.SHOP_MCP_ORIGIN}'],
        auth: { kind: 'bearer' },
        operations: {
          echo: {
            upstreamTool: 'echo',
            signature: echoSignature,
            upstreamOutputSchema: echoSignature.output,
          },
        },
      },
      {
        fetch: async (url, init) => {
          const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
          if (
            body !== null &&
            typeof body === 'object' &&
            !Array.isArray(body) &&
            body.method === 'tools/call'
          ) {
            requests.push({
              url: String(url),
              authorization: new Headers(init?.headers).get('authorization') ?? undefined,
            });
          }
          return baseFetch(url, init);
        },
      },
    );
    const stores = ['a', 'b', 'c', 'd'].map((name) => ({
      name,
      endpoint: `https://store-${name}.example/api/mcp`,
      origin: `https://store-${name}.example`,
      token: `token-${name}`,
    }));

    await expect(
      Promise.all(
        stores.map((store) =>
          c.invoke({
            operation: 'echo',
            args: { message: store.name },
            credential: { token: store.token },
            env: {
              SHOP_MCP_ENDPOINT: store.endpoint,
              SHOP_MCP_ORIGIN: store.origin,
            },
          }),
        ),
      ),
    ).resolves.toEqual(stores.map((store) => ({ echoed: store.name })));
    expect(requests.map((request) => `${request.url} ${request.authorization}`).sort()).toEqual(
      stores.map((store) => `${store.endpoint} Bearer ${store.token}`).sort(),
    );
  });

  it('aborts an invocation at the configured total timeout', async () => {
    const c = new McpConnector(
      {
        id: 'upstream',
        version: '1.0.0',
        endpoint,
        allowedOrigins: ['http://127.0.0.1'],
        operations: {
          echo: {
            upstreamTool: 'echo',
            signature: echoSignature,
            upstreamOutputSchema: echoSignature.output,
          },
        },
        timeoutMs: 5,
      },
      {
        fetch: async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      },
    );

    await expect(
      c.invoke({ operation: 'echo', args: { message: 'hello' }, credential }),
    ).rejects.toMatchObject({ category: 'timeout', retryable: false });
  });

  it('propagates request cancellation to the upstream transport', async () => {
    const controller = new AbortController();
    let upstreamAborted = false;
    const c = new McpConnector(
      {
        id: 'upstream',
        version: '1.0.0',
        endpoint,
        allowedOrigins: ['http://127.0.0.1'],
        operations: {
          echo: {
            upstreamTool: 'echo',
            signature: echoSignature,
            upstreamOutputSchema: echoSignature.output,
          },
        },
        timeoutMs: 5_000,
      },
      {
        fetch: async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            if (init?.signal?.aborted) {
              upstreamAborted = true;
              reject(init.signal.reason);
              return;
            }
            init?.signal?.addEventListener(
              'abort',
              () => {
                upstreamAborted = true;
                reject(init.signal?.reason);
              },
              { once: true },
            );
          }),
      },
    );

    const startedAt = performance.now();
    const invocation = c.invoke({
      operation: 'echo',
      args: { message: 'hello' },
      credential,
      signal: controller.signal,
    });
    controller.abort(new Error('caller stopped'));

    await expect(invocation).rejects.toMatchObject({ category: 'timeout', retryable: false });
    expect(upstreamAborted).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});
