import { describe, expect, it } from 'vitest';
import {
  WhatsAppBindingClientResponseSchema,
  WhatsAppBindingResponseSchema,
  WhatsAppConfigureRequestSchema,
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
  it('rejects accidental server fields while older client readers allow additive fields', () => {
    const response = { ok: true, data: null, futureField: true };
    expect(WhatsAppBindingResponseSchema.safeParse(response).success).toBe(false);
    expect(WhatsAppBindingClientResponseSchema.parse(response)).toEqual({ ok: true, data: null });
  });
});
