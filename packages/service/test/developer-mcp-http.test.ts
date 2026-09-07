import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLogger } from '@noodle-borg/transport-http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createServiceHandler,
  InMemoryAuditStore,
  InMemoryControlPlaneStore,
  InMemoryDeveloperGrantStore,
  InMemoryRequestEventStore,
  InMemoryUserAppLogStore,
  ServerRegistry,
  type ServiceOptions,
} from '../src/index.js';

const SUBJECT = 'developer-subject';
const CLIENT_ID = 'developer-client';
const TOKEN = 'developer-token';
const ACCEPT = 'application/json, text/event-stream';

let http: Server;
let base: string;
let grants: InMemoryDeveloperGrantStore;
let grantId: string;
let controlPlane: InMemoryControlPlaneStore;
let verifyOwnerToken: ReturnType<typeof vi.fn>;
let registry: ServerRegistry;
let logLines: string[];
let audit: InMemoryAuditStore;
let serviceOptions: ServiceOptions & { readonly developerMcp: true };

beforeEach(async () => {
  controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: SUBJECT,
    email: 'developer@example.com',
    role: 'developer',
  });
  let grantSequence = 0;
  grants = new InMemoryDeveloperGrantStore({ id: () => `grant-${++grantSequence}` });
  verifyOwnerToken = vi.fn(async (token: string, resource: string) => {
    if (token === 'unbound-token') {
      return { caller: { subject: SUBJECT, email: 'developer@example.com' } };
    }
    if (token === 'wrong-subject-token')
      return {
        caller: {
          subject: 'other-subject',
          email: 'other@example.com',
          developerGrantId: grantId,
          oauthClientId: CLIENT_ID,
        },
      };
    if (token === 'wrong-client-token')
      return {
        caller: {
          subject: SUBJECT,
          email: 'developer@example.com',
          developerGrantId: grantId,
          oauthClientId: 'other-client',
        },
      };
    return token === TOKEN && resource.endsWith('/developer/mcp')
      ? {
          caller: {
            subject: SUBJECT,
            email: 'developer@example.com',
            developerGrantId: grantId,
            oauthClientId: CLIENT_ID,
          },
        }
      : null;
  });
  registry = new ServerRegistry();
  logLines = [];
  audit = new InMemoryAuditStore({ id: () => 'developer-request-audit' });
  serviceOptions = {
    developerMcp: true,
    controlPlaneStore: controlPlane,
    developerGrantStore: grants,
    verifyOwnerToken,
    authServerIssuer: 'https://auth.noodle.test',
    userAppLogStore: new InMemoryUserAppLogStore(),
    requestEventStore: new InMemoryRequestEventStore(),
    audit,
    maxBodyBytes: 512,
    logger: createLogger({ sink: (line) => logLines.push(line) }),
  };
  http = createServer(createServiceHandler(registry, serviceOptions));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  grantId = (
    await grants.getOrCreateActive({
      clientId: CLIENT_ID,
      subject: SUBJECT,
      resource: `${base}/developer/mcp`,
      capabilities: ['cloud:read'],
    })
  ).id;
});

afterEach(async () => {
  await closeHttp();
});

async function closeHttp(): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    http.close((error) => (error ? reject(error) : resolve())),
  );
}

async function restartService(options: ServiceOptions): Promise<void> {
  await closeHttp();
  http = createServer(createServiceHandler(registry, options));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  grantId = (
    await grants.getOrCreateActive({
      clientId: CLIENT_ID,
      subject: SUBJECT,
      resource: `${base}/developer/mcp`,
      capabilities: ['cloud:read'],
    })
  ).id;
}

