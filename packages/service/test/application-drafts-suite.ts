import { randomUUID } from 'node:crypto';
import { APPLICATION_DRAFT_LIMITS } from '@noodle-borg/wire-contracts';
import { describe, expect, it } from 'vitest';
import type { ApplicationDraftStore } from '../src/application-drafts/store.js';

export function describeApplicationDraftStore(
  factory: () => Promise<{ store: ApplicationDraftStore; revoke: () => void }>,
): void {
  describe('draft authority conformance', () => {
    const source = {
      entrypoint: 'server.ts',
      files: [{ path: 'server.ts', content: '// preserve me\nexport default {};\n' }],
    };
    const scope = () => ({ org: `org-${randomUUID()}`, app: 'assistant' });
    const input = () => ({
      scope: scope(),
      actorSubject: 'builder',
      idempotencyKey: randomUUID(),
      environment: 'prod',
      source,
    });

    it('checks exact current source with fresh edit authority and without adding history', async () => {
      const { store, revoke } = await factory();
      const command = input();
      const draft = await store.create(command);
      const check = {
        scope: command.scope,
        id: draft.id,
        actorSubject: 'builder',
        expectedRevision: 1,
      };
      expect(await store.forValidation(check)).toEqual(draft);
      expect(await store.history(command.scope, draft.id, 'builder')).toHaveLength(1);
      await expect(store.forValidation({ ...check, expectedRevision: 2 })).rejects.toMatchObject({
        code: 'revision_conflict',
      });
      await expect(
        store.forValidation({ ...check, scope: { ...command.scope, app: 'other' } }),
      ).rejects.toMatchObject({ code: 'not_found' });
      revoke();
      await expect(store.forValidation(check)).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('creates an immutable exact-source revision and replays the same receipt', async () => {
      const { store } = await factory();
      const command = input();
      const created = await store.create(command);
      expect(created).toMatchObject({
        revision: 1,
        source,
        createdBySubject: 'builder',
        origin: 'manual',
      });
      expect(created.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(await store.create(command)).toEqual(created);
      expect(await store.list(command.scope, 'builder')).toHaveLength(1);
    });

    it('rejects idempotency key reuse with different source', async () => {
      const { store } = await factory();
      const command = input();
      await store.create(command);
      await expect(
        store.create({
          ...command,
          source: { ...source, files: [{ path: 'server.ts', content: 'changed' }] },
        }),
      ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    });

    it('bounds source history across applications and releases capacity only on explicit erasure', async () => {
      const { store } = await factory();
      const command = input();
      const fullSource = {
        entrypoint: 'server.ts',
        files: Array.from({ length: 4 }, (_, i) => ({
          path: i === 0 ? 'server.ts' : `part-${i}.ts`,
          content: 'x'.repeat(APPLICATION_DRAFT_LIMITS.fileBytes),
        })),
      };
      const first = await store.create({ ...command, source: fullSource });
      const secondScope = { ...command.scope, app: 'another-app' };
      const second = await store.create({ ...command, scope: secondScope, source: fullSource });
      const allowed =
        APPLICATION_DRAFT_LIMITS.sourceBytesPerWorkspace / APPLICATION_DRAFT_LIMITS.totalBytes;
      for (let revision = 1; revision < allowed - 1; revision++) {
        await store.edit({
          ...command,
          id: first.id,
          source: fullSource,
          expectedRevision: revision,
          idempotencyKey: `edit-${revision}`,
        });
      }
      const pending = {
        ...command,
        scope: secondScope,
        id: second.id,
        source: fullSource,
        expectedRevision: 1,
        idempotencyKey: 'over-capacity',
      };
      await expect(store.edit(pending)).rejects.toMatchObject({ code: 'source_capacity' });
      expect((await store.get(secondScope, second.id, 'builder')).revision).toBe(1);
      await store.remove({ ...command, id: first.id, expectedRevision: allowed - 1 });
      expect((await store.edit(pending)).revision).toBe(2);
    }, 30_000);

    it('serializes two edits so exactly one wins the expected revision', async () => {
      const { store } = await factory();
      const command = input();
      const draft = await store.create(command);
      const results = await Promise.allSettled(
        ['one', 'two'].map((content) =>
          store.edit({
            scope: command.scope,
            id: draft.id,
            actorSubject: 'builder',
            expectedRevision: 1,
            idempotencyKey: randomUUID(),
            source: { ...source, files: [{ path: 'server.ts', content }] },
          }),
        ),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((result) => result.status === 'rejected')).toMatchObject({
        reason: { code: 'revision_conflict', currentRevision: 2 },
      });
      expect((await store.get(command.scope, draft.id, 'builder')).revision).toBe(2);
      expect((await store.get(command.scope, draft.id, 'builder', 1)).source).toEqual(source);
    });

    it('undo appends a new revision and preserves intermediate history', async () => {
      const { store } = await factory();
      const command = input();
      const draft = await store.create(command);
      const changed = await store.edit({
        scope: command.scope,
        id: draft.id,
        actorSubject: 'builder',
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
        source: { ...source, files: [{ path: 'server.ts', content: 'changed' }] },
      });
      const undone = await store.undo({
        scope: command.scope,
        id: draft.id,
        actorSubject: 'builder',
        expectedRevision: 2,
        targetRevision: 1,
        idempotencyKey: randomUUID(),
      });
      expect(undone).toMatchObject({
        revision: 3,
        origin: 'undo',
        source,
        sourceDigest: draft.sourceDigest,
      });
      expect(await store.get(command.scope, draft.id, 'builder', 2)).toEqual(changed);
      const history = await store.history(command.scope, draft.id, 'builder');
      expect(history.map((item) => item.revision)).toEqual([3, 2, 1]);
      expect(JSON.stringify(history)).not.toContain('preserve me');
      expect(await store.diff(command.scope, draft.id, 'builder', 1, 2)).toMatchObject({
        fromRevision: 1,
        toRevision: 2,
        changes: [{ path: 'server.ts', before: source.files[0]?.content, after: 'changed' }],
      });
      expect((await store.diff(command.scope, draft.id, 'builder', 1, 3)).changes).toEqual([]);
    });

    it('does not allow a reader or revoked builder to mutate or replay a receipt', async () => {
      const { store, revoke } = await factory();
      const command = input();
      const draft = await store.create(command);
      await expect(store.create({ ...command, actorSubject: 'viewer' })).rejects.toMatchObject({
        code: 'forbidden',
      });
      revoke();
      await expect(store.create(command)).rejects.toMatchObject({ code: 'forbidden' });
      await expect(store.get(command.scope, draft.id, 'builder')).rejects.toMatchObject({
        code: 'forbidden',
      });
    });

    it('never resolves another app or organization by draft ID alone', async () => {
      const { store } = await factory();
      const command = input();
      const draft = await store.create(command);
      for (const other of [
        { ...command.scope, app: 'other' },
        { ...command.scope, org: 'other' },
      ]) {
        await expect(store.get(other, draft.id, 'builder')).rejects.toMatchObject({
          code: 'not_found',
        });
        expect(await store.list(other, 'builder')).toEqual([]);
      }
    });

    it('returns detached objects and does not accept mutated caller state as authority', async () => {
      const { store } = await factory();
      const command = structuredClone(input());
      const draft = await store.create(command);
      const inputFile = command.source.files[0];
      const savedFile = draft.source.files[0];
      if (!inputFile || !savedFile) throw new Error('test source file missing');
      inputFile.content = 'caller changed after save';
      savedFile.content = 'caller changed returned object';
      expect((await store.get(command.scope, draft.id, 'builder')).source).toEqual(source);
    });

    it('validates source before storing it and never echoes invalid content in errors', async () => {
      const { store } = await factory();
      const command = input();
      await expect(
        store.create({
          ...command,
          source: { ...source, files: [{ path: '../secret.ts', content: 'sensitive-marker' }] },
        }),
      ).rejects.toMatchObject({ code: 'invalid_draft' });
      expect(await store.list(command.scope, 'builder')).toEqual([]);
    });

    it('erases a draft only at its reviewed revision and never resurrects it from a create retry', async () => {
      const { store } = await factory();
      const command = input();
      const draft = await store.create(command);
      const removal = {
        scope: command.scope,
        id: draft.id,
        actorSubject: 'builder',
        expectedRevision: 1,
      };
      await expect(store.remove({ ...removal, expectedRevision: 2 })).rejects.toMatchObject({
        code: 'revision_conflict',
      });
      await store.remove(removal);
      await store.remove(removal);
      expect(await store.list(command.scope, 'builder')).toEqual([]);
      await expect(store.get(command.scope, draft.id, 'builder')).rejects.toMatchObject({
        code: 'not_found',
      });
      await expect(store.create(command)).rejects.toMatchObject({ code: 'draft_deleted' });
      expect((await store.create({ ...command, idempotencyKey: randomUUID() })).id).not.toBe(
        draft.id,
      );
    });
  });
}
