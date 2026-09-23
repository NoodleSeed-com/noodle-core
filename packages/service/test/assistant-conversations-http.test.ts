import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryPublicEmbedStore } from '@noodle-borg/assistant-gateway';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationCapture } from '../src/conversation-history/capture.js';
import {
  CONVERSATION_DAY_MS,
  type ConversationPolicy,
  type ConversationPolicySource,
} from '../src/conversation-history/contracts.js';
import { InMemoryConversationHistoryStore } from '../src/conversation-history/memory-store.js';
import { createServiceHandler, InMemoryAssistantStore, ServerRegistry } from '../src/index.js';
import { InMemoryAuditStore } from '../src/store/audit.js';
import type { TenantRef } from '../src/store.js';

/**
 * ADR 0241 decision 12: an embed client's backend lists and forgets one of its own verified users'
 * conversations, by the `user.id` its session exchange sent. The tenant is the client credential's;
 * nothing in the body can reach another tenant's history.
 */
const T0 = Date.UTC(2026, 8, 20, 12);
const ACME: TenantRef = { org: 'acme', app: 'shop', env: 'prod' };
const RIVAL: TenantRef = { org: 'rival', app: 'shop', env: 'prod' };

let now = T0;
let policy: ConversationPolicy | undefined | 'fail';
let history: InMemoryConversationHistoryStore;
let assistants: InMemoryAssistantStore;
let audit: InMemoryAuditStore;
let http: Server;
let base: string;
let acme: { id: string; secret: string };
let rival: { id: string; secret: string };

const policySource: ConversationPolicySource = async () => {
  if (policy === 'fail') throw new Error('policy store down');
  return policy;
};

async function start(withHistory = true) {
  const registry = new ServerRegistry();
  http = createServer(
    createServiceHandler(registry, {
      assistantStore: assistants,
      audit,
      clock: () => new Date(now),
      ...(withHistory
        ? {
            conversationHistory: {
              store: history,
              policy: policySource,
              identityKey: 'customer-conversations-identity-key-32-characters',
            },
          }
        : {}),
    }),
  );
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}

async function client(tenant: TenantRef) {
  const created = await assistants.createClient({
    name: 'backend',
    tenant,
    deploymentId: 'dep_1',
    allowedOrigins: ['https://app.example.test'],
    now: new Date(T0),
  });
  return { id: created.client.id, secret: created.secret };
}

