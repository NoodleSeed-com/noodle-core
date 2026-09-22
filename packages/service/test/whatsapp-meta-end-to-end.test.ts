import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PostgresChannelStore } from '@noodle-borg/assistant-gateway/postgres';
import { defaultKnowledgeStores, wireKnowledge } from '@noodle-borg/knowledge-operations';
import { SecretBox, staticMasterKeyProvider } from '@noodle-borg/runtime';
import { createLogger } from '@noodle-borg/transport-http';
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
describe.skipIf(!databaseUrl)(
  'Meta Cloud API WhatsApp channel through real HTTP and PostgreSQL',
  () => {
    const schema = `whatsapp_meta_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: databaseUrl, max: 1 });
    const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    const worker = new ChannelWorkerLoop();
    const businessToken = 'EAAG'.padEnd(200, 'x');
    const meta = {
      appId: '931692592882983',
      appSecret: 'c'.repeat(32),
      verifyToken: 'd'.repeat(32),
      graphVersion: 'v25.0',
    };
    const phoneNumberId = '1040350119157691',
      wabaId = '2120347998801839';
    const sent: Array<{ text: { body: string }; to: string }> = [];
    const logs: string[] = [];
    const modelRequests: unknown[] = [];
    const registry = new ServerRegistry();
    let http: Server, base: string;
    let subscribed = false;
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
      await registry.configStore.setConfigValue({
        kind: 'secret',
        scope: { level: 'env', ...tenant },
        name: 'WHATSAPP_ACCESS_TOKEN',
        value: businessToken,
      });
      const knowledge = defaultKnowledgeStores();
      wireKnowledge(
        registry,
        knowledge,
        (ref) => registry.configStore.resolveConfigValues('variable', { level: 'env', ...ref }),
        1024 * 1024,
      );
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
          logger: createLogger({ level: 'info', sink: (line) => logs.push(line) }),
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
            meta,
            providerFetch: async (url, init) => {
              expect(new Headers(init?.headers).get('authorization')).toBe(
                `Bearer ${businessToken}`,
              );
              const endpoint = new URL(String(url));
              expect(endpoint.origin).toBe('https://graph.facebook.com');
              if (endpoint.pathname === `/v25.0/${phoneNumberId}`)
                return Response.json({
                  id: phoneNumberId,
                  health_status: { can_send_message: 'AVAILABLE' },
                });
              if (endpoint.pathname === `/v25.0/${wabaId}/subscribed_apps`) {
                if (init?.method === 'POST') {
                  subscribed = true;
                  return Response.json({ success: true });
                }
                return Response.json({
                  data: subscribed ? [{ whatsapp_business_api_data: { id: meta.appId } }] : [],
                });
              }
              if (endpoint.pathname === `/v25.0/${phoneNumberId}/messages`) {
                if (typeof init?.body !== 'string') throw new Error('message body missing');
                sent.push(JSON.parse(init.body));
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
            if (typeof init?.body !== 'string') throw new Error('model request body missing');
            const input = JSON.parse(init.body);
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
    it('configures a Meta number, subscribes its WABA, enables and replies through Graph with the business token', async () => {
      const configured = await call('', 'PUT', {
        expectedRevision: 0,
        provider: 'meta',
        phoneNumberId,
        wabaId,
        apiKeySecret: 'WHATSAPP_ACCESS_TOKEN',
        capabilities: [
          { kind: 'tool', name: 'identity' },
          { kind: 'knowledge', name: 'product' },
        ],
        supportEmail: 'hello@noodleseed.com',
      });
      expect(configured.status).toBe(200);
      const { data: binding } = await configured.json();
      expect(binding).toMatchObject({ provider: 'meta', wabaId, state: 'paused' });
      const before = await (await call('/readiness', 'POST', {})).json();
      expect(before.data.checks).toContainEqual({
        name: 'webhook',
        status: 'unavailable',
        code: 'webhook_not_configured',
      });
      const webhook = await call('/webhook', 'POST', { expectedRevision: binding.revision });
      expect(webhook.status).toBe(200);
      expect((await webhook.json()).data).toEqual({
        url: 'https://service.example/v1/channels/whatsapp/meta',
        matches: true,
        authenticated: true,
      });
      const readiness = await (await call('/readiness', 'POST', {})).json();
      expect(readiness.data, JSON.stringify(readiness)).toMatchObject({
        ready: true,
        webhookUrl: 'https://service.example/v1/channels/whatsapp/meta',
      });
      expect(
        (await call('/state', 'PATCH', { expectedRevision: binding.revision, state: 'enabled' }))
          .status,
      ).toBe(200);
      const payload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: wabaId,
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { display_phone_number: '15556661583', phone_number_id: phoneNumberId },
                  contacts: [{ profile: { name: 'Maya' }, wa_id: '15551234567' }],
                  messages: [
                    {
                      id: 'wamid.incoming-1',
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
      const deliver = (value: unknown, secret = meta.appSecret) => {
        const raw = JSON.stringify(value);
        return fetch(`${base}/v1/channels/whatsapp/meta`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
          },
          body: raw,
        });
      };
      expect((await deliver(payload, 'e'.repeat(32))).status).toBe(401);
      expect((await deliver(payload)).status).toBe(200);
      expect((await deliver(payload)).status).toBe(200);
      await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 10_000 });
      expect(sent[0]).toMatchObject({ to: '15551234567', type: 'text' });
      expect(sent[0]?.text.body).toContain('Noodle Seed helps');
      const status = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: wabaId,
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { phone_number_id: phoneNumberId },
                  statuses: [
                    {
                      id: 'wamid.1',
                      status: 'delivered',
                      timestamp: String(Math.floor(Date.now() / 1000)),
                    },
                  ],
                },
              },
            ],
          },
        ],
      };
      expect((await deliver(status)).status).toBe(200);
      const events = await (await call('/events')).json();
      expect(events.data[0].state).toBe('delivered');
      expect(JSON.stringify(events)).not.toContain('15551234567');
      const reply = logs.find((line) => line.includes('assistant.channel.reply'));
      expect(JSON.parse(reply ?? '{}')).toMatchObject({
        provider: 'meta',
        bindingId: binding.id,
        providerMessageId: 'wamid.1',
        state: 'accepted',
      });
      const all = logs.join('\n');
      for (const secret of [businessToken, meta.appSecret, '15551234567', 'What is Noodle Seed?'])
        expect(all).not.toContain(secret);
    });
  },
);
