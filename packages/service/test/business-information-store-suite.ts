import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type {
  BusinessInformationStore,
  InstallationScope,
  ManagedRequestRecord,
} from '../src/business-information/contracts.js';
import { builtInDefinitionAtRelease } from '../src/business-information/profiles.js';
import { describeNativeRecordQueries } from './business-information-query-suite.js';
import { describeNativeRecordRetention } from './business-information-retention-suite.js';

export interface StoreHarness {
  readonly store: BusinessInformationStore;
  readonly advance: (milliseconds: number) => void;
}

export function describeBusinessInformationStore(makeHarness: () => Promise<StoreHarness>): void {
  describeNativeRecordQueries(makeHarness);
  describeNativeRecordRetention(makeHarness);
  const uniqueScope = (suffix = randomUUID()): InstallationScope => ({
    org: `org-${suffix}`,
    app: 'operations',
    env: 'prod',
    installationId: `install-${suffix}`,
  });

  async function install(harness: StoreHarness, scope = uniqueScope()) {
    const result = await harness.store.createInstallation({
      scope,
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      retentionDays: 30,
      actorSubject: 'founder',
    });
    expect(result.disposition).toBe('created');
    if (result.disposition !== 'created') throw new Error('installation was not created');
    return { scope, installation: result.installation };
  }

  async function createRequest(
    harness: StoreHarness,
    scope: InstallationScope,
    suffix = randomUUID(),
  ): Promise<ManagedRequestRecord> {
    const result = await harness.store.createRequest({
      scope,
      collectionKey: 'travel_requests',
      idempotencyKey: `request-${suffix}`,
      payload: {
        request_type: 'refund',
        summary: 'Review a synthetic refund request.',
        booking_reference: 'ABC123',
      },
      origin: { kind: 'embedded', reference: 'booking-page' },
      actorSubject: 'traveler-1',
    });
    expect(result.disposition).toBe('created');
    if (result.disposition !== 'created') throw new Error('request was not created');
    return result.record;
  }

  it('clears optional fields atomically with updates, preserves omissions, and rejects stale or invalid clears', async () => {
    const harness = await makeHarness();
    const { scope } = await install(harness);
    const record = await createRequest(harness, scope);
    const command = {
      scope,
      collectionKey: 'travel_requests',
      id: record.id,
      expectedRevision: 1,
      actorSubject: 'founder',
    };
    for (const operation of [
      { kind: 'update' as const, payload: {}, unset: ['summary'] },
      { kind: 'update' as const, payload: { booking_reference: null } },
      {
        kind: 'update' as const,
        payload: { booking_reference: 'OTHER' },
        unset: ['booking_reference'],
      },
    ]) {
      await expect(harness.store.mutateRequest({ ...command, operation })).rejects.toThrow();
      expect(await harness.store.getRequest(scope, command.collectionKey, record.id)).toMatchObject(
        {
          revision: 1,
          content: {
            payload: { booking_reference: 'ABC123', summary: record.content?.payload.summary },
          },
        },
      );
    }
    const result = await harness.store.mutateRequest({
      ...command,
      operation: {
        kind: 'update',
        payload: { summary: 'Corrected' },
        unset: ['booking_reference'],
      },
    });
    expect(result).toMatchObject({ ok: true, record: { revision: 2 } });
    const read = await harness.store.getRequest(scope, command.collectionKey, record.id);
    expect(read?.content?.payload).not.toHaveProperty('booking_reference');
    expect(read?.content?.payload).toMatchObject({ request_type: 'refund', summary: 'Corrected' });
    expect(
      await harness.store.mutateRequest({
        ...command,
        operation: { kind: 'update', payload: { booking_reference: 'STALE' } },
      }),
    ).toMatchObject({ ok: false, reason: 'conflict' });
    expect(
      (await harness.store.listActivity(scope, command.collectionKey, record.id)).activities,
    ).toHaveLength(2);
  });

  it('pages immutable history newest first without losing older entries when a new edit arrives', async () => {
    const harness = await makeHarness();
    const { scope } = await install(harness);
    const record = await createRequest(harness, scope);
    for (let revision = 1; revision < 62; revision++) {
      expect(
        await harness.store.mutateRequest({
          scope,
          collectionKey: 'travel_requests',
          id: record.id,
          expectedRevision: revision,
          actorSubject: 'founder',
          operation: { kind: 'update', payload: { summary: `Revision ${revision}` } },
        }),
      ).toMatchObject({ ok: true });
    }
    const first = await harness.store.listActivity(scope, 'travel_requests', record.id);
    expect(first.activities).toHaveLength(50);
    expect(first.activities[0]?.revision).toBe(62);
    expect(first.activities.at(-1)?.revision).toBe(13);
    expect(first.nextCursor).toEqual(expect.any(String));
    if (first.nextCursor === undefined) throw new Error('Expected older history cursor');
    await harness.store.mutateRequest({
      scope,
      collectionKey: 'travel_requests',
      id: record.id,
      expectedRevision: 62,
      actorSubject: 'founder',
      operation: { kind: 'update', payload: { summary: 'Concurrent later edit' } },
    });
    const older = await harness.store.listActivity(scope, 'travel_requests', record.id, {
      cursor: first.nextCursor,
    });
    expect(older.activities.map((entry) => entry.revision)).toEqual(
      Array.from({ length: 12 }, (_, i) => 12 - i),
    );
    expect(older.nextCursor).toBeUndefined();
    expect(older.activities.at(-1)?.kind).toBe('created');
    const other = await createRequest(harness, scope);
    await expect(
      harness.store.listActivity(scope, 'travel_requests', other.id, { cursor: first.nextCursor }),
    ).rejects.toThrow(/cursor/);
    await expect(
      harness.store.listActivity(scope, 'travel_requests', record.id, { limit: 101 }),
    ).rejects.toThrow(/limit/);
  });

  it('creates an opt-in installation idempotently and an independent administrator grant', async () => {
    const harness = await makeHarness();
    const scope = uniqueScope();
    const input = {
      scope,
      profileKey: 'travel' as const,
      managedCollections: ['travel_requests'] as const,
      retentionDays: 30 as const,
      actorSubject: 'founder',
      actorEmail: 'Founder@Example.com',
    };
    const created = await harness.store.createInstallation(input);
    const replay = await harness.store.createInstallation(input);
    expect(created).toMatchObject({
      disposition: 'created',
      installation: {
        scope,
        publicId: expect.stringMatching(/^sol_/),
        retentionDays: 30,
        intakeActive: true,
        revision: 1,
      },
    });
    expect(replay).toMatchObject({ disposition: 'replayed', installation: created.installation });
    await expect(
      harness.store.createInstallation({ ...input, retentionDays: 90 }),
    ).resolves.toMatchObject({ disposition: 'conflict' });
    await expect(harness.store.getGrant(scope, 'founder')).resolves.toMatchObject({
      email: 'founder@example.com',
      role: 'administrator',
      revision: 1,
    });
    await expect(
      harness.store.getInstallationById(scope.org, scope.installationId),
    ).resolves.toEqual(created.installation);
    await expect(
      harness.store.resolveInstallationByPublicId(created.installation.publicId),
    ).resolves.toEqual(created.installation);
    await expect(harness.store.listInstallations(scope.org)).resolves.toEqual([
      created.installation,
    ]);
  });

  it('inventories accepted schema identities once without reading record content', async () => {
    const harness = await makeHarness();
    const { scope } = await install(harness);
    const first = await createRequest(harness, scope, 'schema-inventory-first');
    await createRequest(harness, scope, 'schema-inventory-second');
    const inventory = await harness.store.listAcceptedSchemaInventory();
    expect(
      inventory.filter(
        (schema) =>
          schema.profileKey === first.profileKey &&
          schema.profileVersion === first.profileVersion &&
          schema.collectionKey === first.collectionKey,
      ),
    ).toEqual([
      {
        profileKey: first.profileKey,
        profileVersion: first.profileVersion,
        collectionKey: first.collectionKey,
        schemaVersion: first.schemaVersion,
        schemaDigest: first.schemaDigest,
      },
    ]);
  });

  it('replays the same managed install intent after its central definition advances', async () => {
    const harness = await makeHarness();
    const scope = uniqueScope('managed-release-replay');
    const input = {
      scope,
      managedCollections: ['travel_requests'] as const,
      retentionDays: 30 as const,
      actorSubject: 'founder',
      actorEmail: 'founder@example.com',
    };
    const created = await harness.store.createInstallation({
      ...input,
      definition: builtInDefinitionAtRelease('travel', 1),
    });
    const replay = await harness.store.createInstallation({
      ...input,
      definition: builtInDefinitionAtRelease('travel', 2),
    });
    expect(created.disposition).toBe('created');
    expect(replay).toMatchObject({
      disposition: 'replayed',
      installation: { publicId: created.installation.publicId },
    });
  });

  it('pauses only anonymous intake with CAS while preserving staff operations and replay receipts', async () => {
    const harness = await makeHarness();
    const { scope, installation } = await install(harness);
    const publicInput = {
      scope,
      collectionKey: 'travel_requests',
      idempotencyKey: 'public-before-pause',
      payload: { request_type: 'service', summary: 'Created before pause.' },
      origin: { kind: 'embedded' as const, reference: 'public-intake' },
      actorSubject: 'anonymous',
    };
    const beforePause = await harness.store.createRequest(publicInput);
    expect(beforePause.disposition).toBe('created');

    const paused = await harness.store.setIntakeState({
      scope,
      expectedRevision: installation.revision,
      active: false,
      actorSubject: 'founder',
    });
    expect(paused).toMatchObject({
      ok: true,
      installation: { intakeActive: false, revision: installation.revision + 1 },
    });
    await expect(harness.store.createRequest(publicInput)).resolves.toMatchObject({
      disposition: 'replayed',
    });
    await expect(
      harness.store.createRequest({
        ...publicInput,
        idempotencyKey: 'public-after-pause',
      }),
    ).resolves.toEqual({ disposition: 'paused' });
    await expect(
      harness.store.createRequest({
        ...publicInput,
        idempotencyKey: 'native-tool-after-pause',
        origin: { kind: 'mcp', reference: 'native-tool' },
        publicInput: true,
      }),
    ).resolves.toEqual({ disposition: 'paused' });
    await expect(
      harness.store.createRequest({
        ...publicInput,
        idempotencyKey: 'staff-after-pause',
        origin: { kind: 'portal' },
        actorSubject: 'founder',
      }),
    ).resolves.toMatchObject({ disposition: 'created' });
    await expect(
      harness.store.setIntakeState({
        scope,
        expectedRevision: installation.revision,
        active: true,
        actorSubject: 'founder',
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'conflict',
      currentRevision: installation.revision + 1,
    });
    const resumed = await harness.store.setIntakeState({
      scope,
      expectedRevision: installation.revision + 1,
      active: true,
      actorSubject: 'founder',
    });
    expect(resumed).toMatchObject({
      ok: true,
      installation: { intakeActive: true, revision: installation.revision + 2 },
    });
    await expect(
      harness.store.setIntakeState({
        scope,
        expectedRevision: installation.revision + 2,
        active: true,
        actorSubject: 'founder',
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'invalid_state',
      currentRevision: installation.revision + 2,
    });
  });

  it('keeps business grants installation-scoped and uses CAS for role changes and revocation', async () => {
    const harness = await makeHarness();
    const { scope } = await install(harness);
    const other = (await install(harness, uniqueScope())).scope;
    await expect(
      harness.store.setGrant({
        scope: uniqueScope(),
        subject: 'agent-1',
        email: 'agent-1@example.com',
        role: 'operator',
        expectedRevision: 0,
        actorSubject: 'founder',
      }),
    ).resolves.toEqual({ ok: false, reason: 'not_found', currentRevision: 0 });
    const granted = await harness.store.setGrant({
      scope,
      subject: 'agent-1',
      email: 'agent-1@example.com',
      role: 'operator',
      expectedRevision: 0,
      actorSubject: 'founder',
    });
    expect(granted).toMatchObject({
      ok: true,
      grant: { email: 'agent-1@example.com', role: 'operator', revision: 1 },
    });
    await expect(harness.store.getGrant(other, 'agent-1')).resolves.toBeUndefined();
    await expect(
      harness.store.setGrant({
        scope,
        subject: 'agent-1',
        email: 'agent-1@example.com',
        role: 'manager',
        expectedRevision: 0,
        actorSubject: 'founder',
      }),
    ).resolves.toEqual({ ok: false, reason: 'conflict', currentRevision: 1 });
    await expect(
      harness.store.revokeGrant({
        scope,
        subject: 'agent-1',
        expectedRevision: 1,
        actorSubject: 'founder',
      }),
    ).resolves.toMatchObject({ ok: true, grant: { revision: 2, revokedAt: expect.any(String) } });
  });

  it('preserves at least one live installation administrator', async () => {
    const harness = await makeHarness();
    const { scope } = await install(harness);
    await expect(
      harness.store.setGrant({
        scope,
        subject: 'founder',
        email: 'founder@example.com',
        role: 'manager',
        expectedRevision: 1,
        actorSubject: 'founder',
      }),
    ).resolves.toEqual({ ok: false, reason: 'last_administrator', currentRevision: 1 });
    await expect(
      harness.store.revokeGrant({
        scope,
        subject: 'founder',
        expectedRevision: 1,
        actorSubject: 'founder',
      }),
    ).resolves.toEqual({ ok: false, reason: 'last_administrator', currentRevision: 1 });
    await harness.store.setGrant({
      scope,
      subject: 'admin-2',
      email: 'admin-2@example.com',
      role: 'administrator',
      expectedRevision: 0,
      actorSubject: 'founder',
    });
    await expect(
      harness.store.revokeGrant({
        scope,
        subject: 'founder',
        expectedRevision: 1,
        actorSubject: 'admin-2',
      }),
    ).resolves.toMatchObject({ ok: true, grant: { revokedAt: expect.any(String) } });
  });

  it('claims one installation invitation once and discovers the grant without org membership', async () => {
    const harness = await makeHarness();
    const { scope, installation } = await install(harness);
    const tokenDigest = createHash('sha256').update('invite-token').digest('hex');
    const input = {
      scope,
      invitationId: 'binv_1',
      email: 'Staff@Example.com',
      role: 'operator' as const,
      tokenDigest,
      idempotencyKey: 'invite-staff-1',
      expiresAt: new Date('2030-01-08T00:00:00.000Z'),
      actorSubject: 'founder',
    };
    const created = await harness.store.createInvitation(input);
    expect(created).toMatchObject({
      disposition: 'created',
      invitation: { email: 'staff@example.com', role: 'operator', revision: 1 },
    });
    await expect(harness.store.createInvitation(input)).resolves.toMatchObject({
      disposition: 'replayed',
      invitation: { invitationId: 'binv_1' },
    });
    await expect(
      harness.store.createInvitation({ ...input, role: 'viewer' }),
    ).resolves.toMatchObject({ disposition: 'conflict' });
    await expect(
      harness.store.claimInvitation({
        tokenDigest,
        subject: 'staff-subject',
        email: 'wrong@example.com',
      }),
    ).resolves.toEqual({ ok: false, reason: 'email_mismatch' });
    const [first, replay] = await Promise.all([
      harness.store.claimInvitation({
        tokenDigest,
        subject: 'staff-subject',
        email: 'staff@example.com',
      }),
      harness.store.claimInvitation({
        tokenDigest,
        subject: 'staff-subject',
        email: 'staff@example.com',
      }),
    ]);
    expect([first, replay].filter((result) => result.ok)).toHaveLength(1);
    expect([first, replay].filter((result) => !result.ok)).toEqual([
      { ok: false, reason: 'already_used' },
    ]);
    await expect(harness.store.listInstallationsForSubject('staff-subject')).resolves.toEqual([
      {
        installation,
        grant: expect.objectContaining({
          subject: 'staff-subject',
          email: 'staff@example.com',
          role: 'operator',
        }),
      },
    ]);
  });

  it('does not let an invitation acceptance replace the final administrator', async () => {
    const harness = await makeHarness();
    const { scope } = await install(harness);
    const tokenDigest = createHash('sha256').update('founder-operator-invite').digest('hex');
    await harness.store.createInvitation({
      scope,
      invitationId: 'binv_founder_operator',
      email: 'founder@example.com',
      role: 'operator',
      tokenDigest,
      idempotencyKey: 'founder-operator-invite',
      expiresAt: new Date('2030-01-08T00:00:00.000Z'),
      actorSubject: 'founder',
    });

    await expect(
      harness.store.claimInvitation({
        tokenDigest,
        subject: 'founder',
        email: 'founder@example.com',
      }),
    ).resolves.toEqual({ ok: false, reason: 'last_administrator' });
    await expect(harness.store.getGrant(scope, 'founder')).resolves.toMatchObject({
      role: 'administrator',
      revision: 1,
    });
    await expect(harness.store.listInvitations(scope)).resolves.toEqual([
      expect.objectContaining({ invitationId: 'binv_founder_operator', revision: 1 }),
    ]);

    await harness.store.setGrant({
      scope,
      subject: 'admin-2',
      email: 'admin-2@example.com',
      role: 'administrator',
      expectedRevision: 0,
      actorSubject: 'founder',
    });
    await expect(
      harness.store.claimInvitation({
        tokenDigest,
        subject: 'founder',
        email: 'founder@example.com',
      }),
    ).resolves.toMatchObject({
      ok: true,
      invitation: { revision: 2, acceptedBySubject: 'founder' },
      grant: { subject: 'founder', role: 'operator', revision: 2 },
    });
  });

  it('serializes invitation role replacement with administrator revocation', async () => {
    const harness = await makeHarness();
    const { scope } = await install(harness);
    await harness.store.setGrant({
      scope,
      subject: 'admin-2',
      email: 'admin-2@example.com',
      role: 'administrator',
      expectedRevision: 0,
      actorSubject: 'founder',
    });
    const tokenDigest = createHash('sha256').update('concurrent-founder-invite').digest('hex');
    await harness.store.createInvitation({
      scope,
      invitationId: 'binv_concurrent_founder',
      email: 'founder@example.com',
      role: 'operator',
      tokenDigest,
      idempotencyKey: 'concurrent-founder-invite',
      expiresAt: new Date('2030-01-08T00:00:00.000Z'),
      actorSubject: 'founder',
    });

    const outcomes = await Promise.all([
      harness.store.claimInvitation({
        tokenDigest,
        subject: 'founder',
        email: 'founder@example.com',
      }),
      harness.store.revokeGrant({
        scope,
        subject: 'admin-2',
        expectedRevision: 1,
        actorSubject: 'founder',
      }),
    ]);
    expect(outcomes.filter((result) => result.ok)).toHaveLength(1);
    expect(outcomes.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ reason: 'last_administrator' }),
    ]);
    const grants = await harness.store.listGrants(scope);
    expect(
      grants.filter((grant) => grant.role === 'administrator' && grant.revokedAt === undefined),
    ).toHaveLength(1);
  });

  it('expires and revokes invitation credentials without creating grants', async () => {
    const harness = await makeHarness();
    const { scope } = await install(harness);
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    await harness.store.createInvitation({
      scope,
      invitationId: 'binv_expired',
      email: 'expired@example.com',
      role: 'viewer',
      tokenDigest: digest('expired'),
      idempotencyKey: 'expired',
      expiresAt: new Date(0),
      actorSubject: 'founder',
    });
    await expect(
      harness.store.claimInvitation({
        tokenDigest: digest('expired'),
        subject: 'expired-subject',
        email: 'expired@example.com',
      }),
    ).resolves.toEqual({ ok: false, reason: 'expired' });
    await harness.store.createInvitation({
      scope,
      invitationId: 'binv_revoked',
      email: 'revoked@example.com',
      role: 'operator',
      tokenDigest: digest('revoked'),
      idempotencyKey: 'revoked',
      expiresAt: new Date('2030-01-02T00:00:00.000Z'),
      actorSubject: 'founder',
    });
    await expect(
      harness.store.revokeInvitation({
        scope,
        invitationId: 'binv_revoked',
        expectedRevision: 1,
        actorSubject: 'founder',
      }),
    ).resolves.toMatchObject({
      ok: true,
      invitation: { revision: 2, revokedAt: expect.any(String) },
    });
    await expect(
      harness.store.claimInvitation({
        tokenDigest: digest('revoked'),
        subject: 'revoked-subject',
        email: 'revoked@example.com',
      }),
    ).resolves.toEqual({ ok: false, reason: 'revoked' });
    await expect(harness.store.listInstallationsForSubject('revoked-subject')).resolves.toEqual([]);
  });

  it('serializes invitation acceptance with invitation revocation', async () => {
    const harness = await makeHarness();
    const { scope } = await install(harness);
    const tokenDigest = createHash('sha256').update('claim-revoke-race').digest('hex');
    await harness.store.createInvitation({
      scope,
      invitationId: 'binv_claim_revoke_race',
      email: 'racer@example.com',
      role: 'operator',
      tokenDigest,
      idempotencyKey: 'claim-revoke-race',
      expiresAt: new Date('2030-01-08T00:00:00.000Z'),
      actorSubject: 'founder',
    });

    const outcomes = await Promise.all([
      harness.store.claimInvitation({
        tokenDigest,
        subject: 'racer-subject',
        email: 'racer@example.com',
      }),
      harness.store.revokeInvitation({
        scope,
        invitationId: 'binv_claim_revoke_race',
        expectedRevision: 1,
        actorSubject: 'founder',
      }),
    ]);
    expect(outcomes.filter((result) => result.ok)).toHaveLength(1);
    expect(outcomes.filter((result) => !result.ok)).toHaveLength(1);
    const invitation = (await harness.store.listInvitations(scope))[0];
    expect(Boolean(invitation?.acceptedAt) !== Boolean(invitation?.revokedAt)).toBe(true);
  });

  it('creates requests idempotently, isolates installations, and returns defensive records', async () => {
    const harness = await makeHarness();
    const { scope } = await install(harness);
    const other = (await install(harness, uniqueScope())).scope;
    const input = {
      scope,
      collectionKey: 'travel_requests',
      idempotencyKey: 'intake-1',
      payload: { request_type: 'service', summary: 'Change the passenger meal.' },
      origin: { kind: 'mcp' as const, reference: 'call-1' },
      actorSubject: 'traveler-1',
    };
    const created = await harness.store.createRequest(input);
    const replay = await harness.store.createRequest(input);
    expect(created).toMatchObject({
      disposition: 'created',
      record: { revision: 1, content: { payload: { status: 'new' } } },
    });
    expect(replay).toMatchObject({ disposition: 'replayed', record: created.record });
    await expect(
      harness.store.createRequest({
        ...input,
        payload: { ...input.payload, summary: 'Changed retry' },
      }),
    ).resolves.toMatchObject({ disposition: 'conflict' });
    await expect(
      harness.store.getRequest(other, 'travel_requests', created.record.id),
    ).resolves.toBeUndefined();
    const read = await harness.store.getRequest(scope, 'travel_requests', created.record.id);
    if (read?.content) (read.content.payload as { summary: string }).summary = 'outside mutation';
    await expect(
      harness.store.getRequest(scope, 'travel_requests', created.record.id),
    ).resolves.toMatchObject({
      content: { payload: { summary: 'Change the passenger meal.' } },
    });

    await harness.store.mutateRequest({
      scope,
      collectionKey: 'travel_requests',
      id: created.record.id,
      expectedRevision: 1,
      actorSubject: 'operator-1',
      operation: {
        kind: 'update',
        payload: { request_type: 'service', summary: 'Updated after initial receipt.' },
      },
    });
    await expect(harness.store.createRequest(input)).resolves.toMatchObject({
      disposition: 'replayed',
      record: { id: created.record.id, revision: 2, content: { payload: { status: 'new' } } },
    });
  });

  it('applies update, assignment, status, and note operations through one CAS history', async () => {
    const harness = await makeHarness();
    const { scope } = await install(harness);
    const created = await createRequest(harness, scope);
    const updated = await harness.store.mutateRequest({
      scope,
      collectionKey: 'travel_requests',
      id: created.id,
      expectedRevision: 1,
      actorSubject: 'manager-1',
      operation: {
        kind: 'update',
        payload: { request_type: 'refund', summary: 'Corrected refund request.' },
      },
    });
    expect(updated).toMatchObject({ ok: true, record: { revision: 2 } });
    await harness.store.setGrant({
      scope,
      subject: 'operator-1',
      email: 'operator-1@example.com',
      role: 'operator',
      expectedRevision: 0,
      actorSubject: 'founder',
    });
    const assigned = await harness.store.mutateRequest({
      scope,
      collectionKey: 'travel_requests',
      id: created.id,
      expectedRevision: 2,
      actorSubject: 'manager-1',
      operation: { kind: 'assign', assigneeSubject: 'operator-1' },
    });
    expect(assigned).toMatchObject({
      ok: true,
      record: { revision: 3, assigneeSubject: 'operator-1' },
    });
    const status = await harness.store.mutateRequest({
      scope,
      collectionKey: 'travel_requests',
      id: created.id,
      expectedRevision: 3,
      actorSubject: 'operator-1',
      operation: { kind: 'update', payload: { status: 'in_progress' } },
    });
    expect(status).toMatchObject({
      ok: true,
      record: { revision: 4, content: { payload: { status: 'in_progress' } } },
    });
    const noted = await harness.store.mutateRequest({
      scope,
      collectionKey: 'travel_requests',
      id: created.id,
      expectedRevision: 4,
      actorSubject: 'operator-1',
      operation: { kind: 'add_note', note: 'Customer confirmed the original payment method.' },
    });
    expect(noted).toMatchObject({
      ok: true,
      record: { revision: 5, content: { notes: [{ text: expect.stringContaining('confirmed') }] } },
    });
    await expect(
      harness.store.mutateRequest({
        scope,
        collectionKey: 'travel_requests',
        id: created.id,
        expectedRevision: 1,
        actorSubject: 'stale',
        operation: { kind: 'assign', assigneeSubject: undefined },
      }),
    ).resolves.toEqual({ ok: false, reason: 'conflict', currentRevision: 5 });
    await expect(
      harness.store.listActivity(scope, 'travel_requests', created.id),
    ).resolves.toMatchObject({
      activities: [
        { revision: 5, kind: 'note_added' },
        { revision: 4, kind: 'updated' },
        { revision: 3, kind: 'assigned' },
        { revision: 2, kind: 'updated' },
        { revision: 1, kind: 'created' },
      ],
    });
  });

  it('rejects absent, revoked, viewer and other-installation assignees without changing history', async () => {
    const harness = await makeHarness();
    const { scope } = await install(harness);
    const { scope: otherScope } = await install(harness, { ...uniqueScope(), org: scope.org });
    const record = await createRequest(harness, scope);
    for (const [target, subject, role] of [
      [scope, 'revoked', 'operator'],
      [scope, 'viewer', 'viewer'],
      [otherScope, 'other-installation', 'operator'],
    ] as const) {
      expect(
        await harness.store.setGrant({
          scope: target,
          subject,
          email: `${subject}@example.test`,
          role,
          actorSubject: 'founder',
          expectedRevision: 0,
        }),
      ).toMatchObject({ ok: true });
    }
    expect(
      await harness.store.revokeGrant({
        scope,
        subject: 'revoked',
        expectedRevision: 1,
        actorSubject: 'founder',
      }),
    ).toMatchObject({ ok: true });
    for (const assigneeSubject of ['absent', 'revoked', 'viewer', 'other-installation']) {
      expect(
        await harness.store.mutateRequest({
          scope,
          collectionKey: 'travel_requests',
          id: record.id,
          expectedRevision: 1,
          actorSubject: 'founder',
          operation: { kind: 'assign', assigneeSubject },
        }),
      ).toMatchObject({ ok: false, reason: 'invalid_assignee', currentRevision: 1 });
    }
    expect(await harness.store.getRequest(scope, 'travel_requests', record.id)).not.toHaveProperty(
      'assigneeSubject',
    );
    expect(
      (await harness.store.listActivity(scope, 'travel_requests', record.id)).activities,
    ).toHaveLength(1);
  });

  it('treats application status as a choice with no platform transition graph', async () => {
    const harness = await makeHarness();
    const { scope } = await install(harness);
    const created = await createRequest(harness, scope);
    const closed = await harness.store.mutateRequest({
      scope,
      collectionKey: 'travel_requests',
      id: created.id,
      expectedRevision: 1,
      actorSubject: 'operator-1',
      operation: { kind: 'update', payload: { status: 'closed' } },
    });
    expect(closed).toMatchObject({
      ok: true,
      record: { content: { payload: { status: 'closed' } } },
    });
    await expect(
      harness.store.mutateRequest({
        scope,
        collectionKey: 'travel_requests',
        id: created.id,
        expectedRevision: 2,
        actorSubject: 'operator-1',
        operation: { kind: 'update', payload: { status: 'new' } },
      }),
    ).resolves.toMatchObject({
      ok: true,
      record: { revision: 3, content: { payload: { status: 'new' } } },
    });
  });

  it('lists and exports bounded pages with stable cursors', async () => {
    const harness = await makeHarness();
    const { scope } = await install(harness);
    const first = await createRequest(harness, scope, 'first');
    const second = await createRequest(harness, scope, 'second');
    const listed = await harness.store.listRequests({
      scope,
      collectionKey: 'travel_requests',
      limit: 1,
    });
    expect(listed.records).toHaveLength(1);
    expect(listed.nextCursor).toBeDefined();
    const next = await harness.store.listRequests({
      scope,
      collectionKey: 'travel_requests',
      limit: 1,
      cursor: listed.nextCursor,
    });
    expect(new Set([...listed.records, ...next.records].map((record) => record.id))).toEqual(
      new Set([first.id, second.id]),
    );
    const exported = await harness.store.exportRequests({
      scope,
      collectionKey: 'travel_requests',
      limit: 1,
    });
    expect(exported.records).toHaveLength(1);
    expect(exported.snapshotAt).toBeDefined();
    const exportedNext = await harness.store.exportRequests({
      scope,
      collectionKey: 'travel_requests',
      limit: 10,
      cursor: exported.nextCursor,
    });
    expect(exportedNext.snapshotAt).toBe(exported.snapshotAt);
    expect([...exported.records, ...exportedNext.records]).toHaveLength(2);
    await expect(
      harness.store.listRequests({
        scope,
        collectionKey: 'travel_requests',
        limit: 101,
      }),
    ).rejects.toThrow(/between 1 and 100/);
    await expect(
      harness.store.exportRequests({
        scope,
        collectionKey: 'travel_requests',
        limit: 500,
      }),
    ).resolves.toMatchObject({ records: expect.any(Array) });
  });

  it('soft-deletes by CAS and erases current and historical content', async () => {
    const harness = await makeHarness();
    const { scope } = await install(harness);
    const created = await createRequest(harness, scope);
    await harness.store.mutateRequest({
      scope,
      collectionKey: 'travel_requests',
      id: created.id,
      expectedRevision: 1,
      actorSubject: 'operator-1',
      operation: { kind: 'add_note', note: 'Erase this note during deletion.' },
    });
    const removed = await harness.store.deleteRequest({
      scope,
      collectionKey: 'travel_requests',
      id: created.id,
      expectedRevision: 2,
      actorSubject: 'manager-1',
      reason: 'customer_request',
    });
    expect(removed).toMatchObject({
      ok: true,
      record: { revision: 3, deletedAt: expect.any(String) },
    });
    if (removed.ok) expect(removed.record).not.toHaveProperty('content');
    await expect(
      harness.store.getRequest(scope, 'travel_requests', created.id),
    ).resolves.toBeUndefined();
    const tombstone = await harness.store.getRequest(scope, 'travel_requests', created.id, {
      includeDeleted: true,
    });
    expect(tombstone?.content).toBeUndefined();
    const { activities: activity } = await harness.store.listActivity(
      scope,
      'travel_requests',
      created.id,
    );
    expect(activity).toHaveLength(3);
    expect(activity.every((entry) => entry.content === undefined)).toBe(true);
    const exported = await harness.store.exportRequests({
      scope,
      collectionKey: 'travel_requests',
      includeDeleted: true,
    });
    expect(exported.records[0]).toMatchObject({ id: created.id });
    expect(exported.records[0]).not.toHaveProperty('content');
  });

  it('expires content at the installation retention boundary', async () => {
    const harness = await makeHarness();
    const scope = uniqueScope();
    await harness.store.createInstallation({
      scope,
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      retentionDays: 7,
      actorSubject: 'founder',
    });
    const created = await createRequest(harness, scope);
    const pendingCleanup = await createRequest(harness, scope, 'retention-cleanup');
    harness.advance(8 * 24 * 60 * 60 * 1000);
    await expect(
      harness.store.listRequests({ scope, collectionKey: 'travel_requests' }),
    ).resolves.toEqual({ records: [] });
    await expect(
      harness.store.exportRequests({ scope, collectionKey: 'travel_requests' }),
    ).resolves.toMatchObject({ records: [] });
    await expect(
      harness.store.mutateRequest({
        scope,
        collectionKey: 'travel_requests',
        id: created.id,
        expectedRevision: created.revision,
        actorSubject: 'operator',
        operation: { kind: 'add_note', note: 'must not revive expired content' },
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'not_found' });
    const expired = await harness.store.getRequest(scope, 'travel_requests', created.id, {
      includeDeleted: true,
    });
    expect(expired).toMatchObject({ deletionReason: 'retention_expired' });
    expect(expired).not.toHaveProperty('content');
    const { activities: activity } = await harness.store.listActivity(
      scope,
      'travel_requests',
      created.id,
    );
    expect(activity[0]).toMatchObject({ kind: 'retention_expired' });
    expect(activity.every((event) => event.content === undefined)).toBe(true);
    const exported = await harness.store.exportRequests({
      scope,
      collectionKey: 'travel_requests',
      includeDeleted: true,
    });
    expect(exported.records.find((record) => record.id === created.id)).not.toHaveProperty(
      'content',
    );
    await expect(harness.store.purgeExpired({ scope, limit: 10 })).resolves.toBe(1);
    await expect(
      harness.store.getRequest(scope, 'travel_requests', pendingCleanup.id, {
        includeDeleted: true,
      }),
    ).resolves.toMatchObject({
      deletedAt: expect.any(String),
      deletionReason: 'retention_expired',
    });
  });
}
