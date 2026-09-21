import { describe, expect, it } from 'vitest';
import { whatsappOperation } from '../src/commands/whatsapp-ops.js';
import { formatWhatsAppResult } from '../src/commands/whatsapp-output.js';

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

describe('WhatsApp doctor output', () => {
  it('prints the compatibility report after the readiness checks and omits it for an older service', () => {
    const next = 'Run the service with PostgreSQL channel storage, then rerun doctor.';
    const result = {
      ok: true,
      data: {
        ready: false,
        revision: 2,
        checks: [{ name: 'durability', status: 'unavailable', code: 'durable_storage_required' }],
        capabilities: [
          { capability: 'answer_questions', status: 'native' },
          {
            capability: 'capture_request',
            status: 'needs_setup',
            code: 'durable_storage_required',
            requirement: 'durable_interaction_store',
            next,
          },
          {
            capability: 'account_self_service',
            status: 'unavailable',
            code: 'IDENTITY_NOT_ESTABLISHABLE',
            requirement: 'verified_customer',
          },
        ],
      },
    };
    expect(formatWhatsAppResult(result)).toBe(
      [
        'WhatsApp remains unavailable.',
        'Revision: 2',
        'Unavailable: durability (durable_storage_required)',
        'Capabilities:',
        '  Native: answer_questions',
        `  Needs setup: capture_request (durable_storage_required); requires durable_interaction_store. Next: ${next}`,
        '  Unavailable: account_self_service (IDENTITY_NOT_ESTABLISHABLE); requires verified_customer',
      ].join('\n'),
    );
    expect(formatWhatsAppResult({ ok: true, data: { ready: true, revision: 1, checks: [] } })).toBe(
      'WhatsApp is ready to enable.\nRevision: 1',
    );
  });
});
