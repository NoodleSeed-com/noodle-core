import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RequestEventInput } from '@noodle-borg/module';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createServiceHandler,
  InMemoryAssistantStore,
  InMemoryConfigStore,
  InMemoryPublicEmbedStore,
  ServerRegistry,
} from '../src/index.js';

/**
 * What the apps bridge tells the analytics stream (ADR 0220).
 *
 * A tool call over `/v1/assistant/apps` is a real, governed execution, and until now it left no
 * trace at all: the surface vocabulary had a `webmcp` value with nothing to put it on, so a browser
 * agent working a site looked exactly like a quiet day. These calls are now events like any other,
 * and the surface is what separates a browser agent from the panel — the marker selects the label,
 * never the authority.
 */

const ORIGIN = 'https://www.acme.test';
const tenant = { org: 'acme', app: 'site', env: 'prod' } as const;

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

describe('an apps-bridge tool call is an attributed request event', () => {
  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  it('attributes a bridged call to webmcp and an unmarked one to the surface that owns it', async () => {
    const plain = await appToolCall({ bridged: false });
    expect(plain.status).toBe(200);
    expect(plain.event).toMatchObject({
      method: 'tools/call',
      kind: 'usage',
      toolName: 'ask',
      outcome: 'ok',
      surface: 'assistant-public',
    });

    const bridged = await appToolCall({ bridged: true });
    expect(bridged.status).toBe(200);
    expect(bridged.event).toMatchObject({ toolName: 'ask', surface: 'webmcp', outcome: 'ok' });
  });

  it('records the budget refusal, which is the one an operator most needs to see', async () => {
    // The refusal that fires before any resolution work is the whole point of the budget: an
    // operator watching a browser agent hit its ceiling has to see it, and it used to vanish.
    const refused = await appToolCall({ bridged: true, bridgeBudgetExhausted: true });
    expect(refused.status).toBe(429);
    expect(refused.event).toMatchObject({
      method: 'tools/call',
      toolName: 'ask',
      surface: 'webmcp',
      outcome: 'tool_error',
    });
    expect(refused.event?.errorKind).toBeTypeOf('string');
  });

  it('still records a refusal when the caller never named a tool', async () => {
    // A nameless bridged call that exhausts the budget is the shape abusive traffic takes, so it
    // is the last row that should go missing. `toolName` is optional on the event; the refusal is
    // not.
    const nameless = await appToolCall({
      bridged: true,
      bridgeBudgetExhausted: true,
      omitName: true,
    });
    expect(nameless.status).toBe(429);
    expect(nameless.event).toMatchObject({
      method: 'tools/call',
      surface: 'webmcp',
      outcome: 'tool_error',
    });
    expect(nameless.event?.toolName).toBeUndefined();
  });

  it('records the 400 when a call names no tool at all', async () => {
    const nameless = await appToolCall({ bridged: true, omitName: true });
    expect(nameless.status).toBe(400);
    expect(nameless.event).toMatchObject({ surface: 'webmcp', errorKind: 'tool_name_required' });
  });

  it('records a refused call rather than losing it, and never trusts the marker for authority', async () => {
    // A tool the surface does not project: the call is rejected on the session's authority, and the
    // marker cannot change that. The event still lands, because a rejected call is exactly the
    // traffic an operator watching a browser agent needs to see.
    const denied = await appToolCall({ bridged: true, toolName: 'not_projected' });
    expect(denied.status).toBe(404);
    expect(denied.event).toMatchObject({
      method: 'tools/call',
      surface: 'webmcp',
      outcome: 'tool_error',
    });
  });
});

async function appToolCall(options: {
  readonly bridged: boolean;
  readonly toolName?: string;
  readonly bridgeBudgetExhausted?: boolean;
  readonly omitName?: boolean;
}): Promise<{ readonly status: number; readonly event: RequestEventInput | undefined }> {
  const configStore = new InMemoryConfigStore();
  const registry = new ServerRegistry(undefined, undefined, configStore);
  await configStore.setConfigValue({
    kind: 'secret',
    scope: { level: 'env', ...tenant },
    name: 'MODEL_KEY',
    value: 'provider-secret',
  });

  const deployed = await registry.deploy(tenant, MANIFEST, { accessMode: 'public' });
  expect(deployed.ok, JSON.stringify(deployed)).toBe(true);

  const events: RequestEventInput[] = [];
  const publicEmbeds = new InMemoryPublicEmbedStore();
  const embed = await publicEmbeds.ensure({ ...tenant, surfaceMode: 'public', now: new Date() });
  const server = createServer(
    createServiceHandler(registry, {
      assistantStore: new InMemoryAssistantStore(),
      publicEmbeds,
      configStore,
      admissionCounters: options.bridgeBudgetExhausted
        ? exhaustedBridgeCounters()
        : allowingCounters(),
      captureRequestEvent: (event: RequestEventInput) => events.push(event),
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

  // The mint emits its own session event; only the tool call is under test here.
  events.length = 0;

  const response = await fetch(`${base}/v1/assistant/apps`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.token}`,
      origin: ORIGIN,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      ...(options.bridged ? { bridge: 'webmcp' } : {}),
      method: 'tools/call',
      params: options.omitName ? {} : { name: options.toolName ?? 'ask' },
    }),
  });
  return {
    status: response.status,
    event: events.find((event) => event.method === 'tools/call'),
  };
}

/**
 * Refuses only the bridge counter, so the session still mints and the call still reaches the route.
 * Anything else refused here would stop the test before the exit under test.
 */
function exhaustedBridgeCounters() {
  return {
    durable: true,
    consume: async ({ key, limit }: { readonly key: string; readonly limit: number }) =>
      key.startsWith('bridge:')
        ? { allowed: false, used: limit, limit }
        : { allowed: true, used: 1, limit },
    peek: async () => 0,
  };
}

function allowingCounters() {
  return {
    durable: true,
    consume: async ({ limit }: { readonly limit: number }) => ({ allowed: true, used: 1, limit }),
    peek: async () => 0,
  };
}
