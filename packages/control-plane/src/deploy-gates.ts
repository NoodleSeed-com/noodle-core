import type { IncomingMessage } from 'node:http';
import { PlatformIdentityError, type PlatformPrincipalResolver } from '@noodle-borg/module';
import { bearerToken, type ControlPlaneAuthResult, type DeployAuthGate } from './deploy-auth.js';

/**
 * The concrete control-plane gates (moved verbatim from `packages/service/src/auth/deploy-gate.ts`).
 * Token verification is always injected — the Google `google-auth-library` verifier stays in the
 * hosted service's composition so this package carries no vendor SDK.
 */

export interface GoogleIdTokenVerifier {
  verify(
    token: string,
    audience: string | readonly string[],
  ): Promise<{ subject: string; email: string; givenName?: string }>;
}

export interface SignupAuthorizer {
  isSignupAllowed(input: { subject: string; email: string }): Promise<boolean> | boolean;
}

export type ControlPlaneSignupMode = 'restricted' | 'public';

export interface GoogleControlPlaneGateOptions {
  /**
   * One or more accepted OIDC audiences (control-plane OAuth client IDs). A presented Google ID token is
   * accepted when its `aud` matches ANY of these — e.g. the gcloud CLI client plus the hosted console's
   * Google web client (ADR 0116). All are passed to google-auth-library, which matches against the list.
   */
  readonly audience: string | readonly string[];
  readonly admins: readonly string[];
  readonly allowedEmailDomain?: string;
  readonly signupMode?: ControlPlaneSignupMode;
  readonly signupAuthorizer?: SignupAuthorizer;
  readonly deniedSignupDomains?: readonly string[];
  readonly deniedSignupSubjects?: readonly string[];
  readonly verifier: GoogleIdTokenVerifier;
  /** Optional durable canonical-human resolver. Unset preserves direct-Google compatibility. */
  readonly platformPrincipalResolver?: PlatformPrincipalResolver;
}

export class GoogleControlPlaneGate implements DeployAuthGate {
  readonly #audience: string | readonly string[];
  readonly #admins: ReadonlySet<string>;
  readonly #allowedEmailDomain: string;
  readonly #signupMode: ControlPlaneSignupMode;
  readonly #signupAuthorizer: SignupAuthorizer | undefined;
  readonly #deniedDomains: ReadonlySet<string>;
  readonly #deniedSubjects: ReadonlySet<string>;
  readonly #verifier: GoogleIdTokenVerifier;
  readonly #platformPrincipalResolver: PlatformPrincipalResolver | undefined;

