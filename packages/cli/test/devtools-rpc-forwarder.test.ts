import { CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DevtoolsAuthSession } from '../src/devtools-auth-session.js';
import {
  createDevtoolsRpcForwarder,
  type DevtoolsRpcRequest,
} from '../src/devtools-rpc-forwarder.js';

const MODERN_VERSION = '2026-07-28';
const LEGACY_VERSION = '2025-11-25';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Devtools RPC protocol discovery', () => {
  it('advertises form elicitation when forwarding modern requests', async () => {
    const forwarded: DevtoolsRpcRequest[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        forwarded.push(requestBody(init));
        return rpcResponse(1, { tools: [] });
      }),
    );
    const forward = createDevtoolsRpcForwarder({
      mcpUrl: 'https://modern.example.test/mcp',
      protocolVersion: MODERN_VERSION,
      authSession: () => undefined,
      record: () => undefined,
    });

    await forward(toolsList(1));

    expect(forwarded[0]?.params?._meta).toMatchObject({
      [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } },
    });
  });

  it('records a tool result with isError true as a failed activity without changing its inspector response', async () => {
    const entries: Array<{
      readonly status: 'ok' | 'error';
      readonly summary: string;
      readonly response?: unknown;
    }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const request = requestBody(init);
        return rpcResponse(request.id, {
          isError: true,
          content: [{ type: 'text', text: 'The tool could not complete.' }],
        });
      }),
    );
    const forward = createDevtoolsRpcForwarder({
      mcpUrl: 'https://tool-error.example.test/mcp',
      protocolVersion: LEGACY_VERSION,
      authSession: () => undefined,
      record: (entry) => entries.push(entry),
    });

    const result = await forward({
      id: 1,
      method: 'tools/call',
      params: { name: 'failing_tool' },
    });

    expect(result.json?.error).toBeUndefined();
    expect(entries).toMatchObject([
      {
        status: 'error',
        summary: 'tool error',
        response: {
          isError: true,
          content: [{ type: 'text', text: 'The tool could not complete.' }],
        },
      },
    ]);
  });

  it('retries after a transient discovery failure and bounds every discovery request', async () => {
    let discoveryAttempts = 0;
    const forwardedVersions: string[] = [];
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = requestBody(init);
      if (request.method === 'server/discover') {
        discoveryAttempts += 1;
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        if (discoveryAttempts === 1) throw new TypeError('temporary network failure');
        return discoveryResponse();
      }
      forwardedVersions.push(new Headers(init?.headers).get('mcp-protocol-version') ?? '');
      return rpcResponse(request.id, { tools: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const forward = createForwarder('https://transient.example.test/mcp');

    await expect(forward(toolsList(1))).resolves.toMatchObject({ httpStatus: 200 });
    await expect(forward(toolsList(2))).resolves.toMatchObject({ httpStatus: 200 });

    expect(discoveryAttempts).toBe(2);
    expect(forwardedVersions).toEqual([LEGACY_VERSION, MODERN_VERSION]);
  });

  it('preserves a safe diagnostic when the MCP server rejects both issued tokens', async () => {
    const session = {
      accessToken: vi
        .fn()
        .mockResolvedValueOnce('access-secret')
        .mockResolvedValueOnce('refreshed-access-secret'),
      noteBearerChallenge: vi.fn(),
      rejectToken: vi.fn(),
      clear: vi.fn(),
    } as unknown as DevtoolsAuthSession;
    const forwardedAuthorization: Array<string | null> = [];
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = requestBody(init);
      if (request.method === 'server/discover') return discoveryResponse();
      forwardedAuthorization.push(new Headers(init?.headers).get('authorization'));
      return Response.json(
        { jsonrpc: '2.0', id: request.id, error: { code: -32600, message: 'unauthorized' } },
        { status: 401 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const forward = createForwarder('https://protected.example.test/mcp', () => session);

    const result = await forward(toolsList(1));

    expect(result.httpStatus).toBe(401);
    expect(forwardedAuthorization).toEqual([
      'Bearer access-secret',
      'Bearer refreshed-access-secret',
    ]);
    expect(session.rejectToken).toHaveBeenCalledOnce();
    expect(session.clear).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/access-secret|refreshed-access-secret/u);
  });

  it('does not let an unauthenticated discovery challenge pin a later signed-in request to legacy', async () => {
    let discoveryAttempts = 0;
    let signedIn = false;
    const discoveryAuthorization: Array<string | null> = [];
    const session = {
      accessToken: vi.fn(async () => 'signed-in-token'),
      noteBearerChallenge: vi.fn(),
      clear: vi.fn(),
    } as unknown as DevtoolsAuthSession;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = requestBody(init);
      if (request.method === 'server/discover') {
        discoveryAttempts += 1;
        discoveryAuthorization.push(new Headers(init?.headers).get('authorization'));
        return discoveryAttempts === 1
          ? rpcResponse(request.id, { denied: true }, 401)
          : discoveryResponse();
      }
      return rpcResponse(request.id, { tools: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const forward = createForwarder('https://protected.example.test/mcp', () =>
      signedIn ? session : undefined,
    );

    await expect(forward(toolsList(1))).resolves.toMatchObject({ httpStatus: 200 });
    signedIn = true;
    await expect(forward(toolsList(2))).resolves.toMatchObject({ httpStatus: 200 });

    expect(discoveryAttempts).toBe(2);
    expect(discoveryAuthorization).toEqual([null, 'Bearer signed-in-token']);
  });

  it('scopes confirmed protocol discovery to one forwarder instance', async () => {
    let discoveryAttempts = 0;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = requestBody(init);
      if (request.method === 'server/discover') {
        discoveryAttempts += 1;
        return discoveryResponse();
      }
      return rpcResponse(request.id, { tools: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const first = createForwarder('https://shared-origin.example.test/one/mcp');
    const second = createForwarder('https://shared-origin.example.test/two/mcp');

    await first(toolsList(1));
    await first(toolsList(2));
    await second(toolsList(3));

    expect(discoveryAttempts).toBe(2);
  });

  it('caches an explicit legacy method-not-found result within one forwarder', async () => {
    let discoveryAttempts = 0;
    const forwardedVersions: string[] = [];
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = requestBody(init);
      if (request.method === 'server/discover') {
        discoveryAttempts += 1;
        return Response.json(
          {
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32601, message: 'Method not found' },
          },
          { status: 404 },
        );
      }
      forwardedVersions.push(new Headers(init?.headers).get('mcp-protocol-version') ?? '');
      return rpcResponse(request.id, { tools: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const forward = createForwarder('https://legacy.example.test/mcp');

    await forward(toolsList(1));
    await forward(toolsList(2));

    expect(discoveryAttempts).toBe(1);
    expect(forwardedVersions).toEqual([LEGACY_VERSION, LEGACY_VERSION]);
  });
});

function createForwarder(
  mcpUrl: string,
  authSession: () => DevtoolsAuthSession | undefined = () => undefined,
) {
  return createDevtoolsRpcForwarder({
    mcpUrl,
    authSession,
    record: () => undefined,
  });
}

function toolsList(id: number): DevtoolsRpcRequest {
  return { id, method: 'tools/list', params: {} };
}

function requestBody(init: RequestInit | undefined): DevtoolsRpcRequest {
  return JSON.parse(String(init?.body)) as DevtoolsRpcRequest;
}

function discoveryResponse(): Response {
  return rpcResponse('noodle-devtools-discover', {
    supportedVersions: [LEGACY_VERSION, MODERN_VERSION],
  });
}

function rpcResponse(id: unknown, result: Record<string, unknown>, status = 200): Response {
  return Response.json({ jsonrpc: '2.0', id, result }, { status });
}
