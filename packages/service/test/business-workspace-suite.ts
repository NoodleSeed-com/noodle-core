import { describe, expect, it } from 'vitest';
import type { BusinessWorkspaceBackend } from '../src/business-workspaces/contracts.js';
import { WORKSPACE_ROLE_PERMISSIONS } from '../src/business-workspaces/permissions.js';
import { BusinessWorkspaceStore } from '../src/business-workspaces/store.js';

export function describeBusinessWorkspaceStore(
  factory: () => Promise<BusinessWorkspaceBackend>,
): void {
  describe('versioned business workspace roles', () => {
    async function setup() {
      const suspended = new Set<string>();
      const store = new BusinessWorkspaceStore(await factory(), {
        isIdentityActive: async (subject) => !suspended.has(subject),
      });
      await store.initializeNewWorkspace({ org: 'acme', ownerSubject: 'alice' });
      return { store, suspended };
    }

    it('does not infer workspace authority from an absent legacy workspace', async () => {
      const { store } = await setup();
      expect(await store.authorize('legacy', 'alice', 'drafts:edit')).toBe('legacy');
      expect(await store.authorize('acme', 'unknown', 'drafts:edit')).toBe('denied');
      expect(await store.authorize('acme', 'alice', 'billing:manage')).toBe('allowed');
    });

    it('initialization is idempotent and never repairs or replaces an existing owner', async () => {
      const { store } = await setup();
      await store.initializeNewWorkspace({ org: 'acme', ownerSubject: 'alice' });
      await expect(
        store.initializeNewWorkspace({ org: 'acme', ownerSubject: 'bob' }),
      ).rejects.toMatchObject({ code: 'already_activated' });
      expect((await store.inspect('acme', 'alice')).revision).toBe(1);
    });

    it('keeps Builder away from production and publishing and only Owner manages billing', () => {
      expect(WORKSPACE_ROLE_PERMISSIONS.builder).toEqual([
        'drafts:read',
        'drafts:edit',
        'drafts:preview',
      ]);
      expect(WORKSPACE_ROLE_PERMISSIONS.operator).toContain('records:write');
      expect(WORKSPACE_ROLE_PERMISSIONS.operator).not.toContain('records:export');
      expect(WORKSPACE_ROLE_PERMISSIONS.viewer).not.toContain('records:write');
      expect(WORKSPACE_ROLE_PERMISSIONS.administrator).not.toContain('billing:manage');
      expect(WORKSPACE_ROLE_PERMISSIONS.administrator).not.toContain('owners:manage');
    });

    it('defaults invitations to Operator, uses one-time claims and fences stale revisions', async () => {
      const { store } = await setup();
      const invitation = await store.invite({
        org: 'acme',
        actor: 'alice',
        expectedRevision: 1,
        email: 'BOB@example.test',
      });
      expect(invitation.role).toBe('operator');
      await expect(
        store.accept({
          org: 'acme',
          token: invitation.token,
          subject: 'eve',
          verifiedEmail: 'eve@example.test',
        }),
      ).rejects.toMatchObject({ code: 'invalid_invitation' });
      await store.accept({
        org: 'acme',
        token: invitation.token,
        subject: 'bob',
        verifiedEmail: 'bob@example.test',
      });
      await expect(
        store.accept({
          org: 'acme',
          token: invitation.token,
          subject: 'bob',
          verifiedEmail: 'bob@example.test',
        }),
      ).rejects.toMatchObject({ code: 'invalid_invitation' });
      expect(await store.authorize('acme', 'bob', 'records:write')).toBe('allowed');
      await expect(
        store.changeRole({
          org: 'acme',
          actor: 'alice',
          expectedRevision: 1,
          subject: 'bob',
          role: 'viewer',
        }),
      ).rejects.toMatchObject({ code: 'revision_conflict', currentRevision: 3 });
    });

    it('does not let administrators promote themselves, remove owners or issue owner invitations', async () => {
      const { store } = await setup();
      const invitation = await store.invite({
        org: 'acme',
        actor: 'alice',
        expectedRevision: 1,
        email: 'bob@example.test',
        role: 'administrator',
      });
      await store.accept({
        org: 'acme',
        token: invitation.token,
        subject: 'bob',
        verifiedEmail: 'bob@example.test',
      });
      await expect(
        store.changeRole({
          org: 'acme',
          actor: 'bob',
          expectedRevision: 3,
          subject: 'bob',
          role: 'owner',
        }),
      ).rejects.toMatchObject({ code: 'forbidden' });
      await expect(
        store.changeRole({
          org: 'acme',
          actor: 'bob',
          expectedRevision: 3,
          subject: 'alice',
          role: null,
        }),
      ).rejects.toMatchObject({ code: 'forbidden' });
      await expect(
        store.invite({
          org: 'acme',
          actor: 'bob',
          expectedRevision: 3,
          email: 'eve@example.test',
          role: 'owner',
        }),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('serializes concurrent last-owner mutations and retains one owner', async () => {
      const { store } = await setup();
      const invitation = await store.invite({
        org: 'acme',
        actor: 'alice',
        expectedRevision: 1,
        email: 'bob@example.test',
        role: 'owner',
      });
      await store.accept({
        org: 'acme',
        token: invitation.token,
        subject: 'bob',
        verifiedEmail: 'bob@example.test',
      });
      const results = await Promise.allSettled(
        ['alice', 'bob'].map((subject) =>
          store.changeRole({
            org: 'acme',
            actor: 'alice',
            expectedRevision: 3,
            subject,
            role: 'viewer',
          }),
        ),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const owner =
        (await store.authorize('acme', 'alice', 'owners:manage')) === 'allowed' ? 'alice' : 'bob';
      const state = await store.inspect('acme', owner);
      expect(state.members.filter((member) => member.role === 'owner')).toHaveLength(1);
      await expect(
        store.changeRole({
          org: 'acme',
          actor: owner,
          expectedRevision: state.revision,
          subject: owner,
          role: null,
        }),
      ).rejects.toMatchObject({ code: 'last_owner' });
    });

    it('rechecks the inviting administrator when a delayed invitation is accepted', async () => {
      const { store } = await setup();
      const admin = await store.invite({
        org: 'acme',
        actor: 'alice',
        expectedRevision: 1,
        email: 'bob@example.test',
        role: 'administrator',
      });
      await store.accept({
        org: 'acme',
        token: admin.token,
        subject: 'bob',
        verifiedEmail: 'bob@example.test',
      });
      const pending = await store.invite({
        org: 'acme',
        actor: 'bob',
        expectedRevision: 3,
        email: 'eve@example.test',
        role: 'builder',
      });
      await store.changeRole({
        org: 'acme',
        actor: 'alice',
        expectedRevision: 4,
        subject: 'bob',
        role: 'operator',
      });
      await expect(
        store.accept({
          org: 'acme',
          token: pending.token,
          subject: 'eve',
          verifiedEmail: 'eve@example.test',
        }),
      ).rejects.toMatchObject({ code: 'invalid_invitation' });
    });

    it('suspension closes access even for the last owner and does not repair it', async () => {
      const { store, suspended } = await setup();
      suspended.add('alice');
      expect(await store.authorize('acme', 'alice', 'drafts:edit')).toBe('denied');
      await expect(store.inspect('acme', 'alice')).rejects.toMatchObject({ code: 'forbidden' });
      await expect(
        store.initializeNewWorkspace({ org: 'acme', ownerSubject: 'bob' }),
      ).rejects.toMatchObject({ code: 'already_activated' });
    });
  });
}
