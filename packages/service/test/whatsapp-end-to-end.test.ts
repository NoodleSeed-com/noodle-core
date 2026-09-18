import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PostgresChannelStore } from '@noodle-borg/assistant-gateway/postgres';
import { defaultKnowledgeStores, wireKnowledge } from '@noodle-borg/knowledge-operations';
import { SecretBox, staticMasterKeyProvider } from '@noodle-borg/runtime';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChannelSecretBoxCipher } from '../src/channels/cipher.js';
import { ChannelWorkerLoop } from '../src/channels/worker-loop.js';
import { createServiceHandler, InMemoryControlPlaneStore, ServerRegistry } from '../src/index.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
const document =
  'Noodle Seed helps businesses serve customers through AI assistants. Public visitors do not need an account.';
const documentSha = createHash('sha256').update(document).digest('hex');
const manifest = `manifestVersion: "2"
server:
  name: channel_test
  version: 1.0.0
  title: Noodle Seed
  assistant:
    model: { kind: noodle-managed }
    allowedOrigins: [https://noodleseed.dev]
    surfaces:
      - { mode: public, origins: [https://noodleseed.dev], capabilities: [{kind: tool, name: identity}, {kind: knowledge, name: product}] }
      - { kind: messaging, channel: whatsapp, mode: public, capabilities: [{kind: tool, name: identity}, {kind: knowledge, name: product}] }
  knowledge:
    - name: product
      title: Product guide
      description: Reviewed Noodle Seed facts.
      documents:
        - { path: product.md, title: Product guide, sha256: ${documentSha}, bytes: ${Buffer.byteLength(document)} }
      sites: []
tools:
  - name: identity
    description: Identify the business.
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    inputSchema: { type: object, properties: {}, additionalProperties: false }
    fulfilment: { steps: [], output: { name: Noodle Seed } }
`;
describe.skipIf(!databaseUrl)('WhatsApp channel through real HTTP and encrypted PostgreSQL', () => {
  const schema = `whatsapp_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  const worker = new ChannelWorkerLoop();
  const providerSecret = 'a'.repeat(32),
    callbackSecret = 'b'.repeat(32);
  const sent: Array<{ text: { body: string }; to: string }> = [];
  const modelRequests: unknown[] = [];
  const registry = new ServerRegistry();
  let http: Server, base: string;
  let webhook: { url: string; headers?: Record<string, string> } = { url: '' };
  const tenant = { org: 'acme', app: 'site', env: 'prod' };
  const path = '/v1/orgs/acme/apps/site/envs/prod/channels/whatsapp';
  async function call(suffix: string, method = 'GET', body?: unknown, token = 'owner') {
    return fetch(`${base}${path}${suffix}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const store = new PostgresChannelStore(
      pool,
      new ChannelSecretBoxCipher(new SecretBox(staticMasterKeyProvider(randomBytes(32)))),
    );
    await store.ensureSchema();
    for (const [name, value] of [
      ['WHATSAPP_API_KEY', providerSecret],
      ['WHATSAPP_WEBHOOK_SECRET', callbackSecret],
    ])
      await registry.configStore.setConfigValue({
        kind: 'secret',
        scope: { level: 'env', ...tenant },
        name: name!,
        value: value!,
      });
    const knowledge = defaultKnowledgeStores();
    wireKnowledge(
      registry,
      knowledge,
      (ref) => registry.configStore.resolveConfigValues('variable', { level: 'env', ...ref }),
      1024 * 1024,
    );
    await registry.configStore.setConfigValue({
      kind: 'variable',
      scope: { level: 'env', ...tenant },
      name: 'NOODLE_KNOWLEDGE_ENABLED',
      value: 'true',
    });
    await knowledge.staging.put(
      'acme/site/prod',
      documentSha,
      Buffer.from(document),
      Buffer.byteLength(document),
    );
    const deployed = await registry.deploy(tenant, manifest, { accessMode: 'public' });
    if (!deployed.ok) throw new Error(JSON.stringify(deployed.errors));
    const controlPlane = new InMemoryControlPlaneStore();
    await controlPlane.createOrgWithOwner({
      slug: 'acme',
      owner: { subject: 'owner', email: 'owner@example.test' },
    });
    http = createServer(
      createServiceHandler(registry, {
        controlPlaneStore: controlPlane,
        publicBaseUrl: 'https://service.example',
        deployGate: {
          authorize: async (request) => ({
            ok: true,
            identity: {
              subject: request.headers.authorization === 'Bearer owner' ? 'owner' : 'outsider',
              email: '',
              superAdmin: false,
            },
          }),
        },
        whatsapp: {
          store,
          worker,
          providerFetch: async (url, init) => {
            expect(new Headers(init?.headers).get('D360-API-KEY')).toBe(providerSecret);
            const endpoint = new URL(String(url));
            if (endpoint.pathname === '/health_status')
              return Response.json({
                id: 'owned',
                health_status: { can_send_message: 'AVAILABLE' },
              });
            if (endpoint.pathname === '/v1/configs/webhook') {
              if (init?.method === 'POST') webhook = JSON.parse(init.body as string);
              return Response.json(webhook);
            }
            if (endpoint.pathname === '/messages') {
              sent.push(JSON.parse(init!.body as string));
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
        assistantModelFetch: async (_url, init) => {
          const input = JSON.parse(init!.body as string);
          modelRequests.push(input);
          if (!input.messages.some((message: { role: string }) => message.role === 'tool'))
            return Response.json({
              choices: [
                {
                  message: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        id: 'call-1',
                        type: 'function',
                        function: { name: 'identity', arguments: '{}' },
                      },
                      {
                        id: 'call-2',
                        type: 'function',
                        function: {
                          name: 'search_product',
                          arguments: '{"query":"public visitors account"}',
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
            });
          return Response.json({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'Noodle Seed helps businesses serve customers through AI assistants.',
                },
              },
            ],
            usage: { prompt_tokens: 150, completion_tokens: 30, total_tokens: 180 },
          });
        },
      }),
    );
    worker.start();
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await worker.stop();
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  it('configures, diagnoses, enables, answers through tools and records delivery without transcript leaks', async () => {
    expect((await call('', 'GET', undefined, 'outsider')).status).toBe(403);
    const configured = await call('', 'PUT', {
      expectedRevision: 0,
      phoneNumberId: 'owned',
      apiKeySecret: 'WHATSAPP_API_KEY',
      webhookSecret: 'WHATSAPP_WEBHOOK_SECRET',
      capabilities: [
        { kind: 'tool', name: 'identity' },
        { kind: 'knowledge', name: 'product' },
      ],
      supportEmail: 'hello@noodleseed.com',
    });
    expect(configured.status).toBe(200);
    const { data: binding } = await configured.json();
    expect(binding.state).toBe('paused');
    expect((await call('/webhook', 'POST', { expectedRevision: binding.revision })).status).toBe(
      200,
    );
    const readiness = await (await call('/readiness', 'POST', {})).json();
    expect(readiness.data, JSON.stringify(readiness)).toMatchObject({ ready: true });
    expect(
      (await call('/state', 'PATCH', { expectedRevision: binding.revision, state: 'enabled' }))
        .status,
    ).toBe(200);
    const callbackUrl = `${base}/v1/channels/whatsapp/webhooks/${binding.id}`;
    const payload = {
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
                    id: 'incoming-1',
                    from: '15551234567',
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: 'What is Noodle Seed?' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const sendCallback = (secret: string, value: unknown) =>
      fetch(callbackUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-noodle-webhook-secret': secret },
        body: JSON.stringify(value),
      });
    expect((await sendCallback('wrong', payload)).status).toBe(401);
    expect((await sendCallback(callbackSecret, payload)).status).toBe(200);
    expect((await sendCallback(callbackSecret, payload)).status).toBe(200);
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 10_000 });
    expect(sent[0]?.text.body).toContain('AI assistant');
    expect(sent[0]?.text.body).toContain('Noodle Seed helps');
    expect(modelRequests).toHaveLength(2);
    expect(JSON.stringify(modelRequests[1])).toContain('public visitors do not need an account');
    const status = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: 'owned' },
                statuses: [
                  {
                    id: 'wamid.1',
                    status: 'read',
                    timestamp: String(Math.floor(Date.now() / 1000)),
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    expect((await sendCallback(callbackSecret, status)).status).toBe(200);
    const events = await (await call('/events')).json();
    expect(events.data[0].state).toBe('read');
    expect(JSON.stringify(events)).not.toContain('15551234567');
    expect(JSON.stringify(events)).not.toContain('What is Noodle Seed?');
    const rows = await pool.query('SELECT sealed::text FROM assistant_channel_records');
    expect(JSON.stringify(rows.rows)).not.toContain('What is Noodle Seed?');
    const usage = await (await call('/usage')).json();
    expect(usage.data.spentMicroUsd).toBeGreaterThan(0);
    expect(usage.data.reservedMicroUsd).toBe(0);
  });
});
