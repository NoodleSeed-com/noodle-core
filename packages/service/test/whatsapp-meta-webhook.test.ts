import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryChannelStore } from '@noodle-borg/assistant-gateway/portable';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChannelWorkerLoop } from '../src/channels/worker-loop.js';
import { createServiceHandler, InMemoryControlPlaneStore, ServerRegistry } from '../src/index.js';

const manifest = `manifestVersion: "2"
server:
  name: channel_test
  version: 1.0.0
  title: Noodle Seed
  assistant:
    model: { kind: noodle-managed }
    allowedOrigins: [https://noodleseed.dev]
    surfaces:
      - { mode: public, origins: [https://noodleseed.dev], capabilities: [{kind: tool, name: identity}] }
      - { kind: messaging, channel: whatsapp, mode: public, capabilities: [{kind: tool, name: identity}] }
tools:
  - name: identity
    description: Identify the business.
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    inputSchema: { type: object, properties: {}, additionalProperties: false }
    fulfilment: { steps: [], output: { name: Noodle Seed } }
`;
const meta = {
  appId: '931692592882983',
  appSecret: 's'.repeat(32),
  verifyToken: 'v'.repeat(32),
  graphVersion: 'v25.0',
};
const META_PHONE = '1040350119157691',
  WABA = '2120347998801839',
  DIALOG_PHONE = '2220000000000';
