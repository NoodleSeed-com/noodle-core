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
  it('selects the Meta Cloud API with its WABA and no callback secret', () => {
    const meta = [
      'configure',
      '--provider',
      'meta',
      '--phone-number-id',
      '1040350119157691',
      '--waba-id',
      '2120347998801839',
      '--api-key-secret',
      'WHATSAPP_ACCESS_TOKEN',
      '--capabilities',
      'knowledge:product',
      '--support-email',
      'hello@noodleseed.com',
      '--expected-revision',
      '0',
    ];
    expect(whatsappOperation(meta).body).toEqual({
      expectedRevision: 0,
      provider: 'meta',
      phoneNumberId: '1040350119157691',
      wabaId: '2120347998801839',
      apiKeySecret: 'WHATSAPP_ACCESS_TOKEN',
      capabilities: [{ kind: 'knowledge', name: 'product' }],
      supportEmail: 'hello@noodleseed.com',
      limits: {},
    });
    expect(() =>
      whatsappOperation(
        meta.filter((flag) => !flag.startsWith('2120')).filter((flag) => flag !== '--waba-id'),
      ),
    ).toThrow();
    expect(() =>
      whatsappOperation([...meta, '--webhook-secret', 'WHATSAPP_WEBHOOK_SECRET']),
    ).toThrow();
    // An unselected provider stays implicit so services that predate the choice keep accepting it.
    const dialog = whatsappOperation([
      'configure',
      '--phone-number-id',
      '1234',
      '--api-key-secret',
      'WHATSAPP_API_KEY',
      '--webhook-secret',
      'WHATSAPP_WEBHOOK_SECRET',
      '--capabilities',
      'knowledge:product',
      '--support-email',
      'hello@noodleseed.com',
      '--expected-revision',
      '0',
    ]);
    expect(dialog.body).not.toHaveProperty('provider');
    expect(
      formatWhatsAppResult({
        ok: true,
        data: {
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
        },
      }),
    ).toContain('Provider: meta (WABA 2120347998801839)');
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
