import { describe, expect, it } from 'vitest';
import { InMemoryBusinessWorkspaceBackend } from '../src/business-workspaces/memory.js';
import { BusinessWorkspaceStore } from '../src/business-workspaces/store.js';
import { describeBusinessWorkspaceStore } from './business-workspace-suite.js';

describeBusinessWorkspaceStore(async () => new InMemoryBusinessWorkspaceBackend());
describe('shared local transaction composition', () => {
  describeBusinessWorkspaceStore(
    async () =>
      new InMemoryBusinessWorkspaceBackend(undefined, undefined, new InMemoryAtomicState()),
  );
});

describe('workspace invitation lifetime', () => {
  it('expires invitations at the absolute deadline and does not persist bearer tokens', async () => {
    let now = new Date('2026-09-18T00:00:00Z');
    const backend = new InMemoryBusinessWorkspaceBackend(undefined, () => now);
    const store = new BusinessWorkspaceStore(backend, { isIdentityActive: async () => true });
    await store.initializeNewWorkspace({ org: 'acme', ownerSubject: 'owner' });
    const invitation = await store.invite({
      org: 'acme',
      actor: 'owner',
      expectedRevision: 1,
      email: 'member@example.test',
    });
    expect(JSON.stringify(await backend.read('acme'))).not.toContain(invitation.token);
    expect(JSON.stringify(await store.inspect('acme', 'owner'))).not.toContain('tokenDigest');
    now = new Date(invitation.expiresAt);
    await expect(
      store.accept({
        org: 'acme',
        subject: 'member',
        verifiedEmail: 'member@example.test',
        token: invitation.token,
      }),
    ).rejects.toMatchObject({ code: 'invalid_invitation' });
    expect((await store.inspect('acme', 'owner')).invitations).toEqual([]);
  });
});

import { InMemoryAtomicState } from '@noodle-borg/control-plane/portable';
