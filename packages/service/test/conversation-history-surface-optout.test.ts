import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryDailyCounterStore } from '@noodle-borg/admission-limits/portable';
import {
  ChannelCoordinator,
  InMemoryAssistantStore,
  InMemoryChannelStore,
  InMemoryPublicEmbedStore,
} from '@noodle-borg/assistant-gateway/portable';
import { MODULE_API_VERSION } from '@noodle-borg/module';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';
import { ChannelWorkerLoop } from '../src/channels/worker-loop.js';
import { InMemoryConversationHistoryStore } from '../src/conversation-history/memory-store.js';
import { createServiceHandler, InMemoryControlPlaneStore, ServerRegistry } from '../src/index.js';
import { InMemoryOperationEvidenceStore } from '../src/operation-evidence-memory.js';
import type { TenantRef } from '../src/store.js';

/**
 * A surface declared `history: false` in server.ts never keeps chats (ADR 0241 decision 11), even when
 * the installation records conversations: it captures nothing and states no retention window, while a
 * sibling surface of the same application keeps recording under the business's setting.
 */
const WWW = 'https://www.acme.test';
const APP = 'https://app.acme.test';
const TENANT: TenantRef = { org: 'acme', app: 'clinic', env: 'prod' };
const manifest = `manifestVersion: "2"
server:
  name: clinic
  version: 1.0.0
  title: Acme
  assistant:
    model: { kind: noodle-managed }
    allowedOrigins: ["${WWW}", "${APP}"]
    surfaces:
      - { mode: public, origins: ["${WWW}"], capabilities: [{ kind: tool, name: ask }] }
      - { mode: authenticated, origins: ["${APP}"], history: false }
      - { kind: messaging, channel: whatsapp, mode: public, capabilities: [{ kind: tool, name: ask }], history: false }
tools:
  - name: ask
    description: Answer a question.
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    inputSchema: { type: object, properties: {}, additionalProperties: false }
    fulfilment: { steps: [], output: { answer: Hello } }
`;

/** A durable stand-in; real durability is proven by the counter store's own parity suite. */
class DurableCounters extends InMemoryDailyCounterStore {
  override readonly durable = true;
}

