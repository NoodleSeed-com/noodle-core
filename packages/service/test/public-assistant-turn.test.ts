import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ADMISSION_DEFAULTS,
  clamp,
  InMemoryDailyCounterStore,
} from '@noodle-borg/admission-limits';
import {
  InMemoryAssistantStore,
  InMemoryPublicEmbedStore,
  type PublicEmbedRecord,
} from '@noodle-borg/assistant-gateway';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerRegistry } from '../src/registry.js';
import type { AssistantRouteDeps } from '../src/routes/assistant.js';
import { handleAssistantTurn } from '../src/routes/assistant.js';

/** Live application authority is checked first; public admission still precedes model work. */

const NOW = new Date('2030-01-01T00:00:00.000Z');
const ORIGIN = 'https://www.acme.test';
const TENANT = { org: 'acme', app: 'site', env: 'prod' };

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function start(options: {
  readonly kind: 'public' | 'authenticated';
  readonly budget?: { turnsPerDay?: number; mintsPerDay?: number };
  readonly revoked?: boolean;
  readonly omitStores?: boolean;
  readonly envelope?: typeof ADMISSION_DEFAULTS;
  readonly modelSource?: 'operator' | 'noodle-managed';
  readonly managedModelResolver?: AssistantRouteDeps['managedModelResolver'];
}) {
  const store = new InMemoryAssistantStore();
  const embeds = new InMemoryPublicEmbedStore();
  const embed: PublicEmbedRecord = await embeds.ensure({
    ...TENANT,
    surfaceMode: 'public',
    now: NOW,
  });
  if (options.budget) await embeds.setBudget(embed.embedId, options.budget, NOW);
  if (options.revoked) await embeds.revoke(embed.embedId, NOW);

  const registry = new ServerRegistry();
  await registry.configStore.setConfigValue({
    kind: 'secret',
    scope: { level: 'env', ...TENANT },
    name: 'MODEL_KEY',
    value: 'test-model-key',
  });
  const deployed = await registry.deploy(
    TENANT,
    `
manifestVersion: "2"
server:
  name: site
  version: 1.0.0
  title: Site
  assistant:
    model: { kind: openai-compatible, baseUrl: "https://models.example/v1", model: m, apiKey: MODEL_KEY }
    allowedOrigins: ["${ORIGIN}"]
    surfaces:
      - mode: ${options.kind}
        origins: ["${ORIGIN}"]
        capabilities: [{ kind: tool, name: ask }]
tools:
  - name: ask
    description: Answer a question.
    annotations: { readOnlyHint: true }
    inputSchema: { type: object, additionalProperties: false }
    fulfilment: { steps: [], output: { answer: "Hello" } }
`,
    { accessMode: 'public' },
  );
  if (!deployed.ok) throw new Error(JSON.stringify(deployed.errors));
  const created = await store.createClient({
    name: 'web',
    tenant: TENANT,
    deploymentId: deployed.deploymentId,
    allowedOrigins: [ORIGIN],
    now: NOW,
  });
  const { token } = await store.createSession({
    clientId: created.client.id,
    tenant: TENANT,
    deploymentId: deployed.deploymentId,
    ...(options.modelSource === undefined ? {} : { modelSource: options.modelSource }),
    origin: ORIGIN,
    ...(options.kind === 'public' ? { publicEmbedId: embed.embedId } : {}),
    caller:
      options.kind === 'public'
        ? { subject: 'anon_1', identityKind: 'anonymous' }
        : { subject: 'user_1', identityKind: 'customer' },
    createdAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
    absoluteExpiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
  });

  const modelFetch = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      choices: [{ message: { role: 'assistant', content: 'Hello.' } }],
    }),
  );
  const deps = {
    store,
    registry,
    modelFetch,
    audit: { emit: async () => {} },
    ...(options.omitStores
      ? {}
      : { publicEmbeds: embeds, admissionCounters: new InMemoryDailyCounterStore() }),
    ...(options.envelope ? { admissionEnvelope: options.envelope } : {}),
    ...(options.managedModelResolver ? { managedModelResolver: options.managedModelResolver } : {}),
    serviceBase: () => '',
    clock: () => NOW,
    maxBody: 64 * 1024,
  } as unknown as AssistantRouteDeps;

  const server = createServer((req, res) => {
    void handleAssistantTurn(req, res, deps).catch(() => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('handler threw');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, token, modelFetch };
}

const turn = (base: string, token: string, message = 'hello') =>
  fetch(`${base}/v1/assistant/turns`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      origin: ORIGIN,
    },
    body: JSON.stringify({ message }),
  });

