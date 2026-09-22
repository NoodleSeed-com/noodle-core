import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryControlPlaneStore } from '@noodle-borg/control-plane/portable';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';
import { InMemoryConversationHistoryStore } from '../src/conversation-history/memory-store.js';
import { serveService } from '../src/serve.js';
import {
  createConversationHistoryOptions,
  createLocalOperationStores,
} from '../src/serve-operation-stores.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function serve(options: Parameters<typeof serveService>[0] = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'noodle-conversations-'));
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.createOrgWithOwner({
    slug: 'acme',
    owner: { subject: 'owner', email: 'owner@example.com' },
  });
  const service = await serveService({
    host: '127.0.0.1',
    port: 0,
    serviceConfigDir: dir,
    controlPlaneStore: controlPlane,
    businessInformationStore: new InMemoryBusinessInformationStore(),
    businessInformationEnabled: true,
    deployGate: {
      authorize: async () => ({
        ok: true,
        identity: { subject: 'owner', email: 'owner@example.com', superAdmin: false },
      }),
    },
    ...options,
  });
  cleanup.push(async () => {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  });
  const installation = await fetch(`${service.url}/v1/orgs/acme/solution-installations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      definition: { kind: 'managed', profileId: 'travel' },
      appSlug: 'travel',
      environment: 'prod',
      retentionDays: 30,
    }),
  });
  expect(installation.status, await installation.clone().text()).toBe(201);
  const { data } = (await installation.json()) as { data: { installation: { id: string } } };
  return `${service.url}/v1/orgs/acme/solution-installations/${data.installation.id}/conversations`;
}

describe('composed conversation history', () => {
  it('serves the operator API from the composed service while capture stays off', async () => {
    const conversations = await serve();
    const response = await fetch(conversations);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { conversations: [] } });
  });

  it('projects an injected store through the same routes', async () => {
    const store = new InMemoryConversationHistoryStore();
    const at = Date.now() - 1_000;
    await store.append(
      {
        id: 'cv_composed_conversation',
        tenant: { org: 'acme', app: 'travel', env: 'prod' },
        channel: 'whatsapp',
        subject: { kind: 'participant', ref: 'wa_4821' },
      },
      [{ kind: 'message', role: 'user', text: 'Is the shop open?', at }],
      7,
    );
    const conversations = await serve({
      conversationHistory: { store, policy: async () => undefined },
    });
    const listed = await (await fetch(conversations)).json();
    expect(listed.data.conversations.map((row: { id: string }) => row.id)).toEqual([
      'cv_composed_conversation',
    ]);
    const shown = await (await fetch(`${conversations}/cv_composed_conversation`)).json();
    expect(shown.data.conversation.items[0].text).toBe('Is the shop open?');
  });
});

describe('hosted conversation history options', () => {
  it('records nothing, derives a stable cursor key, and honours an injected composition', async () => {
    const stores = createLocalOperationStores();
    const composed = createConversationHistoryOptions(
      { secretMasterKey: 'k'.repeat(44) },
      stores,
      true,
    );
    expect(composed?.store).toBe(stores.history);
    expect(await composed?.policy({ org: 'acme', app: 'travel', env: 'prod' })).toBeUndefined();
    expect(composed?.identityKey).toMatch(/^[a-f0-9]{64}$/);
    expect(
      createConversationHistoryOptions({ secretMasterKey: 'k'.repeat(44) }, stores, true)
        ?.identityKey,
    ).toBe(composed?.identityKey);
    expect(createConversationHistoryOptions({}, stores, false)).toBeUndefined();
    const injected = {
      store: new InMemoryConversationHistoryStore(),
      policy: async () => undefined,
    };
    expect(createConversationHistoryOptions({ conversationHistory: injected }, stores, true)).toBe(
      injected,
    );
  });
});
