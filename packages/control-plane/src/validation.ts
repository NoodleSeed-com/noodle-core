import type { OrgRole, SignupAllowlistKind } from './contracts.js';

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}\.)+[a-z0-9-]{2,63}$/;
export const OPENAI_APPS_CHALLENGE_MAX_LENGTH = 2048;

const RESERVED_SLUGS = new Set(['deploy', 'healthz', 'readyz', 'v1', 'o', 'mcp']);
const SYSTEM_OWNED_ORG_SLUGS = new Set(['local']);

/** Whether an organization namespace is owned by service bootstrap rather than a customer. */
export function isSystemOwnedOrgSlug(value: string): boolean {
  return SYSTEM_OWNED_ORG_SLUGS.has(value);
}

export function validateSlug(kind: 'org' | 'app' | 'env', value: string): string {
  if (!SLUG_PATTERN.test(value) || RESERVED_SLUGS.has(value)) {
    throw new Error(
      `invalid ${kind} slug "${value}"; use lowercase letters, numbers, and hyphens only`,
    );
  }
  return value;
}

/** User-owned organizations must not claim namespaces reserved for service bootstrap behavior. */
export function validateUserOwnedOrgSlug(value: string): string {
  const slug = validateSlug('org', value);
  if (isSystemOwnedOrgSlug(slug)) {
    throw new Error(`organization slug "${value}" is reserved for system use`);
  }
  return slug;
}

/** Public MCP hostname labels share tenant syntax but cannot use system-owned organization names. */
export function validateMcpSubdomain(value: string): string {
  return validateUserOwnedOrgSlug(value);
}

export function validateDomain(value: string): string {
  const domain = value.trim().toLowerCase();
  if (!DOMAIN_PATTERN.test(domain)) {
    throw new Error(`invalid domain "${value}"`);
  }
  return domain;
}

/**
 * Consumer mailbox providers. Registering one as an org domain would admit every signed-in user on the
 * platform while reading like a narrow rule, so it is refused: `--access authenticated` is the one
 * canonical way to say "anyone signed in".
 */
const PUBLIC_EMAIL_PROVIDERS = new Set([
  'aol.com',
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'icloud.com',
  'live.com',
  'mail.com',
  'me.com',
  'msn.com',
  'outlook.com',
  'proton.me',
  'protonmail.com',
  'yahoo.com',
  'yandex.com',
  'zoho.com',
]);

/** Validate a domain that will grant data-plane membership to everyone who signs in with it. */
export function validateOrgMembershipDomain(value: string): string {
  const domain = validateDomain(value);
  if (PUBLIC_EMAIL_PROVIDERS.has(domain)) {
    throw new Error(
      `"${domain}" is a public email provider, so every signed-in user would match it; ` +
        'use --access authenticated if that is what you want',
    );
  }
  return domain;
}

export function validateOpenAIAppsChallenge(value: string): string {
  const challenge = value.trim();
  if (challenge.length === 0) {
    throw new Error('OpenAI Apps challenge must be a non-empty string');
  }
  if (challenge.length > OPENAI_APPS_CHALLENGE_MAX_LENGTH) {
    throw new Error(
      `OpenAI Apps challenge must be at most ${OPENAI_APPS_CHALLENGE_MAX_LENGTH} characters`,
    );
  }
  if (/[\r\n]/.test(challenge)) {
    throw new Error('OpenAI Apps challenge must be a single line');
  }
  return challenge;
}

export function validateSignupAllowlistKind(value: string): SignupAllowlistKind {
  if (value !== 'subject' && value !== 'domain') {
    throw new Error(`invalid signup allowlist kind "${value}"`);
  }
  return value;
}

export function validateOrgRole(role: string): OrgRole {
  if (role !== 'owner' && role !== 'developer') {
    throw new Error(`invalid org role "${role}"`);
  }
  return role;
}
