import type {
  AuditEventInput,
  OrgMembershipSource,
  PlatformPrincipalResolver,
  VerifiedEmailLookup,
} from '@noodle-borg/module';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDataPlaneMembershipAuthorizer } from '../src/data-plane-membership.js';
import { InMemoryControlPlaneStore } from '../src/index.js';

const NOW = () => new Date('2026-07-24T00:00:00.000Z');

let controlPlane: InMemoryControlPlaneStore;

/** Fixed resolver; `undefined` models a store that faults rather than answering. */
function resolver(
  lookup: VerifiedEmailLookup | undefined,
): Pick<PlatformPrincipalResolver, 'lookupActiveVerifiedEmails'> {
  return {
    lookupActiveVerifiedEmails: () =>
      lookup === undefined ? Promise.reject(new Error('boom')) : Promise.resolve(lookup),
  };
}

function domainCall(subject: string, email?: string) {
  return {
    accessMode: 'org-members' as const,
    org: 'acme',
    subject,
    ...(email !== undefined ? { email } : {}),
  };
}

beforeEach(async () => {
  controlPlane = new InMemoryControlPlaneStore({ now: NOW });
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: 'owner-sub',
    email: 'owner@acme.com',
    role: 'owner',
  });
  await controlPlane.addOrgDomain({
    org: 'acme',
    domain: 'acme.com',
    challenge: 'txt-proof',
  });
  await controlPlane.markOrgDomainVerification({
    org: 'acme',
    domain: 'acme.com',
    verified: true,
  });
});

