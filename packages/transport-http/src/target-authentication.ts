import type { AccessMode, OwnerTokenVerifier } from '@noodle-borg/module';

/** Resolved identity authority. A missing customer verifier must never select platform defaults. */
export type TargetAuthentication =
  | { readonly kind: 'platform'; readonly verifyToken?: OwnerTokenVerifier }
  | {
      readonly kind: 'customer';
      readonly verifyToken?: OwnerTokenVerifier;
      readonly authorizationServers?: readonly string[];
    };

export function resolveTargetAuthentication(
  target: { readonly accessMode?: AccessMode; readonly authentication?: TargetAuthentication },
  platformVerifier?: OwnerTokenVerifier,
): TargetAuthentication {
  if (target.authentication?.kind === 'customer') return target.authentication;
  if (target.accessMode === 'customers') return { kind: 'customer' };
  const verifyToken = target.authentication?.verifyToken ?? platformVerifier;
  return { kind: 'platform', ...(verifyToken === undefined ? {} : { verifyToken }) };
}
