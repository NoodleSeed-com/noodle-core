import type { IncomingMessage } from 'node:http';
import {
  CompositeControlPlaneGate,
  GoogleControlPlaneGate,
  type GoogleIdTokenVerifier,
  GoogleWorkloadControlPlaneGate,
} from '@noodle-borg/control-plane/portable';
import { describe, expect, it, vi } from 'vitest';
import { assertCanonicalPlatformAdminConfiguration } from '../src/control-plane-auth-bootstrap.js';

function bearer(): IncomingMessage {
  return {
    headers: { authorization: 'Bearer google-id-token' },
  } as unknown as IncomingMessage;
}

describe('exact Google workload control-plane gate', () => {
  it('accepts only an exact configured subject and audience without human principal resolution', async () => {
    const verify = vi.fn(async () => ({
      subject: '109876543210987654321',
      email: 'github-deployer@example.iam.gserviceaccount.com',
    }));
    const gate = new GoogleWorkloadControlPlaneGate({
      audience: 'control-plane-client',
      subjects: ['109876543210987654321'],
      admins: ['109876543210987654321'],
      verifier: { verify },
    });

    await expect(gate.authorize(bearer())).resolves.toEqual({
      ok: true,
      identity: {
        subject: '109876543210987654321',
        email: 'github-deployer@example.iam.gserviceaccount.com',
        superAdmin: true,
        authenticationKind: 'google-workload',
      },
    });
    expect(verify).toHaveBeenCalledWith('google-id-token', 'control-plane-client');
  });

  it('never grants workload admin authority from a mutable email match', async () => {
    const gate = new GoogleWorkloadControlPlaneGate({
      audience: 'control-plane-client',
      subjects: ['109876543210987654321'],
      admins: ['github-deployer@example.iam.gserviceaccount.com'],
      verifier: {
        verify: async () => ({
          subject: '109876543210987654321',
          email: 'github-deployer@example.iam.gserviceaccount.com',
        }),
      },
    });

    await expect(gate.authorize(bearer())).resolves.toMatchObject({
      ok: true,
      identity: {
        subject: '109876543210987654321',
        superAdmin: false,
        authenticationKind: 'google-workload',
      },
    });
  });

  it('returns verifier-not-applicable for a valid human token so fallback can authorize it', async () => {
    const verifier: GoogleIdTokenVerifier = {
      verify: async () => ({ subject: 'human-google-sub', email: 'human@example.test' }),
    };
    const gate = new CompositeControlPlaneGate([
      new GoogleWorkloadControlPlaneGate({
        audience: 'control-plane-client',
        subjects: ['workload-sub'],
        admins: [],
        verifier,
      }),
      new GoogleControlPlaneGate({
        audience: 'control-plane-client',
        admins: [],
        signupMode: 'public',
        verifier,
      }),
    ]);

    const result = await gate.authorize(bearer());
    expect(result).toMatchObject({ ok: true, identity: { subject: 'human-google-sub' } });
    if (result.ok) expect(result.identity).not.toHaveProperty('authenticationKind');
  });

  it('definitively blocks an unlisted service account instead of falling through to human auth', async () => {
    const gate = new GoogleWorkloadControlPlaneGate({
      audience: 'control-plane-client',
      subjects: ['allowed-workload-sub'],
      admins: [],
      verifier: {
        verify: async () => ({
          subject: 'unlisted-workload-sub',
          email: 'unknown@example.iam.gserviceaccount.com',
        }),
      },
    });

    await expect(gate.authorize(bearer())).resolves.toEqual({
      ok: false,
      status: 403,
      message: 'workload identity is not permitted',
    });
  });

  it('rejects malformed exact-subject configuration at boot', () => {
    expect(
      () =>
        new GoogleWorkloadControlPlaneGate({
          audience: 'control-plane-client',
          subjects: [],
          admins: [],
        }),
    ).toThrow(/workload subject/);
    expect(
      () =>
        new GoogleWorkloadControlPlaneGate({
          audience: 'control-plane-client',
          subjects: ['has whitespace'],
          admins: [],
        }),
    ).toThrow(/workload subject/);
  });

  it('requires canonical admin subjects before a platform identity provider becomes available', () => {
    expect(() =>
      assertCanonicalPlatformAdminConfiguration({
        admins: ['admin@noodleseed.com'],
        canonicalIdentityConfigured: true,
      }),
    ).toThrow(/principal subjects/);
    expect(() =>
      assertCanonicalPlatformAdminConfiguration({
        admins: ['legacy-google-subject', 'usr_123'],
        canonicalIdentityConfigured: true,
      }),
    ).not.toThrow();
  });
});

it('never produces workload provenance when verification rejects the pinned audience', async () => {
  const gate = new GoogleWorkloadControlPlaneGate({
    audience: 'expected-audience',
    subjects: ['109876543210987654321'],
    admins: [],
    verifier: {
      verify: async (_token, audience) => {
        expect(audience).toBe('expected-audience');
        throw new Error('wrong audience');
      },
    },
  });
  await expect(gate.authorize(bearer())).resolves.toEqual({
    ok: false,
    status: 401,
    message: 'invalid bearer token',
  });
});
