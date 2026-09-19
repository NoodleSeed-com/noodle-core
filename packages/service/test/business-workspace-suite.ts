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

    it('discovers only current memberships with bounded pages and no invitation or member payload', async () => {
      const { store, suspended } = await setup();
      await store.initializeNewWorkspace({ org: 'beta', ownerSubject: 'alice' });
      await store.initializeNewWorkspace({ org: 'gamma', ownerSubject: 'bob' });
      const invitation = await store.invite({
        org: 'acme',
        actor: 'alice',
        expectedRevision: 1,
        email: 'bob@example.test',
      });
      await store.accept({
        org: 'acme',
        subject: 'bob',
        verifiedEmail: 'bob@example.test',
        token: invitation.token,
      });
      const page = await store.listForSubject('bob', { limit: 1 });
      expect(page.workspaces).toEqual([
        {
          org: 'acme',
          authorityVersion: 1,
          revision: 3,
          role: 'operator',
          permissions: WORKSPACE_ROLE_PERMISSIONS.operator,
        },
      ]);
      expect(page.nextCursor).toBeDefined();
      const next = await store.listForSubject('bob', { limit: 1, cursor: page.nextCursor });
      expect(next.workspaces.map((item) => item.org)).toEqual(['gamma']);
      expect(next.nextCursor).toBeUndefined();
      expect(JSON.stringify(page)).not.toContain('bob@example.test');
      expect(JSON.stringify(page)).not.toContain(invitation.token);
      await store.changeRole({
        org: 'acme',
        actor: 'alice',
        subject: 'bob',
        role: null,
        expectedRevision: 3,
      });
      expect((await store.listForSubject('bob', {})).workspaces.map((item) => item.org)).toEqual([
        'gamma',
      ]);
      expect((await store.listForSubject('stranger', {})).workspaces).toEqual([]);
      suspended.add('bob');
      await expect(store.listForSubject('bob', {})).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('rejects malformed discovery input without trusting cursors as authority', async () => {
      const { store } = await setup();
      for (const query of [
        { limit: 0 },
        { limit: 101 },
        { cursor: 'invalid==' },
        { cursor: Buffer.from('../private').toString('base64url') },
      ])
        await expect(store.listForSubject('alice', query)).rejects.toMatchObject({
          code: 'invalid_request',
        });
      expect(
        (
          await store.listForSubject('stranger', {
            cursor: Buffer.from('acme').toString('base64url'),
          })
        ).workspaces,
      ).toEqual([]);
    });

    it('returns validation failures as rejected promises for every public mutation', async () => {
      const { store } = await setup();
      const actions = [
        () => store.initializeNewWorkspace({ org: '', ownerSubject: 'alice' }),
        () =>
          store.changeRole({
            org: 'acme',
            actor: 'alice',
            expectedRevision: 0,
            subject: 'bob',
            role: 'viewer',
          }),
        () => store.invite({ org: 'acme', actor: 'alice', expectedRevision: 1, email: 'invalid' }),
        () =>
          store.accept({
            org: 'acme',
            subject: 'bob',
            verifiedEmail: 'bob@example.test',
            token: 'invalid',
          }),
        () =>
          store.revokeInvitation({
            org: 'acme',
            actor: 'alice',
            expectedRevision: 1,
            invitationId: 'invalid',
          }),
      ];
      for (const action of actions) {
        const pending = action();
        expect(pending).toBeInstanceOf(Promise);
        await expect(pending).rejects.toHaveProperty('code');
      }
      expect((await store.inspect('acme', 'alice')).revision).toBe(1);
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