function payload(phone: string, waba = WABA, id = `wamid.${randomUUID()}`) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: waba,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15556661583', phone_number_id: phone },
              contacts: [{ profile: { name: 'Maya' }, wa_id: '15551234567' }],
              messages: [
                {
                  id,
                  from: '15551234567',
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: 'Hello' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}
function sign(raw: string, secret = meta.appSecret) {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}
async function serve(options: { meta?: typeof meta }) {
  const registry = new ServerRegistry();
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.createOrgWithOwner({
    slug: 'acme',
    owner: { subject: 'owner', email: 'owner@example.test' },
  });
  for (const app of ['metasite', 'dialogsite']) {
    const deployed = await registry.deploy({ org: 'acme', app, env: 'prod' }, manifest, {
      accessMode: 'public',
    });
    if (!deployed.ok) throw new Error(JSON.stringify(deployed.errors));
  }
  const worker = new ChannelWorkerLoop();
  const http: Server = createServer(
    createServiceHandler(registry, {
      controlPlaneStore: controlPlane,
      publicBaseUrl: 'https://service.example',
      deployGate: {
        authorize: async () => ({
          ok: true,
          identity: { subject: 'owner', email: '', superAdmin: false },
        }),
      },
      whatsapp: {
        store: new InMemoryChannelStore(),
        worker,
        providerFetch: async () => {
          throw new Error('no provider call expected');
        },
        ...(options.meta ? { meta: options.meta } : {}),
      },
    }),
  );
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  return { http, worker, base: `http://127.0.0.1:${(http.address() as AddressInfo).port}` };
}
describe('shared Meta WhatsApp callback', () => {
  let base: string, http: Server, worker: ChannelWorkerLoop;
  const operator = (app: string, suffix = '', method = 'GET', body?: unknown) =>
    fetch(`${base}/v1/orgs/acme/apps/${app}/envs/prod/channels/whatsapp${suffix}`, {
      method,
      headers: {
        authorization: 'Bearer owner',
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const callback = (value: unknown, signature?: string) => {
    const raw = JSON.stringify(value);
    return fetch(`${base}/v1/channels/whatsapp/meta`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(signature === undefined ? {} : { 'x-hub-signature-256': signature }),
      },
      body: raw,
    });
  };
  const signed = (value: unknown) => callback(value, sign(JSON.stringify(value)));
  const events = async (app: string) => (await (await operator(app, '/events')).json()).data;
  let metaBinding: { id: string };
  beforeAll(async () => {
    ({ base, http, worker } = await serve({ meta }));
    const configured = await operator('metasite', '', 'PUT', {
      expectedRevision: 0,
      provider: 'meta',
      phoneNumberId: META_PHONE,
      wabaId: WABA,
      apiKeySecret: 'WHATSAPP_ACCESS_TOKEN',
      capabilities: [{ kind: 'tool', name: 'identity' }],
      supportEmail: 'hello@noodleseed.com',
    });
    expect(configured.status).toBe(200);
    metaBinding = (await configured.json()).data;
    expect(metaBinding).toMatchObject({ provider: 'meta', wabaId: WABA, state: 'paused' });
    expect(
      (
        await operator('dialogsite', '', 'PUT', {
          expectedRevision: 0,
          phoneNumberId: DIALOG_PHONE,
          apiKeySecret: 'WHATSAPP_API_KEY',
          webhookSecret: 'WHATSAPP_WEBHOOK_SECRET',
          capabilities: [{ kind: 'tool', name: 'identity' }],
          supportEmail: 'hello@noodleseed.com',
        })
      ).status,
    ).toBe(200);
  });
  afterAll(async () => {
    await worker.stop();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  it('answers the verification handshake only for the configured verify token', async () => {
    const handshake = (token: string, challenge = '1158201444') =>
      fetch(
        `${base}/v1/channels/whatsapp/meta?hub.mode=subscribe&hub.challenge=${challenge}&hub.verify_token=${encodeURIComponent(token)}`,
      );
    const ok = await handshake(meta.verifyToken);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('text/plain');
    expect(await ok.text()).toBe('1158201444');
    expect((await handshake('wrong')).status).toBe(403);
    expect((await handshake(meta.verifyToken, '%3Cscript%3E%20x')).status).toBe(403);
    expect(
      (await fetch(`${base}/v1/channels/whatsapp/meta?hub.mode=unsubscribe&hub.challenge=1`))
        .status,
    ).toBe(403);
  });
  it('rejects a missing, malformed or wrongly keyed signature before reading the payload', async () => {
    const value = payload(META_PHONE);
    expect((await callback(value)).status).toBe(401);
    expect((await callback(value, 'sha256=zz')).status).toBe(401);
    expect((await callback(value, sign(JSON.stringify(value), 'x'.repeat(32)))).status).toBe(401);
    expect((await callback(value, sign(`${JSON.stringify(value)} `))).status).toBe(401);
    expect(await events('metasite')).toEqual([]);
  });
  it('acknowledges numbers it does not own, other providers and foreign WABAs without recording', async () => {
    expect((await signed(payload('9999999999'))).status).toBe(200);
    expect((await signed(payload(DIALOG_PHONE))).status).toBe(200);
    expect((await signed(payload(META_PHONE, '1111111111'))).status).toBe(200);
    expect((await signed({ object: 'page', entry: [] })).status).toBe(200);
    expect(await events('metasite')).toEqual([]);
    expect(await events('dialogsite')).toEqual([]);
  });
  it('routes a signed batch by phone-number id and refuses it while the binding is paused', async () => {
    expect((await signed(payload(META_PHONE))).status).toBe(200);
    const recorded = await events('metasite');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ state: 'refused', code: 'channel_paused' });
    expect(JSON.stringify(recorded)).not.toContain('15551234567');
    expect(await events('dialogsite')).toEqual([]);
  });
  it('keeps Meta numbers off the per-binding 360dialog callback', async () => {
    const response = await fetch(`${base}/v1/channels/whatsapp/webhooks/${metaBinding.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-noodle-webhook-secret': 'x'.repeat(32) },
      body: JSON.stringify(payload(META_PHONE)),
    });
    expect(response.status).toBe(404);
  });
});
describe('Meta callback without platform configuration', () => {
  it('is absent', async () => {
    const { http, worker, base } = await serve({});
    try {
      expect(
        (
          await fetch(
            `${base}/v1/channels/whatsapp/meta?hub.mode=subscribe&hub.challenge=1&hub.verify_token=x`,
          )
        ).status,
      ).toBe(404);
      expect((await fetch(`${base}/v1/channels/whatsapp/meta`, { method: 'POST' })).status).toBe(
        404,
      );
    } finally {
      await worker.stop();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });
});
