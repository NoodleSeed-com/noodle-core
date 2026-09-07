import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { clamp } from '@noodle-borg/admission-limits';
import { defaultKnowledgeStores, wireKnowledge } from '@noodle-borg/knowledge-operations';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createServiceHandler,
  InMemoryAssistantStore,
  InMemoryConfigStore,
  InMemoryPublicEmbedStore,
  ServerRegistry,
} from '../src/index.js';

/**
 * Where a WebMCP bridge call's budget is spent, relative to the work the apps route does (ADR 0220).
 *
 * A browser agent retries far faster than a human, so a refusal that has already resolved the
 * deployment's knowledge gate hands an agent loop a way to spend the surface's resources on calls the
 * platform decided to reject before it looked. The refusal has to come first, and the only honest
 * proof is a probe on the work itself: `resolveAssistantKnowledge` awaits the deployment-bound port's
 * `enabled()`, so counting that counts the work.
 */

const ORIGIN = 'https://www.acme.test';
const tenant = { org: 'acme', app: 'site', env: 'prod' } as const;
const DOC = 'Noodle Seed is a declarative platform for MCP servers.';
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const MANIFEST = `manifestVersion: "2"
server:
  name: site
  version: 1.0.0
  title: Acme Site
  assistant:
    model: { kind: openai-compatible, baseUrl: "https://models.example/v1", model: m, apiKey: MODEL_KEY }
    allowedOrigins: ["${ORIGIN}"]
    webmcp: { enabled: true }
    surfaces:
      - mode: public
        origins: ["${ORIGIN}"]
        capabilities:
          - { kind: tool, name: ask }
          - { kind: knowledge, name: product }
  knowledge:
    - name: product
      title: Product knowledge
      description: Public product information.
      documents:
        - path: docs/faq.md
          title: FAQ
          sha256: ${sha(DOC)}
          bytes: ${Buffer.byteLength(DOC)}
      sites: []
tools:
  - name: ask
    description: Answer from the curated FAQ.
    inputSchema: { type: object, properties: {}, additionalProperties: false }
    annotations: { readOnlyHint: true }
    fulfilment:
      steps: []
      output: { answer: "Noodle Seed is a declarative platform." }
`;

const servers: Server[] = [];

describe('WebMCP bridge admission runs before the apps route resolves anything', () => {
  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  it('refuses a killed surface without resolving knowledge, and resolves it when admitted', async () => {
    // The control first. Without it the assertion below proves nothing: this establishes that the
    // probe does fire on the path a bridge call takes when the budget lets it through.
    const admitted = await bridgeCall({ killed: false });
    expect(admitted.status).toBe(200);
    expect(admitted.knowledgeGateReads).toBeGreaterThan(0);

    const refused = await bridgeCall({ killed: true });
    expect(refused.status).toBe(429);
    // Pin which 429 this is. Every counter here admits, so today only the kill switch can refuse —
    // but an earlier 429 added to this route later (an origin throttle, a mint cap) would keep this
    // test green while the ordering invariant it exists for went uncovered.
    expect(refused.code).toBe('daily_bridge_budget_exhausted');
    expect(refused.knowledgeGateReads).toBe(0);
  });
});

async function bridgeCall(options: { readonly killed: boolean }): Promise<{
  readonly status: number;
  readonly code: unknown;
  readonly knowledgeGateReads: number;
}> {
  const configStore = new InMemoryConfigStore();
  const registry = new ServerRegistry(undefined, undefined, configStore);
  const scope = { level: 'env' as const, ...tenant };
  await configStore.setConfigValue({
    kind: 'variable',
    scope,
    name: 'NOODLE_KNOWLEDGE_ENABLED',
    value: 'true',
  });
  await configStore.setConfigValue({
    kind: 'secret',
    scope,
    name: 'MODEL_KEY',
    value: 'provider-secret',
  });

  // Counts exactly the await `resolveAssistantKnowledge` performs before it can answer. `wireKnowledge`
  // takes its registry structurally, so the real wiring stays and only the bound port is observed.
  const gateReads = vi.fn();
  const stores = defaultKnowledgeStores();
  wireKnowledge(
    {
      setKnowledgeDeployHooks: (hooks, search) =>
        registry.setKnowledgeDeployHooks(hooks, (tenantRef, components) => {
          const port = search?.(tenantRef, components);
          if (!port) throw new Error('knowledge search factory missing');
          return {
            ...port,
            enabled: () => {
              gateReads();
              return port.enabled();
            },
          };
        }),
      getActiveByTenant: (ref) => registry.getActiveByTenant(ref),
    } as unknown as Parameters<typeof wireKnowledge>[0],
    stores,
    (ref) =>
      configStore.resolveConfigValues('variable', {
        level: 'env',
        org: ref.org,
        app: ref.app,
        env: ref.env,
      }),
    1024 * 1024,
  );
  await stores.staging.put(
    `${tenant.org}/${tenant.app}/${tenant.env}`,
    sha(DOC),
    Buffer.from(DOC),
    Buffer.byteLength(DOC),
  );

  const deployed = await registry.deploy(tenant, MANIFEST, { accessMode: 'public' });
  expect(deployed.ok, JSON.stringify(deployed)).toBe(true);

  const publicEmbeds = new InMemoryPublicEmbedStore();
  const embed = await publicEmbeds.ensure({ ...tenant, surfaceMode: 'public', now: new Date() });
  const server = createServer(
    createServiceHandler(registry, {
      assistantStore: new InMemoryAssistantStore(),
      publicEmbeds,
      configStore,
      admissionCounters: allowingCounters(),
      // `turnsPerDay: 0` is the operator's documented emergency stop. One kill switch, not two: it
      // stops the tools a page agent can reach without ever running a turn.
      ...(options.killed ? { admissionEnvelope: clamp({ turnsPerDay: 0 }) } : {}),
    } as unknown as Parameters<typeof createServiceHandler>[1]),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const mint = await fetch(`${base}/v1/assistant/public-sessions`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ embedId: embed.embedId }),
  });
  expect(mint.status, await mint.clone().text()).toBe(201);
  const session = await mint.json();

  // Minting resolves nothing about knowledge; only the apps route does. Count from here so the
  // assertion is about the bridge call alone.
  gateReads.mockClear();

  const response = await fetch(`${base}/v1/assistant/apps`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.token}`,
      origin: ORIGIN,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ bridge: 'webmcp', method: 'tools/call', params: { name: 'ask' } }),
  });
  const payload = (await response.json().catch(() => ({}))) as { readonly code?: unknown };
  return {
    status: response.status,
    code: payload.code,
    knowledgeGateReads: gateReads.mock.calls.length,
  };
}

function allowingCounters() {
  return {
    durable: true,
    consume: async ({ limit }: { readonly limit: number }) => ({ allowed: true, used: 1, limit }),
    peek: async () => 0,
  };
}
