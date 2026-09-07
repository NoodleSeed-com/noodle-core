import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { inspect } from 'node:util';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SelfHostAdminGate } from '../src/admin-gate.js';

const ADMIN_TOKEN = 'LQPPSnvpT4TMomooI4tXegZQJQFxeEJr2Sn9sYrZj9Y';
const DENIED = { ok: false, status: 401, message: 'invalid bearer token' } as const;

function request(authorization?: string): IncomingMessage {
  const incoming = new IncomingMessage(new Socket());
  if (authorization !== undefined) incoming.headers.authorization = authorization;
  return incoming;
}

function rejectedConstructorMessage(token: string): string {
  try {
    new SelfHostAdminGate(token);
    throw new Error('weak administrator token unexpectedly accepted');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function expectSecretAbsent(output: string, secret: string): void {
  expect(output.includes(secret)).toBe(false);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SelfHostAdminGate', () => {
  it.each([
    ['a missing header', undefined],
    ['an empty header', ''],
    ['a basic authorization header', `Basic ${ADMIN_TOKEN}`],
    ['a bearer scheme without a token', 'Bearer'],
    ['an unrelated authorization scheme', `Token ${ADMIN_TOKEN}`],
  ])('fails closed for %s', (_description, authorization) => {
    const gate: DeployAuthGate = new SelfHostAdminGate(ADMIN_TOKEN);

    expect(gate.authorize(request(authorization))).toEqual(DENIED);
  });

  it.each([
    ['shorter', 'wrong-token'],
    ['equal-length', 'J'.repeat(ADMIN_TOKEN.length)],
    ['longer', `${ADMIN_TOKEN}not-the-configured-token`],
  ])('rejects a wrong %s token', (_description, candidate) => {
    const gate = new SelfHostAdminGate(ADMIN_TOKEN);

    expect(gate.authorize(request(`Bearer ${candidate}`))).toEqual(DENIED);
  });

  it('authorizes the exact token as the fixed self-host administrator', () => {
    const gate: DeployAuthGate = new SelfHostAdminGate(ADMIN_TOKEN);

    expect(gate.authorize(request(`Bearer ${ADMIN_TOKEN}`))).toEqual({
      ok: true,
      identity: {
        subject: 'self-host-admin',
        email: 'self-host-admin@localhost.invalid',
        identityIssuer: 'urn:noodle:self-host',
        superAdmin: true,
      },
    });
  });

  it('keeps concurrent authorization calls independent', async () => {
    const gate = new SelfHostAdminGate(ADMIN_TOKEN);

    const results = await Promise.all([
      Promise.resolve(gate.authorize(request(`Bearer ${ADMIN_TOKEN}`))),
      Promise.resolve(gate.authorize(request('Bearer wrong-token'))),
      Promise.resolve(gate.authorize(request(`Bearer ${ADMIN_TOKEN}`))),
      Promise.resolve(gate.authorize(request())),
    ]);

    expect(results).toEqual([
      {
        ok: true,
        identity: {
          subject: 'self-host-admin',
          email: 'self-host-admin@localhost.invalid',
          identityIssuer: 'urn:noodle:self-host',
          superAdmin: true,
        },
      },
      DENIED,
      {
        ok: true,
        identity: {
          subject: 'self-host-admin',
          email: 'self-host-admin@localhost.invalid',
          identityIssuer: 'urn:noodle:self-host',
          superAdmin: true,
        },
      },
      DENIED,
    ]);
  });

  it.each([
    ['a token shorter than 32 UTF-8 bytes', 'short-generated-token'],
    ['a known example token', 'example-admin-token-do-not-use-123'],
    ['an all-one-character token', 'z'.repeat(32)],
    ['a whitespace-padded token', ` ${ADMIN_TOKEN}`],
  ])('rejects %s without disclosing it', (_description, weakToken) => {
    const message = rejectedConstructorMessage(weakToken);

    expect(message).toContain('NOODLE_SELF_HOST_ADMIN_TOKEN');
    expectSecretAbsent(message, weakToken);
  });

  it('keeps leakage-assertion failures free of the fixture secret', () => {
    const fixtureSecret = 'assertion-secret-that-must-not-appear';
    let matcherMessage = '';

    try {
      expectSecretAbsent(`observable output: ${fixtureSecret}`, fixtureSecret);
    } catch (error) {
      matcherMessage = error instanceof Error ? error.message : String(error);
    }

    expect(matcherMessage.length > 0).toBe(true);
    expectSecretAbsent(matcherMessage, fixtureSecret);
  });

  it('never exposes configured or candidate tokens through errors, results, inspection, or output', () => {
    const wrongToken = 'wrong-candidate-token-that-must-not-leak';
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const gate = new SelfHostAdminGate(ADMIN_TOKEN);
    const success = gate.authorize(request(`Bearer ${ADMIN_TOKEN}`));
    const failure = gate.authorize(request(`Bearer ${wrongToken}`));
    const weakTokenError = rejectedConstructorMessage(` ${ADMIN_TOKEN}`);

    const observableOutput = inspect({
      gate,
      success,
      failure,
      weakTokenError,
      consoleCalls: [consoleLog.mock.calls, consoleWarn.mock.calls, consoleError.mock.calls],
    });
    expectSecretAbsent(observableOutput, ADMIN_TOKEN);
    expectSecretAbsent(observableOutput, wrongToken);
  });
});
