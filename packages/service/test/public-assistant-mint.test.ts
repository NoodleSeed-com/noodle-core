import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { clamp, InMemoryDailyCounterStore } from '@noodle-borg/admission-limits';
import {
  type AssistantAppearanceOverride,
  InMemoryAssistantAppearanceSettingsStore,
  InMemoryAssistantStore,
  InMemoryPublicEmbedStore,
} from '@noodle-borg/assistant-gateway';
import type { RuntimeArtifact } from '@noodle-borg/compiler';
import type { RequestEventInput } from '@noodle-borg/module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantRouteDeps } from '../src/routes/assistant.js';
import { handlePublicAssistantSession } from '../src/routes/assistant-public-session.js';

const NOW = new Date('2030-01-01T00:00:00.000Z');
const ORIGIN = 'https://www.acme.test';
const TENANT = { org: 'acme', app: 'site', env: 'prod' };

/** A durable stand-in; real durability is proven by the counter store's own Postgres parity suite. */
class DurableCounters extends InMemoryDailyCounterStore {
  override readonly durable = true;
}

const ARTIFACT = {
  artifactSchemaVersion: '0.15.0',
  resolution: 'resolved',
  source: { manifestName: 'acme_site', manifestVersion: '2', coreVersion: '2' },
  server: {
    name: 'acme_site',
    title: 'Acme',
    version: '1.0.0',
    branding: { name: 'Acme' },
    assistant: {
      model: {
        kind: 'openai-compatible',
        baseUrl: '${env.MODEL_BASE_URL}',
        model: '${env.MODEL}',
        apiKey: 'MODEL_API_KEY',
      },
      allowedOrigins: [ORIGIN],
      behavior: { showConfirmationDetails: false },
      labels: { welcomeHeading: 'Ask us anything' },
      surfaces: [
        {
          mode: 'public',
          origins: [ORIGIN],
          capabilities: [{ kind: 'tool', name: 'ask_product' }],
        },
      ],
    },
  },
  capabilities: { tools: [] },
  tools: [],
} as unknown as RuntimeArtifact;

