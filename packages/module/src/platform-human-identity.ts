import type { ModuleSqlTransaction } from './sql-transaction.js';

export interface UpstreamHumanIdentity {
  readonly provider: string;
  readonly realm: string;
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

/** Trim and lowercase only; provider-specific aliasing is deliberately out of scope. */
export function normalizePlatformIdentityEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 320 || !normalized.includes('@')) {
    throw new Error('verified email must be a non-empty email address');
  }
  return normalized;
}

export interface UpstreamAuthorizationOptions {
  readonly forceAuthentication?: boolean;
  readonly screenHint?: 'sign-up' | 'sign-in';
}

export const FRESH_AUTH_SCOPE = 'noodle:fresh-auth';
export const SIGNUP_INTENT_SCOPE = 'noodle:signup-intent';

export function upstreamAuthorizationOptionsInput(
  scopes: readonly string[] | undefined,
  signupClient: boolean,
): { readonly options?: UpstreamAuthorizationOptions } {
  const forceAuthentication = scopes?.includes(FRESH_AUTH_SCOPE) === true;
  const signup = signupClient && scopes?.includes(SIGNUP_INTENT_SCOPE) === true;
  if (!forceAuthentication && !signup) return {};
  return {
    options: {
      ...(forceAuthentication ? { forceAuthentication: true } : {}),
      ...(signup ? { screenHint: 'sign-up' as const } : {}),
    },
  };
}

export interface UpstreamHumanAuthentication extends UpstreamHumanIdentity {
  readonly locale?: string;
  readonly timeZone?: string;
  readonly upstreamSession?: { readonly provider: string; readonly id: string };
}

export interface UpstreamHumanOAuthAuthenticator {
  readonly provider: 'google' | 'workos';
  readonly realm: string;
  authorizationUrl(state: string, options?: UpstreamAuthorizationOptions): URL;
  exchange(code: string): Promise<UpstreamHumanAuthentication>;
  sessionLogoutUrl?(sessionId: string, returnTo: string): URL;
}

export interface ResolvedPlatformIdentity {
  readonly subject: string;
  /** Stable authority for provisioning identity-bound module state; omitted for legacy providers. */
  readonly identityIssuer?: string;
}

export type VerifiedEmailLookup =
  | { readonly kind: 'known'; readonly emails: readonly string[] }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'unavailable' };

export type PlatformIdentityErrorCode =
  | 'identity_email_unverified'
  | 'identity_link_required'
  | 'identity_link_disabled'
  | 'identity_link_remap_forbidden'
  | 'identity_signup_denied'
  | 'identity_signup_reserved'
  | 'principal_suspended';

/** Stable cross-package identity failure used by private providers and public consumers alike. */
export class PlatformIdentityError extends Error {
  readonly code: PlatformIdentityErrorCode;

  constructor(code: PlatformIdentityErrorCode) {
    super(code.replaceAll('_', ' '));
    this.name = 'PlatformIdentityError';
    this.code = code;
  }
}

export interface PlatformPrincipalResolver {
  resolve(input: UpstreamHumanIdentity): Promise<ResolvedPlatformIdentity>;
  resolveLinked(input: UpstreamHumanIdentity): Promise<ResolvedPlatformIdentity | undefined>;
  hasVerifiedEmailEvidence(email: string): Promise<boolean>;
  assertEmailAvailable(input: {
    readonly provider: string;
    readonly realm: string;
    readonly normalizedEmail: string;
  }): Promise<void>;
  resolveExisting(principalId: string): Promise<ResolvedPlatformIdentity | undefined>;
  assertActive(principalId: string): Promise<void>;
  lookupActiveVerifiedEmails(principalId: string): Promise<VerifiedEmailLookup>;
}

export interface UpstreamHumanRollout {
  readonly workosPercentage: number;
  readonly workosCanaryClientIds: readonly string[];
  readonly workosRecoveryClientIds?: readonly string[];
  readonly allowUserSelectedWorkosRecovery?: boolean;
}

export interface UpstreamHumanRolloutStore {
  get(): Promise<UpstreamHumanRollout>;
}

export interface PlatformHumanIdentityContribution {
  readonly principalResolver: PlatformPrincipalResolver;
  readonly upstreamAuthenticators?: Readonly<Record<string, UpstreamHumanOAuthAuthenticator>>;
  readonly rollout?: UpstreamHumanRollout;
  readonly rolloutStore?: UpstreamHumanRolloutStore;
  /** Install hosted identity hooks only after the public OAuth tables exist. */
  readonly initializeOAuthPersistence?: () => void | Promise<void>;
  /** Validate a platform refresh inside the public store's existing rotation transaction. */
  readonly assertRefreshPrincipal?: (
    transaction: ModuleSqlTransaction,
    input: { readonly oldTokenHash: string; readonly clientId: string },
  ) => Promise<'continue' | 'unknown' | 'suspended'>;
  readonly continuityProbe?: () => void | Promise<void>;
}
