import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ChannelCoordinator,
  InMemoryAssistantStore,
  InMemoryChannelStore,
} from '@noodle-borg/assistant-gateway/portable';
import { MODULE_API_VERSION } from '@noodle-borg/module';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { privateDefinitionFromDeployment } from '../src/business-information/definition-resolver.js';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';
import { ChannelWorkerLoop } from '../src/channels/worker-loop.js';
import type { ConversationSubject } from '../src/conversation-history/contracts.js';
import { InMemoryConversationHistoryStore } from '../src/conversation-history/memory-store.js';
import { createServiceHandler, InMemoryControlPlaneStore, ServerRegistry } from '../src/index.js';
import { InMemoryOperationEvidenceStore } from '../src/operation-evidence-memory.js';
import type { TenantRef } from '../src/store.js';

/**
 * Capture through the hosted composition (ADR 0241): no policy is injected, so each tenant's
 * installation history setting decides. An existing installation records nothing until it opts in; a
 * newly created one records from day one; Off hides existing history and stops new capture.
 */
const ORIGIN = 'https://www.acme.test';
const EXISTING: TenantRef = { org: 'acme', app: 'site', env: 'prod' };
const CREATED: TenantRef = { org: 'acme', app: 'shop', env: 'prod' };
/** A Preview environment of the existing site: deployed after production, so never production. */
const PREVIEW: TenantRef = { org: 'acme', app: 'site', env: 'dev' };
const key = (tenant: TenantRef) => `${tenant.app}/${tenant.env}`;
const CARD = '4242 4242 4242 4242';
const manifest = (name: string) => `manifestVersion: "2"
server:
  name: ${name}
  version: 1.0.0
  title: Acme
  assistant:
    model: { kind: noodle-managed }
    allowedOrigins: ["${ORIGIN}"]
    surfaces:
      - { mode: authenticated, origins: ["${ORIGIN}"], capabilities: [{ kind: tool, name: ask }] }
      - { kind: messaging, channel: whatsapp, mode: public, capabilities: [{ kind: tool, name: ask }] }
  collections:
    - name: leads
      title: Leads
      description: People who asked Acme for help.
      schemaVersion: 1
      recordSchema:
        type: object
        additionalProperties: false
        required: [name]
        properties: { name: { type: string, maxLength: 120 } }
tools:
  - name: ask
    description: Answer a question.
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    inputSchema: { type: object, properties: {}, additionalProperties: false }
    fulfilment: { steps: [], output: { answer: Hello } }
`;