function call(
  action: 'list' | 'forget-user',
  body: unknown,
  credentials: { id: string; secret: string } | null = acme,
) {
  return fetch(`${base}/v1/assistant/conversations/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(credentials
        ? {
            authorization: `Basic ${Buffer.from(`${credentials.id}:${credentials.secret}`).toString('base64')}`,
          }
        : {}),
    },
    body: JSON.stringify(body),
  });
}

async function seed(
  tenant: TenantRef,
  id: string,
  ref: string,
  messages: readonly (readonly ['user' | 'assistant', string])[],
  at: number,
  options: { readonly kind?: 'customer' | 'anonymous'; readonly channel?: 'website' } = {},
) {
  await history.append(
    {
      id,
      tenant,
      channel: options.channel ?? 'website',
      subject: { kind: options.kind ?? 'customer', ref },
    },
    messages.map(([role, text], index) => ({ kind: 'message', role, text, at: at + index })),
    30,
  );
}

beforeEach(async () => {
  now = T0;
  policy = { maximumDays: 30, conversationDays: 30 };
  history = new InMemoryConversationHistoryStore(() => now);
  assistants = new InMemoryAssistantStore();
  audit = new InMemoryAuditStore();
  acme = await client(ACME);
  rival = await client(RIVAL);
  await start();
});
afterEach(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

describe('customer-backend conversation list', () => {
  it('lists only this user’s website conversations in the client’s tenant, newest first', async () => {
    await seed(
      ACME,
      'cv_sara_older',
      'sara',
      [
        ['user', 'Gluten-free?'],
        ['assistant', 'Yes'],
      ],
      T0 - 5_000,
    );
    await seed(
      ACME,
      'cv_sara_newer',
      'sara',
      [
        ['assistant', 'Hi!'],
        ['user', '  Track\n my   order '],
      ],
      T0 - 1_000,
    );
    await seed(ACME, 'cv_omar_1', 'omar', [['user', 'Omar here']], T0 - 500);
    await seed(ACME, 'cv_sara_anon', 'sara', [['user', 'anonymous handle']], T0 - 400, {
      kind: 'anonymous',
    });
    await seed(RIVAL, 'cv_sara_rival', 'sara', [['user', 'Rival tenant']], T0 - 300);

    const response = await call('list', { user: { id: 'sara' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      ok: true,
      data: {
        conversations: [
          {
            id: 'cv_sara_newer',
            channel: 'website',
            startedAt: new Date(T0 - 1_000).toISOString(),
            lastMessageAt: new Date(T0 - 999).toISOString(),
            preview: 'Track my order',
          },
          {
            id: 'cv_sara_older',
            channel: 'website',
            startedAt: new Date(T0 - 5_000).toISOString(),
            lastMessageAt: new Date(T0 - 4_999).toISOString(),
            preview: 'Gluten-free?',
          },
        ],
      },
    });
    const rivalView = await (await call('list', { user: { id: 'sara' } }, rival)).json();
    expect(rivalView.data.conversations.map((row: { id: string }) => row.id)).toEqual([
      'cv_sara_rival',
    ]);
    const events = await audit.list({ org: 'acme', eventType: 'conversation.listed' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorSubject: acme.id, details: { count: 2 } });
    expect(JSON.stringify(events)).not.toContain('Track');
    expect(JSON.stringify(events)).not.toContain('sara');
  });

  it('never exposes staff notes or review status to the customer backend', async () => {
    await seed(ACME, 'cv_sara_noted', 'sara', [['assistant', 'Hello']], T0 - 1_000);
    expect(
      await history.addNote(ACME, 'cv_sara_noted', {
        author: 'staff_owner',
        text: 'Private: refund flagged',
        at: T0 - 500,
      }),
    ).toBe(true);
    expect(await history.setReviewStatus(ACME, 'cv_sara_noted', 'needs_attention')).toBe(true);
    const response = await call('list', { user: { id: 'sara' } });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text).data.conversations).toEqual([
      {
        id: 'cv_sara_noted',
        channel: 'website',
        startedAt: new Date(T0 - 1_000).toISOString(),
        lastMessageAt: new Date(T0 - 1_000).toISOString(),
      },
    ]);
    for (const leaked of ['refund', 'staff_owner', 'notes', 'reviewStatus', 'needs_attention'])
      expect(text).not.toContain(leaked);
    expect(JSON.stringify(await audit.list({ org: 'acme' }))).not.toContain('refund');
  });

  it('keys the list by the exact user id a session exchange recorded', async () => {
    const { session } = await assistants.createSession({
      clientId: acme.id,
      tenant: ACME,
      deploymentId: 'dep_1',
      origin: 'https://app.example.test',
      caller: { subject: 'user_7', identityKind: 'customer' },
      createdAt: new Date(T0).toISOString(),
      expiresAt: new Date(T0 + 600_000).toISOString(),
      absoluteExpiresAt: new Date(T0 + 3_600_000).toISOString(),
    });
    await new ConversationCapture(history, policySource, { now: () => now }).recordSessionTurn(
      session,
      [
        { role: 'user', content: 'Where is my parcel?', kind: 'visible' },
        { role: 'assistant', content: 'On its way.', kind: 'visible' },
      ],
      { historyDisabled: false },
    );
    const listed = await (await call('list', { user: { id: 'user_7' } })).json();
    expect(listed.data.conversations).toHaveLength(1);
    expect(listed.data.conversations[0].preview).toBe('Where is my parcel?');
    expect(
      (await (await call('list', { user: { id: 'USER_7' } })).json()).data.conversations,
    ).toEqual([]);
  });

  it('pages with a cursor bound to its client, user and page size', async () => {
    for (const index of [1, 2, 3])
      await seed(ACME, `cv_page_${index}000`, 'sara', [['user', `q${index}`]], T0 - index * 1_000);
    const first = await (await call('list', { user: { id: 'sara' }, limit: 2 })).json();
    expect(first.data.conversations.map((row: { id: string }) => row.id)).toEqual([
      'cv_page_1000',
      'cv_page_2000',
    ]);
    const cursor = first.data.nextCursor;
    expect(typeof cursor).toBe('string');
    const second = await (await call('list', { user: { id: 'sara' }, limit: 2, cursor })).json();
    expect(second.data).toEqual({
      conversations: [expect.objectContaining({ id: 'cv_page_3000' })],
    });
    for (const replay of [
      { user: { id: 'omar' }, limit: 2, cursor },
      { user: { id: 'sara' }, limit: 3, cursor },
    ]) {
      const refused = await call('list', replay);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ code: 'conversation_invalid' });
    }
    const other = await client(ACME);
    expect((await call('list', { user: { id: 'sara' }, limit: 2, cursor }, other)).status).toBe(
      400,
    );
  });

  it('shows only items inside the live window and unexpired', async () => {
    await seed(
      ACME,
      'cv_old_window',
      'sara',
      [['user', 'ten days ago']],
      T0 - 10 * CONVERSATION_DAY_MS,
    );
    await seed(
      ACME,
      'cv_mixed_items',
      'sara',
      [['user', 'first, old']],
      T0 - 10 * CONVERSATION_DAY_MS,
    );
    await history.append(
      {
        id: 'cv_mixed_items',
        tenant: ACME,
        channel: 'website',
        subject: { kind: 'customer', ref: 'sara' },
      },
      [{ kind: 'message', role: 'user', text: 'second, recent', at: T0 - 1_000 }],
      30,
    );
    policy = { maximumDays: 7, conversationDays: 30 };
    const windowed = await (await call('list', { user: { id: 'sara' } })).json();
    expect(windowed.data.conversations).toEqual([
      expect.objectContaining({ id: 'cv_mixed_items', preview: 'second, recent' }),
    ]);
    now = T0 + 31 * CONVERSATION_DAY_MS;
    policy = { maximumDays: 90, conversationDays: 90 };
    expect(
      (await (await call('list', { user: { id: 'sara' } })).json()).data.conversations,
    ).toEqual([]);
  });

  it('returns nothing when the business does not record, and 503 when policy cannot be read', async () => {
    await seed(ACME, 'cv_sara_kept', 'sara', [['user', 'kept']], T0 - 1_000);
    for (const off of [undefined, { maximumDays: 30, conversationDays: 0 }]) {
      policy = off;
      const response = await call('list', { user: { id: 'sara' } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, data: { conversations: [] } });
    }
    policy = 'fail';
    const failed = await call('list', { user: { id: 'sara' } });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ code: 'conversation_unavailable' });
  });

  it('truncates previews without splitting a character and drops a row purged mid-read', async () => {
    await seed(ACME, 'cv_long_preview', 'sara', [['user', `${'a'.repeat(119)}😀tail`]], T0 - 1_000);
    await seed(ACME, 'cv_no_question', 'sara', [['assistant', 'Welcome back']], T0 - 2_000);
    await seed(ACME, 'cv_purged_race', 'sara', [['user', 'gone']], T0 - 3_000);
    const read = history.read.bind(history);
    history.read = async (tenant, id, at, notBefore) =>
      id === 'cv_purged_race' ? undefined : read(tenant, id, at, notBefore);
    const rows = (await (await call('list', { user: { id: 'sara' } })).json()).data.conversations;
    expect(rows.map((row: { id: string }) => row.id)).toEqual([
      'cv_long_preview',
      'cv_no_question',
    ]);
    expect(rows[0].preview).toBe('a'.repeat(119));
    expect(rows[1]).not.toHaveProperty('preview');
  });
});

describe('customer-backend forget-user', () => {
  it('erases exactly this user in this tenant, idempotently, and audits counts only', async () => {
    await seed(
      ACME,
      'cv_sara_one',
      'sara',
      [
        ['user', 'a'],
        ['assistant', 'b'],
      ],
      T0 - 2_000,
    );
    await seed(ACME, 'cv_sara_two', 'sara', [['user', 'c']], T0 - 1_000);
    await seed(ACME, 'cv_omar_one', 'omar', [['user', 'd']], T0 - 1_000);
    await seed(RIVAL, 'cv_sara_rival', 'sara', [['user', 'e']], T0 - 1_000);

    const forgotten = await call('forget-user', { user: { id: 'sara' } });
    expect(forgotten.status).toBe(200);
    expect(await forgotten.json()).toEqual({
      ok: true,
      data: { forgotten: { conversations: 2, items: 3 } },
    });
    expect(await history.read(ACME, 'cv_sara_one', now)).toBeUndefined();
    expect(await history.read(ACME, 'cv_omar_one', now)).toBeDefined();
    expect(await history.read(RIVAL, 'cv_sara_rival', now)).toBeDefined();
    expect(await (await call('forget-user', { user: { id: 'sara' } })).json()).toEqual({
      ok: true,
      data: { forgotten: { conversations: 0, items: 0 } },
    });
    // Newest first.
    const events = await audit.list({ org: 'acme', eventType: 'conversation.forgotten' });
    expect(events.map((event) => [event.actorSubject, event.details])).toEqual([
      [acme.id, { conversations: 0, items: 0, kind: 'customer' }],
      [acme.id, { conversations: 2, items: 3, kind: 'customer' }],
    ]);
    expect(JSON.stringify(events)).not.toContain('sara');
  });

  it('forgets even when the business no longer records', async () => {
    await seed(ACME, 'cv_sara_off', 'sara', [['user', 'a']], T0 - 1_000);
    policy = undefined;
    expect(await (await call('forget-user', { user: { id: 'sara' } })).json()).toMatchObject({
      data: { forgotten: { conversations: 1, items: 1 } },
    });
    policy = 'fail';
    await seed(ACME, 'cv_sara_fail', 'sara', [['user', 'a']], T0 - 1_000);
    expect((await call('forget-user', { user: { id: 'sara' } })).status).toBe(200);
  });
});

describe('customer-backend conversation authentication', () => {
  it('accepts only a live embed client credential and never a body tenant', async () => {
    await seed(ACME, 'cv_sara_auth', 'sara', [['user', 'a']], T0 - 1_000);
    const embeds = new InMemoryPublicEmbedStore();
    const embed = await embeds.ensure({ ...ACME, surfaceMode: 'public', now: new Date(T0) });
    const revoked = await client(ACME);
    await assistants.revokeClient(revoked.id, new Date(T0));
    for (const credentials of [
      null,
      { id: acme.id, secret: 'nsa_wrong' },
      { id: embed.embedId, secret: 'anything' },
      revoked,
    ])
      for (const action of ['list', 'forget-user'] as const) {
        const response = await call(action, { user: { id: 'sara' } }, credentials);
        expect(response.status, `${action} ${credentials?.id}`).toBe(401);
      }
    for (const action of ['list', 'forget-user'] as const) {
      const response = await call(action, { user: { id: 'sara' }, tenant: RIVAL }, rival);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'conversation_invalid' });
      expect((await call(action, { user: { id: '' } })).status).toBe(400);
    }
    expect(await history.read(ACME, 'cv_sara_auth', now)).toBeDefined();
    expect((await fetch(`${base}/v1/assistant/conversations/list`)).status).toBe(405);
  });

  it('answers 503 with a code when this service keeps no history', async () => {
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await start(false);
    for (const action of ['list', 'forget-user'] as const) {
      const response = await call(action, { user: { id: 'sara' } });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'conversation_unavailable' });
      expect((await call(action, { user: { id: 'sara' } }, null)).status).toBe(401);
    }
  });
});
