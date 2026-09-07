import type { IncomingMessage } from 'node:http';

const DEPLOY_KEY_PATTERN = /^sha256:[a-f0-9]{64}$/;

export type DeployIdempotencyValidation =
  | { readonly ok: true; readonly key?: string }
  | {
      readonly ok: false;
      readonly status: 400;
      readonly code: 'invalid_idempotency_key';
      readonly error: string;
    };

/**
 * Validate the optional CLI retry key. The registry binds it to the first persisted request and
 * rejects a later body/target mismatch without storing command text or secret values.
 */
export function validateDeployIdempotency(req: IncomingMessage): DeployIdempotencyValidation {
  const header = req.headers['idempotency-key'];
  if (header === undefined) return { ok: true };
  if (Array.isArray(header) || !DEPLOY_KEY_PATTERN.test(header)) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_idempotency_key',
      error: 'idempotency-key must be a full sha256 deploy key',
    };
  }
  return { ok: true, key: header };
}
