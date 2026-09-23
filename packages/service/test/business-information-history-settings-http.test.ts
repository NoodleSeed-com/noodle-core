import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryDailyCounterStore } from '@noodle-borg/admission-limits/portable';
import { InMemoryControlPlaneStore } from '@noodle-borg/control-plane/portable';
import { noopLogger, sendJson } from '@noodle-borg/transport-http';
import {
  ApplicationHistorySettingsResponseSchema,
  ApplicationHistorySettingsSaveResponseSchema,
} from '@noodle-borg/wire-contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApplicationActivity } from '../src/application-activity.js';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';
import { CONVERSATION_DAY_MS } from '../src/conversation-history/contracts.js';
import { InMemoryConversationHistoryStore } from '../src/conversation-history/memory-store.js';
import { ApplicationConversations } from '../src/conversation-history/operator.js';
import { InMemoryOperationEvidenceStore } from '../src/operation-evidence-memory.js';
import { dispatchBusinessInformationRoutes } from '../src/routes/business-information-dispatch.js';
import { InMemoryAuditStore } from '../src/store/audit.js';

const scope = { org: 'acme', app: 'travel', env: 'prod', installationId: 'travel-prod' };
const tenant = { org: 'acme', app: 'travel', env: 'prod' };
const now = Date.parse('2026-09-06T12:00:00Z');
let http: Server;
let installation: string;
let base: string;
let evidence: InMemoryOperationEvidenceStore;
let history: InMemoryConversationHistoryStore;
let audit: InMemoryAuditStore;
let activity: ApplicationActivity;
let maximumDays = 90;
let allowanceAvailable = true;

