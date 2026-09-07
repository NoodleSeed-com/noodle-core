import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import {
  bearerToken,
  type ControlPlaneAuthResult,
  type ControlPlaneIdentity,
  type DeployAuthGate,
} from '@noodle-borg/control-plane/portable';

import { assertStrongAdminToken } from './config.js';

const SELF_HOST_ADMIN: ControlPlaneIdentity = Object.freeze({
  subject: 'self-host-admin',
  email: 'self-host-admin@localhost.invalid',
  identityIssuer: 'urn:noodle:self-host',
  superAdmin: true,
});

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export class SelfHostAdminGate implements DeployAuthGate {
  readonly #expected: Buffer;

  constructor(token: string) {
    assertStrongAdminToken(token);
    this.#expected = digest(token);
  }

  authorize(req: IncomingMessage): ControlPlaneAuthResult {
    const candidate = bearerToken(req);
    if (candidate === null || !timingSafeEqual(this.#expected, digest(candidate))) {
      return { ok: false, status: 401, message: 'invalid bearer token' };
    }
    return { ok: true, identity: SELF_HOST_ADMIN };
  }
}
