import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createServiceHandler,
  InMemoryControlPlaneStore,
  InMemoryIntentCaptureSettingsStore,
  InMemoryIntentEventStore,
  InMemoryRequestEventStore,
  ServerRegistry,
} from '../src/index.js';

let server: Server;
let base: string;
const settings = new InMemoryIntentCaptureSettingsStore();
const intents = new InMemoryIntentEventStore();
const requests = new InMemoryRequestEventStore();

beforeAll(async () => {
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: 'owner-sub',
    email: 'owner@acme.test',
    role: 'owner',
  });
  await requests.emit({
    org: 'acme',
    app: 'support',
    env: 'prod',
    requestId: 'r-1',
    sessionSource: 'none',
    subjectKind: 'anonymous',
    method: 'tools/call',
    kind: 'usage',
    toolName: 'search',
    outcome: 'ok',
    durationMs: 10,
  });
  await intents.emit({
    org: 'acme',
    app: 'support',
    env: 'prod',
    requestId: 'r-1',
    protocolEra: 'modern',
    toolName: 'search',
    outcome: 'ok',
    category: 'discover',
    match: 'direct',
    goal: 'Find available support options',
    source: 'tool_schema',
  });
  server = createServer(
    createServiceHandler(new ServerRegistry(), {
      controlPlaneStore: controlPlane,
      requestEventStore: requests,
      intentCaptureSettingsStore: settings,
      intentEventStore: intents,
      intentCapturePreviewOrgs: ['acme'],
      deployGate: {
        authorize: () =>
          Promise.resolve({
            ok: true as const,
            identity: { subject: 'owner-sub', email: 'owner@acme.test', superAdmin: false },
          }),
      },
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
});

const path = '/v1/orgs/acme/apps/support/envs/prod';
const request = (suffix: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${base}${path}${suffix}`, {
    ...init,
    headers: { authorization: 'Bearer owner-token', ...init.headers },
  });

describe('intent capture operator routes', () => {
  it('is off by default and can be enabled by an owner', async () => {
    const initial = await request('/intent-capture');
    expect(initial.status).toBe(200);
    await expect(initial.json()).resolves.toMatchObject({ data: { mode: 'off' } });

    const enabled = await request('/intent-capture', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'starter-v1' }),
    });
    expect(enabled.status).toBe(200);
    await expect(enabled.json()).resolves.toMatchObject({
      data: { mode: 'starter-v1', retentionDays: 14 },
    });
  });

  it('reports coverage, fixed taxonomy breakdowns, and evidence caveats', async () => {
    const response = await request('/intents?window=7d');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        mode: 'starter-v1',
        coverage: { captured: 1, toolCalls: 1, rate: 1 },
        byCategory: [{ key: 'discover', count: 1 }],
        byMatch: [{ key: 'direct', count: 1 }],
        evidence: { retentionDays: 14 },
      },
    });
  });

  it('purges retained intent and disables capture explicitly', async () => {
    const response = await request('/intent-capture', { method: 'DELETE' });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { mode: 'off', purged: 1 } });
    await expect(intents.list({ org: 'acme', app: 'support', env: 'prod' })).resolves.toEqual([]);
  });
});