describe('public turn admission on the route', () => {
  it('refuses every turn on a surface switched off, without invoking the model', async () => {
    const { base, token, modelFetch } = await start({
      kind: 'public',
      budget: { turnsPerDay: 0 },
    });
    const response = await turn(base, token);

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: 'daily_turn_budget_exhausted' });
    expect(modelFetch).not.toHaveBeenCalled();
  });

  it('refuses once the surface has spent its day', async () => {
    const { base, token } = await start({ kind: 'public', budget: { turnsPerDay: 1 } });

    // The first turn reaches the model; the second is refused by admission itself.
    const response = await turn(base, token);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('event: error');
    expect((await turn(base, token)).status).toBe(429);
  });

  it('refuses a session that has spent its own turns', async () => {
    const { base, token, modelFetch } = await start({
      kind: 'public',
      envelope: clamp({ turnsPerSession: 1 }),
    });

    const response = await turn(base, token);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('event: error');
    const spent = await turn(base, token);
    expect(spent.status).toBe(429);
    expect(await spent.json()).toMatchObject({ code: 'session_turn_budget_exhausted' });
    expect(modelFetch).toHaveBeenCalledTimes(1);
  });

  it('never applies sponsored bounds to an operator-funded session in an enrolled tenant', async () => {
    const resolve = vi.fn(async () => ({
      source: 'noodle-managed' as const,
      baseUrl: 'https://models.example',
      model: 'managed',
      apiKey: 'operator-secret',
      publicAdmission: {
        defaults: { turnsPerSession: 40, turnsPerDay: 5_000, mintsPerDay: 1_000 },
        ceiling: { turnsPerDay: 5_000, mintsPerDay: 1_000 },
      },
    }));
    const { base, token } = await start({
      kind: 'public',
      modelSource: 'operator',
      envelope: clamp({ turnsPerSession: 1 }),
      managedModelResolver: { resolve },
    });

    const response = await turn(base, token);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('event: error');
    expect((await turn(base, token)).status).toBe(429);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses an oversized message before it costs a turn', async () => {
    const { base, token, modelFetch } = await start({ kind: 'public' });
    const response = await turn(base, token, 'x'.repeat(ADMISSION_DEFAULTS.messageCharacters + 1));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'message_too_long' });
    expect(modelFetch).not.toHaveBeenCalled();
  });

  it('stops a live conversation whose surface was revoked', async () => {
    const { base, token, modelFetch } = await start({ kind: 'public', revoked: true });

    expect((await turn(base, token)).status).toBe(403);
    expect(modelFetch).not.toHaveBeenCalled();
  });

  /**
   * Fail closed rather than open. A public session reaching a service with no counters would run
   * unbounded against the customer's model budget — the one outcome the envelope exists to prevent.
   */
  it('refuses rather than running unbounded when admission is not configured', async () => {
    const { base, token, modelFetch } = await start({ kind: 'public', omitStores: true });

    expect((await turn(base, token)).status).toBe(503);
    expect(modelFetch).not.toHaveBeenCalled();
  });

  it('leaves an authenticated session’s turns to the embedding customer', async () => {
    const { base, token, modelFetch } = await start({ kind: 'authenticated' });

    // Authenticated surfaces use their embedding customer's limits.
    const response = await turn(base, token);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('event: error');
    expect(modelFetch).toHaveBeenCalled();
  });
});
