import { z } from 'zod';
import { ConnectionError, type StoredConnection } from './types.js';

const identifier = z.string().min(1).max(512);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().nonnegative();
export const connectionScopeSchema = z.strictObject({
  org: identifier,
  app: identifier,
  env: identifier,
  installationId: identifier,
  connectionId: identifier,
});
const target = z.strictObject({
  key: connectionScopeSchema,
  label: z.string().min(1).max(200),
  connectionConfigRevision: identifier,
  requiredScopes: z.array(identifier).max(100),
});
const token = z.string().min(1).max(16_384);
const subject = z.string().min(1).max(1024);
const tokens = z.strictObject({
  subject,
  accessToken: token,
  refreshToken: token,
  scopes: z.array(identifier).max(100),
  expiresAt: z.number().finite(),
});
const stored = z.strictObject({
  revision,
  generation: identifier,
  credentialEpoch: identifier,
  connectionConfigRevision: identifier,
  providerDigest: digest,
  providerId: identifier,
  state: z.enum(['unconfigured', 'ready', 'reauth_required', 'revoked']),
  subject: subject.optional(),
  tokens: tokens.optional(),
  pending: z
    .array(
      z.strictObject({
        target,
        generation: identifier,
        providerDigest: digest,
        credentialEpoch: identifier,
        stateHash: digest,
        sessionHash: digest,
        subject,
        providerId: identifier,
        verifier: token,
        nonce: token,
        returnUrl: z.url().max(2048),
        expiresAt: z.number().finite(),
        revision,
      }),
    )
    .max(4),
});
/** Validate after authenticated decryption; failures never reveal ciphertext or token contents. */
export function parseStoredConnection(value: unknown): StoredConnection {
  const parsed = stored.safeParse(value);
  if (
    !parsed.success ||
    (parsed.data.state === 'ready' &&
      (parsed.data.tokens === undefined || parsed.data.subject !== parsed.data.tokens.subject))
  )
    throw new ConnectionError('connection_unavailable');
  const { subject, tokens, ...rest } = parsed.data;
  return {
    ...rest,
    ...(subject === undefined ? {} : { subject }),
    ...(tokens === undefined ? {} : { tokens }),
  };
}
export function parseConnectionEnvelope(value: unknown, expectedKey: string): StoredConnection {
  const parsed = z.strictObject({ key: digest, value: z.unknown() }).safeParse(value);
  if (!parsed.success || parsed.data.key !== expectedKey)
    throw new ConnectionError('connection_unavailable');
  return parseStoredConnection(parsed.data.value);
}