describe('public assistant mint route', () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  async function start(
    overrides: {
      readonly envelope?: AssistantRouteDeps['admissionEnvelope'];
      readonly counters?: AssistantRouteDeps['admissionCounters'];
      readonly enabled?: boolean;
      readonly artifact?: RuntimeArtifact;
      readonly appearanceOverride?: AssistantAppearanceOverride;
    } = {},
  ) {
    const store = new InMemoryAssistantStore();
    const embeds = new InMemoryPublicEmbedStore();
    const appearance = new InMemoryAssistantAppearanceSettingsStore();
    if (overrides.appearanceOverride) {
      await appearance.replace({
        tenant: TENANT,
        expectedRevision: 0,
        override: overrides.appearanceOverride,
        updatedAt: NOW,
        updatedBy: 'operator-1',
      });
    }
    const embed = await embeds.ensure({ ...TENANT, surfaceMode: 'public', now: NOW });
    const modelFetch = vi.fn();
    const usageEvents: RequestEventInput[] = [];
    let serviceBase = '';
    const enabled = overrides.enabled !== false;
    const deps = {
      store,
      appearance,
      ...(enabled ? { publicEmbeds: embeds } : {}),
      ...(enabled ? { admissionCounters: overrides.counters ?? new DurableCounters() } : {}),
      ...(overrides.envelope ? { admissionEnvelope: overrides.envelope } : {}),
      registry: {
        getActiveByTenant: () =>
          Promise.resolve({
            deploymentId: 'dep_1',
            served: { artifact: overrides.artifact ?? ARTIFACT, deps: {} },
          }),
      },
      serviceBase: () => serviceBase,
      clock: () => NOW,
      modelFetch,
      captureRequestEvent: (event) => usageEvents.push(event),
      maxBody: 64 * 1024,
    } as unknown as AssistantRouteDeps;

    const server = createServer((req, res) => {
      void handlePublicAssistantSession(req, res, deps).catch((error: unknown) => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(error instanceof Error ? error.message : 'unknown test handler failure');
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    serviceBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base: serviceBase, embed, store, modelFetch, appearance, usageEvents };
  }

  // `null` means "send no Origin header at all" — distinct from omitting the argument, which defaults
  // to the allowed origin. A defaulted `undefined` would silently turn the no-origin case into a pass.
  const mint = (base: string, body: unknown, origin: string | null = ORIGIN) =>
    fetch(`${base}/v1/assistant/public-sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(origin === null ? {} : { origin }),
      },
      body: JSON.stringify(body),
    });

  it('mints an anonymous session for a page on the live surface', async () => {
    const { base, embed, store, usageEvents } = await start();
    const response = await mint(base, { embedId: embed.embedId });

    expect(response.status).toBe(201);
    // The browser reads this response directly; without the echoed origin the widget is dead on arrival.
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const body = await response.json();
    const stored = await store.getSession(body.token, NOW);
    expect(stored?.caller.identityKind).toBe('anonymous');
    expect(stored?.publicEmbedId).toBe(embed.embedId);
    expect(stored?.turnCount).toBe(0);
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]?.details).toMatchObject({
      eventKind: 'session',
      surface: 'public',
      modelSource: 'operator',
    });
  });

  it('carries no secret in either direction', async () => {
    const { base, embed, store } = await start();
    const body = await (await mint(base, { embedId: embed.embedId })).json();
    const stored = await store.getSession(body.token, NOW);

    // The embed id is printed in page source: it must never behave like a credential.
    expect(JSON.stringify(body)).not.toContain('MODEL_API_KEY');
    expect(stored?.caller).not.toHaveProperty('roles');
    expect(stored?.caller).not.toHaveProperty('claims');
    expect(stored?.caller.subject).not.toContain(embed.embedId);
  });

  it('forwards only allowlisted browser configuration', async () => {
    const { base, embed } = await start();
    const body = await (await mint(base, { embedId: embed.embedId })).json();

    expect(body.configuration).toEqual({
      branding: { name: 'Acme' },
      assistant: {
        behavior: { showConfirmationDetails: false },
        labels: { welcomeHeading: 'Ask us anything' },
      },
    });
    // The surface's internal capability allowlist is not the visitor's business.
    expect(JSON.stringify(body)).not.toContain('ask_product');
  });

  it('merges the environment override into new public sessions', async () => {
    const { base, embed, store, appearance } = await start({
      appearanceOverride: {
        branding: { accent: '#EA580C' },
        assistant: { theme: 'dark', presentation: { launcher: { style: 'bubble' } } },
      },
    });
    const first = await (await mint(base, { embedId: embed.embedId })).json();
    expect(first.configuration).toEqual({
      branding: { name: 'Acme', accent: '#EA580C' },
      assistant: {
        theme: 'dark',
        behavior: { showConfirmationDetails: false },
        labels: { welcomeHeading: 'Ask us anything' },
        presentation: { launcher: { style: 'bubble' } },
      },
    });

    await appearance.replace({
      tenant: TENANT,
      expectedRevision: 1,
      override: { assistant: { theme: 'light' } },
      updatedAt: new Date(NOW.getTime() + 1_000),
      updatedBy: 'operator-2',
    });
    const second = await (await mint(base, { embedId: embed.embedId })).json();
    expect(second.configuration.assistant.theme).toBe('light');
    expect((await store.getSession(first.token, NOW))?.configuration?.assistant?.theme).toBe(
      'dark',
    );
  });

  it.each([
    ['an unknown embed id', { embedId: 'pub_bbbbbbbbbbbbbbbbbbbbbbbb' }, ORIGIN, 403],
    ['a credential-shaped id', { embedId: 'sk_live_x' }, ORIGIN, 400],
    ['a missing id', {}, ORIGIN, 400],
    ['an origin outside the surface', undefined, 'https://evil.test', 403],
    ['a missing origin', undefined, null, 403],
  ])('refuses %s without a CORS grant', async (_label, body, origin, status) => {
    const { base, embed } = await start();
    const response = await mint(base, body ?? { embedId: embed.embedId }, origin);

    expect(response.status).toBe(status);
    // A refusal must not hand the page a readable response; otherwise a disallowed origin looks live.
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('refuses when no public surface is live on the active deployment', async () => {
    const { base, embed } = await start({
      artifact: {
        ...ARTIFACT,
        server: {
          ...ARTIFACT.server,
          assistant: { ...ARTIFACT.server.assistant, surfaces: [] },
        },
      } as unknown as RuntimeArtifact,
    });
    expect((await mint(base, { embedId: embed.embedId })).status).toBe(409);
  });

  it('refuses to serve the public at all when the counter store is not durable', async () => {
    const { base, embed } = await start({ counters: new InMemoryDailyCounterStore() });
    const response = await mint(base, { embedId: embed.embedId });

    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('admission_store_not_durable');
  });

  it('refuses when this service serves authenticated embeds only', async () => {
    const { base, embed } = await start({ enabled: false });
    expect((await mint(base, { embedId: embed.embedId })).status).toBe(503);
  });

  it('stops minting calmly once the surface has spent its day', async () => {
    const { base, embed, modelFetch } = await start({ envelope: clamp({ mintsPerDay: 1 }) });

    expect((await mint(base, { embedId: embed.embedId })).status).toBe(201);
    const spent = await mint(base, { embedId: embed.embedId });

    expect(spent.status).toBe(429);
    expect((await spent.json()).code).toBe('daily_session_budget_exhausted');
    // Admission precedes every metered thing (ADR 0201 §8): nothing reached a model on the way here.
    expect(modelFetch).not.toHaveBeenCalled();
  });

  /**
   * The refusal an operator has to be able to see.
   *
   * The route used to return before the usage capture ran, so a surface turning visitors away left
   * no event, no metric and no audit entry — indistinguishable from a quiet day. The code rides as
   * `errorKind` because "we are over budget" and "one address is hammering us" want opposite
   * responses from an operator.
   */
  it('records a refused mint against the surface it was refused for', async () => {
    const { base, embed, usageEvents } = await start({ envelope: clamp({ mintsPerDay: 1 }) });

    expect((await mint(base, { embedId: embed.embedId })).status).toBe(201);
    expect((await mint(base, { embedId: embed.embedId })).status).toBe(429);

    expect(usageEvents).toHaveLength(2);
    const refusal = usageEvents[1];
    expect(refusal?.errorKind).toBe('daily_session_budget_exhausted');
    expect(refusal?.details).toMatchObject({ eventKind: 'session', assistantOutcome: 'refused' });
    expect(refusal?.org).toBe(TENANT.org);
    // No session existed, so the event claims none.
    expect(refusal?.sessionId).toBeUndefined();
  });

  it("leaves an unattributable refusal out of a customer's usage", async () => {
    const { base, usageEvents } = await start();

    expect((await mint(base, { embedId: 'pub_notarealembedidxxxxxxx' })).status).toBe(403);
    expect((await mint(base, { embedId: 'nonsense' })).status).toBe(400);

    // Prober noise belongs in platform logs, not in someone's numbers.
    expect(usageEvents).toEqual([]);
  });

  it('serves nobody while the kill switch is down', async () => {
    const { base, embed } = await start({ envelope: clamp({ mintsPerDay: 0 }) });
    expect((await mint(base, { embedId: embed.embedId })).status).toBe(429);
  });
});
