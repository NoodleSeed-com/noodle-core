import { describe, expect, it } from 'vitest';
import { whatsappOperation } from '../src/commands/whatsapp-ops.js';

describe('WhatsApp assisted setup', () => {
  it('builds reference-only paused setup and requires an explicit revision', () => {
    const command = [
      'configure',
      '--phone-number-id',
      '1234',
      '--api-key-secret',
      'WHATSAPP_API_KEY',
      '--webhook-secret',
      'WHATSAPP_WEBHOOK_SECRET',
      '--capabilities',
      'knowledge:product,tool:site_identity',
      '--support-email',
      'hello@noodleseed.com',
      '--expected-revision',
      '0',
    ];
    expect(whatsappOperation(command)).toMatchObject({
      method: 'PUT',
      body: {
        expectedRevision: 0,
        capabilities: [
          { kind: 'knowledge', name: 'product' },
          { kind: 'tool', name: 'site_identity' },
        ],
      },
    });
    expect(() => whatsappOperation(['enable'])).toThrow('expected-revision');
    expect(() => whatsappOperation([...command, '--api-key', 'secret'])).toThrow('unknown option');
  });
  it('preserves zero limits and rejects values above the approved ceiling', () => {
    expect(
      whatsappOperation(['limits', 'set', '--expected-revision', '3', '--per-minute', '0']),
    ).toMatchObject({ method: 'PATCH', path: '/limits', body: { limits: { perMinute: 0 } } });
    expect(() =>
      whatsappOperation(['limits', 'set', '--expected-revision', '3', '--per-minute', '11']),
    ).toThrow();
  });
  it('requires an explicit block duration or indefinite choice and never invents resends', () => {
    const id = `p_${'a'.repeat(64)}`;
    expect(() => whatsappOperation(['block', '--participant-id', id])).toThrow('until');
    expect(whatsappOperation(['block', '--participant-id', id, '--indefinite'])).toMatchObject({
      body: { participantId: id, until: null },
    });
    expect(whatsappOperation(['events', 'reconcile', '--event-id', 'e_123_1'])).toMatchObject({
      method: 'POST',
      path: '/events/e_123_1/reconcile',
    });
    expect(() => whatsappOperation(['events', 'resend'])).toThrow();
  });
});
