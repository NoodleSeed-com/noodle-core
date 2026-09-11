import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RuntimeArtifact } from '@noodle-borg/compiler';
import type { OwnerTokenVerifier } from '@noodle-borg/module';
import type { ServedArtifact } from '@noodle-borg/protocol';
import {
  type ConnectorCall,
  type CredentialRequest,
  InMemoryConnectorRegistry,
} from '@noodle-borg/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpRouter, type ServedTarget } from '../src/index.js';

const fixture = JSON.parse(
  readFileSync(
    new URL('../../compiler/fixtures/valid/minimal.resolved.artifact.json', import.meta.url),
    'utf8',
  ),
) as RuntimeArtifact;
const claims = {
  subject: 'same-subject',
  identityKind: 'customer' as const,
  scopes: ['orders.read'],
  roles: ['reader'],
};

describe.each(['2025-11-25', '2026-07-28'])('mixed customer authentication (%s)', (era) => {
  let server: Server;
  let endpoint: string;
  let target: ServedTarget;
  let calls: ConnectorCall[];
  let credentials: CredentialRequest[];
  let verifyCustomer: ReturnType<typeof vi.fn<OwnerTokenVerifier>>;
  let verifyPlatform: ReturnType<typeof vi.fn<OwnerTokenVerifier>>;

  beforeEach(async () => {
    calls = [];
    credentials = [];
    verifyCustomer = vi.fn(async (token, resource) => {
      if (token === 'invalid') return null;
      return {
        caller: {
          ...claims,
          audience: resource,
          ...(token === 'human' ? { identityKind: 'platform' as const } : {}),
          ...(token === 'missing-role' ? { roles: [] } : {}),
          ...(token === 'missing-scope' ? { scopes: [] } : {}),
        },
        customerIssuer: 'https://customer-idp.example',
      };
    });
    verifyPlatform = vi.fn(async () => ({
      caller: { ...claims, identityKind: 'platform', subject: 'platform-user' },
    }));
    target = {
      accessMode: 'mixed',
      authentication: { kind: 'customer', verifyToken: verifyCustomer },
      served: served(),
    };
    server = createServer(
      createMcpRouter(async () => target, { verifyOwnerToken: verifyPlatform }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/test-deployment/mcp`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('serves public help anonymously without invoking either verifier', async () => {
    const response = await call('help');
    expect(response.status, await response.clone().text()).toBe(200);
    expect(calls).toHaveLength(1);
    expect(verifyCustomer).not.toHaveBeenCalled();
    expect(verifyPlatform).not.toHaveBeenCalled();
  });

  it('discovers a protected tool before sign-in without granting execution', async () => {
    const response = await request('tools/list', {});
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      result: {
        tools: [
          { name: 'help', securitySchemes: [{ type: 'noauth' }] },
          { name: 'orders', securitySchemes: [{ type: 'oauth2', scopes: ['orders.read'] }] },
        ],
      },
    });
    expect(verifyCustomer).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(credentials).toHaveLength(0);
  });

  it('never inherits a previous caller from a reused session id', async () => {
    expect((await call('orders', 'Bearer valid')).status).toBe(200);
    calls.length = 0;
    credentials.length = 0;
    const denied = await call('orders');
    expect(denied.status).toBe(401);
    expect(calls).toHaveLength(0);
    expect(credentials).toHaveLength(0);
    expect((await call('help')).status).toBe(200);
    expect(calls[0]?.caller).toBeUndefined();
  });

  it('uses customer claims and private issuer provenance for the protected tool', async () => {
    const response = await call('orders', 'Bearer valid');
    expect(response.status, await response.clone().text()).toBe(200);
    expect(verifyCustomer).toHaveBeenCalledExactlyOnceWith('valid', endpoint);
    expect(verifyPlatform).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.caller).toMatchObject(claims);
    expect(credentials[0]).toMatchObject({ customerIssuer: 'https://customer-idp.example' });
    expect(calls[0]?.caller).not.toHaveProperty('customerIssuer');
    expect(JSON.stringify(credentials)).not.toContain('Bearer valid');
  });

  it.each([
    'Bearer invalid',
    'Bearer human',
    'Basic invalid',
    'Bearer ',
  ])('rejects supplied invalid customer credentials %s without anonymous downgrade', async (authorization) => {
    const response = await call('help', authorization);
    expect(response.status, await response.clone().text()).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
    expect(response.headers.get('www-authenticate')).toContain('invalid_token');
    expect(verifyPlatform).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(credentials).toHaveLength(0);
  });

  it('never substitutes the platform verifier when the customer verifier is absent', async () => {
    target = { ...target, authentication: { kind: 'customer' } };
    const response = await call('orders', 'Bearer valid');
    expect(response.status, await response.clone().text()).toBe(401);
    expect(verifyPlatform).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(credentials).toHaveLength(0);
  });

  it('challenges anonymous protected calls before credentials or connectors', async () => {
    const response = await call('orders');
    expect(response.status, await response.clone().text()).toBe(401);
    expect(calls).toHaveLength(0);
    expect(credentials).toHaveLength(0);
  });

  it.each([
    'missing-role',
    'missing-scope',
  ])('enforces the customer token permissions for %s', async (token) => {
    const response = await call('orders', `Bearer ${token}`);
    expect(response.status, await response.clone().text()).toBe(403);
    if (token === 'missing-role') expect(response.headers.get('www-authenticate')).toBeNull();
    else expect(response.headers.get('www-authenticate')).toContain('insufficient_scope');
    expect(calls).toHaveLength(0);
    expect(credentials).toHaveLength(0);
  });

  function call(name: string, authorization?: string) {
    return request('tools/call', { name, arguments: { order_id: 'test' } }, authorization);
  }

  function request(method: string, params: Record<string, unknown>, authorization?: string) {
    return fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': era,
        'mcp-session-id': 'same-untrusted-session',
        ...(era === '2026-07-28'
          ? {
              'mcp-method': method,
              ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
            }
          : {}),
        ...(authorization === undefined ? {} : { authorization }),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          ...(era === '2026-07-28'
            ? {
                _meta: {
                  'io.modelcontextprotocol/protocolVersion': era,
                  'io.modelcontextprotocol/clientCapabilities': {},
                  'io.modelcontextprotocol/clientInfo': { name: 'mixed-auth-test', version: '1' },
                },
              }
            : {}),
        },
      }),
    });
  }

  function served(): ServedArtifact {
    const tool = fixture.tools[0];
    if (!tool) throw new Error('fixture tool missing');
    return {
      artifact: {
        ...fixture,
        tools: [
          { ...tool, name: 'help' },
          {
            ...tool,
            name: 'orders',
            authorization: {
              requiredScopes: ['orders.read'],
              allowedRoles: ['reader'],
              discovery: 'public',
            },
          },
        ],
        capabilities: { tools: ['help', 'orders'] },
      },
      deps: {
        tenantId: 'org/app/prod',
        broker: {
          getCredential: async (request) => {
            credentials.push(request);
            return { token: 'downstream-only' };
          },
        },
        connectors: new InMemoryConnectorRegistry([
          {
            id: 'acme_orders',
            version: '1.2.0',
            signature: () => ({
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
            }),
            invoke: async (request) => {
              calls.push(request);
              return { order: { id: 'test' } };
            },
          },
        ]),
      },
    };
  }
});
