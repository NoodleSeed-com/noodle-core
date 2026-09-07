import { createHash } from 'node:crypto';
import type { SignupAllowlistKind } from './contracts.js';
import { validateDomain, validateSlug } from './validation.js';

export function memberKey(org: string, subject: string): string {
  return `${org}/${subject}`;
}

export function domainKey(org: string, domain: string): string {
  return `${org}/${domain}`;
}

export function domainFromEmail(email: string): string | undefined {
  const at = email.lastIndexOf('@');
  if (at < 0) return undefined;
  try {
    return validateDomain(email.slice(at + 1));
  } catch {
    return undefined;
  }
}

export function normalizeSignupAllowlistValue(kind: SignupAllowlistKind, value: string): string {
  return kind === 'domain' ? validateDomain(value) : value.trim().toLowerCase();
}

export function signupKey(kind: SignupAllowlistKind, value: string): string {
  return `${kind}/${value}`;
}

export function personalOrgSlug(identity: {
  readonly subject: string;
  readonly email: string;
}): string {
  const localPart = identity.email.split('@')[0] ?? 'user';
  const base = slugPart(localPart).slice(0, 52) || 'user';
  return validateSlug('org', `u-${base}${personalOrgSlugSuffix(identity.subject)}`);
}

/** Immutable suffix used to discover and bind legacy email-derived personal organization slugs. */
export function personalOrgSlugSuffix(subject: string): string {
  return `-${createHash('sha256').update(subject).digest('hex').slice(0, 8)}`;
}

function slugPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
