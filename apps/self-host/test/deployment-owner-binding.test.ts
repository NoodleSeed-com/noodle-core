import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createServiceHandler,
  InMemoryAuditStore,
  InMemoryControlPlaneStore,
  ServerRegistry,
} from '@noodle-borg/service';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SelfHostAdminGate } from '../src/admin-gate.js';

const ADMIN_TOKEN = 'LQPPSnvpT4TMomooI4tXegZQJQFxeEJr2Sn9sYrZj9Y';
const OWNER_BEARER = 'oauth-owner-bearer';
const OTHER_BEARER = 'oauth-other-bearer';
const ACCEPT = 'application/json, text/event-stream';
const MANIFEST = `
manifestVersion: "1"
server:
  name: self_host_owner
  version: 1.0.0
  title: Self-host owner
tools:
  - name: greet
    description: Greet a caller.
    inputSchema:
      type: object
      properties:
        name: { type: string }
      required: [name]
      additionalProperties: false
    fulfilment:
      steps: []
      output:
        message: "Hello, \${input.name}!"
`;

let server: Server;
let baseUrl: string;
let audit: InMemoryAuditStore;

beforeEach(async () => {
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.createOrg({ slug: 'acme' });
  audit = new InMemoryAuditStore();
  server = createServer(
    createServiceHandler(new ServerRegistry(), {
      audit,
      controlPlaneStore: controlPlane,
      deployGate: new SelfHostAdminGate(ADMIN_TOKEN),
      authServerIssuer: 'https://identity.self-host.test',
      verifyOwnerToken: async (token) =>
        token === OWNER_BEARER
          ? { caller: { subject: 'oauth-human' } }
          : token === OTHER_BEARER
            ? { caller: { subject: 'oauth-human-2' } }
            : null,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe('self-host deployment owner binding', () => {
  it('keeps the administrator on the control plane and admits only the bound OAuth subject', async () => {
    const deploy = await fetch(`${baseUrl}/v1/orgs/acme/apps/hello/envs/prod/deploy`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({
        manifest: MANIFEST,
        accessMode: 'owner-only',
        ownerSubject: 'oauth-human',
      }),
    });
    expect(deploy.status).toBe(201);
    const deployment = (await deploy.json()) as { url: string; ownerSubject?: string };
    expect(deployment.ownerSubject).toBe('oauth-human');

    expect((await mcp(deployment.url, initialize(), OWNER_BEARER)).status).toBe(200);
    const call = await mcp(
      deployment.url,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'greet', arguments: { name: 'Ada' } },
      },
      OWNER_BEARER,
    );
    expect(call.status).toBe(200);
    await expect(call.json()).resolves.toMatchObject({
      result: { structuredContent: { message: 'Hello, Ada!' } },
    });

    expect((await mcp(deployment.url, initialize(), OTHER_BEARER)).status).toBe(403);
    expect((await mcp(deployment.url, initialize(), ADMIN_TOKEN)).status).toBe(401);

    const [event] = await audit.list({ org: 'acme', eventType: 'deploy.accepted' });
    expect(event).toMatchObject({
      actorSubject: 'self-host-admin',
      actorEmail: 'self-host-admin@localhost.invalid',
    });
    const evidence = JSON.stringify(await audit.list({ org: 'acme' }));
    expect(evidence.includes(ADMIN_TOKEN)).toBe(false);
    expect(evidence.includes(OWNER_BEARER)).toBe(false);
    expect(evidence.includes(OTHER_BEARER)).toBe(false);
  });
});

function initialize() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'self-host-owner-test', version: '1' },
    },
  };
}

function mcp(url: string, body: unknown, token: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: ACCEPT,
      'mcp-protocol-version': '2025-11-25',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}