describe('a surface declared history: false', () => {
  const registry = new ServerRegistry();
  const assistants = new InMemoryAssistantStore();
  const publicEmbeds = new InMemoryPublicEmbedStore();
  const history = new InMemoryConversationHistoryStore();
  const channels = new InMemoryChannelStore();
  const worker = new ChannelWorkerLoop();
  const sent: { text?: { body: string } }[] = [];
  const callbackSecret = 'b'.repeat(32);
  let http: Server;
  let base: string;
  let bindingId: string;
  let installationId: string;
  let client: { readonly id: string; readonly clientSecret: string };

  const owner = (path: string, method = 'GET', body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: 'Bearer owner',
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function exchange(origin: string, user: string) {
    const response = await fetch(`${base}/v1/assistant/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(`${client.id}:${client.clientSecret}`).toString('base64')}`,
      },
      body: JSON.stringify({ origin, user: { id: user } }),
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(201);
    return body as { readonly token: string; readonly history?: unknown };
  }
  async function turn(token: string, origin: string, message: string) {
    const response = await fetch(`${base}/v1/assistant/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, origin },
      body: JSON.stringify({ message }),
    });
    const stream = await response.text();
    expect(response.status, stream).toBe(200);
    expect(stream).not.toContain('event: error');
  }
  const conversations = async (channel: 'website' | 'whatsapp') =>
    history.list(TENANT, { now: Date.now(), limit: 10, channel });
  async function whatsapp(text: string) {
    const before = sent.length;
    const response = await fetch(`${base}/v1/channels/whatsapp/webhooks/${bindingId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-noodle-webhook-secret': callbackSecret },
      body: JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { phone_number_id: 'owned' },
                  messages: [
                    {
                      id: `incoming-${randomUUID()}`,
                      from: '15551234567',
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      type: 'text',
                      text: { body: text },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(sent.length).toBe(before + 1), { timeout: 15_000 });
  }

  beforeAll(async () => {
    for (const [name, value] of [
      ['WHATSAPP_API_KEY', 'a'.repeat(32)],
      ['WHATSAPP_WEBHOOK_SECRET', callbackSecret],
    ] as const)
      await registry.configStore.setConfigValue({
        kind: 'secret',
        scope: { level: 'env', ...TENANT },
        name,
        value,
      });
    const controlPlane = new InMemoryControlPlaneStore();
    await controlPlane.createOrgWithOwner({
      slug: 'acme',
      owner: { subject: 'owner', email: 'owner@example.test' },
    });
    const allowance = async () => ({ maximumDays: 30, defaultDays: 30, revision: 'plan-v1' });
    const contributions = { resolveActivityHistoryAllowance: allowance };
    http = createServer(
      createServiceHandler(registry, {
        controlPlaneStore: controlPlane,
        businessInformationStore: new InMemoryBusinessInformationStore(),
        businessInformationEnabled: true,
        assistantStore: assistants,
        publicEmbeds,
        admissionCounters: new DurableCounters(),
        operationEvidence: {
          store: new InMemoryOperationEvidenceStore(),
          epoch: 'surface-optout-epoch',
          identityKey: 'surface-optout-identity-key-over-32-characters',
        },
        conversationHistory: { store: history },
        loadedModules: [
          {
            module: {
              name: 'history-plan',
              version: '1.0.0',
              apiVersion: MODULE_API_VERSION,
              init: () => contributions,
            },
            contributions,
            position: 0,
          },
        ],
        publicBaseUrl: 'https://service.example',
        deployGate: {
          authorize: async () => ({
            ok: true,
            identity: { subject: 'owner', email: 'owner@example.test', superAdmin: false },
          }),
        },
        whatsapp: {
          store: channels,
          worker,
          providerFetch: async (url, init) => {
            const endpoint = new URL(String(url));
            if (endpoint.pathname === '/health_status')
              return Response.json({
                id: 'owned',
                health_status: { can_send_message: 'AVAILABLE' },
              });
            if (endpoint.pathname === '/v1/configs/webhook') return Response.json({ url: '' });
            if (endpoint.pathname === '/messages') {
              sent.push(JSON.parse(String(init?.body)));
              return Response.json({ messages: [{ id: `wamid.${sent.length}` }] });
            }
            throw new Error('unexpected provider operation');
          },
        },
        managedAssistantModelResolver: {
          resolve: async () => ({
            source: 'noodle-managed',
            baseUrl: 'https://model.example/v1',
            model: 'test-pinned',
            apiKey: 'model-secret',
            requestPolicy: { maxModelStepsPerTurn: 3, maxCompletionTokens: 1000 },
            inferenceCost: {
              version: 'test-bounds',
              validUntil: '2099-01-01T00:00:00Z',
              maxInputTokens: 10000,
              maxBilledOutputTokens: 2000,
              inputMicroUsdPerMillionTokens: 300000,
              outputMicroUsdPerMillionTokens: 2500000,
            },
          }),
        },
        assistantModelFetch: async () =>
          Response.json({
            choices: [{ message: { role: 'assistant', content: 'We open at nine.' } }],
            usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
          }),
      }),
    );
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const deployed = await registry.deploy(TENANT, manifest, { accessMode: 'public' });
    if (!deployed.ok) throw new Error(JSON.stringify(deployed.errors));
    // A newly created installation records conversations from day one (ADR 0241 decision 8).
    const created = await owner('/v1/orgs/acme/solution-installations', 'POST', {
      definition: {
        kind: 'private',
        publisherOrg: 'acme',
        app: TENANT.app,
        environment: TENANT.env,
        deploymentId: deployed.deploymentId,
      },
      appSlug: TENANT.app,
      environment: TENANT.env,
      retentionDays: 30,
    });
    expect(created.status, await created.clone().text()).toBe(201);
    installationId = (await created.json()).data.installation.id;
    const minted = await owner(
      `/v1/orgs/acme/apps/${TENANT.app}/envs/prod/assistant/clients`,
      'POST',
      {
        name: 'backend',
      },
    );
    expect(minted.status, await minted.clone().text()).toBe(201);
    client = await minted.json();
    const configured = await owner(
      `/v1/orgs/acme/apps/${TENANT.app}/envs/prod/channels/whatsapp`,
      'PUT',
      {
        expectedRevision: 0,
        phoneNumberId: 'owned',
        apiKeySecret: 'WHATSAPP_API_KEY',
        webhookSecret: 'WHATSAPP_WEBHOOK_SECRET',
        capabilities: [{ kind: 'tool', name: 'ask' }],
        supportEmail: 'hello@acme.test',
      },
    );
    expect(configured.status, await configured.clone().text()).toBe(200);
    const { data: binding } = await configured.json();
    bindingId = binding.id;
    const coordinator = new ChannelCoordinator(channels, () => Date.now());
    await coordinator.markReady(bindingId, binding.revision);
    await coordinator.setState(bindingId, 'enabled', 'operator', 'enable', binding.revision);
    worker.start();
  });
  afterAll(async () => {
    await worker.stop();
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
  });

  it('keeps no chats and states no window on the opted-out surface', async () => {
    const signedIn = await exchange(APP, 'sara_91');
    expect(signedIn).not.toHaveProperty('history');
    await turn(signedIn.token, APP, 'Can I move my appointment?');
    expect(await conversations('website')).toEqual([]);
  });

  it('keeps recording the sibling surface of the same application', async () => {
    const embed = await publicEmbeds.ensure({ ...TENANT, surfaceMode: 'public', now: new Date() });
    const response = await fetch(`${base}/v1/assistant/public-sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: WWW },
      body: JSON.stringify({ embedId: embed.embedId }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const visitor = (await response.json()) as {
      readonly token: string;
      readonly history?: unknown;
    };
    expect(visitor.history).toEqual({ retentionDays: 30 });
    await turn(visitor.token, WWW, 'When do you open?');
    const [recorded, ...others] = await conversations('website');
    expect(others).toEqual([]);
    expect(recorded?.subject.kind).toBe('anonymous');
  });

  it('keeps no WhatsApp chats and states no window in the first reply', async () => {
    await whatsapp('Are you open Sunday?');
    expect(sent.at(-1)?.text?.body).toMatch(/^I’m Acme’s AI assistant\.\n\n/);
    expect(await conversations('whatsapp')).toEqual([]);
  });

  it('tells the operator which surfaces the application keeps no chats on', async () => {
    const response = await owner(
      `/v1/orgs/acme/solution-installations/${installationId}/history/settings`,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const { data } = await response.json();
    // The business still chose to record: its setting is unchanged, and only these surfaces opt out.
    expect(data.conversations).toMatchObject({
      state: 'on',
      retentionDays: 30,
      disabledByApplication: ['authenticatedWebsite', 'publicMessaging'],
    });
  });
});