function rpc(body: unknown, token = TOKEN, extraHeaders: Record<string, string> = {}) {
  return fetch(`${base}/developer/mcp`, {
    method: 'POST',
    headers: {
      accept: ACCEPT,
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

function modernRpc(method: string, params: Record<string, unknown> = {}) {
  return rpc(
    {
      jsonrpc: '2.0',
      id: 20,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'modern-codex', version: '2.0.0' },
        },
      },
    },
    TOKEN,
    {
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
      ...(method === 'tools/call' && typeof params.name === 'string'
        ? { 'mcp-name': params.name }
        : {}),
    },
  );
}

describe('Noodle developer MCP HTTP mount', () => {
  it('publishes protected-resource metadata for the exact developer endpoint', async () => {
    const response = await fetch(`${base}/.well-known/oauth-protected-resource/developer/mcp`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resource: `${base}/developer/mcp`,
      authorization_servers: ['https://auth.noodle.test'],
      bearer_methods_supported: ['header'],
      scopes_supported: ['cloud:read'],
    });
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('challenges a request without a bearer token before MCP dispatch', async () => {
    const response = await fetch(`${base}/developer/mcp`, {
      method: 'POST',
      headers: { accept: ACCEPT, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/developer/mcp"`,
    );
    expect(verifyOwnerToken).not.toHaveBeenCalled();
  });

  it('authenticates against the exact resource and initializes the MCP server', async () => {
    const response = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'codex', version: '1.0.0' },
      },
    });

    expect(response.status).toBe(200);
    expect(verifyOwnerToken).toHaveBeenCalledWith(TOKEN, `${base}/developer/mcp`);
    expect(await response.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        serverInfo: { name: 'noodle-developer' },
        capabilities: { tools: {}, resources: {}, prompts: {} },
      },
    });
  });

  it('serves modern discovery and complete calls without changing the developer contract', async () => {
    const discovery = await modernRpc('server/discover');
    expect(discovery.status).toBe(200);
    await expect(discovery.json()).resolves.toMatchObject({
      result: {
        supportedVersions: [
          '2026-07-28',
          '2025-11-25',
          '2025-06-18',
          '2025-03-26',
          '2024-11-05',
          '2024-10-07',
        ],
        resultType: 'complete',
      },
    });

    const called = await modernRpc('tools/call', {
      name: 'get_context',
      arguments: {},
    });
    expect(called.status).toBe(200);
    await expect(called.json()).resolves.toMatchObject({
      result: {
        resultType: 'complete',
        structuredContent: {
          ok: true,
          data: {
            accessModel: 'live_user',
            organizations: [{ org: 'acme', role: 'developer' }],
          },
        },
      },
    });
  });

  it('applies the origin-wide legacy-only rollback gate to Developer MCP', async () => {
    await restartService({ ...serviceOptions, mcpProtocolMode: 'legacy-only' });

    const modern = await modernRpc('server/discover');
    expect(modern.status).toBe(200);
    await expect(modern.json()).resolves.toMatchObject({
      error: { code: -32601, message: 'Method not found' },
    });

    const legacy = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'rollback-client', version: '1.0.0' },
      },
    });
    expect(legacy.status).toBe(200);
    await expect(legacy.json()).resolves.toMatchObject({
      result: {
        protocolVersion: '2025-11-25',
        serverInfo: { name: 'noodle-developer' },
      },
    });
  });

  it('reloads and rejects a revoked developer grant', async () => {
    await grants.revoke(grantId, new Date().toISOString());

    const response = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'developer access grant is not active' });
  });

  it('rejects browser origins outside the canonical service origin', async () => {
    const response = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, TOKEN, {
      origin: 'https://attacker.example',
    });

    expect(response.status).toBe(403);
    expect(verifyOwnerToken).not.toHaveBeenCalled();
  });

  it('rejects wrong-audience tokens and tokens without grant bindings', async () => {
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

    const wrongAudience = await rpc(body, 'wrong-audience-token');
    expect(wrongAudience.status).toBe(401);
    expect(verifyOwnerToken).toHaveBeenCalledWith('wrong-audience-token', `${base}/developer/mcp`);

    const unbound = await rpc(body, 'unbound-token');
    expect(unbound.status).toBe(403);
    expect(await unbound.json()).toEqual({ error: 'developer access grant is required' });
  });

  it.each([
    'wrong-subject-token',
    'wrong-client-token',
  ])('rejects a grant-bound identity with mismatched claims (%s)', async (token) => {
    const response = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, token);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'developer access grant is not active' });
  });

  it('keeps discovery available when membership changes', async () => {
    await controlPlane.removeOrgMember({ org: 'acme', subject: SUBJECT });

    const response = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ result: { tools: expect.any(Array) } });
  });

  it('negotiates GET and DELETE through the stateless Streamable HTTP transport', async () => {
    const responses = await Promise.all(
      ['GET', 'DELETE'].map((method) =>
        fetch(`${base}/developer/mcp`, {
          method,
          headers: { accept: 'text/event-stream', authorization: `Bearer ${TOKEN}` },
        }),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual([405, 405]);
    for (const response of responses) {
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('lists the exact tool catalog and returns complete structured context', async () => {
    const listResponse = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const listed = await listResponse.json();
    expect(listResponse.status).toBe(200);
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'get_context',
      'list_apps',
      'inspect_app',
      'inspect_deployment',
      'get_logs',
      'get_metrics',
      'list_events',
      'get_session',
      'diagnose_app',
      'rollback_deployment',
    ]);

    const callResponse = await rpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_context', arguments: {} },
    });
    const called = await callResponse.json();
    expect(callResponse.status).toBe(200);
    expect(called.result.structuredContent).toMatchObject({
      ok: true,
      data: {
        accessModel: 'live_user',
        capabilities: ['cloud:read'],
        organizations: [{ org: 'acme', role: 'developer', capabilities: ['cloud:read'] }],
      },
      meta: { capabilityVersion: '2' },
    });
  });

  it('applies added and removed memberships live without reconnecting', async () => {
    await controlPlane.addOrgMember({
      org: 'second-org',
      subject: SUBJECT,
      email: 'developer@example.com',
      role: 'developer',
    });
    const contextResponse = await rpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'get_context', arguments: {} },
    });
    await expect(contextResponse.json()).resolves.toMatchObject({
      result: {
        structuredContent: {
          ok: true,
          data: {
            organizations: [
              { org: 'acme', role: 'developer' },
              { org: 'second-org', role: 'developer' },
            ],
          },
        },
      },
    });

    await controlPlane.removeOrgMember({ org: 'acme', subject: SUBJECT });
    const listApps = vi.spyOn(registry, 'listApps');

    const response = await rpc({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'list_apps', arguments: { org: 'acme' } },
    });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.result.isError).toBe(true);
    expect(json.result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'forbidden_scope' },
    });
    expect(listApps).not.toHaveBeenCalled();
    await expect(audit.list({ org: 'acme', eventType: 'developer.mcp.request' })).resolves.toEqual([
      expect.objectContaining({
        decision: 'deny',
        reasonCode: 'forbidden_scope',
        status: '200',
      }),
    ]);
    expect(logLines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        event: 'developer.mcp.request',
        decision: 'deny',
        errorCode: 'forbidden_scope',
      }),
    );
  });

  it('bounds and validates request bodies before SDK dispatch', async () => {
    const malformed = await fetch(`${base}/developer/mcp`, {
      method: 'POST',
      headers: {
        accept: ACCEPT,
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: '{',
    });
    expect(malformed.status).toBe(400);

    const oversized = await fetch(`${base}/developer/mcp`, {
      method: 'POST',
      headers: {
        accept: ACCEPT,
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ value: 'x'.repeat(600) }),
    });
    expect(oversized.status).toBe(413);
  });

  it('converts adapter failures to safe typed MCP errors', async () => {
    vi.spyOn(registry, 'listApps').mockRejectedValue(new Error('database password leaked'));

    const response = await rpc({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'list_apps', arguments: { org: 'acme' } },
    });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'internal_error', retryable: true },
    });
    expect(JSON.stringify(json)).not.toContain('database password leaked');
  });

  it('logs only allowlisted structural request fields', async () => {
    await rpc(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'get_context', arguments: {} },
      },
      TOKEN,
      {
        'x-request-id': 'request-6',
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      },
    );

    const emitted = logLines.join('\n');
    expect(emitted).toContain('developer.mcp.request');
    expect(emitted).toContain('get_context');
    expect(emitted).toContain('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(emitted).not.toContain(TOKEN);
    expect(emitted).not.toContain(grantId);
    expect(emitted).not.toContain(SUBJECT);
    expect(emitted).not.toContain('developer@example.com');
  });
});
