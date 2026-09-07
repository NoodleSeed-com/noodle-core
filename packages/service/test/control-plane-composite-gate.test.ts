import type { IncomingMessage } from 'node:http';
import {
  CompositeControlPlaneGate,
  type ControlPlaneAuthResult,
  type DeployAuthGate,
} from '@noodle-borg/control-plane/portable';
import { describe, expect, it } from 'vitest';

// The hosted control plane runs the self-hosted OAuth AS AND accepts first-party Google ID tokens, so its
// gate is a composite: try the AS-issued token, then the console/CLI Google ID token (ADR 0116). A 401
// (couldn't verify this token) falls through to the next gate; a 403 (verified but denied) is definitive.

function req(): IncomingMessage {
  return { headers: { authorization: 'Bearer tok' } } as unknown as IncomingMessage;
}

function gateReturning(result: ControlPlaneAuthResult): {
  gate: DeployAuthGate;
  calls: () => number;
} {
  let calls = 0;
  return {
    gate: {
      authorize: () => {
        calls += 1;
        return result;
      },
    },
    calls: () => calls,
  };
}

const OK: ControlPlaneAuthResult = {
  ok: true,
  identity: { subject: 's', email: 'a@noodleseed.com', superAdmin: false },
};
const UNAUTH: ControlPlaneAuthResult = { ok: false, status: 401, message: 'invalid bearer token' };
const DENIED: ControlPlaneAuthResult = {
  ok: false,
  status: 403,
  message: 'email domain is not allowed',
};

describe('CompositeControlPlaneGate', () => {
  it('accepts the first gate that authorizes and skips the rest', async () => {
    const first = gateReturning(OK);
    const second = gateReturning(UNAUTH);
    const gate = new CompositeControlPlaneGate([first.gate, second.gate]);
    const result = await gate.authorize(req());
    expect(result.ok).toBe(true);
    expect(first.calls()).toBe(1);
    expect(second.calls()).toBe(0);
  });

  it('falls through a 401 to the next gate (AS token fails, Google ID token verifies)', async () => {
    const as = gateReturning(UNAUTH);
    const google = gateReturning(OK);
    const gate = new CompositeControlPlaneGate([as.gate, google.gate]);
    const result = await gate.authorize(req());
    expect(result.ok).toBe(true);
    expect(as.calls()).toBe(1);
    expect(google.calls()).toBe(1);
  });

  it('short-circuits on a 403 (verified but denied) without trying later gates', async () => {
    const first = gateReturning(DENIED);
    const second = gateReturning(OK);
    const gate = new CompositeControlPlaneGate([first.gate, second.gate]);
    const result = await gate.authorize(req());
    expect(result).toEqual(DENIED);
    expect(second.calls()).toBe(0);
  });

  it('returns 401 when every gate rejects with 401', async () => {
    const gate = new CompositeControlPlaneGate([
      gateReturning(UNAUTH).gate,
      gateReturning(UNAUTH).gate,
    ]);
    const result = await gate.authorize(req());
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 401 });
  });

  it('requires at least one gate', () => {
    expect(() => new CompositeControlPlaneGate([])).toThrow(/at least one gate/);
  });
});
