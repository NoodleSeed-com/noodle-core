import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { clientAddressBucket } from './client-address.js';
import { dayKey } from './counter-store.js';
import { visitorBucket } from './visitor-bucket.js';

export const PUBLIC_ADMISSION_ASSERTION_HEADER = 'x-noodle-public-admission';
export const PUBLIC_ADMISSION_ASSERTION_TTL_SECONDS = 60;
const CLOCK_SKEW_SECONDS = 5;
const digestPattern = /^[a-f0-9]{64}$/;

/** A request binding is private BFF-to-service evidence, never a browser credential or tool authority. */
export interface PublicAdmissionRequestBinding {
  readonly surfaceId: string;
  readonly installationId: string;
  readonly route: string;
  readonly method: 'POST';
  readonly idempotencyKey: string;
  readonly requestDigest: string;
}

export interface PublicAdmissionSigningKeys {
  readonly activeVersion: string;
  readonly keys: Readonly<Record<string, string>>;
  /** Separate stable deployment key: rotating assertion signing keys never resets quota buckets. */
  readonly pseudonymKey: string;
}

interface Assertion extends PublicAdmissionRequestBinding {
  readonly version: 1;
  readonly keyVersion: string;
  readonly issuer: 'noodle-portal';
  readonly audience: 'noodle-public-admission';
  readonly epoch: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly network: string;
  readonly visitor?: string;
}

export function publicAdmissionRequestDigest(serializedBody: string): string {
  return createHash('sha256').update(serializedBody).digest('hex');
}

/** Caller must derive sourceAddress from a verified ingress adapter, never arbitrary forwarding headers. */
export function signPublicAdmissionAssertion(
  binding: PublicAdmissionRequestBinding,
  attribution: { readonly sourceAddress: string; readonly visitorHint?: unknown },
  keys: PublicAdmissionSigningKeys,
  now: Date,
): string {
  const address = attribution.sourceAddress.includes(',')
    ? undefined
    : clientAddressBucket(attribution.sourceAddress);
  const visitor = visitorBucket(attribution.visitorHint);
  if (!address || keys.pseudonymKey.length < 32 || !validBinding(binding))
    throw new Error('verified public admission attribution is unavailable');
  const issuedAt = Math.floor(now.getTime() / 1000);
  const epoch = dayKey(now);
  const pseudonym = (kind: string, value: string) =>
    createHmac('sha256', keys.pseudonymKey)
      .update(JSON.stringify([binding.installationId, binding.surfaceId, epoch, kind, value]))
      .digest('hex');
  const assertion: Assertion = {
    ...binding,
    version: 1,
    keyVersion: keys.activeVersion,
    issuer: 'noodle-portal',
    audience: 'noodle-public-admission',
    epoch,
    issuedAt,
    expiresAt: issuedAt + PUBLIC_ADMISSION_ASSERTION_TTL_SECONDS,
    network: pseudonym('network', address),
    ...(visitor ? { visitor: pseudonym('visitor', visitor) } : {}),
  };
  const encoded = Buffer.from(JSON.stringify(assertion)).toString('base64url');
  return `${encoded}.${signature(encoded, signingKey(keys, keys.activeVersion)).toString('base64url')}`;
}

export function verifyPublicAdmissionAssertion(
  token: string,
  expected: PublicAdmissionRequestBinding,
  keys: PublicAdmissionSigningKeys,
  now: Date,
): { readonly network: string; readonly visitor?: string } | undefined {
  if (token.length > 4096 || !validBinding(expected)) return undefined;
  try {
    const parts = token.split('.');
    if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part)))
      return undefined;
    const encoded = parts[0] ?? '';
    const assertion: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!isAssertion(assertion)) return undefined;
    const supplied = Buffer.from(parts[1] ?? '', 'base64url');
    const correct = signature(encoded, signingKey(keys, assertion.keyVersion));
    if (supplied.length !== correct.length || !timingSafeEqual(supplied, correct)) return undefined;
    const seconds = Math.floor(now.getTime() / 1000);
    if (
      assertion.epoch !== dayKey(now) ||
      assertion.epoch !== dayKey(new Date(assertion.issuedAt * 1000)) ||
      assertion.issuedAt > seconds + CLOCK_SKEW_SECONDS ||
      assertion.expiresAt < seconds - CLOCK_SKEW_SECONDS ||
      assertion.expiresAt <= assertion.issuedAt ||
      assertion.expiresAt - assertion.issuedAt > PUBLIC_ADMISSION_ASSERTION_TTL_SECONDS
    )
      return undefined;
    if (
      Object.entries(expected).some(([key, value]) => assertion[key as keyof Assertion] !== value)
    )
      return undefined;
    return {
      network: assertion.network,
      ...(assertion.visitor ? { visitor: assertion.visitor } : {}),
    };
  } catch {
    return undefined;
  }
}

function signingKey(keys: PublicAdmissionSigningKeys, version: string): string {
  const key = Object.hasOwn(keys.keys, version) ? keys.keys[version] : undefined;
  if (!key || key.length < 32 || !/^[A-Za-z0-9_-]{1,32}$/.test(version))
    throw new Error('public admission signing key unavailable');
  return key;
}
function signature(encoded: string, key: string): Buffer {
  return createHmac('sha256', key).update(encoded).digest();
}
function validBinding(value: PublicAdmissionRequestBinding): boolean {
  return (
    [value.surfaceId, value.installationId, value.idempotencyKey].every(
      (item) => typeof item === 'string' && item.length > 0 && item.length <= 128,
    ) &&
    value.method === 'POST' &&
    typeof value.route === 'string' &&
    value.route.startsWith('/') &&
    value.route.length <= 512 &&
    digestPattern.test(value.requestDigest)
  );
}
function isAssertion(value: unknown): value is Assertion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const a = value as Partial<Assertion>;
  return (
    validBinding(a as PublicAdmissionRequestBinding) &&
    a.version === 1 &&
    a.issuer === 'noodle-portal' &&
    a.audience === 'noodle-public-admission' &&
    typeof a.keyVersion === 'string' &&
    typeof a.epoch === 'string' &&
    Number.isSafeInteger(a.issuedAt) &&
    Number.isSafeInteger(a.expiresAt) &&
    typeof a.network === 'string' &&
    digestPattern.test(a.network) &&
    (a.visitor === undefined || digestPattern.test(a.visitor)) &&
    Object.keys(a).every((key) =>
      [
        'surfaceId',
        'installationId',
        'route',
        'method',
        'idempotencyKey',
        'requestDigest',
        'version',
        'keyVersion',
        'issuer',
        'audience',
        'epoch',
        'issuedAt',
        'expiresAt',
        'network',
        'visitor',
      ].includes(key),
    )
  );
}
