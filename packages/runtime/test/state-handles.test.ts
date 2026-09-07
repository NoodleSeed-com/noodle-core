import type { ArtifactState } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import {
  InMemoryStateHandleStore,
  PATCH_STATE_OPERATION,
  READ_STATE_OPERATION,
  StateConnector,
} from '../src/state-handles.js';

const state: ArtifactState = {
  handles: {
    draft: {
      kind: 'draft',
      version: 'v1',
      scope: 'caller',
      ttlSeconds: 60,
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          count: { type: 'integer' },
        },
      },
    },
  },
};

describe('state handles', () => {
  it('reads an empty handle, patches by expected revision, and isolates caller scope', () => {
    const store = new InMemoryStateHandleStore(state);

    expect(store.read({ handle: 'draft', callerSubject: 'alice' })).toMatchObject({
      handle: 'draft',
      key: 'default',
      value: {},
      revision: 0,
      status: 'active',
    });

    expect(
      store.patch({
        handle: 'draft',
        callerSubject: 'alice',
        expectedRevision: 0,
        value: { title: 'One', count: 1 },
      }),
    ).toMatchObject({
      value: { title: 'One', count: 1 },
      revision: 1,
    });

    expect(store.read({ handle: 'draft', callerSubject: 'bob' })).toMatchObject({
      value: {},
      revision: 0,
    });
    expect(() =>
      store.patch({
        handle: 'draft',
        callerSubject: 'alice',
        expectedRevision: 0,
        value: { title: 'stale' },
      }),
    ).toThrow(/revision conflict/);
  });

  it('recreates expired caller state and continues patching on the same runtime', () => {
    let now = Date.UTC(2026, 7, 25, 12, 0, 0);
    const store = new InMemoryStateHandleStore(state, () => new Date(now));

    expect(store.read({ handle: 'draft', callerSubject: 'alice' })).toMatchObject({
      value: {},
      revision: 0,
      status: 'active',
    });
    const initial = store.patch({
      handle: 'draft',
      callerSubject: 'alice',
      expectedRevision: 0,
      value: { title: 'Initial', count: 1 },
    });
    expect(store.read({ handle: 'draft', callerSubject: 'alice' })).toMatchObject({
      value: { title: 'Initial', count: 1 },
      revision: initial.revision,
      status: 'active',
    });

    now += 61_000;
    const expired = store.read({ handle: 'draft', callerSubject: 'alice' });
    expect(expired).toMatchObject({ status: 'expired' });

    const recreated = store.patch({
      handle: 'draft',
      callerSubject: 'alice',
      expectedRevision: expired.revision,
      value: { title: 'Fresh' },
    });
    expect(recreated).toMatchObject({
      value: { title: 'Fresh' },
      status: 'active',
    });

    const patched = store.patch({
      handle: 'draft',
      callerSubject: 'alice',
      expectedRevision: recreated.revision,
      value: { count: 2 },
    });
    expect(patched).toMatchObject({
      value: { title: 'Fresh', count: 2 },
      revision: recreated.revision + 1,
      status: 'active',
    });
    expect(store.read({ handle: 'draft', callerSubject: 'alice' })).toEqual(patched);
  });

  it('uses one clock snapshot for mutation decisions and response shaping', () => {
    const start = Date.UTC(2026, 7, 25, 12, 0, 0);
    let patchNow = start;
    const patchStore = new InMemoryStateHandleStore(state, () => {
      const value = patchNow;
      patchNow += 61_000;
      return new Date(value);
    });

    expect(
      patchStore.patch({
        handle: 'draft',
        callerSubject: 'alice',
        expectedRevision: 0,
        value: { title: 'Captured once' },
      }),
    ).toMatchObject({ revision: 1, status: 'active' });

    let completeNow = start;
    let advanceClock = false;
    const completeStore = new InMemoryStateHandleStore(state, () => {
      const value = completeNow;
      if (advanceClock) completeNow += 61_000;
      return new Date(value);
    });
    const initial = completeStore.patch({
      handle: 'draft',
      callerSubject: 'alice',
      expectedRevision: 0,
      value: { title: 'Complete once' },
    });

    advanceClock = true;
    expect(
      completeStore.complete({
        handle: 'draft',
        callerSubject: 'alice',
        expectedRevision: initial.revision,
      }),
    ).toMatchObject({ revision: initial.revision + 1, status: 'completed' });
  });

  it('rejects stale pre-expiry revisions and allows only one fresh writer after expiry', async () => {
    let now = Date.UTC(2026, 7, 25, 12, 0, 0);
    const store = new InMemoryStateHandleStore(state, () => new Date(now));
    const connector = new StateConnector(store);
    const initial = store.patch({
      handle: 'draft',
      callerSubject: 'alice',
      expectedRevision: 0,
      value: { title: 'Initial' },
    });

    now += 61_000;
    const expired = store.read({ handle: 'draft', callerSubject: 'alice' });
    expect(expired).toMatchObject({
      revision: initial.revision + 1,
      status: 'expired',
    });
    expect(() =>
      store.patch({
        handle: 'draft',
        callerSubject: 'alice',
        expectedRevision: initial.revision,
        value: { title: 'Stale' },
      }),
    ).toThrow(/revision conflict/);

    const credential = { token: 'svc-token', scope: 'state' };
    const attempts = await Promise.allSettled([
      connector.invoke({
        operation: PATCH_STATE_OPERATION,
        credential,
        caller: { subject: 'alice' },
        args: {
          handle: 'draft',
          expectedRevision: expired.revision,
          value: { title: 'First fresh writer' },
        },
      }),
      connector.invoke({
        operation: PATCH_STATE_OPERATION,
        credential,
        caller: { subject: 'alice' },
        args: {
          handle: 'draft',
          expectedRevision: expired.revision,
          value: { title: 'Second fresh writer' },
        },
      }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    const rejection = attempts.find((attempt) => attempt.status === 'rejected');
    expect(rejection).toMatchObject({ status: 'rejected' });
    expect(String(rejection && rejection.status === 'rejected' ? rejection.reason : '')).toMatch(
      /revision conflict/,
    );
    expect(store.read({ handle: 'draft', callerSubject: 'alice' })).toMatchObject({
      revision: expired.revision + 1,
      status: 'active',
    });
    expect(store.read({ handle: 'draft', callerSubject: 'bob' })).toMatchObject({
      value: {},
      revision: 0,
      status: 'active',
    });
  });

  it('keeps completed handles immutable and rejects secrets and schema-invalid values', () => {
    const store = new InMemoryStateHandleStore(state);
    store.patch({ handle: 'draft', expectedRevision: 0, value: { title: 'Done' } });
    expect(store.complete({ handle: 'draft', expectedRevision: 1 })).toMatchObject({
      status: 'completed',
      revision: 2,
    });
    expect(() =>
      store.patch({ handle: 'draft', expectedRevision: 2, value: { title: 'Again' } }),
    ).toThrow(/read-only/);
    expect(() =>
      new InMemoryStateHandleStore(state).patch({
        handle: 'draft',
        expectedRevision: 0,
        value: { accessToken: 'nope' },
      }),
    ).toThrow(/credential-shaped/);
    expect(() =>
      new InMemoryStateHandleStore(state).patch({
        handle: 'draft',
        expectedRevision: 0,
        value: { count: 'not-an-integer' },
      }),
    ).toThrow(/must be an integer/);
  });

  it('exposes state operations through the runtime connector', async () => {
    const connector = new StateConnector(new InMemoryStateHandleStore(state));
    const credential = { token: 'svc-token', scope: 'state' };

    await expect(
      connector.invoke({
        operation: PATCH_STATE_OPERATION,
        credential,
        caller: { subject: 'alice' },
        args: {
          handle: 'draft',
          expectedRevision: 0,
          value: { title: 'From connector' },
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { title: 'From connector' },
      revision: 1,
    });

    await expect(
      connector.invoke({
        operation: READ_STATE_OPERATION,
        credential,
        caller: { subject: 'alice' },
        args: { handle: 'draft' },
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { title: 'From connector' },
      revision: 1,
    });
  });
});
