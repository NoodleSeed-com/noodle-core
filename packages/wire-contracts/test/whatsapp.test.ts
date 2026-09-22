import { describe, expect, it } from 'vitest';
import {
  WhatsAppBindingClientResponseSchema,
  WhatsAppBindingResponseSchema,
  WhatsAppConfigureRequestSchema,
  WhatsAppReadinessClientResponseSchema,
  WhatsAppReadinessResponseSchema,
} from '../src/whatsapp.js';

const config = {
  phoneNumberId: '1234',
  apiKeySecret: 'WHATSAPP_API_KEY',
  webhookSecret: 'WHATSAPP_WEBHOOK_SECRET',
  capabilities: [{ kind: 'knowledge', name: 'product' }],
  supportEmail: 'hello@noodleseed.com',
  expectedRevision: 0,
};
describe('WhatsApp wire contract', () => {
  it('accepts references only, rejects unexpected credentials, invalid limits and unsupported capabilities', () => {
    expect(WhatsAppConfigureRequestSchema.safeParse(config).success).toBe(true);
    expect(WhatsAppConfigureRequestSchema.safeParse({ ...config, apiKey: 'secret' }).success).toBe(
      false,
    );
    expect(
      WhatsAppConfigureRequestSchema.safeParse({ ...config, limits: { perMinute: 11 } }).success,
    ).toBe(false);
    expect(
      WhatsAppConfigureRequestSchema.safeParse({
        ...config,
        capabilities: [{ kind: 'resource', name: 'widget' }],
      }).success,
    ).toBe(false);
  });
  it('defaults to 360dialog and holds each provider to its own callback authentication', () => {
    expect(WhatsAppConfigureRequestSchema.parse(config).provider).toBe('360dialog');
    const { webhookSecret: _callback, ...withoutCallback } = config;
    expect(WhatsAppConfigureRequestSchema.safeParse(withoutCallback).success).toBe(false);
    expect(
      WhatsAppConfigureRequestSchema.safeParse({ ...config, wabaId: '2120347998801839' }).success,
    ).toBe(false);
    const meta = {
      ...withoutCallback,
      provider: 'meta',
      apiKeySecret: 'WHATSAPP_ACCESS_TOKEN',
      wabaId: '2120347998801839',
    };
    expect(WhatsAppConfigureRequestSchema.parse(meta)).toMatchObject({
      provider: 'meta',
      wabaId: '2120347998801839',
    });
    const { wabaId: _waba, ...metaWithoutWaba } = meta;
    expect(WhatsAppConfigureRequestSchema.safeParse(metaWithoutWaba).success).toBe(false);
    expect(
      WhatsAppConfigureRequestSchema.safeParse({
        ...meta,
        webhookSecret: 'WHATSAPP_WEBHOOK_SECRET',
      }).success,
    ).toBe(false);
    expect(WhatsAppConfigureRequestSchema.safeParse({ ...meta, provider: 'twilio' }).success).toBe(
      false,
    );
    const binding = {
      id: 'binding-1',
      tenant: { org: 'noodleseed', app: 'site-assistant', env: 'meta-test' },
      provider: 'meta',
      phoneNumberId: '1040350119157691',
      wabaId: '2120347998801839',
      apiKeySecret: 'WHATSAPP_ACCESS_TOKEN',
      deploymentId: 'deploy-1',
      capabilities: [],
      supportEmail: 'hello@noodleseed.com',
      revision: 1,
      generation: 1,
      state: 'paused',
      limits: {
        perMinute: 10,
        perHour: 60,
        perDay: 200,
        channelPerDay: 1000,
        newParticipantsPerDay: 200,
        concurrent: 5,
        pendingPerParticipant: 3,
        pending: 100,
        textCharacters: 4000,
        dailyMicroUsd: 20_000_000,
      },
      createdAt: 1,
      updatedAt: 1,
      actor: 'operator',
    };
    expect(WhatsAppBindingResponseSchema.safeParse({ ok: true, data: binding }).success).toBe(true);
    expect(
      WhatsAppBindingClientResponseSchema.parse({ ok: true, data: binding }).data,
    ).toMatchObject({ provider: 'meta', wabaId: '2120347998801839' });
  });
  it('rejects accidental server fields while older client readers allow additive fields', () => {
    const response = { ok: true, data: null, futureField: true };
    expect(WhatsAppBindingResponseSchema.safeParse(response).success).toBe(false);
    expect(WhatsAppBindingClientResponseSchema.parse(response)).toEqual({ ok: true, data: null });
  });
});
describe('WhatsApp readiness capability report', () => {
  const entry = {
    capability: 'capture_request',
    status: 'needs_setup',
    code: 'collection_not_installed',
    next: 'Install the application before enabling the channel.',
  };
  const data = { ready: false, revision: 1, checks: [], capabilities: [entry] };
  it('accepts one entry per capability on the strict server schema and rejects undeclared shapes', () => {
    expect(WhatsAppReadinessResponseSchema.safeParse({ ok: true, data }).success).toBe(true);
    expect(
      WhatsAppReadinessResponseSchema.safeParse({
        ok: true,
        data: { ...data, capabilities: [{ ...entry, renderer: 'flow' }] },
      }).success,
    ).toBe(false);
    expect(
      WhatsAppReadinessResponseSchema.safeParse({
        ok: true,
        data: { ...data, capabilities: [{ ...entry, status: 'maybe' }] },
      }).success,
    ).toBe(false);
    expect(
      WhatsAppReadinessResponseSchema.safeParse({
        ok: true,
        data: {
          ...data,
          capabilities: [
            {
              capability: 'account_self_service',
              status: 'unavailable',
              code: 'IDENTITY_NOT_ESTABLISHABLE',
              requirement: 'verified_customer',
            },
          ],
        },
      }).success,
    ).toBe(true);
  });
  it('strips additive fields on the client reader and tolerates a service that omits the array', () => {
    expect(
      WhatsAppReadinessClientResponseSchema.parse({
        ok: true,
        data: { ...data, capabilities: [{ ...entry, renderer: 'flow' }], later: 1 },
      }),
    ).toEqual({ ok: true, data });
    expect(
      WhatsAppReadinessClientResponseSchema.parse({
        ok: true,
        data: { ready: true, revision: 1, checks: [] },
      }).data.capabilities,
    ).toBeUndefined();
  });
});
