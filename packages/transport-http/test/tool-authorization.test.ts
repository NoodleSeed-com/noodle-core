import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OperationSignature, RuntimeArtifact } from '@noodle-borg/compiler';
import type { ServedArtifact } from '@noodle-borg/protocol';
import {
  type Connector,
  type ConnectorCall,
  InMemoryConnectorRegistry,
  StaticServiceBroker,
} from '@noodle-borg/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, createMcpRouter } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(
  here,
  '..',
  '..',
  'compiler',
  'fixtures',
  'valid',
  'minimal.resolved.artifact.json',
);
const ACCEPT = 'application/json, text/event-stream';
const HEADERS = {
  'content-type': 'application/json',
  accept: ACCEPT,
  'mcp-protocol-version': '2025-11-25',
};
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

let server: Server;
let endpoint: string;
let calls: ConnectorCall[];
let logLines: string[];
let denyAdmission: boolean;

beforeEach(async () => {
  calls = [];
  logLines = [];
  denyAdmission = false;
  const connector: Connector = {
    id: 'acme_orders',
    version: '1.2.0',
    signature: () => signature,
    invoke: async (call) => {
      calls.push(call);
      return { order: { id: call.args.id, status: 'open' } };
    },
  };
  const target = restrictedTarget(connector);
  server = createServer(
    createMcpRouter(
      () =>
        Promise.resolve({
          served: target,
          accessMode: 'mixed',
        }),
      {
        logger: createLogger({ sink: (line) => logLines.push(line) }),
        admissionGate: async () =>
          denyAdmission ? { allow: false, reason: 'operator_policy' } : { allow: true },
        verifyOwnerToken: async (token) => {
          if (token === 'viewer') {
            return {
              caller: {
                subject: 'viewer-1',
                scopes: ['orders.read', 'orders.write'],
                roles: ['viewer'],
              },
            };
          }
          if (token === 'support-read') {
            return {
              caller: {
                subject: 'support-1',
                scopes: ['orders.read'],
                roles: ['support'],
              },
            };
          }
          if (token === 'support-write') {
            return {
              caller: {
                subject: 'support-1',
                scopes: ['orders.read', 'orders.write'],
                roles: ['support'],
              },
            };
          }
          return null;
        },
      },
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  endpoint = `http://127.0.0.1:${port}/alpha/mcp`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe('HTTP per-tool authorization', () => {
  it.each([
    '2025-11-25',
    '2026-07-28',
  ])('derives private write attribution from the peer and verified caller on %s', async (version) => {
    const invoke = async (token?: string, forwarded = '198.51.100.1') => {
      const modern = version === '2026-07-28';
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          ...HEADERS,
          'mcp-protocol-version': version,
          ...(modern ? { 'mcp-method': 'tools/call', 'mcp-name': 'public_order' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          'x-forwarded-for': forwarded,
          'x-noodle-public-admission': 'forged',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 20,
          method: 'tools/call',
          params: {
            name: 'public_order',
            arguments: { order_id: 'A1' },
            _meta: {
              publicAdmission: { network: 'forged', visitor: 'forged' },
              ...(modern
                ? {
                    'io.modelcontextprotocol/protocolVersion': version,
                    'io.modelcontextprotocol/clientCapabilities': {},
                    'io.modelcontextprotocol/clientInfo': { name: 'admission-test', version: '1' },
                  }
                : {}),
            },
          },
        }),
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).not.toContain('publicAdmission');
      return calls.at(-1);
    };
    const anonymous = await invoke();
    expect(anonymous?.publicAdmission).toEqual({
      network: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const forgedPeer = await invoke(undefined, '198.51.100.2');
    expect(forgedPeer?.publicAdmission).toEqual(anonymous?.publicAdmission);
    const authenticated = await invoke('support-write');
    expect(authenticated?.publicAdmission?.network).toBe(anonymous?.publicAdmission?.network);
    expect(authenticated?.publicAdmission?.visitor).toMatch(/^[a-f0-9]{64}$/);
    expect((await invoke('viewer'))?.publicAdmission?.visitor).not.toBe(
      authenticated?.publicAdmission?.visitor,
    );
    expect(authenticated?.args).toEqual({ id: 'A1' });
    expect(logLines.join('\n')).not.toContain(authenticated?.publicAdmission?.network);
  });
  it('filters tools/list per request while preserving artifact order', async () => {
    const anonymous = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    expect(
      (await anonymous.json()).result.tools.map((tool: { name: string }) => tool.name),
    ).toEqual(['public_order']);

    const authorized = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'support-write');
    expect(
      (await authorized.json()).result.tools.map((tool: { name: string }) => tool.name),
    ).toEqual(['public_order', 'restricted_order']);
    expect(authorized.headers.get('cache-control')).toBe('private, no-store');
  });

  it('returns 401 for an anonymous restricted call before argument validation', async () => {
    const response = await post({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'restricted_order', arguments: {} },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
    expect(calls).toHaveLength(0);
  });

  it('returns a generic role-only 403 without leaking configured roles', async () => {
    const response = await post(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'restricted_order', arguments: { order_id: 'A1' } },
      },
      'viewer',
    );
    const body = await response.text();

    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(body).not.toContain('support');
    expect(body).not.toContain('viewer');
    expect(calls).toHaveLength(0);
  });

  it('returns the complete insufficient-scope challenge after the role passes', async () => {
    const response = await post(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'restricted_order', arguments: { order_id: 'A1' } },
      },
      'support-read',
    );
    const challenge = response.headers.get('www-authenticate') ?? '';

    expect(response.status).toBe(403);
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="orders.read orders.write"');
    expect(challenge).toContain('resource_metadata=');
    expect(calls).toHaveLength(0);
  });

  it('preflights the whole batch before an authorized sibling can execute', async () => {
    const response = await post(
      [
        {
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: { name: 'public_order', arguments: { order_id: 'A1' } },
        },
        {
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'restricted_order', arguments: { order_id: 'A2' } },
        },
      ],
      'support-read',
    );

    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('allows a caller satisfying both roles and scopes', async () => {
    const response = await post(
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'restricted_order', arguments: { order_id: 'A1' } },
      },
      'support-write',
    );

    expect(response.status).toBe(200);
    expect((await response.json()).result.isError).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('keeps authorization observations scalar and omits claim and rule values', async () => {
    await post(
      {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'restricted_order', arguments: { order_id: 'A1' } },
      },
      'support-read',
    );

    const observations = logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.event === 'mcp.tool_authorization');
    expect(observations).toEqual([
      expect.objectContaining({
        toolName: 'restricted_order',
        decision: 'deny',
        reason: 'insufficient_scope',
        ruleClass: 'scopes_and_roles',
        ruleFingerprint: expect.stringMatching(/^fnv1a32:[0-9a-f]{8}$/),
      }),
    ]);
    expect(JSON.stringify(observations)).not.toMatch(
      /orders\.read|orders\.write|"admin"|"support"|Bearer/,
    );
  });

  it('keeps managed admission outside authored authorization and lets admission denial win', async () => {
    denyAdmission = true;

    const response = await post(
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'restricted_order', arguments: { order_id: 'A1' } },
      },
      'support-write',
    );

    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
    expect(
      logLines.some(
        (line) => (JSON.parse(line) as { event?: string }).event === 'mcp.tool_authorization',
      ),
    ).toBe(false);
  });
});

function restrictedTarget(connector: Connector): ServedArtifact {
  const artifact = JSON.parse(readFileSync(fixturePath, 'utf8')) as RuntimeArtifact;
  const base = artifact.tools[0];
  if (base === undefined) throw new Error('missing fixture tool');
  return {
    artifact: {
      ...artifact,
      capabilities: { ...artifact.capabilities, tools: ['public_order', 'restricted_order'] },
      tools: [
        { ...base, name: 'public_order' },
        {
          ...base,
          name: 'restricted_order',
          authorization: {
            requiredScopes: ['orders.read', 'orders.write'],
            allowedRoles: ['admin', 'support'],
          },
        },
      ],
    },
    deps: {
      tenantId: 'org/app/production',
      connectors: new InMemoryConnectorRegistry([connector]),
      broker: new StaticServiceBroker({ token: 'svc' }),
    },
  };
}

function post(body: unknown, token?: string): Promise<Response> {
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      ...HEADERS,
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}