  constructor(options: GoogleControlPlaneGateOptions) {
    const audiences = typeof options.audience === 'string' ? [options.audience] : options.audience;
    if (audiences.length === 0 || audiences.some((value) => value.length === 0)) {
      throw new Error('Google audience must be non-empty');
    }
    // Preserve the configured shape: a lone string stays a string (byte-for-byte unchanged single-audience
    // behavior), a list stays a list. google-auth-library accepts either and matches a token's `aud`.
    this.#audience = options.audience;
    this.#admins = new Set(options.admins.map((value) => value.toLowerCase()));
    this.#allowedEmailDomain = normalizeEmailDomain(
      options.allowedEmailDomain ?? '@noodleseed.com',
    );
    this.#signupMode = options.signupMode ?? 'restricted';
    this.#signupAuthorizer = options.signupAuthorizer;
    this.#deniedDomains = normalizedDomains(options.deniedSignupDomains ?? []);
    this.#deniedSubjects = new Set(options.deniedSignupSubjects?.map((s) => s.toLowerCase()) ?? []);
    this.#verifier = options.verifier;
    this.#platformPrincipalResolver = options.platformPrincipalResolver;
  }

  async authorize(req: IncomingMessage): Promise<ControlPlaneAuthResult> {
    const token = bearerToken(req);
    if (token === null) return { ok: false, status: 401, message: 'missing bearer token' };
    let identity: { subject: string; email: string; givenName?: string };
    try {
      identity = await this.#verifier.verify(token, this.#audience);
    } catch {
      return { ok: false, status: 401, message: 'invalid bearer token' };
    }
    const email = identity.email.toLowerCase();
    if (isDenied(identity.subject, email, this.#deniedSubjects, this.#deniedDomains)) {
      return { ok: false, status: 403, message: 'signup is denied' };
    }
    if (
      this.#signupMode === 'restricted' &&
      !email.endsWith(this.#allowedEmailDomain) &&
      !(await this.#signupAuthorizer?.isSignupAllowed({ subject: identity.subject, email }))
    ) {
      return { ok: false, status: 403, message: 'email domain is not allowed' };
    }
    let identityIssuer: string | undefined;
    if (this.#platformPrincipalResolver !== undefined) {
      try {
        const resolved = await this.#platformPrincipalResolver.resolve({
          provider: 'google',
          realm: 'accounts.google.com',
          subject: identity.subject,
          email,
          emailVerified: true,
        });
        // Google backfill uses its exact existing sub. A resolver that ever violates this would alter the
        // wire-compatible subject boundary, so fail closed rather than accepting an unsafe mapping.
        if (resolved.subject !== identity.subject) {
          return { ok: false, status: 403, message: 'platform identity is not permitted' };
        }
        identityIssuer = resolved.identityIssuer;
      } catch (error) {
        if (error instanceof PlatformIdentityError && error.code === 'principal_suspended') {
          return { ok: false, status: 403, message: 'platform identity is suspended' };
        }
        return { ok: false, status: 403, message: 'platform identity is not permitted' };
      }
    }
    return {
      ok: true,
      identity: {
        subject: identity.subject,
        email,
        ...(identityIssuer === undefined ? {} : { identityIssuer }),
        ...(identity.givenName !== undefined ? { givenName: identity.givenName } : {}),
        superAdmin: this.#admins.has(identity.subject.toLowerCase()) || this.#admins.has(email),
      },
    };
  }
}

export interface GoogleWorkloadControlPlaneGateOptions {
  /** Exact Google token audience(s) for CI/build service-account identity tokens. */
  readonly audience: string | readonly string[];
  /** Exact immutable Google `sub` values; email is never an authorization key. */
  readonly subjects: readonly string[];
  readonly admins: readonly string[];
  readonly verifier: GoogleIdTokenVerifier;
}

/**
 * Separate workload gate retained after direct human Google auth is removed. It deliberately bypasses
 * principal creation/email evidence: a workload is not a platform human and may act only when its exact
 * Google subject and configured audience both match.
 */
export class GoogleWorkloadControlPlaneGate implements DeployAuthGate {
  readonly #audience: string | readonly string[];
  readonly #subjects: ReadonlySet<string>;
  readonly #admins: ReadonlySet<string>;
  readonly #verifier: GoogleIdTokenVerifier;

  constructor(options: GoogleWorkloadControlPlaneGateOptions) {
    const audiences = typeof options.audience === 'string' ? [options.audience] : options.audience;
    if (audiences.length === 0 || audiences.some((audience) => audience.trim().length === 0)) {
      throw new Error('Google workload audience must be non-empty');
    }
    if (
      options.subjects.length === 0 ||
      options.subjects.some(
        (subject) =>
          subject.length === 0 ||
          subject.length > 512 ||
          subject.trim() !== subject ||
          /\s/.test(subject),
      )
    ) {
      throw new Error('Google workload subject allowlist must contain exact non-empty subjects');
    }
    this.#audience = options.audience;
    this.#subjects = new Set(options.subjects);
    this.#admins = new Set(options.admins.map((value) => value.toLowerCase()));
    this.#verifier = options.verifier;
  }

