import {
  CompositeControlPlaneGate,
  type DeployAuthGate,
  GoogleControlPlaneGate,
  GoogleWorkloadControlPlaneGate,
  NoodleOAuthControlPlaneGate,
} from '@noodle-borg/control-plane/portable';
import type { PlatformPrincipalResolver } from '@noodle-borg/module';
import type { OwnerTokenVerifier } from '@noodle-borg/transport-http';
import { GoogleOAuthVerifier } from './auth/google-token-verifier.js';
import { restrictPortalControlPlane } from './auth/portal-control-plane-policy.js';
import { normalizeOAuthResource } from './http-util.js';
import type { OAuthStore } from './oauth/store.js';
import type { ServeServiceOptions } from './serve-options.js';
import type { ControlPlaneStore } from './store.js';

/** Compose the temporary human/workload Google gates behind the canonical Noodle-token gate. */
export function createDefaultControlPlaneGate(input: {
  readonly options: ServeServiceOptions;
  readonly oauthStore?: Pick<OAuthStore, 'getClientPurpose'>;
  readonly verifyOwnerToken?: OwnerTokenVerifier;
  readonly authServerIssuer?: string;
  readonly controlPlaneStore: ControlPlaneStore;
  readonly platformPrincipalResolver?: PlatformPrincipalResolver;
}): DeployAuthGate | undefined {
  const gates: DeployAuthGate[] = [];
  const { options } = input;
  assertGoogleWorkloadConfiguration({
    subjects: options.googleWorkloadSubjects ?? [],
    ...(options.googleClientId === undefined ? {} : { audience: options.googleClientId }),
    ...(options.googleHumanAuthCompatibility === undefined
      ? {}
      : { humanAuthCompatibility: options.googleHumanAuthCompatibility }),
  });
  assertCanonicalPlatformAdminConfiguration({
    admins: options.controlPlaneAdmins ?? [],
    canonicalIdentityConfigured: input.platformPrincipalResolver !== undefined,
  });
  if (input.verifyOwnerToken !== undefined && input.authServerIssuer !== undefined) {
    const allowedEmailDomain =
      options.controlPlaneAllowedEmailDomain ?? options.oauth?.allowedEmailDomain;
    gates.push(
      restrictPortalControlPlane(
        new NoodleOAuthControlPlaneGate({
          verifier: async (token, audience) =>
            (await input.verifyOwnerToken?.(token, audience))?.caller ?? null,
          audience: [
            normalizeOAuthResource(options.publicBaseUrl ?? input.authServerIssuer),
            `${input.authServerIssuer}/developer/mcp`,
            `${input.authServerIssuer}/developer/cli`,
            // Exchange-minted assistant tokens (ADR 0218): grant-bound, so never super-admin.
            `${input.authServerIssuer}/developer/assistant`,
          ],
          admins: options.controlPlaneAdmins ?? [],
          signupMode: options.controlPlaneSignupMode ?? 'restricted',
          signupAuthorizer: input.controlPlaneStore,
          deniedSignupDomains: options.deniedSignupDomains ?? [],
          deniedSignupSubjects: options.deniedSignupSubjects ?? [],
          ...(input.platformPrincipalResolver === undefined
            ? {}
            : { platformPrincipalResolver: input.platformPrincipalResolver }),
          ...(allowedEmailDomain !== undefined ? { allowedEmailDomain } : {}),
        }),
        input.oauthStore,
        options.oauth?.controlPlaneExchange?.clientId,
      ),
    );
  }
  if (options.googleClientId !== undefined) {
    const googleAudience =
      options.googleAdditionalAudiences && options.googleAdditionalAudiences.length > 0
        ? [options.googleClientId, ...options.googleAdditionalAudiences]
        : options.googleClientId;
    if ((options.googleWorkloadSubjects?.length ?? 0) > 0) {
      gates.push(
        new GoogleWorkloadControlPlaneGate({
          // Workloads use the one exact configured audience. Human compatibility audiences (for example,
          // the legacy Console web client) must never widen this service-account trust boundary.
          audience: options.googleClientId,
          subjects: options.googleWorkloadSubjects ?? [],
          admins: options.controlPlaneAdmins ?? [],
          verifier: options.googleVerifier ?? new GoogleOAuthVerifier(),
        }),
      );
    }
    if (options.googleHumanAuthCompatibility !== false) {
      gates.push(
        new GoogleControlPlaneGate({
          // Single audience stays a plain string (unchanged); only a configured additional-audience list
          // widens it to an array. Keeps the CLI/gcloud single-client path byte-for-byte identical.
          audience: googleAudience,
          admins: options.controlPlaneAdmins ?? [],
          signupMode: options.controlPlaneSignupMode ?? 'restricted',
          signupAuthorizer: input.controlPlaneStore,
          deniedSignupDomains: options.deniedSignupDomains ?? [],
          deniedSignupSubjects: options.deniedSignupSubjects ?? [],
          ...(options.controlPlaneAllowedEmailDomain !== undefined
            ? { allowedEmailDomain: options.controlPlaneAllowedEmailDomain }
            : {}),
          verifier: options.googleVerifier ?? new GoogleOAuthVerifier(),
          ...(input.platformPrincipalResolver === undefined
            ? {}
            : { platformPrincipalResolver: input.platformPrincipalResolver }),
        }),
      );
    }
  }
  return gates.length === 0
    ? undefined
    : gates.length === 1
      ? gates[0]
      : new CompositeControlPlaneGate(gates);
}

/** Finalization may disable human Google only when the independent workload gate remains exact and usable. */
function assertGoogleWorkloadConfiguration(input: {
  readonly audience?: string;
  readonly subjects: readonly string[];
  readonly humanAuthCompatibility?: boolean;
}): void {
  const audience = input.audience?.trim();
  if (input.subjects.length > 0 && !audience) {
    throw new Error('Google workload subjects require an exact workload audience');
  }
  if (input.humanAuthCompatibility === false && input.subjects.length === 0) {
    throw new Error('Disabling human Google requires exact workload subjects');
  }
}

/** Email-configured admins are a direct-Google compatibility shim, never a WorkOS authorization key. */
export function assertCanonicalPlatformAdminConfiguration(input: {
  readonly admins: readonly string[];
  readonly canonicalIdentityConfigured: boolean;
}): void {
  if (input.canonicalIdentityConfigured && input.admins.some((admin) => admin.includes('@'))) {
    throw new Error('canonical identity requires control-plane admins to use principal subjects');
  }
}
