import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryDailyCounterStore } from '@noodle-borg/admission-limits/portable';
import { InMemoryControlPlaneStore } from '@noodle-borg/control-plane/portable';
import { noopLogger, sendJson } from '@noodle-borg/transport-http';
import {
  ConversationExportResponseSchema,
  ConversationForgetResponseSchema,
  ConversationListResponseSchema,
  ConversationShowResponseSchema,
} from '@noodle-borg/wire-contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';
import { InMemoryBusinessWorkspaceBackend } from '../src/business-workspaces/memory.js';
import { BusinessWorkspaceStore } from '../src/business-workspaces/store.js';
import {
  CONVERSATION_DAY_MS,
  type ConversationSubject,
} from '../src/conversation-history/contracts.js';
import { InMemoryConversationHistoryStore } from '../src/conversation-history/memory-store.js';
import { ApplicationConversations } from '../src/conversation-history/operator.js';
import { dispatchBusinessInformationRoutes } from '../src/routes/business-information-dispatch.js';
import { InMemoryAuditStore } from '../src/store/audit.js';

const scope = { org: 'acme', app: 'travel', env: 'prod', installationId: 'travel-prod' };
const otherScope = { org: 'acme', app: 'other', env: 'prod', installationId: 'other-prod' };
const now = Date.parse('2026-09-06T12:00:00Z');
const sara: ConversationSubject = { kind: 'customer', ref: 'sara_91' };
let http: Server;
let base: string;
let records: InMemoryBusinessInformationStore;
let history: InMemoryConversationHistoryStore;
let audit: InMemoryAuditStore;
let composed: boolean;

