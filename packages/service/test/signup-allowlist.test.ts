import { describe, expect, it } from 'vitest';
import {
  GoogleControlPlaneGate,
  InMemoryControlPlaneStore,
  NoodleOAuthControlPlaneGate,
} from '../src/index.js';

describe('Stage-1 signup allowlist gates (B10)', () => {
  it('public signup mode admits any verified external identity unless denied', async () => {
    const gate = new GoogleControlPlaneGate({
      audience: 'client-id',
      admins: [],
      signupMode: 'public',
      deniedSignupDomains: ['blocked.example'],
      deniedSignupSubjects: ['blocked-sub'],
      verifier: {
        verify: (token) =>
          Promise.resolve(
            token === 'blocked-domain'
              ? { subject: 'domain-sub', email: 'dev@blocked.example' }
              : token === 'blocked-subject'
                ? { subject: 'blocked-sub', email: 'dev@example.com' }
                : { subject: 'external-sub', email: 'person@example.com' },
          ),
      },
    });

    await expect(gate.authorize(req('external'))).resolves.toMatchObject({ ok: true });
    await expect(gate.authorize(req('blocked-domain'))).resolves.toMatchObject({
      ok: false,
      status: 403,
    });
    await expect(gate.authorize(req('blocked-subject'))).resolves.toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it('allows internal identities and store-allowlisted external domains', async () => {
    const store = new InMemoryControlPlaneStore();
    await store.allowSignup({ kind: 'domain', value: 'partner.example' });
    const gate = new GoogleControlPlaneGate({
      audience: 'client-id',
      admins: [],
      signupAuthorizer: store,
      verifier: {
        verify: (token) =>
          Promise.resolve(
            token === 'internal'
              ? { subject: 'internal-sub', email: 'user@noodleseed.com' }
              : token === 'partner'
                ? { subject: 'partner-sub', email: 'builder@partner.example' }
                : { subject: 'other-sub', email: 'other@example.com' },
          ),
      },
    });

    await expect(gate.authorize(req('internal'))).resolves.toMatchObject({ ok: true });
    await expect(gate.authorize(req('partner'))).resolves.toMatchObject({ ok: true });
    await expect(gate.authorize(req('other'))).resolves.toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it('supports subject allowlists for Noodle OAuth control-plane tokens', async () => {
    const store = new InMemoryControlPlaneStore();
    await store.allowSignup({ kind: 'subject', value: 'external-sub' });
    const gate = new NoodleOAuthControlPlaneGate({
      audience: 'https://cloud.noodleseed.dev',
      admins: [],
      signupAuthorizer: store,
      verifier: (token) =>
        Promise.resolve(
          token === 'external'
            ? { subject: 'external-sub', email: 'person@example.com' }
            : { subject: 'blocked-sub', email: 'blocked@example.com' },
        ),
    });

    await expect(gate.authorize(req('external'))).resolves.toMatchObject({ ok: true });
    await expect(gate.authorize(req('blocked'))).resolves.toMatchObject({
      ok: false,
      status: 403,
    });
  });
});

function req(token: string): { headers: { authorization: string } } {
  return { headers: { authorization: `Bearer ${token}` } };
}