  async authorize(req: IncomingMessage): Promise<ControlPlaneAuthResult> {
    const token = bearerToken(req);
    if (token === null) return { ok: false, status: 401, message: 'missing bearer token' };
    let identity: { subject: string; email: string };
    try {
      identity = await this.#verifier.verify(token, this.#audience);
    } catch {
      return { ok: false, status: 401, message: 'invalid bearer token' };
    }
    const email = identity.email.toLowerCase();
    if (!this.#subjects.has(identity.subject)) {
      // A verified service-account token is definitively outside the exact workload allowlist and must not
      // fall through to the temporary broad human-Google compatibility gate. Ordinary human tokens remain
      // verifier-not-applicable so the fallback can handle them during the 14-day window.
      return email.endsWith('.gserviceaccount.com')
        ? { ok: false, status: 403, message: 'workload identity is not permitted' }
        : { ok: false, status: 401, message: 'not a configured workload identity' };
    }
    return {
      ok: true,
      identity: {
        subject: identity.subject,
        email,
        // Workload authority is bound only to the exact immutable Google subject. Email is profile data.
        superAdmin: this.#admins.has(identity.subject.toLowerCase()),
      },
    };
  }
}

/**
 * Tries several control-plane gates in order and accepts the first that authorizes. On the hosted control
 * plane a first-party caller may present EITHER an AS-issued token (MCP clients, CLI) OR a Google ID token
 * from a trusted audience (the console, [ADR 0116](../../../docs/decisions/0116-host-the-developer-console.md)) —
 * restoring the ADR 0039 Google control-plane path alongside the self-hosted AS (ADR 0042). A `403`
 * (identity verified but denied) is definitive and short-circuits; a `401` (couldn't verify this token) falls
 * through to the next gate, so each verifier gets a chance at a token it doesn't recognize.
 */
export class CompositeControlPlaneGate implements DeployAuthGate {
  readonly #gates: readonly DeployAuthGate[];

  constructor(gates: readonly DeployAuthGate[]) {
    if (gates.length === 0) {
      throw new Error('composite control-plane gate requires at least one gate');
    }
    this.#gates = gates;
  }

  async authorize(req: IncomingMessage): Promise<ControlPlaneAuthResult> {
    let last: ControlPlaneAuthResult = { ok: false, status: 401, message: 'invalid bearer token' };
    for (const gate of this.#gates) {
      const result = await gate.authorize(req);
      if (result.ok) return result;
      // 403 = identity verified but denied (domain/deny-list): definitive, do not try another verifier.
      if (result.status === 403) return result;
      last = result;
    }
    return last;
  }
}

export interface NoodleOAuthControlPlaneGateOptions {
  readonly verifier: (
    token: string,
    audience: string,
  ) => Promise<{
    readonly subject: string;
    readonly email?: string;
    readonly givenName?: string;
    readonly developerGrantId?: string;
    readonly oauthClientId?: string;
    readonly authTime?: number;
  } | null>;
  readonly audience: string | readonly string[];
  readonly admins: readonly string[];
  readonly allowedEmailDomain?: string;
  readonly signupMode?: ControlPlaneSignupMode;
  readonly signupAuthorizer?: SignupAuthorizer;
  readonly deniedSignupDomains?: readonly string[];
  readonly deniedSignupSubjects?: readonly string[];
  /** Optional canonical-principal lookup for Noodle-issued tokens. Missing legacy subjects remain valid. */
  readonly platformPrincipalResolver?: PlatformPrincipalResolver;
}