async function start() {
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.createOrgWithOwner({
    slug: 'acme',
    owner: { subject: 'owner', email: 'owner@example.com' },
  });
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: 'member',
    email: 'member@example.com',
    role: 'owner',
  });
  const conversations = new ApplicationConversations({
    store: history,
    policy: async () => ({ maximumDays: 365, conversationDays: 365 }),
    identityKey: 'conversation-http-fixture-key-over-thirty-two-characters',
    now: () => now,
  });
  http = createServer((req, res) => {
    const handled = dispatchBusinessInformationRoutes(
      req,
      res,
      new URL(req.url ?? '/', 'http://localhost'),
      {
        store: records,
        ...(composed ? { conversations } : {}),
        audit,
        controlPlane,
        publicCounters: new InMemoryDailyCounterStore(),
        maxBody: 32768,
        trustProxy: false,
        logger: noopLogger,
        tls: {},
        applySecurityHeaders: () => {},
        enforceHttps: () => false,
        gate: {
          authorize: async (request) => {
            const subject =
              /^Bearer (owner|viewer|member|manager|operator|administrator|builder)$/.exec(
                String(request.headers.authorization ?? ''),
              )?.[1];
            return subject === undefined
              ? { ok: false, status: 401, message: 'Authentication required' }
              : {
                  ok: true,
                  identity: { subject, email: `${subject}@example.com`, superAdmin: false },
                };
          },
        },
      },
    );
    if (!handled) sendJson(res, 404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1/orgs/acme/solution-installations`;
}

beforeEach(async () => {
  records = new InMemoryBusinessInformationStore();
  history = new InMemoryConversationHistoryStore(() => now);
  audit = new InMemoryAuditStore();
  composed = true;
  for (const target of [scope, otherScope]) {
    await records.createInstallation({
      scope: target,
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      actorSubject: 'owner',
      actorEmail: 'owner@example.com',
    });
    for (const role of ['viewer', 'manager', 'operator'] as const)
      await records.setGrant({
        scope: target,
        subject: role,
        email: `${role}@example.com`,
        role,
        expectedRevision: 0,
        actorSubject: 'owner',
      });
  }
  await start();
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    http.close((error) => (error ? reject(error) : resolve())),
  );
});

function get(path: string, subject = 'owner') {
  return fetch(`${base}/${path}`, { headers: { authorization: `Bearer ${subject}` } });
}
function review(conversation: string, body: unknown, subject = 'owner') {
  return fetch(`${base}/travel-prod/conversations/${conversation}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${subject}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function forget(body: unknown, subject = 'owner', installation = 'travel-prod') {
  return fetch(`${base}/${installation}/conversations/forget`, {
    method: 'POST',
    headers: { authorization: `Bearer ${subject}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function seed(
  id: string,
  options: {
    target?: typeof scope;
    at?: number;
    subject?: ConversationSubject;
    days?: number;
  } = {},
) {
  const { installationId: _installation, ...tenant } = options.target ?? scope;
  const at = options.at ?? now - 1_000;
  await history.append(
    { id, tenant, channel: 'website', subject: options.subject ?? sara },
    [
      { kind: 'message', role: 'user', text: `private question ${id}`, at },
      { kind: 'message', role: 'assistant', text: `private answer ${id}`, at: at + 1 },
    ],
    options.days ?? 7,
  );
}
const id = (suffix: string) => `cv_conversation_${suffix}`;

async function workspaceAuthority() {
  const workspaces = new BusinessWorkspaceStore(new InMemoryBusinessWorkspaceBackend(), {
    isIdentityActive: async () => true,
  });
  await workspaces.initializeNewWorkspace({ org: scope.org, ownerSubject: 'owner' });
  for (const role of ['administrator', 'builder', 'operator', 'viewer'] as const) {
    const invite = await workspaces.invite({
      org: scope.org,
      actor: 'owner',
      email: `${role}@example.com`,
      role,
      expectedRevision: (await workspaces.inspect(scope.org, 'owner')).revision,
    });
    await workspaces.accept({
      org: scope.org,
      subject: role,
      token: invite.token,
      verifiedEmail: `${role}@example.com`,
    });
  }
  records.staff.configure(workspaces);
}

describe('workspace roles for conversation history (ADR 0241 decision 10)', () => {
  it('lets every reading role read text, keeps Builder out, and reserves export and forget', async () => {
    await workspaceAuthority();
    for (const role of ['owner', 'administrator', 'builder', 'operator', 'viewer']) {
      await seed(id(role));
      const read = role !== 'builder';
      const manage = role === 'owner' || role === 'administrator';
      const handle = read && role !== 'viewer';
      expect(
        (await review(id(role), { reviewStatus: 'reviewed' }, role)).status,
        `${role} review`,
      ).toBe(handle ? 200 : 403);
      expect((await review(id(role), { note: 'Call back' }, role)).status, `${role} note`).toBe(
        handle ? 200 : 403,
      );
      expect((await get('travel-prod/conversations', role)).status, `${role} list`).toBe(
        read ? 200 : 403,
      );
      expect(
        (await get(`travel-prod/conversations/${id(role)}`, role)).status,
        `${role} show`,
      ).toBe(read ? 200 : 403);
      expect((await get('travel-prod/conversations/export', role)).status, `${role} export`).toBe(
        manage ? 200 : 403,
      );
      expect((await forget({ conversationId: id(role) }, role)).status, `${role} forget`).toBe(
        manage ? 200 : 403,
      );
    }
  });
});

describe('conversation history HTTP projection', () => {
  it('requires a live installation grant, never organization ownership alone', async () => {
    await seed(id('one'));
    expect((await get('travel-prod/conversations', 'missing')).status).toBe(401);
    expect((await get('travel-prod/conversations', 'member')).status).toBe(403);
    const response = await get('travel-prod/conversations', 'viewer');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = ConversationListResponseSchema.parse(await response.json());
    expect(body.data.conversations).toEqual([
      {
        id: id('one'),
        channel: 'website',
        subject: sara,
        startedAt: new Date(now - 1_000).toISOString(),
        lastMessageAt: new Date(now - 999).toISOString(),
        itemCount: 2,
        reviewStatus: 'new',
      },
    ]);
    expect(JSON.stringify(body)).not.toContain('private');
    // Legacy grants: a manager may export but only an administrator may forget.
    expect((await get('travel-prod/conversations/export', 'manager')).status).toBe(200);
    expect((await forget({ conversationId: id('one') }, 'manager')).status).toBe(403);
    expect((await forget({ conversationId: id('one') }, 'operator')).status).toBe(403);
  });

  it('never exposes an anonymous handle and never lists or shows an expired conversation', async () => {
    await seed(id('anon'), { subject: { kind: 'anonymous', ref: 'anon_secret_handle' } });
    await seed(id('expired'), { at: now - 8 * CONVERSATION_DAY_MS });
    const listed = await (await get('travel-prod/conversations')).json();
    expect(listed.data.conversations.map((row: { id: string }) => row.id)).toEqual([id('anon')]);
    expect(listed.data.conversations[0].subject).toEqual({ kind: 'anonymous' });
    expect(JSON.stringify(listed)).not.toContain('anon_secret_handle');
    expect((await get(`travel-prod/conversations/${id('expired')}`)).status).toBe(404);
  });

  it('shows items with text, audits the read by identifier only, and hides other installations', async () => {
    await seed(id('show'));
    await seed(id('elsewhere'), { target: otherScope });
    const response = await get(`travel-prod/conversations/${id('show')}`, 'operator');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = ConversationShowResponseSchema.parse(await response.json());
    expect(body.data.conversation.items).toEqual([
      {
        kind: 'message',
        role: 'user',
        text: `private question ${id('show')}`,
        at: new Date(now - 1_000).toISOString(),
      },
      {
        kind: 'message',
        role: 'assistant',
        text: `private answer ${id('show')}`,
        at: new Date(now - 999).toISOString(),
      },
    ]);
    const events = await audit.list({ org: 'acme' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'conversation.read',
      app: 'travel',
      env: 'prod',
      actorSubject: 'operator',
      details: { conversationId: id('show') },
    });
    expect(JSON.stringify(events)).not.toMatch(/private|sara_91/);
    expect((await get(`travel-prod/conversations/${id('elsewhere')}`)).status).toBe(404);
    expect((await get('travel-prod/conversations/cv_bad')).status).toBe(404);
  });

  it('pages with cursors bound to purpose, installation, page size and channel', async () => {
    for (const [index, suffix] of ['a', 'b', 'c'].entries())
      await seed(id(suffix), { at: now - 10_000 + index * 10 });
    const first = ConversationListResponseSchema.parse(
      await (await get('travel-prod/conversations?limit=2')).json(),
    ).data;
    expect(first.conversations.map((row) => row.id)).toEqual([id('c'), id('b')]);
    const cursor = encodeURIComponent(first.nextCursor ?? '');
    const second = ConversationListResponseSchema.parse(
      await (await get(`travel-prod/conversations?limit=2&cursor=${cursor}`)).json(),
    ).data;
    expect(second.conversations.map((row) => row.id)).toEqual([id('a')]);
    expect(second.nextCursor).toBeUndefined();
    for (const path of [
      `travel-prod/conversations?limit=1&cursor=${cursor}`,
      `travel-prod/conversations?limit=2&channel=whatsapp&cursor=${cursor}`,
      `other-prod/conversations?limit=2&cursor=${cursor}`,
      `travel-prod/conversations/export?limit=2&cursor=${cursor}`,
      'travel-prod/conversations?limit=101',
      'travel-prod/conversations?limit=0',
      'travel-prod/conversations?limit=1&limit=2',
      'travel-prod/conversations?channel=sms',
      `travel-prod/conversations?limit=2&status=reviewed&cursor=${cursor}`,
      'travel-prod/conversations?status=needs-attention',
      'travel-prod/conversations?cursor=forged',
      'travel-prod/conversations?format=raw',
      'travel-prod/conversations/export?limit=26',
    ])
      expect((await get(path)).status, path).toBe(400);
    expect(
      ConversationListResponseSchema.parse(
        await (await get('travel-prod/conversations?channel=whatsapp')).json(),
      ).data.conversations,
    ).toEqual([]);
  });

  it('exports conversations with items and audits each page by count', async () => {
    await seed(id('x'));
    await seed(id('y'), { at: now - 500 });
    const response = await get('travel-prod/conversations/export?limit=1', 'administrator');
    expect(response.status).toBe(403);
    const page = ConversationExportResponseSchema.parse(
      await (await get('travel-prod/conversations/export?limit=1')).json(),
    ).data;
    expect(page.conversations).toHaveLength(1);
    expect(page.conversations[0]?.id).toBe(id('y'));
    expect(page.conversations[0]?.items).toHaveLength(2);
    expect(page.nextCursor).toBeDefined();
    const events = await audit.list({ org: 'acme', eventType: 'conversation.exported' });
    expect(events.map((event) => event.details)).toEqual([{ count: 1 }]);
    expect(JSON.stringify(events)).not.toMatch(/private|sara_91/);
  });

  it('forgets one conversation or every conversation of a subject and audits counts only', async () => {
    await seed(id('first'));
    await seed(id('second'), { at: now - 5_000 });
    await seed(id('omar'), { subject: { kind: 'customer', ref: 'omar' } });
    await seed(id('other'), { target: otherScope });
    expect((await forget({ conversationId: id('other') })).status).toBe(200);
    expect((await get(`other-prod/conversations/${id('other')}`)).status).toBe(200);
    const byId = ConversationForgetResponseSchema.parse(
      await (await forget({ conversationId: id('first') })).json(),
    );
    expect(byId.data.forgotten).toEqual({ conversations: 1, items: 2 });
    expect((await get(`travel-prod/conversations/${id('first')}`)).status).toBe(404);
    const bySubject = ConversationForgetResponseSchema.parse(
      await (await forget({ subject: sara })).json(),
    );
    expect(bySubject.data.forgotten).toEqual({ conversations: 1, items: 2 });
    const remaining = await (await get('travel-prod/conversations')).json();
    expect(remaining.data.conversations.map((row: { id: string }) => row.id)).toEqual([id('omar')]);
    for (const body of [{}, { subject: { kind: 'anonymous', ref: 'x' } }, { conversationId: 'x' }])
      expect((await forget(body)).status, JSON.stringify(body)).toBe(400);
    const events = await audit.list({ org: 'acme', eventType: 'conversation.forgotten' });
    expect(events.map((event) => event.details).reverse()).toEqual([
      { conversations: 0, items: 0, kind: 'conversation' },
      { conversations: 1, items: 2, kind: 'conversation' },
      { conversations: 1, items: 2, kind: 'customer' },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/sara_91|private/);
  });

  it('reviews and notes a conversation by identifier-only audit, and filters the list by status', async () => {
    await seed(id('review'));
    await seed(id('untouched'), { at: now - 5_000 });
    const response = await review(
      id('review'),
      { reviewStatus: 'reviewed', note: 'Refund card 4242 4242 4242 4242 approved' },
      'operator',
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const { conversation } = ConversationShowResponseSchema.parse(await response.json()).data;
    expect(conversation.reviewStatus).toBe('reviewed');
    expect(conversation.notes).toEqual([
      {
        author: 'operator',
        text: 'Refund card •••• 4242 approved',
        at: new Date(now).toISOString(),
      },
    ]);
    expect(conversation.expiresAt).toBe(
      new Date(now - 999 + 7 * CONVERSATION_DAY_MS).toISOString(),
    );
    expect((await review(id('review'), { note: 'Second' }, 'owner')).status).toBe(200);
    const shown = ConversationShowResponseSchema.parse(
      await (await get(`travel-prod/conversations/${id('review')}`, 'viewer')).json(),
    ).data.conversation;
    expect(shown.notes.map((note) => [note.author, note.text])).toEqual([
      ['operator', 'Refund card •••• 4242 approved'],
      ['owner', 'Second'],
    ]);
    const reviewed = ConversationListResponseSchema.parse(
      await (await get('travel-prod/conversations?status=reviewed')).json(),
    ).data.conversations;
    expect(reviewed.map((row) => [row.id, row.reviewStatus])).toEqual([[id('review'), 'reviewed']]);
    expect(
      ConversationListResponseSchema.parse(
        await (await get('travel-prod/conversations?status=new')).json(),
      ).data.conversations.map((row) => row.id),
    ).toEqual([id('untouched')]);
    const exported = await (await get('travel-prod/conversations/export')).text();
    expect(exported).not.toMatch(/Refund card|Second/);
    const events = await audit.list({ org: 'acme' });
    expect(
      events
        .filter(
          (event) =>
            event.eventType !== 'conversation.read' && event.eventType !== 'conversation.exported',
        )
        .map((event) => [event.eventType, event.actorSubject, event.details])
        .reverse(),
    ).toEqual([
      [
        'conversation.reviewed',
        'operator',
        { conversationId: id('review'), reviewStatus: 'reviewed' },
      ],
      ['conversation.noted', 'operator', { conversationId: id('review') }],
      ['conversation.noted', 'owner', { conversationId: id('review') }],
    ]);
    expect(JSON.stringify(events)).not.toMatch(/Refund|Second|••••|private/);
  });

  it('rejects malformed reviews and unknown or expired conversations', async () => {
    await seed(id('valid'));
    await seed(id('expired'), { at: now - 8 * CONVERSATION_DAY_MS });
    for (const body of [
      {},
      { reviewStatus: 'needs-attention' },
      { note: '' },
      { note: '   ' },
      { note: 'x'.repeat(2001) },
      { note: 'ok', author: 'someone-else' },
    ])
      expect((await review(id('valid'), body)).status, JSON.stringify(body)).toBe(400);
    expect((await review(id('valid'), { note: 'x'.repeat(2000) })).status).toBe(200);
    expect((await review(id('expired'), { note: 'late' })).status).toBe(404);
    expect((await review('cv_conversation_missing', { reviewStatus: 'reviewed' })).status).toBe(
      404,
    );
    expect((await review(id('valid'), { note: 'x' }, 'viewer')).status).toBe(403);
    expect(
      (await audit.list({ org: 'acme' })).filter(
        (event) => event.eventType === 'conversation.noted',
      ),
    ).toHaveLength(1);
  });

  it('accepts only the documented methods and reports an uncomposed history as unavailable', async () => {
    expect(
      (
        await fetch(`${base}/travel-prod/conversations`, {
          method: 'POST',
          headers: { authorization: 'Bearer owner' },
        })
      ).status,
    ).toBe(405);
    expect((await get('travel-prod/conversations/forget')).status).toBe(405);
    await new Promise<void>((resolve) => http.close(() => resolve()));
    composed = false;
    await start();
    const response = await get('travel-prod/conversations');
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('conversation_unavailable');
  });
});
