import {
  MODULE_API_VERSION,
  type PlatformHumanIdentityContribution,
  PlatformIdentityError,
} from '@noodle-borg/module';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';

async function setup() {
  const store = new InMemoryBusinessInformationStore();
  const scope = { org: 'acme', app: 'travel', env: 'prod', installationId: 'travel-prod' };
  await store.createInstallation({
    scope,
    profileKey: 'travel',
    managedCollections: ['travel_requests'],
    actorSubject: 'owner',
  });
  for (const [subject, role] of [
    ['active', 'operator'],
    ['inactive', 'operator'],
    ['viewer', 'viewer'],
  ] as const) {
    await store.setGrant({
      scope,
      subject,
      email: `${subject}@example.test`,
      role,
      actorSubject: 'owner',
      expectedRevision: 0,
    });
  }
  const accepted = await store.createRequest({
    scope,
    collectionKey: 'travel_requests',
    payload: { request_type: 'service', summary: 'Preserve history' },
    idempotencyKey: 'create',
    origin: { kind: 'portal' },
    actorSubject: 'owner',
  });
  if (accepted.disposition !== 'created') throw new Error('fixture was not created');
  const assign = (subject: string, expectedRevision = 1) =>
    store.mutateRequest({
      scope,
      collectionKey: 'travel_requests',
      id: accepted.record.id,
      expectedRevision,
      actorSubject: 'owner',
      operation: { kind: 'assign', assigneeSubject: subject },
    });
  return { store, scope, accepted, assign };
}
function authority(
  assertActive: (subject: string) => Promise<void>,
): Pick<PlatformHumanIdentityContribution, 'principalResolver'> {
  return {
    principalResolver: {
      assertActive,
      resolve: vi.fn(),
      resolveLinked: vi.fn(),
      hasVerifiedEmailEvidence: vi.fn(),
      assertEmailAvailable: vi.fn(),
      resolveExisting: vi.fn(),
      lookupActiveVerifiedEmails: vi.fn(),
    },
  };
}

describe('canonical principal assignment authority', () => {
  it('excludes suspended principals and preserves accepted history when suspension happens later', async () => {
    const { store, scope, accepted, assign } = await setup();
    let suspended = 'inactive';
    store.configurePrincipalAuthority(
      authority(async (subject) => {
        if (subject === suspended) throw new PlatformIdentityError('principal_suspended');
      }),
    );
    expect((await store.listEligibleAssignees(scope)).map((grant) => grant.subject)).toEqual([
      'active',
    ]);
    expect(await assign('inactive')).toMatchObject({ ok: false, reason: 'invalid_assignee' });
    expect(await assign('active')).toMatchObject({ ok: true, record: { revision: 2 } });
    suspended = 'active';
    expect(await assign('active', 2)).toMatchObject({ ok: false, reason: 'invalid_assignee' });
    expect(await store.getRequest(scope, 'travel_requests', accepted.record.id)).toMatchObject({
      revision: 2,
      assigneeSubject: 'active',
    });
    expect(
      (await store.listActivity(scope, 'travel_requests', accepted.record.id)).activities,
    ).toHaveLength(2);
  });
  it('fails closed on resolver outage, without a mutation or a falsely empty success projection', async () => {
    const { store, scope, accepted, assign } = await setup();
    store.configurePrincipalAuthority(
      authority(async () => {
        throw new Error('identity unavailable');
      }),
    );
    await expect(assign('active')).rejects.toThrow('identity unavailable');
    await expect(store.listEligibleAssignees(scope)).rejects.toThrow('identity unavailable');
    expect(await store.getRequest(scope, 'travel_requests', accepted.record.id)).toMatchObject({
      revision: 1,
    });
  });
  it('keeps ordinary portable identity semantics when no canonical provider is configured', async () => {
    const { store, scope, assign } = await setup();
    expect((await store.listEligibleAssignees(scope)).map((grant) => grant.subject)).toEqual([
      'active',
      'inactive',
    ]);
    expect(await assign('active')).toMatchObject({ ok: true });
  });
});

describe('composed business principal projection', () => {
  it('uses the configured module identity authority for HTTP eligibility and assignment', async () => {
    const { store, scope, accepted } = await setup();
    const [
      { createServer },
      { ServerRegistry },
      { createServiceHandler },
      { listenHttpServer, closeHttpServer },
    ] = await Promise.all([
      import('node:http'),
      import('../src/registry.js'),
      import('../src/service.js'),
      import('../src/service-resource-cleanup.js'),
    ]);
    const provider = authority(async (subject) => {
      if (subject === 'inactive') throw new PlatformIdentityError('principal_suspended');
    });
    const http = createServer(
      createServiceHandler(new ServerRegistry(), {
        businessInformationStore: store,
        loadedModules: [
          {
            module: {
              name: 'canonical-test-identity',
              version: '0.0.0',
              apiVersion: MODULE_API_VERSION,
              init: () => ({ platformHumanIdentity: provider }),
            },
            contributions: { platformHumanIdentity: provider },
            position: 0,
          },
        ],
        deployGate: {
          authorize: async () => ({
            ok: true,
            identity: { subject: 'owner', email: 'owner@example.test', superAdmin: false },
          }),
        },
      }),
    );
    await listenHttpServer(http, 0, '127.0.0.1');
    try {
      const address = http.address();
      if (!address || typeof address === 'string') throw new Error('listener missing');
      const base = `http://127.0.0.1:${address.port}/v1/orgs/${scope.org}/solution-installations/${scope.installationId}`;
      const response = await fetch(`${base}/assignees`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ data: { assignees: [{ subject: 'active' }] } });
      const denied = await fetch(
        `${base}/collections/travel_requests/records/${accepted.record.id}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedRevision: 1,
            operation: 'assign',
            assigneeSubject: 'inactive',
          }),
        },
      );
      expect(denied.status).toBe(422);
      expect(await denied.json()).toMatchObject({ code: 'invalid_assignee' });
    } finally {
      await closeHttpServer(http);
    }
  });
});
