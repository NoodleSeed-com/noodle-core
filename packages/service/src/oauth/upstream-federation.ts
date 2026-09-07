import type { ControlPlaneSignupMode, SignupAuthorizer } from '@noodle-borg/control-plane/portable';
import {
  normalizePlatformIdentityEmail,
  PlatformIdentityError,
  type PlatformPrincipalResolver,
  type UpstreamHumanIdentity,
} from '@noodle-borg/module';
import type { GoogleAuthenticator } from './google.js';
import type {
  UpstreamAuthorizationOptions,
  UpstreamHumanAuthentication,
  UpstreamHumanOAuthAuthenticator,
  UpstreamHumanProvider,
} from './upstream-human.js';

export function upstreamAuthorizationUrl(input: {
  readonly provider: UpstreamHumanProvider;
  readonly google?: GoogleAuthenticator;
  readonly workos?: UpstreamHumanOAuthAuthenticator;
  readonly state: string;
  readonly options?: UpstreamAuthorizationOptions;
}): string {
  if (input.provider === 'google') {
    if (input.google === undefined) throw new Error('Google authenticator is unavailable');
    return input.google.authorizationUrl(input.state, input.options).toString();
  }
  return input.workos?.authorizationUrl(input.state, input.options).toString() ?? '';
}

export async function exchangeUpstreamHumanIdentity(input: {
  readonly provider: UpstreamHumanProvider;
  readonly code: string;
  readonly google?: GoogleAuthenticator;
  readonly workos?: UpstreamHumanOAuthAuthenticator;
}): Promise<UpstreamHumanAuthentication> {
  if (input.provider === 'workos') {
    if (input.workos === undefined) throw new Error('WorkOS authenticator is unavailable');
    const identity = await input.workos.exchange(input.code);
    if (identity.provider !== input.workos.provider || identity.realm !== input.workos.realm) {
      throw new Error('WorkOS identity provider or realm mismatch');
    }
    return identity;
  }
  if (input.google === undefined) throw new Error('Google authenticator is unavailable');
  const identity = await input.google.exchange(input.code);
  return {
    provider: 'google',
    realm: 'accounts.google.com',
    subject: identity.subject,
    email: identity.email,
    emailVerified: true,
    ...(identity.locale !== undefined ? { locale: identity.locale } : {}),
    ...(identity.timeZone !== undefined ? { timeZone: identity.timeZone } : {}),
  };
}

export async function resolveUpstreamHumanPrincipal(input: {
  readonly provider: UpstreamHumanProvider;
  readonly identity: UpstreamHumanIdentity;
  readonly resolver?: PlatformPrincipalResolver;
  readonly signupAuthorizer?: SignupAuthorizer;
  readonly allowedEmailDomain?: string;
  readonly signupMode?: ControlPlaneSignupMode;
  readonly deniedSignupDomains?: readonly string[];
  readonly deniedSignupSubjects?: readonly string[];
}): Promise<string> {
  if (input.provider === 'google') {
    // Admission is evaluated against the verified Google identity before creating canonical state or
    // enqueueing WorkOS synchronization. Rejected callbacks must be side-effect free.
    assertIdentityIsNotDenied(input, input.identity.subject);
    if (
      (input.signupMode ?? 'restricted') === 'restricted' &&
      input.allowedEmailDomain !== undefined &&
      !emailMatchesDomain(input.identity.email, input.allowedEmailDomain) &&
      !(await input.signupAuthorizer?.isSignupAllowed({
        subject: input.identity.subject,
        email: input.identity.email.toLowerCase(),
      }))
    ) {
      throw new PlatformIdentityError('identity_link_required');
    }
    return input.resolver === undefined
      ? input.identity.subject
      : (await input.resolver.resolve(input.identity)).subject;
  }
  if (input.resolver === undefined) throw new PlatformIdentityError('identity_link_required');
  const existing = await input.resolver.resolveLinked(input.identity);
  // Linked identities are still observed through the resolver so a newer verified WorkOS email becomes the
  // sole current provider/realm evidence. This is not email linking: the immutable WorkOS ID was resolved first.
  if (existing !== undefined) {
    assertIdentityIsNotDenied(input, existing.subject);
    return (await input.resolver.resolve(input.identity)).subject;
  }
  if (await input.resolver.hasVerifiedEmailEvidence(input.identity.email)) {
    throw new PlatformIdentityError('identity_link_required');
  }
  await input.resolver.assertEmailAvailable({
    provider: input.identity.provider,
    realm: input.identity.realm,
    normalizedEmail: normalizePlatformIdentityEmail(input.identity.email),
  });
  assertIdentityIsNotDenied(input);
  if ((input.signupMode ?? 'restricted') === 'public') {
    return (await input.resolver.resolve(input.identity)).subject;
  }
  const signupAllowed = await input.signupAuthorizer?.isSignupAllowed({
    subject: input.identity.subject,
    email: input.identity.email.toLowerCase(),
  });
  const domainAllowed =
    input.allowedEmailDomain !== undefined &&
    emailMatchesDomain(input.identity.email, input.allowedEmailDomain);
  if (!domainAllowed && signupAllowed !== true)
    throw new PlatformIdentityError('identity_link_required');
  return (await input.resolver.resolve(input.identity)).subject;
}

function assertIdentityIsNotDenied(
  input: {
    readonly identity: UpstreamHumanIdentity;
    readonly deniedSignupDomains?: readonly string[];
    readonly deniedSignupSubjects?: readonly string[];
  },
  canonicalSubject?: string,
): void {
  const subjects = new Set(
    (input.deniedSignupSubjects ?? []).map((subject) => subject.trim().toLowerCase()),
  );
  const externalSubject = input.identity.subject.toLowerCase();
  const canonical = canonicalSubject?.toLowerCase();
  const deniedDomain = (input.deniedSignupDomains ?? []).some((domain) =>
    emailMatchesDomain(input.identity.email, domain),
  );
  if (
    subjects.has(externalSubject) ||
    (canonical !== undefined && subjects.has(canonical)) ||
    deniedDomain
  ) {
    throw new PlatformIdentityError('identity_signup_denied');
  }
}

function emailMatchesDomain(email: string, configuredDomain: string): boolean {
  const domain = configuredDomain.trim().toLowerCase();
  if (domain.length === 0) return false;
  return email.toLowerCase().endsWith(domain.startsWith('@') ? domain : `@${domain}`);
}
