import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_DAY_MS,
  type ConversationPolicy,
  effectiveConversationDays,
} from '../src/conversation-history/contracts.js';
import { CustomerConversations } from '../src/conversation-history/customer.js';
import { InMemoryConversationHistoryStore } from '../src/conversation-history/memory-store.js';
import {
  PREVIEW_CONVERSATION_DAYS,
  previewEnvironments,
  withPreviewConversations,
} from '../src/conversation-history/preview.js';
import type { EnvSummary, TenantRef } from '../src/store.js';

/** ADR 0241 decision 18: Preview-environment conversations keep a short fixed retention. */
const PREVIEW: TenantRef = { org: 'acme', app: 'site', env: 'dev' };
const PRODUCTION: TenantRef = { org: 'acme', app: 'site', env: 'prod' };

function env(envName: string, isProduction: boolean): EnvSummary {
  return {
    orgSlug: 'acme',
    appSlug: 'site',
    envName,
    isProduction,
    active: true,
    createdAt: '2026-09-01T00:00:00Z',
    deploymentCount: 1,
  };
}
function reader(envs: readonly EnvSummary[]) {
  return {
    getEnvironment: async (_org: string, _app: string, name: string) =>
      envs.find((item) => item.envName === name),
    listEnvironments: async () => envs,
  };
}

describe('Preview environments (ADR 0241 decision 18)', () => {
  it('is a deployed environment beside an explicit production environment', async () => {
    const isPreview = previewEnvironments(reader([env('prod', true), env('dev', false)]));
    expect(await isPreview(PREVIEW)).toBe(true);
    expect(await isPreview(PRODUCTION)).toBe(false);
  });

  it('keeps production semantics when production is unresolved, unknown or unreadable', async () => {
    // Two environments with no production designation: neither may be treated as Preview.
    expect(
      await previewEnvironments(reader([env('staging', false), env('dev', false)]))(PREVIEW),
    ).toBe(false);
    // An environment with no deployment (a managed installation's name) is not a Preview.
    expect(await previewEnvironments(reader([env('prod', true)]))(PREVIEW)).toBe(false);
    const failing = {
      getEnvironment: async () => {
        throw new Error('registry unavailable');
      },
      listEnvironments: async () => [],
    };
    expect(await previewEnvironments(failing)(PREVIEW)).toBe(false);
  });
});

describe('Preview conversation policy', () => {
  const off: ConversationPolicy = { maximumDays: 30, conversationDays: 0 };
  const production: ConversationPolicy = {
    maximumDays: 30,
    conversationDays: 14,
    sources: { website_visitors: false },
  };
  const policy = (value: ConversationPolicy | undefined) =>
    withPreviewConversations(
      async () => value,
      async (tenant) => tenant.env === 'dev',
    );

  it('records every Preview source for three days, whatever the stored duration or switches', async () => {
    expect(PREVIEW_CONVERSATION_DAYS).toBe(3);
    for (const stored of [off, production, { ...production, conversationDays: 0 }]) {
      const effective = await policy(stored)(PREVIEW);
      for (const source of ['website_visitors', 'signed_in_customers', 'whatsapp'] as const)
        expect(effectiveConversationDays(effective, source), source).toBe(3);
    }
  });

  it('never exceeds the plan maximum and never invents a policy', async () => {
    expect(await policy({ maximumDays: 1, conversationDays: 0 })(PREVIEW)).toMatchObject({
      conversationDays: 1,
    });
    expect(await policy({ maximumDays: 0, conversationDays: 0 })(PREVIEW)).toMatchObject({
      conversationDays: 0,
    });
    expect(await policy(undefined)(PREVIEW)).toBeUndefined();
  });

  it('leaves the production policy unchanged', async () => {
    expect(await policy(production)(PRODUCTION)).toBe(production);
    expect(await policy(off)(PRODUCTION)).toBe(off);
  });
});

describe('customer-backend lists and Preview environments', () => {
  it('scopes each embed client to its own environment, with the Preview window in Preview', async () => {
    const now = Date.parse('2026-09-22T12:00:00Z');
    const store = new InMemoryConversationHistoryStore(() => now);
    const subject = { kind: 'customer', ref: 'user_1' } as const;
    for (const [tenant, id, age] of [
      [PRODUCTION, 'cv_production_0001', 1_000],
      [PREVIEW, 'cv_preview_00000001', 1_000],
      [PREVIEW, 'cv_preview_00000old', 4 * CONVERSATION_DAY_MS],
    ] as const)
      await store.append(
        { id, tenant, channel: 'website', subject },
        [{ kind: 'message', role: 'user', text: id, at: now - age }],
        30,
      );
    const customers = new CustomerConversations({
      store,
      policy: withPreviewConversations(
        async () => ({ maximumDays: 30, conversationDays: 30 }),
        async (tenant) => tenant.env === 'dev',
      ),
      identityKey: 'customer-preview-fixture-key-over-thirty-two-chars',
      now: () => now,
    });
    const listed = async (tenant: TenantRef) =>
      (
        await customers.list({ id: 'client_1', tenant }, { user: { id: 'user_1' } })
      ).response.data.conversations.map((row) => row.id);
    expect(await listed(PRODUCTION)).toEqual(['cv_production_0001']);
    expect(await listed(PREVIEW)).toEqual(['cv_preview_00000001']);
  });
});