describe('createDataPlaneMembershipAuthorizer', () => {
  it('denies any access mode other than org-members', async () => {
    const authorize = createDataPlaneMembershipAuthorizer({ controlPlane });
    await expect(
      authorize({ ...domainCall('owner-sub'), accessMode: 'authenticated' }),
    ).resolves.toEqual({ allowed: false });
  });

  it('uses the token claim email when no verified-email resolver is wired', async () => {
    const authorize = createDataPlaneMembershipAuthorizer({ controlPlane });
    await expect(authorize(domainCall('employee-sub', 'employee@acme.com'))).resolves.toEqual({
      allowed: true,
      via: 'domain',
    });
  });

  it('ignores a stale claim email and uses the current verified address', async () => {
    const authorize = createDataPlaneMembershipAuthorizer({
      controlPlane,
      verifiedEmails: resolver({ kind: 'known', emails: ['employee@former-employer.test'] }),
    });
    await expect(authorize(domainCall('employee-sub', 'employee@acme.com'))).resolves.toEqual({
      allowed: false,
    });
  });

  it('grants when the current verified address is on an org domain even if the claim is stale', async () => {
    const authorize = createDataPlaneMembershipAuthorizer({
      controlPlane,
      verifiedEmails: resolver({ kind: 'known', emails: ['employee@acme.com'] }),
    });
    await expect(authorize(domainCall('employee-sub', 'employee@stale.test'))).resolves.toEqual({
      allowed: true,
      via: 'domain',
    });
  });

  it('denies the domain path for a principal with no active verified email', async () => {
    const authorize = createDataPlaneMembershipAuthorizer({
      controlPlane,
      verifiedEmails: resolver({ kind: 'known', emails: [] }),
    });
    await expect(authorize(domainCall('employee-sub', 'employee@acme.com'))).resolves.toEqual({
      allowed: false,
    });
  });

  it('denies the domain path for an unknown principal and does not fall back to the claim', async () => {
    const authorize = createDataPlaneMembershipAuthorizer({
      controlPlane,
      verifiedEmails: resolver({ kind: 'unknown' }),
    });
    await expect(authorize(domainCall('employee-sub', 'employee@acme.com'))).resolves.toEqual({
      allowed: false,
    });
  });

  it('denies the domain path when the lookup is unavailable', async () => {
    const authorize = createDataPlaneMembershipAuthorizer({
      controlPlane,
      verifiedEmails: resolver(undefined),
    });
    await expect(authorize(domainCall('employee-sub', 'employee@acme.com'))).resolves.toEqual({
      allowed: false,
    });
  });

  it('still admits an explicit org member for every lookup outcome', async () => {
    const outcomes: readonly (VerifiedEmailLookup | undefined)[] = [
      { kind: 'known', emails: [] },
      { kind: 'unknown' },
      undefined,
    ];
    for (const outcome of outcomes) {
      const authorize = createDataPlaneMembershipAuthorizer({
        controlPlane,
        verifiedEmails: resolver(outcome),
      });
      await expect(authorize(domainCall('owner-sub', 'owner@acme.com'))).resolves.toEqual({
        allowed: true,
        via: 'explicit',
      });
    }
  });

  it('admits both sources when the deployment declares no membership sources', async () => {
    const authorize = createDataPlaneMembershipAuthorizer({ controlPlane });
    await expect(authorize(domainCall('owner-sub', 'owner@acme.com'))).resolves.toMatchObject({
      via: 'explicit',
    });
    await expect(authorize(domainCall('employee-sub', 'employee@acme.com'))).resolves.toMatchObject(
      { via: 'domain' },
    );
  });

  it('denies a domain-only caller when the deployment narrows to explicit members', async () => {
    const authorize = createDataPlaneMembershipAuthorizer({ controlPlane });
    await expect(
      authorize({
        ...domainCall('employee-sub', 'employee@acme.com'),
        membershipSources: ['explicit'],
      }),
    ).resolves.toEqual({ allowed: false });
  });

  it('still admits an explicit member when the deployment narrows to explicit members', async () => {
    const authorize = createDataPlaneMembershipAuthorizer({ controlPlane });
    await expect(
      authorize({ ...domainCall('owner-sub', 'owner@acme.com'), membershipSources: ['explicit'] }),
    ).resolves.toEqual({ allowed: true, via: 'explicit' });
  });

  // Symmetry: the list means exactly what it says, in both directions (ADR 0183).
  it('denies an explicit-only member when the deployment narrows to domain membership', async () => {
    const authorize = createDataPlaneMembershipAuthorizer({ controlPlane });
    await expect(
      authorize({
        ...domainCall('contractor-sub', 'contractor@external.test'),
        membershipSources: ['domain'],
      }),
    ).resolves.toEqual({ allowed: false });
    // An owner whose own address is on a registered domain still gets in through the domain path.
    await expect(
      authorize({ ...domainCall('owner-sub', 'owner@acme.com'), membershipSources: ['domain'] }),
    ).resolves.toEqual({ allowed: true, via: 'domain' });
    await expect(
      authorize({
        ...domainCall('employee-sub', 'employee@acme.com'),
        membershipSources: ['domain'],
      }),
    ).resolves.toEqual({ allowed: true, via: 'domain' });
  });

  it('denies every caller when the list is empty, so a corrupt narrowing fails closed', async () => {
    const authorize = createDataPlaneMembershipAuthorizer({ controlPlane });
    for (const subject of ['owner-sub', 'employee-sub', 'contractor-sub']) {
      await expect(
        authorize({ ...domainCall(subject, `${subject}@acme.com`), membershipSources: [] }),
      ).resolves.toEqual({ allowed: false });
    }
  });

  it('denies rather than widens when the list names only a source this build does not know', async () => {
    const authorize = createDataPlaneMembershipAuthorizer({ controlPlane });
    const unknown = ['group'] as unknown as readonly OrgMembershipSource[];
    await expect(
      authorize({ ...domainCall('owner-sub', 'owner@acme.com'), membershipSources: unknown }),
    ).resolves.toEqual({ allowed: false });
    await expect(
      authorize({ ...domainCall('employee-sub', 'employee@acme.com'), membershipSources: unknown }),
    ).resolves.toEqual({ allowed: false });
  });

  it('records how access was granted so audit can distinguish the source', async () => {
    const authorize = createDataPlaneMembershipAuthorizer({ controlPlane });
    await expect(authorize(domainCall('owner-sub', 'owner@acme.com'))).resolves.toMatchObject({
      via: 'explicit',
    });
    await expect(authorize(domainCall('employee-sub', 'employee@acme.com'))).resolves.toMatchObject(
      { via: 'domain' },
    );
  });

  it('emits a deny audit event carrying org and reason only', async () => {
    const events: AuditEventInput[] = [];
    const authorize = createDataPlaneMembershipAuthorizer({
      controlPlane,
      verifiedEmails: resolver({ kind: 'unknown' }),
      audit: {
        emit: (event) => {
          events.push(event);
          return Promise.resolve();
        },
      },
    });
    await authorize(domainCall('employee-sub', 'employee@acme.com'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      org: 'acme',
      decision: 'deny',
      reasonCode: 'domain_membership_principal_unknown',
    });
    expect(events[0]?.actorSubject).toBeUndefined();
    expect(events[0]?.actorEmail).toBeUndefined();
    expect(JSON.stringify(events[0])).not.toContain('employee@acme.com');
    expect(JSON.stringify(events[0])).not.toContain('employee-sub');
  });

  it('does not emit a deny audit event when the principal is simply offboarded', async () => {
    const events: AuditEventInput[] = [];
    const authorize = createDataPlaneMembershipAuthorizer({
      controlPlane,
      verifiedEmails: resolver({ kind: 'known', emails: ['employee@former-employer.test'] }),
      audit: {
        emit: (event) => {
          events.push(event);
          return Promise.resolve();
        },
      },
    });
    await authorize(domainCall('employee-sub', 'employee@acme.com'));
    expect(events).toEqual([]);
  });

  it('logs a domain-membership denial without subject or email', async () => {
    const warned: { event: string; fields?: Record<string, unknown> }[] = [];
    const authorize = createDataPlaneMembershipAuthorizer({
      controlPlane,
      verifiedEmails: resolver(undefined),
      logger: { warn: (event, fields) => warned.push({ event, ...(fields ? { fields } : {}) }) },
    });
    await authorize(domainCall('employee-sub', 'employee@acme.com'));
    expect(warned).toEqual([
      {
        event: 'data_plane.domain_membership_denied',
        fields: { org: 'acme', reason: 'lookup_unavailable' },
      },
    ]);
  });
});