describe('conversation capture through the hosted composition', () => {
  const registry = new ServerRegistry();
  const business = new InMemoryBusinessInformationStore();
  const assistants = new InMemoryAssistantStore();
  const history = new InMemoryConversationHistoryStore();
  const channels = new InMemoryChannelStore();
  const worker = new ChannelWorkerLoop();
  const sent: { text?: { body: string } }[] = [];
  const deployments = new Map<string, string>();
  const callbackSecret = 'b'.repeat(32);
  let http: Server;
  let base: string;
  let bindingId: string;

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
  async function webTurn(tenant: TenantRef, subject: string, message: string) {
    const deploymentId = deployments.get(key(tenant)) ?? '';
    const { client } = await assistants.createClient({
      name: 'web',
      tenant,
      deploymentId,
      allowedOrigins: [ORIGIN],
      now: new Date(),
    });
    const { token } = await assistants.createSession({
      clientId: client.id,
      tenant,
      deploymentId,
      origin: ORIGIN,
      caller: { subject, identityKind: 'customer' },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      absoluteExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const response = await fetch(`${base}/v1/assistant/turns`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        origin: ORIGIN,
      },
      body: JSON.stringify({ message }),
    });
    const stream = await response.text();
    expect(response.status, stream).toBe(200);
    expect(stream).not.toContain('event: error');
  }
  const customer = (ref: string): ConversationSubject => ({ kind: 'customer', ref });
  async function recorded(tenant: TenantRef, subject: ConversationSubject, channel = 'website') {
    const id = await history.findRecent(tenant, channel as 'website', subject, 0);
    const read = id ? await history.read(tenant, id, Date.now()) : undefined;
    return read?.items.map((item) => item.kind === 'message' && [item.role, item.text]) ?? [];
  }
  async function whatsapp(text: string, from = '15551234567') {
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
                      from,
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
  async function whatsappConversations() {
    const rows = await history.list(EXISTING, { now: Date.now(), limit: 10, channel: 'whatsapp' });
    return Promise.all(rows.map((row) => history.read(EXISTING, row.id, Date.now())));
  }
  async function historySettings(installationId: string, change?: Record<string, unknown>) {
    const path = `/v1/orgs/acme/solution-installations/${installationId}/history/settings`;
    const current = (await (await owner(path)).json()).data;
    if (!change) return current;
    const saved = await owner(path, 'PUT', { expectedRevision: current.revision, ...change });
    expect(saved.status, await saved.clone().text()).toBe(200);
    return (await saved.json()).data.settings;
  }

  beforeAll(async () => {
    for (const [name, value] of [
      ['WHATSAPP_API_KEY', 'a'.repeat(32)],
      ['WHATSAPP_WEBHOOK_SECRET', callbackSecret],
    ] as const)
      await registry.configStore.setConfigValue({
        kind: 'secret',
        scope: { level: 'env', ...EXISTING },
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
        businessInformationStore: business,
        businessInformationEnabled: true,
        assistantStore: assistants,
        operationEvidence: {
          store: new InMemoryOperationEvidenceStore(),
          epoch: 'composed-history-epoch',
          identityKey: 'composed-history-identity-key-over-32-characters',
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
            choices: [{ message: { role: 'assistant', content: 'We ship to Dubai.' } }],
            usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
          }),
      }),
    );
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    for (const tenant of [EXISTING, CREATED, PREVIEW]) {
      const deployed = await registry.deploy(tenant, manifest(tenant.app), {
        accessMode: 'public',
      });
      if (!deployed.ok) throw new Error(JSON.stringify(deployed.errors));
      deployments.set(key(tenant), deployed.deploymentId);
    }
    // Installations that predate conversation history: written straight to the store.
    for (const tenant of [EXISTING, PREVIEW]) {
      const target = await registry.getActiveByTenant(tenant);
      if (!target) throw new Error('deployment unavailable');
      const deploymentId = deployments.get(key(tenant)) ?? '';
      await business.createInstallation({
        scope: { ...tenant, installationId: `site-${tenant.env}` },
        definition: privateDefinitionFromDeployment(
          { publisherOrg: 'acme', app: 'site', environment: tenant.env, deploymentId },
          { ...tenant, environment: tenant.env, deploymentId, artifact: target.served.artifact },
        ),
        managedCollections: ['leads'],
        actorSubject: 'owner',
        actorEmail: 'owner@example.test',
      });
    }
    const configured = await owner('/v1/orgs/acme/apps/site/envs/prod/channels/whatsapp', 'PUT', {
      expectedRevision: 0,
      phoneNumberId: 'owned',
      apiKeySecret: 'WHATSAPP_API_KEY',
      webhookSecret: 'WHATSAPP_WEBHOOK_SECRET',
      capabilities: [{ kind: 'tool', name: 'ask' }],
      supportEmail: 'hello@acme.test',
    });
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

  it('records nothing for an existing installation until an Owner opts in', async () => {
    await webTurn(EXISTING, 'sara_91', 'Do you ship to Dubai?');
    expect(await recorded(EXISTING, customer('sara_91'))).toEqual([]);
    await whatsapp(`My card is ${CARD}`);
    expect(await whatsappConversations()).toEqual([]);
    // Nothing is recorded, so the first reply's AI disclosure states no retention window.
    expect(sent.at(-1)?.text?.body).toMatch(/^I’m Acme’s AI assistant\.\n\n/);
    expect((await historySettings('site-prod')).conversations.state).toBe('not_enabled');

    await historySettings('site-prod', { conversations: { retentionDays: 14 } });
    await webTurn(EXISTING, 'omar_7', 'Do you ship to Dubai?');
    expect(await recorded(EXISTING, customer('omar_7'))).toEqual([
      ['user', 'Do you ship to Dubai?'],
      ['assistant', 'We ship to Dubai.'],
    ]);
  });

  it('records an opted-in WhatsApp exchange under the participant with card numbers masked', async () => {
    await whatsapp(`Charge my card ${CARD} please`);
    const [conversation, ...others] = await whatsappConversations();
    expect(others).toEqual([]);
    expect(conversation?.subject.kind).toBe('participant');
    expect(conversation?.subject.ref).not.toContain('15551234567');
    const texts = conversation?.items.map((item) => item.kind === 'message' && item.text);
    expect(texts?.[0]).toBe('Charge my card •••• 4242 please');
    expect(JSON.stringify(conversation)).not.toContain(CARD);
    expect(texts).toHaveLength(2);
  });

  it('turning conversations off hides existing history and stops new capture', async () => {
    expect(await whatsappConversations()).toHaveLength(1);
    await historySettings('site-prod', { conversations: 'off' });
    expect(await whatsappConversations()).toEqual([]);
    expect(await recorded(EXISTING, customer('omar_7'))).toEqual([]);
    await webTurn(EXISTING, 'lina_3', 'Are you open today?');
    expect(await recorded(EXISTING, customer('lina_3'))).toEqual([]);
    await whatsapp('Still there?');
    expect(await whatsappConversations()).toEqual([]);
  });

  it('states the WhatsApp window in the first reply once conversations are recorded', async () => {
    await historySettings('site-prod', { conversations: { retentionDays: 14 } });
    await whatsapp('Hello, are you open?', '15559876543');
    expect(sent.at(-1)?.text?.body).toMatch(
      /^I’m Acme’s AI assistant\. Chats are kept for 14 days\.\n\n/,
    );
    await whatsapp('And on Sunday?', '15559876543');
    expect(sent.at(-1)?.text?.body).not.toContain('Chats are kept');
  });

  it('forgets a WhatsApp participant from history and working memory, keeping safeguards', async () => {
    await whatsapp('Please forget me', '15550001111');
    const [conversation] = (await whatsappConversations()).filter((row) =>
      row?.items.some((item) => item.kind === 'message' && item.text === 'Please forget me'),
    );
    const ref = conversation?.subject.ref ?? '';
    expect(ref).toMatch(/^p_[a-f0-9]{64}$/);
    const memory = () =>
      channels.transaction([bindingId], async (tx) => ({
        participant: await tx.get(bindingId, ref),
        events: (await tx.list(bindingId, { kind: 'event', limit: 1000 }))
          .map((row) => row.value as { participantId: string; text?: string; code?: string })
          .filter((event) => event.participantId === ref),
      }));
    expect((await memory()).participant).toBeDefined();
    const coordinator = new ChannelCoordinator(channels, () => Date.now());
    await coordinator.block(bindingId, ref, 'operator', 'block-before-forget', null);
    const forget = (subject: unknown) =>
      owner('/v1/orgs/acme/solution-installations/site-prod/conversations/forget', 'POST', {
        subject,
      });
    const response = await forget({ kind: 'participant', ref });
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await response.json()).data.forgotten.conversations).toBe(1);
    const after = await memory();
    expect(after.participant).toBeUndefined();
    expect(after.events.length).toBeGreaterThan(0);
    for (const event of after.events) expect(event).toMatchObject({ code: 'forgotten' });
    expect(JSON.stringify(after.events)).not.toContain('Please forget me');
    // A content-free control survives erasure.
    expect((await coordinator.blocks(bindingId)).map((block) => block.participantId)).toContain(
      ref,
    );
    // A reference that cannot name a participant never reaches the channel store.
    expect((await forget({ kind: 'participant', ref: 'binding' })).status).toBe(200);
    expect((await coordinator.internal(bindingId)).id).toBe(bindingId);
  });

  it('records a newly created installation from day one at the plan default', async () => {
    const created = await owner('/v1/orgs/acme/solution-installations', 'POST', {
      definition: {
        kind: 'private',
        publisherOrg: 'acme',
        app: 'shop',
        environment: 'prod',
        deploymentId: deployments.get(key(CREATED)),
      },
      appSlug: 'shop',
      environment: 'prod',
      retentionDays: 30,
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const { data } = await created.json();
    expect((await historySettings(data.installation.id)).conversations).toMatchObject({
      state: 'on',
      retentionDays: 30,
    });
    await webTurn(CREATED, 'noor_2', 'Do you ship to Dubai?');
    expect(await recorded(CREATED, customer('noor_2'))).toHaveLength(2);
  });

  it('records a Preview environment for three days without its opt-in, apart from production', async () => {
    expect((await historySettings('site-dev')).conversations.state).toBe('not_enabled');
    const before = Date.now();
    await webTurn(PREVIEW, 'builder_test', 'Do you ship to Dubai?');
    const id = await history.findRecent(PREVIEW, 'website', customer('builder_test'), 0);
    const preview = id ? await history.read(PREVIEW, id, Date.now()) : undefined;
    expect(preview?.items).toHaveLength(2);
    for (const item of preview?.items ?? []) expect(item.expiresAt - item.at).toBe(3 * 86_400_000);
    expect(preview?.items[0]?.at).toBeGreaterThanOrEqual(before);
    // The production installation never lists or reads the Preview conversation.
    const production = await history.list(EXISTING, { now: Date.now(), limit: 100 });
    expect(production.map((row) => row.id)).not.toContain(id);
    expect(id ? await history.read(EXISTING, id, Date.now()) : undefined).toBeUndefined();
    expect(await recorded(EXISTING, customer('builder_test'))).toEqual([]);
    expect((await historySettings('site-dev')).conversations.state).toBe('not_enabled');
  });
});
