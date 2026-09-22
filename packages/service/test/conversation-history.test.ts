import type { AssistantSessionRecord } from '@noodle-borg/assistant-gateway/portable';
import { describe, expect, it, vi } from 'vitest';
import { ConversationCapture } from '../src/conversation-history/capture.js';
import {
  CONVERSATION_DAY_MS,
  type ConversationHistoryStore,
  type ConversationPolicy,
  effectiveConversationDays,
} from '../src/conversation-history/contracts.js';
import { InMemoryConversationHistoryStore } from '../src/conversation-history/memory-store.js';
import { maskPaymentCards } from '../src/payment-card.js';
import { describeConversationHistoryStore, T0, TENANT } from './conversation-history-suite.js';

describeConversationHistoryStore(
  'in-memory',
  async (clock) => new InMemoryConversationHistoryStore(() => clock.now),
);

const optedIn: ConversationPolicy = { maximumDays: 7, conversationDays: 7 };

function session(identityKind: 'anonymous' | 'customer', subject: string): AssistantSessionRecord {
  return {
    id: 'session_1',
    tenant: TENANT,
    caller: { subject, identityKind },
  } as unknown as AssistantSessionRecord;
}

function capture(
  policy: ConversationPolicy | undefined,
  store = new InMemoryConversationHistoryStore(),
) {
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const history = new ConversationCapture(store, async () => policy, {
    now: () => T0,
    logger,
  });
  return { history, store, logger };
}

async function only(store: ConversationHistoryStore, id: string) {
  return (await store.read(TENANT, id, T0))?.items ?? [];
}

describe('effective conversation days', () => {
  it('is off until a business explicitly opts in (existing workspaces, ADR 0241 decision 8)', () => {
    expect(effectiveConversationDays(undefined, 'website_visitors')).toBe(0);
    expect(effectiveConversationDays({ maximumDays: 7 }, 'website_visitors')).toBe(0);
    expect(effectiveConversationDays({ maximumDays: 7, conversationDays: 0 }, 'whatsapp')).toBe(0);
  });
  it('is capped by the plan maximum and honours per-channel switches', () => {
    expect(effectiveConversationDays({ maximumDays: 7, conversationDays: 30 }, 'whatsapp')).toBe(7);
    const policy = { maximumDays: 30, conversationDays: 5, sources: { website_visitors: false } };
    expect(effectiveConversationDays(policy, 'website_visitors')).toBe(0);
    expect(effectiveConversationDays(policy, 'signed_in_customers')).toBe(5);
  });
});

describe('payment card masking', () => {
  it('keeps only the last four digits of checksum-valid card numbers', () => {
    expect(maskPaymentCards('my card is 4242 4242 4242 4242 thanks')).toBe(
      'my card is •••• 4242 thanks',
    );
    expect(maskPaymentCards('order 1234567890123 ok')).toBe('order 1234567890123 ok');
  });
});

describe('conversation capture', () => {
  it('writes nothing while the business has not opted in', async () => {
    const { history, store } = capture(undefined);
    await history.recordSessionTurn(session('anonymous', 'anon_9f'), [
      { role: 'user', content: 'hi', kind: 'visible' },
    ]);
    expect(await store.purgeExpired({ limit: 10 })).toBe(0);
    expect(
      await store.findRecent(TENANT, 'website', { kind: 'anonymous', ref: 'anon_9f' }, 0),
    ).toBeUndefined();
  });

  it('keeps only visible rows, masks cards, and records outcomes as references', async () => {
    const { history, store } = capture(optedIn);
    const visitor = session('anonymous', 'anon_9f');
    await history.recordSessionTurn(visitor, [
      { role: 'user', content: 'card 4242 4242 4242 4242', kind: 'visible' },
      { role: 'assistant', content: 'Completed search: {"sku":"GF-8"}', kind: 'narration' },
      { role: 'assistant', content: 'Legacy untagged row' },
      { role: 'assistant', content: 'We need 48 hours notice.', kind: 'visible' },
    ]);
    await history.recordSessionOutcome(visitor, {
      interactionId: 'int_1',
      tool: 'create_order',
      status: 'succeeded',
    });
    const id = await store.findRecent(TENANT, 'website', { kind: 'anonymous', ref: 'anon_9f' }, 0);
    const items = await only(store, id ?? '');
    expect(items.map((item) => (item.kind === 'message' ? item.text : item.tool))).toEqual([
      'card •••• 4242',
      'We need 48 hours notice.',
      'create_order',
    ]);
    expect(JSON.stringify(items)).not.toContain('GF-8');
  });

  it('follows the per-channel switch for the current caller', async () => {
    const { history, store } = capture({ ...optedIn, sources: { website_visitors: false } });
    await history.recordSessionTurn(session('anonymous', 'anon_9f'), [
      { role: 'user', content: 'before sign-in', kind: 'visible' },
    ]);
    await history.recordSessionTurn(session('customer', 'sara_91'), [
      { role: 'user', content: 'after sign-in', kind: 'visible' },
    ]);
    const id = await store.findRecent(TENANT, 'website', { kind: 'customer', ref: 'sara_91' }, 0);
    expect(
      (await only(store, id ?? '')).map((item) => item.kind === 'message' && item.text),
    ).toEqual(['after sign-in']);
  });

  it('moves the conversation in progress to the customer at sign-in', async () => {
    const { history, store } = capture(optedIn);
    await history.recordSessionTurn(session('anonymous', 'anon_9f'), [
      { role: 'user', content: 'before', kind: 'visible' },
    ]);
    await history.reownSession(session('customer', 'sara_91'));
    const id = await store.findRecent(TENANT, 'website', { kind: 'customer', ref: 'sara_91' }, 0);
    expect(
      (await only(store, id ?? '')).map((item) => item.kind === 'message' && item.text),
    ).toEqual(['before']);
    expect(
      await store.findRecent(TENANT, 'website', { kind: 'anonymous', ref: 'anon_9f' }, 0),
    ).toBeUndefined();
  });

  it('starts a new WhatsApp conversation after 24 hours of silence', async () => {
    const store = new InMemoryConversationHistoryStore();
    let now = T0;
    const history = new ConversationCapture(store, async () => optedIn, { now: () => now });
    const turn = (text: string) =>
      history.recordChannelTurn({
        tenant: TENANT,
        participantId: 'wa_4821',
        user: text,
        assistant: 'ok',
        receivedAt: now,
      });
    await turn('Are you open Sunday?');
    now += CONVERSATION_DAY_MS - 1;
    await turn('And Monday?');
    const first = await store.findRecent(
      TENANT,
      'whatsapp',
      { kind: 'participant', ref: 'wa_4821' },
      0,
    );
    now += CONVERSATION_DAY_MS + 1;
    await turn('Can I change my pickup?');
    const second = await store.findRecent(
      TENANT,
      'whatsapp',
      { kind: 'participant', ref: 'wa_4821' },
      0,
    );
    expect(second).not.toBe(first);
    expect(await only(store, first ?? '')).toHaveLength(4);
  });

  it('never fails the customer turn when the store fails, and logs scalars only', async () => {
    const broken = new InMemoryConversationHistoryStore();
    broken.append = async () => {
      throw new Error('database down: secret row text');
    };
    const { history, logger } = capture(optedIn, broken);
    await expect(
      history.recordSessionTurn(session('anonymous', 'anon_9f'), [
        { role: 'user', content: 'hi', kind: 'visible' },
      ]),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith('assistant.history.capture_failed', {
      org: 'crumb',
      app: 'bakery',
      env: 'prod',
    });
  });
});
