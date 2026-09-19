import { APPLICATION_DRAFT_LIMITS } from '@noodle-borg/wire-contracts';
import { expect, it } from 'vitest';
import { InMemoryApplicationDraftBackend } from '../src/application-drafts/memory.js';
import { ApplicationDraftStore } from '../src/application-drafts/store.js';
import { describeApplicationDraftStore } from './application-drafts-suite.js';

describeApplicationDraftStore(async () => {
  let active = true;
  return {
    store: new ApplicationDraftStore(new InMemoryApplicationDraftBackend(), {
      authorize: async (_scope, actor) => active && actor === 'builder',
    }),
    revoke: () => {
      active = false;
    },
  };
});

it('does not extend retry custody on reads and releases expired opaque receipts', async () => {
  let now = new Date('2026-09-18T00:00:00Z');
  const backend = new InMemoryApplicationDraftBackend(undefined, () => now);
  const store = new ApplicationDraftStore(backend, { authorize: async () => true });
  const input = {
    scope: { org: 'acme', app: 'assistant' },
    actorSubject: 'builder',
    environment: 'prod',
    idempotencyKey: 'save-one',
    source: { entrypoint: 'server.ts', files: [{ path: 'server.ts', content: 'original' }] },
  };
  const draft = await store.create(input);
  now = new Date(now.getTime() + APPLICATION_DRAFT_LIMITS.retryWindowMs - 1);
  expect((await store.create(input)).id).toBe(draft.id);
  await store.remove({ ...input, id: draft.id, expectedRevision: 1 });
  await expect(store.create(input)).rejects.toMatchObject({ code: 'draft_deleted' });
  now = new Date(now.getTime() + 1);
  expect((await store.create(input)).id).not.toBe(draft.id);
  expect(await backend.run(input.scope, (tx) => tx.capacity())).toMatchObject({
    receipts: 1,
    drafts: 1,
  });
});
