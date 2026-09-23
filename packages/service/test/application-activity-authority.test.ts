import { describe, expect, it, vi } from 'vitest';
import { type ActivityProjectionAction, ApplicationActivity } from '../src/application-activity.js';
import { BusinessWorkspaceError } from '../src/business-workspaces/contracts.js';
import { InMemoryOperationCoordinationStore } from '../src/operation-coordination.js';
import { InMemoryOperationEvidenceStore } from '../src/operation-evidence-memory.js';

const scope = { org: 'acme', app: 'sales', env: 'production', installationId: 'sales' };
const input = { parameters: [], canEdit: true, reviewer: 'owner' } as const;
function fixture() {
  let inside = false;
  const store = new InMemoryOperationEvidenceStore();
  const coordination = new InMemoryOperationCoordinationStore();
  const calls: string[] = [];
  const check = (method: string) => {
    expect(inside, method).toBe(true);
    calls.push(method);
  };
  const read = store.readRetention.bind(store);
  vi.spyOn(store, 'readRetention').mockImplementation((...args) => {
    check('readRetention');
    return read(...args);
  });
  const set = store.setRetention.bind(store);
  vi.spyOn(store, 'setRetention').mockImplementation((...args) => {
    check('setRetention');
    return set(...args);
  });
  const list = store.list.bind(store);
  vi.spyOn(store, 'list').mockImplementation((...args) => {
    check('list');
    return list(...args);
  });
  const preview = store.preview.bind(store);
  vi.spyOn(store, 'preview').mockImplementation((...args) => {
    check('preview');
    return preview(...args);
  });
  const activity = new ApplicationActivity({
    store,
    coordination,
    epoch: 'test',
    identityKey: 'test',
    allowance: async () => {
      expect(inside, 'billing authority must resolve outside the workspace transaction').toBe(
        false,
      );
      return {
        maximumDays: 30,
        defaultDays: 7,
        revision: 'policy',
        preview: {
          asOf: '2026-09-07T00:00:00.000Z',
          paidPeriodEnd: '2026-10-01T00:00:00.000Z',
          scenarios: [{ id: 'free', label: 'Free', maximumDays: 7 }],
        },
      };
    },
  });
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    expect(inside).toBe(false);
    inside = true;
    try {
      return await operation();
    } finally {
      inside = false;
    }
  };
  return { activity, store, coordination, calls, run };
}

describe('application activity local-effect authority', () => {
  it('fences initialization, settings CAS, listing, export, and preview without enclosing billing', async () => {
    const { activity, calls, run } = fixture();
    const settings = await activity.settings(scope, true, run);
    await activity.project(
      scope,
      'save-settings',
      {
        ...input,
        body: { expectedRevision: settings.projection.revision, activityDays: 3 },
      },
      run,
    );
    for (const action of ['settings', 'list', 'export', 'preview'] as const)
      await activity.project(scope, action, input, run);
    expect(calls.filter((name) => name === 'setRetention')).toHaveLength(2);
    expect(calls.filter((name) => name === 'list')).toHaveLength(2);
    expect(calls.filter((name) => name === 'preview')).toHaveLength(1);
  });

  it.each([
    'settings',
    'list',
    'export',
    'preview',
    'save-settings',
  ] as const)('denies %s before any local read or write when access is withdrawn', async (action) => {
    const { activity, calls } = fixture();
    const forbidden = new BusinessWorkspaceError('forbidden');
    await expect(
      activity.project(
        scope,
        action,
        {
          ...input,
          body: { expectedRevision: 'a'.repeat(64), activityDays: 3 },
        },
        async () => {
          throw forbidden;
        },
      ),
    ).rejects.toBe(forbidden);
    expect(calls).toEqual([]);
  });

  it('rechecks immediately before a settings write, not only on the preceding read', async () => {
    const { activity, calls, run } = fixture();
    const settings = await activity.settings(scope, true, run);
    calls.length = 0;
    let count = 0;
    await expect(
      activity.project(
        scope,
        'save-settings',
        {
          ...input,
          body: { expectedRevision: settings.projection.revision, activityDays: 3 },
        },
        (operation) => {
          if (++count === 2) throw new BusinessWorkspaceError('forbidden');
          return run(operation);
        },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(calls).toEqual(['readRetention']);
  });

  it.each([
    'coordination-list',
    'coordination-resolve',
  ] as const)('preserves forbidden errors outside the %s backend-error mapping', async (action: ActivityProjectionAction) => {
    const { activity, coordination } = fixture();
    const list = vi.spyOn(coordination, 'list');
    const resolve = vi.spyOn(coordination, 'resolve');
    const forbidden = new BusinessWorkspaceError('forbidden');
    await expect(
      activity.project(
        scope,
        action,
        {
          ...input,
          body: {
            resource: 'a'.repeat(64),
            token: '11111111-1111-4111-8111-111111111111',
            reason: 'Verified with the customer',
          },
        },
        async () => {
          throw forbidden;
        },
      ),
    ).rejects.toBe(forbidden);
    expect(list).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });
});
