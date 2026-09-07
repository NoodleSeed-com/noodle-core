import type { IncomingMessage } from 'node:http';
import {
  GoogleControlPlaneGate,
  type GoogleIdTokenVerifier,
} from '@noodle-borg/control-plane/portable';
import { describe, expect, it } from 'vitest';

// The console (ADR 0116) signs users in with its own Google web OAuth client, then calls the control plane
// with that Google ID token. Its `aud` differs from the gcloud-CLI client, so the gate must accept BOTH.

function bearer(token: string): IncomingMessage {
  return { headers: { authorization: `Bearer ${token}` } } as unknown as IncomingMessage;
}

const IDENTITY = { subject: 'sub-1', email: 'dev@noodleseed.com' } as const;

/** A verifier that records the audience it was asked to check against (never does real matching). */
function recordingVerifier(): { readonly verifier: GoogleIdTokenVerifier; seen(): unknown } {
  let seen: unknown;
  return {
    verifier: {
      verify: async (_token, audience) => {
        seen = audience;
        return { ...IDENTITY };
      },
    },
    seen: () => seen,
  };
}

describe('control-plane gate accepts multiple Google audiences (console + CLI)', () => {
  it('forwards every configured audience to the verifier', async () => {
    const rec = recordingVerifier();
    const gate = new GoogleControlPlaneGate({
      audience: [
        '32555940559.apps.googleusercontent.com',
        '927870639198-console.apps.googleusercontent.com',
      ],
      admins: [],
      signupMode: 'public',
      verifier: rec.verifier,
    });
    const result = await gate.authorize(bearer('tok'));
    expect(result.ok).toBe(true);
    expect(rec.seen()).toEqual([
      '32555940559.apps.googleusercontent.com',
      '927870639198-console.apps.googleusercontent.com',
    ]);
  });

  it('passes a single string audience through unchanged (CLI-only, backward compatible)', async () => {
    const rec = recordingVerifier();
    const gate = new GoogleControlPlaneGate({
      audience: '32555940559.apps.googleusercontent.com',
      admins: [],
      signupMode: 'public',
      verifier: rec.verifier,
    });
    await gate.authorize(bearer('tok'));
    expect(rec.seen()).toBe('32555940559.apps.googleusercontent.com');
  });

  it('rejects an empty audience list', () => {
    expect(() => new GoogleControlPlaneGate({ audience: [], admins: [] })).toThrow(
      /audience must be non-empty/,
    );
  });

  it('rejects an audience list containing an empty string', () => {
    expect(() => new GoogleControlPlaneGate({ audience: ['ok', ''], admins: [] })).toThrow(
      /audience must be non-empty/,
    );
  });

  it('still rejects a request with no bearer token before verifying', async () => {
    const rec = recordingVerifier();
    const gate = new GoogleControlPlaneGate({
      audience: ['a'],
      admins: [],
      verifier: rec.verifier,
    });
    const result = await gate.authorize({ headers: {} } as unknown as IncomingMessage);
    expect(result.ok).toBe(false);
    expect(rec.seen()).toBeUndefined();
  });
});
