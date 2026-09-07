import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OperationSignature, RuntimeArtifact } from '@noodle-borg/compiler';
import type { AdmissionContext, RequestEventInput } from '@noodle-borg/module';
import type { ProtocolToolDispatchContext, ServedArtifact } from '@noodle-borg/protocol';
import type {
  Connector,
  ConnectorCall,
  CredentialRequest,
  ExecuteDeps,
} from '@noodle-borg/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger, createMcpRouter } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const artifactPath = join(
  here,
  '..',
  '..',
  'compiler',
  'fixtures',
  'valid',
  'customer-routing.artifact.json',
);
const ROUTE_A = 'https://tenant-a.api.noodleseed.dev/v1';
const ROUTE_B = 'https://tenant-b.api.noodleseed.dev/v2';
const ISSUER_A = 'https://tenant-a-idp.noodleseed.dev';
const ISSUER_B = 'https://tenant-b-idp.noodleseed.dev';
const SIGNATURE: OperationSignature = {
  type: 'read',
  input: { type: 'object', properties: {}, additionalProperties: false },
  output: { type: 'object', properties: {}, additionalProperties: false },
};
const HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-11-25',
};

let server: Server | undefined;

afterEach(async () => {
  if (server === undefined) return;
  await new Promise<void>((resolve, reject) =>
    server?.close((error) => (error ? reject(error) : resolve())),
  );
  server = undefined;
});

describe('HTTP private customer routing context', () => {
  it('keeps routes out of transport hooks while preserving identical authorization and discovery', async () => {
    const connectorCalls: ConnectorCall[] = [];
    const credentialRequests: CredentialRequest[] = [];
    const admission: AdmissionContext[] = [];
    const dispatch: ProtocolToolDispatchContext[] = [];
    const invocationInputs: unknown[] = [];
    const events: RequestEventInput[] = [];
    const logs: string[] = [];
    const verifiedResources: string[] = [];
    const target = routedTarget(connectorCalls, credentialRequests);
    const handler = createMcpRouter(() => Promise.resolve(undefined), {
      tenantLookup: async () => ({
        served: target,
        deploymentId: 'dep-1',
        accessMode: 'customers',
        org: 'acme',
        verifyToken: async (token, resource) => {
          verifiedResources.push(resource);
          const baseUrl =
            token === 'tenant-a' ? ROUTE_A : token === 'tenant-b' ? ROUTE_B : undefined;
          return baseUrl === undefined
            ? null
            : {
                caller: {
                  subject: 'customer-123',
                  identityKind: 'customer',
                  scopes: ['records.read'],
                  roles: ['support'],
                  audience: resource,
                },
                customerIssuer: token === 'tenant-a' ? ISSUER_A : ISSUER_B,
                customerRouting: { customer_api: baseUrl },
              };
        },
      }),
      admissionGate: async (context) => {
        admission.push(context);
        return { allow: true };
      },
      beforeToolDispatch: async (context) => {
        dispatch.push(context);
        return { allow: true };
      },
      resolveInvocationContext: async (input) => {
        invocationInputs.push(input);
        return undefined;
      },
      captureRequestEvent: (event) => events.push(event),
      logger: createLogger({ sink: (line) => logs.push(line) }),
    });
    server = createServer(handler);
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing test port');
    const endpoint = `http://127.0.0.1:${address.port}/o/acme/support/mcp`;

    const listedA = await post(endpoint, 'tenant-a', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    const listedB = await post(endpoint, 'tenant-b', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    expect((await listedA.json()).result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'list_records',
    ]);
    expect((await listedB.json()).result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'list_records',
    ]);

    await post(endpoint, 'tenant-a', {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_records', arguments: {} },
    });
    await post(endpoint, 'tenant-b', {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'list_records', arguments: {} },
    });

    expect(connectorCalls.map((call) => call.route?.baseUrl)).toEqual([ROUTE_A, ROUTE_B]);
    expect(credentialRequests.map((request) => request.customerIssuer)).toEqual([
      ISSUER_A,
      ISSUER_B,
    ]);
    expect(
      connectorCalls.every((call) => !Object.hasOwn(call.caller ?? {}, 'customerIssuer')),
    ).toBe(true);
    expect(new Set(verifiedResources).size).toBe(1);
    for (const publicOrHookValue of [admission, dispatch, events, logs]) {
      const serialized = JSON.stringify(publicOrHookValue);
      expect(serialized).not.toContain(ROUTE_A);
      expect(serialized).not.toContain(ROUTE_B);
      expect(serialized).not.toContain(ISSUER_A);
      expect(serialized).not.toContain(ISSUER_B);
      expect(serialized).not.toContain('customer_api');
      expect(serialized).not.toContain('fingerprint');
    }
    expect(JSON.stringify(invocationInputs)).not.toContain(ROUTE_A);
    expect(JSON.stringify(invocationInputs)).not.toContain(ROUTE_B);
    expect(JSON.stringify(invocationInputs)).not.toContain('fingerprint');
    expect(invocationInputs).toEqual([
      expect.objectContaining({
        caller: expect.objectContaining({ subject: 'customer-123' }),
      }),
      expect.objectContaining({
        caller: expect.objectContaining({ subject: 'customer-123' }),
      }),
    ]);
  });
});

function routedTarget(
  calls: ConnectorCall[],
  credentialRequests: CredentialRequest[],
): ServedArtifact {
  const base = JSON.parse(readFileSync(artifactPath, 'utf8')) as RuntimeArtifact;
  const artifact: RuntimeArtifact = {
    ...base,
    tools: base.tools.map((tool) => ({
      ...tool,
      authorization: {
        requiredScopes: ['records.read'],
        allowedRoles: ['support'],
      },
    })),
  };
  const connector: Connector = {
    id: 'customer_records',
    version: '1.0.0',
    signature: () => SIGNATURE,
    invoke(call) {
      calls.push(call);
      return {};
    },
  };
  const deps: ExecuteDeps = {
    connectors: { resolve: () => connector },
    broker: {
      getCredential: async (request) => {
        credentialRequests.push(request);
        return { token: 'downstream' };
      },
    },
  };
  return { artifact, deps };
}

function post(endpoint: string, token: string, body: unknown): Promise<Response> {
  return fetch(endpoint, {
    method: 'POST',
    headers: { ...HEADERS, authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}