export class NoodleOAuthControlPlaneGate implements DeployAuthGate {
  readonly #verifier: (
    token: string,
    audience: string,
  ) => Promise<{
    readonly subject: string;
    readonly email?: string;
    readonly givenName?: string;
    readonly developerGrantId?: string;
    readonly oauthClientId?: string;
    readonly authTime?: number;
  } | null>;
  readonly #audiences: readonly string[];
  readonly #admins: ReadonlySet<string>;
  readonly #allowedEmailDomain: string;
  readonly #signupMode: ControlPlaneSignupMode;
  readonly #signupAuthorizer: SignupAuthorizer | undefined;
  readonly #deniedDomains: ReadonlySet<string>;
  readonly #deniedSubjects: ReadonlySet<string>;
  readonly #platformPrincipalResolver: PlatformPrincipalResolver | undefined;

  constructor(options: NoodleOAuthControlPlaneGateOptions) {
    const audiences = typeof options.audience === 'string' ? [options.audience] : options.audience;
    if (audiences.length === 0 || audiences.some((audience) => audience.length === 0)) {
      throw new Error('OAuth audience must be non-empty');
    }
    this.#verifier = options.verifier;
    this.#audiences = [...audiences];
    this.#admins = new Set(options.admins.map((value) => value.toLowerCase()));
    this.#allowedEmailDomain = normalizeEmailDomain(
      options.allowedEmailDomain ?? '@noodleseed.com',
    );
    this.#signupMode = options.signupMode ?? 'restricted';
    this.#signupAuthorizer = options.signupAuthorizer;
    this.#deniedDomains = normalizedDomains(options.deniedSignupDomains ?? []);
    this.#deniedSubjects = new Set(options.deniedSignupSubjects?.map((s) => s.toLowerCase()) ?? []);
    this.#platformPrincipalResolver = options.platformPrincipalResolver;
  }

  async authorize(req: IncomingMessage): Promise<ControlPlaneAuthResult> {
    const token = bearerToken(req);
    if (token === null) return { ok: false, status: 401, message: 'missing bearer token' };
    let identity: Awaited<ReturnType<NoodleOAuthControlPlaneGateOptions['verifier']>> = null;
    for (const audience of this.#audiences) {
      identity = await this.#verifier(token, audience);
      if (identity !== null) break;
    }
    if (!identity?.email) {
      return { ok: false, status: 401, message: 'invalid bearer token' };
    }
    const email = identity.email.toLowerCase();
    if (isDenied(identity.subject, email, this.#deniedSubjects, this.#deniedDomains)) {
      return { ok: false, status: 403, message: 'signup is denied' };
    }
    if (
      this.#signupMode === 'restricted' &&
      !email.endsWith(this.#allowedEmailDomain) &&
      !(await this.#signupAuthorizer?.isSignupAllowed({ subject: identity.subject, email }))
    ) {
      return { ok: false, status: 403, message: 'email domain is not allowed' };
    }
    let identityIssuer: string | undefined;
    if (this.#platformPrincipalResolver !== undefined) {
      try {
        // A Noodle token already has a canonical subject. Do not create an identity from a mutable email claim.
        identityIssuer = (await this.#platformPrincipalResolver.resolveExisting(identity.subject))
          ?.identityIssuer;
      } catch (error) {
        if (error instanceof PlatformIdentityError && error.code === 'principal_suspended') {
          return { ok: false, status: 403, message: 'platform identity is suspended' };
        }
        return { ok: false, status: 403, message: 'platform identity is not permitted' };
      }
    }
    return {
      ok: true,
      identity: {
        subject: identity.subject,
        email,
        ...(identityIssuer === undefined ? {} : { identityIssuer }),
        ...(identity.givenName !== undefined ? { givenName: identity.givenName } : {}),
        ...(identity.developerGrantId !== undefined
          ? { developerGrantId: identity.developerGrantId }
          : {}),
        ...(identity.oauthClientId !== undefined ? { oauthClientId: identity.oauthClientId } : {}),
        ...(identity.authTime !== undefined ? { authTime: identity.authTime } : {}),
        superAdmin:
          identity.developerGrantId === undefined &&
          // Noodle access tokens carry the canonical principal. Mutable email must never grant authority.
          this.#admins.has(identity.subject.toLowerCase()),
      },
    };
  }
}

function normalizeEmailDomain(value: string): string {
  const domain = value.trim().toLowerCase();
  if (domain.length === 0) throw new Error('allowed email domain must be non-empty');
  return domain.startsWith('@') ? domain : `@${domain}`;
}

function normalizedDomains(values: readonly string[]): ReadonlySet<string> {
  return new Set(values.map(normalizeEmailDomain));
}

function isDenied(
  subject: string,
  email: string,
  deniedSubjects: ReadonlySet<string>,
  deniedDomains: ReadonlySet<string>,
): boolean {
  return (
    deniedSubjects.has(subject.toLowerCase()) || [...deniedDomains].some((d) => email.endsWith(d))
  );
}
