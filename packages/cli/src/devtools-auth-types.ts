import type {
  McpOAuthClientRegistration,
  McpOAuthDiscovery,
  McpOAuthPendingAuthorization,
  McpOAuthTokens,
} from '@noodle-borg/auth';
import type { DevtoolsFirebaseAuthConfig } from './devtools-firebase-auth.js';
import type { DevtoolsMicrosoftAuthConfig } from './devtools-microsoft-auth.js';

export type DevtoolsCustomerAuth =
  | {
      readonly kind: 'oidc';
      readonly issuer: string;
      /** Opaque local-only revision used to clear credentials when audience/claim routing changes. */
      readonly configurationKey?: string;
      /** Test/self-host seam. Production authorization servers must use HTTPS. */
      readonly allowInsecureLocalhost?: boolean;
    }
  | {
      readonly kind: 'federatedOidc';
      readonly issuers: readonly string[];
      /** Opaque local-only revision used to clear credentials when audience/claim routing changes. */
      readonly configurationKey?: string;
      /** Test/self-host seam. Production authorization servers must use HTTPS. */
      readonly allowInsecureLocalhost?: boolean;
    }
  | DevtoolsFirebaseAuthConfig
  | DevtoolsMicrosoftAuthConfig
  | {
      readonly kind: 'unsupported';
      readonly method: string;
    };

export interface DevtoolsOAuthDriver {
  discover(): Promise<McpOAuthDiscovery>;
  register(
    discovery: McpOAuthDiscovery,
    scopes?: readonly string[],
  ): Promise<McpOAuthClientRegistration>;
  beginAuthorization(
    discovery: McpOAuthDiscovery,
    registration: McpOAuthClientRegistration,
    scopes?: readonly string[],
  ): McpOAuthPendingAuthorization;
  exchangeCallback(
    discovery: McpOAuthDiscovery,
    registration: McpOAuthClientRegistration,
    pending: McpOAuthPendingAuthorization,
    callbackUrl: string,
  ): Promise<McpOAuthTokens>;
  refresh(
    discovery: McpOAuthDiscovery,
    registration: McpOAuthClientRegistration,
    current: McpOAuthTokens,
  ): Promise<McpOAuthTokens>;
}

export type DevtoolsAuthState =
  | 'signed_out'
  | 'authorizing'
  | 'signed_in'
  | 'reauthorization_required'
  | 'unsupported'
  | 'error';

export interface DevtoolsAuthStatus {
  readonly signInRequested?: boolean;
  readonly required: boolean;
  readonly supported: boolean;
  readonly state: DevtoolsAuthState;
  readonly issuer?: string;
  readonly issuers?: readonly string[];
  readonly method?: string;
  readonly scopes: readonly string[];
  readonly expiresAt?: number;
  /** Allowlisted provider/standards code only; never a raw provider response or request identifier. */
  readonly errorCode?: string;
  readonly message?: string;
}

/** A browser-safe auth failure whose code and message are intentionally curated by the Node host. */
export class DevtoolsAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DevtoolsAuthError';
  }
}

export class DevtoolsAuthRequiredError extends Error {
  constructor(message = 'Sign in to test this MCP app') {
    super(message);
    this.name = 'DevtoolsAuthRequiredError';
  }
}