beforeEach(async () => {
  const records = new InMemoryBusinessInformationStore();
  maximumDays = 90;
  allowanceAvailable = true;
  evidence = new InMemoryOperationEvidenceStore();
  history = new InMemoryConversationHistoryStore(() => now);
  audit = new InMemoryAuditStore();
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.createOrgWithOwner({
    slug: 'acme',
    owner: { subject: 'owner', email: 'owner@example.com' },
  });
  // An installation that existed before conversation history: its setting is created on first read.
  await records.createInstallation({
    scope,
    profileKey: 'travel',
    managedCollections: ['travel_requests'],
    actorSubject: 'owner',
    actorEmail: 'owner@example.com',
  });
  for (const role of ['viewer', 'operator'] as const)
    await records.setGrant({
      scope,
      subject: role,
      email: `${role}@example.com`,
      role,
      expectedRevision: 0,
      actorSubject: 'owner',
    });
  activity = new ApplicationActivity({
    store: evidence,
    epoch: 'history-http-epoch',
    identityKey: 'history-http-fixture-key-over-thirty-two-characters',
    now: () => now,
    allowance: async () =>
      allowanceAvailable
        ? { maximumDays, defaultDays: Math.min(30, maximumDays), revision: `plan-${maximumDays}` }
        : undefined,
    conversationHistory: history,
  });
  http = createServer((req, res) => {
    const handled = dispatchBusinessInformationRoutes(
      req,
      res,
      new URL(req.url ?? '/', 'http://localhost'),
      {
        store: records,
        activity,
        conversations: new ApplicationConversations({
          store: history,
          policy: async () => activity.conversationPolicy(scope),
          identityKey: 'history-http-conversation-key-over-thirty-two-characters',
          now: () => now,
        }),
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
            const subject = /^Bearer (owner|viewer|operator)$/.exec(
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
  installation = `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1/orgs/acme/solution-installations/travel-prod`;
  base = `${installation}/history/settings`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    http.close((error) => (error ? reject(error) : resolve())),
  );
});

async function read(subject = 'owner') {
  const response = await fetch(base, { headers: { authorization: `Bearer ${subject}` } });
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  return ApplicationHistorySettingsResponseSchema.parse(await response.json()).data;
}
function put(body: unknown, subject = 'owner') {
  return fetch(base, {
    method: 'PUT',
    headers: { authorization: `Bearer ${subject}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function save(body: Record<string, unknown>) {
  const response = await put({ expectedRevision: (await read()).revision, ...body });
  expect(response.status, await response.clone().text()).toBe(200);
  return ApplicationHistorySettingsSaveResponseSchema.parse(await response.json()).data;
}
async function seedConversation(id: string, ages: readonly number[], days = 60) {
  await history.append(
    { id, tenant, channel: 'website', subject: { kind: 'anonymous', ref: `anon_${id}` } },
    ages.map((age) => ({
      kind: 'message' as const,
      role: 'user' as const,
      text: 'hello',
      at: now - age * CONVERSATION_DAY_MS,
    })),
    days,
  );
}

async function visible() {
  const get = (path: string) =>
    fetch(`${installation}/conversations${path}`, { headers: { authorization: 'Bearer owner' } });
  const listed = (await (await get('')).json()).data.conversations as { id: string }[];
  const exported = (await (await get('/export')).json()).data.conversations as {
    id: string;
    items: unknown[];
  }[];
  const shown = await Promise.all(
    listed.map(async ({ id }) => (await (await get(`/${id}`)).json()).data.conversation),
  );
  expect(exported.map((row) => row.id).sort()).toEqual(listed.map((row) => row.id).sort());
  return Object.fromEntries(shown.map((row) => [row.id, row.items.length])) as Record<
    string,
    number
  >;
}

describe('shortening conversation history caps stored expiry on save', () => {
  it('hides history older than the new window immediately, exactly as the dry run counted', async () => {
    await save({ conversations: { retentionDays: 30 } });
    await seedConversation('cv_old_conversation', [20, 10]);
    await seedConversation('cv_mixed_conversation', [8, 2]);
    expect(await visible()).toEqual({ cv_old_conversation: 2, cv_mixed_conversation: 2 });
    const preview = await save({ conversations: { retentionDays: 7 }, dryRun: true });
    expect(await visible()).toEqual({ cv_old_conversation: 2, cv_mixed_conversation: 2 });
    const saved = await save({ conversations: { retentionDays: 7 } });
    expect(saved.impact).toEqual(preview.impact);
    expect(saved.impact).toEqual({ conversations: 1, items: 3 });
    expect(await visible()).toEqual({ cv_mixed_conversation: 1 });
    // Lengthening never resurfaces capped history.
    expect((await save({ conversations: { retentionDays: 30 } })).impact).toEqual({
      conversations: 0,
      items: 0,
    });
    expect(await visible()).toEqual({ cv_mixed_conversation: 1 });
  });

  it('Off hides every conversation, and channel switches leave existing history alone', async () => {
    await save({ conversations: { retentionDays: 30 } });
    await seedConversation('cv_first_conversation', [3]);
    await seedConversation('cv_second_conversation', [1, 0]);
    expect((await save({ sources: { websiteVisitors: false } })).impact).toEqual({
      conversations: 0,
      items: 0,
    });
    expect(Object.keys(await visible())).toHaveLength(2);
    const off = await save({ conversations: 'off' });
    expect(off.impact).toEqual({ conversations: 2, items: 3 });
    expect(await visible()).toEqual({});
  });
});

describe('the live plan allowance bounds staff reads', () => {
  it('a downgrade hides older conversations at once without rewriting stored expiry', async () => {
    maximumDays = 30;
    await save({ conversations: { retentionDays: 30 } });
    await seedConversation('cv_old_conversation', [20, 10], 30);
    await seedConversation('cv_recent_conversation', [5, 2], 30);
    expect(await visible()).toEqual({ cv_old_conversation: 2, cv_recent_conversation: 2 });
    maximumDays = 7;
    expect(await visible()).toEqual({ cv_recent_conversation: 2 });
    // Hidden, not deleted: a restored plan shows items still inside their stamped expiry.
    maximumDays = 30;
    expect(await visible()).toEqual({ cv_old_conversation: 2, cv_recent_conversation: 2 });
    allowanceAvailable = false;
    const unavailable = await fetch(`${installation}/conversations`, {
      headers: { authorization: 'Bearer owner' },
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ code: 'conversation_unavailable' });
  });

  it('shows nothing for an installation that never opted in', async () => {
    await seedConversation('cv_legacy_conversation', [1]);
    expect(await visible()).toEqual({});
  });
});

describe('installation history settings API', () => {
  it('reads an existing installation as not enabled, with every channel switch on, for any reader', async () => {
    const viewer = await read('viewer');
    expect(viewer).toMatchObject({
      canEdit: false,
      activity: { retentionDays: 30, maximumDays: 90, defaultDays: 30 },
      conversations: {
        state: 'not_enabled',
        sources: { websiteVisitors: true, signedInCustomers: true, whatsapp: true },
      },
    });
    expect(viewer.conversations.retentionDays).toBeUndefined();
    expect((await read()).canEdit).toBe(true);
    expect(await activity.conversationPolicy(scope)).toEqual({ maximumDays: 90 });
  });

  it('opts in, changes channel switches and Activity under one revision, and audits scalars only', async () => {
    const original = (await read()).revision;
    const saved = await save({
      activityDays: 60,
      conversations: { retentionDays: 14 },
      sources: { whatsapp: false },
    });
    expect(saved).toMatchObject({
      dryRun: false,
      shortensConversations: false,
      impact: { conversations: 0, items: 0 },
      settings: {
        activity: { retentionDays: 60 },
        conversations: {
          state: 'on',
          retentionDays: 14,
          sources: { websiteVisitors: true, signedInCustomers: true, whatsapp: false },
        },
      },
    });
    expect(await activity.conversationPolicy(scope)).toEqual({
      maximumDays: 90,
      conversationDays: 14,
      sources: { website_visitors: true, signed_in_customers: true, whatsapp: false },
    });
    const events = await audit.list({ org: 'acme', eventType: 'config.history.settings_changed' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorSubject: 'owner',
      app: 'travel',
      env: 'prod',
      details: { activityDays: 60, conversationDays: 14, sourcesChanged: 'whatsapp' },
    });
    // A stale revision never overwrites the newer setting.
    expect(saved.settings.revision).not.toBe(original);
    expect((await put({ expectedRevision: original, activityDays: 7 })).status).toBe(409);
  });

  it('reports existing conversations outside a shorter window without saving on a dry run', async () => {
    await save({ conversations: { retentionDays: 60 } });
    await seedConversation('cv_old_conversation', [40, 35]);
    await seedConversation('cv_mixed_conversation', [20, 2]);
    const before = await read();
    const dryRun = await save({ conversations: { retentionDays: 30 }, dryRun: true });
    expect(dryRun).toMatchObject({
      dryRun: true,
      shortensConversations: true,
      impact: { conversations: 1, items: 2 },
      settings: { revision: before.revision, conversations: { state: 'on', retentionDays: 60 } },
    });
    expect((await read()).revision).toBe(before.revision);
    const off = await save({ conversations: 'off', dryRun: true });
    expect(off.impact).toEqual({ conversations: 2, items: 4 });
    // Extending never needs confirmation and counts nothing.
    expect(await save({ conversations: { retentionDays: 90 }, dryRun: true })).toMatchObject({
      shortensConversations: false,
      impact: { conversations: 0, items: 0 },
    });
    const events = await audit.list({ org: 'acme', eventType: 'config.history.settings_changed' });
    expect(events).toHaveLength(1);
    const saved = await save({ conversations: 'off' });
    expect(saved).toMatchObject({
      shortensConversations: true,
      settings: { conversations: { state: 'off' } },
    });
    expect(saved.settings.conversations.retentionDays).toBeUndefined();
    const changes = await audit.list({ org: 'acme', eventType: 'config.history.settings_changed' });
    expect(changes.map((event) => event.details)).toContainEqual({
      activityDays: 30,
      conversationDays: 'off',
      sourcesChanged: 'none',
    });
    expect(changes).toHaveLength(2);
  });

  it('turning conversations on from not enabled is not a shortening', async () => {
    await seedConversation('cv_unrelated_conversation', [5]);
    expect(await save({ conversations: { retentionDays: 1 }, dryRun: true })).toMatchObject({
      shortensConversations: false,
      impact: { conversations: 0, items: 0 },
    });
  });

  it('after a downgrade, changes only what is asked and validates only changed durations', async () => {
    await save({ activityDays: 60, conversations: { retentionDays: 60 } });
    maximumDays = 7;
    const current = await read();
    expect(current.activity.retentionDays).toBe(7);
    expect(current.conversations.retentionDays).toBe(7);
    expect(await save({ sources: { whatsapp: false } })).toMatchObject({
      settings: { conversations: { sources: { whatsapp: false } } },
    });
    expect((await save({ conversations: { retentionDays: 5 } })).shortensConversations).toBe(true);
    const { revision } = await read();
    expect((await put({ expectedRevision: revision, activityDays: 8 })).status).toBe(400);
  });

  it('rejects durations above the plan maximum, empty changes and unknown fields', async () => {
    const { revision } = await read();
    for (const body of [
      { expectedRevision: revision, activityDays: 91 },
      { expectedRevision: revision, conversations: { retentionDays: 91 } },
      { expectedRevision: revision, conversations: { retentionDays: 0 } },
      { expectedRevision: revision },
      { expectedRevision: revision, retentionDays: 7 },
      { expectedRevision: revision, sources: { email: true } },
    ]) {
      const response = await put(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect((await read()).revision).toBe(revision);
  });

  it('requires installation administration to change the setting and allows only GET and PUT', async () => {
    const { revision } = await read();
    for (const subject of ['viewer', 'operator'])
      expect((await put({ expectedRevision: revision, activityDays: 7 }, subject)).status).toBe(
        403,
      );
    const patch = await fetch(base, {
      method: 'PATCH',
      headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: revision, activityDays: 7 }),
    });
    expect(patch.status).toBe(405);
    expect(patch.headers.get('allow')).toBe('GET, PUT');
    expect((await read()).revision).toBe(revision);
  });
});
