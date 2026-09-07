import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryAssistantStore } from '@noodle-borg/assistant-gateway';
import type { RuntimeArtifact } from '@noodle-borg/compiler';
import { afterEach, describe, expect, it } from 'vitest';
import { type AssistantRouteDeps, handleAssistantSession } from '../src/routes/assistant.js';

const NOW = new Date('2030-01-01T00:00:00.000Z');
const VALID_ROUTE = 'https://tenant-a.api.noodleseed.dev/v1';
const ARTIFACT = {
  artifactSchemaVersion: '0.15.0',
  resolution: 'resolved',
  source: {
    manifestName: 'assistant_customer_routing',
    manifestVersion: '2',
    coreVersion: '2',
  },
  server: {
    name: 'assistant_customer_routing',
    title: 'Assistant Customer Routing',
    version: '1.0.0',
    assistant: {
      model: {
        kind: 'openai-compatible',
        baseUrl: '${env.ASSISTANT_MODEL_BASE_URL}',
        model: '${env.ASSISTANT_MODEL}',
        apiKey: 'ASSISTANT_MODEL_API_KEY',
      },
      allowedOrigins: ['https://app.example.com'],
    },
  },
  capabilities: { tools: [] },
  customerEndpoints: {
    customer_api: { allowedHttpsHostSuffixes: ['noodleseed.dev'] },
  },
  tools: [],
} as const satisfies RuntimeArtifact;

describe('embedded assistant customer routing session boundary', () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  async function start() {
    const store = new InMemoryAssistantStore();
    const tenant = { org: 'acme', app: 'support', env: 'prod' };
    const created = await store.createClient({
      name: 'web',
      tenant,
      deploymentId: 'dep_123',
      allowedOrigins: ['https://app.example.com'],
      now: NOW,
    });
    const target = {
      deploymentId: 'dep_123',
      served: { artifact: ARTIFACT, deps: {} },
    };
    let serviceBase = '';
    const deps = {
      store,
      registry: {
        getActiveByTenant: () => Promise.resolve(target),
      },
      serviceBase: () => serviceBase,
      clock: () => NOW,
      maxBody: 64 * 1024,
    } as unknown as AssistantRouteDeps;
    const server = createServer((req, res) => {
      void handleAssistantSession(req, res, deps).catch((error: unknown) => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(error instanceof Error ? error.message : 'unknown test handler failure');
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    serviceBase = base;
    const basic = Buffer.from(`${created.client.id}:${created.secret}`).toString('base64');
    return { base, basic, store };
  }

  it('stores a canonical private route without adding it to the session response or caller', async () => {
    const { base, basic, store } = await start();
    const response = await exchange(base, basic, {
      endpoints: { customer_api: `${VALID_ROUTE}/` },
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain(VALID_ROUTE);
    expect(body).not.toHaveProperty('routing');
    const stored = await store.getSession(body.token, NOW);
    expect(stored?.customerRouting).toEqual({ customer_api: VALID_ROUTE });
    expect(stored?.caller).not.toHaveProperty('customerRouting');
  });

  it('keeps routing optional for backward-compatible static assistant sessions', async () => {
    const { base, basic, store } = await start();
    const response = await exchange(base, basic);

    expect(response.status).toBe(201);
    const body = await response.json();
    const stored = await store.getSession(body.token, NOW);
    expect(stored).not.toHaveProperty('customerRouting');
  });

  it.each([
    ['null routing', null],
    ['array routing', []],
    ['missing endpoint map', {}],
    ['array endpoint map', { endpoints: [] }],
    ['unknown endpoint', { endpoints: { other_api: VALID_ROUTE } }],
    ['non-string value', { endpoints: { customer_api: 42 } }],
    ['malformed URL', { endpoints: { customer_api: 'not-a-url' } }],
    ['disallowed URL', { endpoints: { customer_api: 'https://tenant.example.net/v1' } }],
  ])('rejects %s without reflecting route input', async (_name, routing) => {
    const { base, basic } = await start();
    const response = await exchange(base, basic, routing);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({ error: 'invalid assistant routing' });
    expect(JSON.stringify(body)).not.toContain('tenant');
    expect(JSON.stringify(body)).not.toContain('not-a-url');
  });

  it('preserves authentication and origin failure precedence over route validation', async () => {
    const { base, basic } = await start();
    const malformed = { endpoints: { customer_api: 'not-a-url' } };

    const wrongSecret = await exchange(
      base,
      Buffer.from('bad:secret').toString('base64'),
      malformed,
    );
    expect(wrongSecret.status).toBe(401);
    expect(await wrongSecret.json()).toEqual({ error: 'invalid assistant client' });

    const wrongOrigin = await exchange(base, basic, malformed, 'https://evil.example.com');
    expect(wrongOrigin.status).toBe(403);
    expect(await wrongOrigin.json()).toEqual({ error: 'origin is not allowed' });
  });
});

function exchange(
  base: string,
  basic: string,
  routing?: unknown,
  origin = 'https://app.example.com',
): Promise<Response> {
  return fetch(base, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      origin,
      user: { id: 'customer-1', email: 'person@example.com' },
      ...(routing === undefined ? {} : { routing }),
    }),
  });
}
