import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { PlatformIdentityError, type PlatformPrincipalResolver } from '@noodle-borg/module';
import type { OwnerTokenVerifier } from '@noodle-borg/transport-http';
import type { OAuthStore } from './store.js';

/** Enforce canonical-principal suspension on every platform access-token authorization. */
export function guardPlatformAccessTokenVerifier(
  verifier: OwnerTokenVerifier,
  resolver: PlatformPrincipalResolver,
): OwnerTokenVerifier {
  return async (token, resource) => {
    const verification = await verifier(token, resource);
    if (
      verification === null ||
      verification.caller.identityKind === 'customer' ||
      verification.caller.identityKind === 'service'
    ) {
      return verification;
    }
    try {
      // Missing principals are pre-backfill legacy identities and remain compatible; the durable resolver
      // throws only for a known suspended principal. Any persistence failure still fails authorization closed.
      await resolver.resolveExisting(verification.caller.subject);
      return verification;
    } catch {
      return null;
    }
  };
}

/** Fail before rotation so suspending a principal cannot mint a successor refresh token. */
export async function assertPlatformRefreshPrincipal(
  store: OAuthStore,
  resolver: PlatformPrincipalResolver | undefined,
  input: { readonly oldTokenHash: string; readonly client: OAuthClientInformationFull },
): Promise<void> {
  if (resolver === undefined) return;
  const current = await store.getRefreshToken(input.oldTokenHash);
  if (
    current === undefined ||
    current.clientId !== input.client.client_id ||
    current.identityKind === 'customer'
  ) {
    return;
  }
  try {
    await resolver.resolveExisting(current.ownerSubject);
  } catch (error) {
    if (error instanceof PlatformIdentityError && error.code === 'principal_suspended') {
      throw new InvalidGrantError('invalid refresh token');
    }
    throw error;
  }
}
