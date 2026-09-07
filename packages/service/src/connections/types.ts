import type { ServedTarget } from '@noodle-borg/transport-http';
import type { ApplicationConnectionsProjection } from '@noodle-borg/wire-contracts';
import type { SolutionInstallation } from '../business-information/contracts.js';
import type { SourceCredentialAuthority } from '../business-information/source-credential-fence.js';
import type { LocalExternalCredentialProvider } from '../external-credential-exchange.js';

export interface ConnectionScope {
  readonly org: string;
  readonly app: string;
  readonly env: string;
  readonly installationId: string;
}
export interface ConnectionKey extends ConnectionScope {
  readonly connectionId: string;
}
export interface ConnectionTarget {
  readonly key: ConnectionKey;
  readonly label: string;
  readonly connectionConfigRevision: string;
  readonly requiredScopes: readonly string[];
}
export interface PendingConnection {
  readonly target: ConnectionTarget;
  readonly generation: string;
  readonly providerDigest: string;
  readonly credentialEpoch: string;
  readonly stateHash: string;
  readonly sessionHash: string;
  readonly subject: string;
  readonly providerId: string;
  readonly verifier: string;
  readonly nonce: string;
  readonly returnUrl: string;
  readonly expiresAt: number;
  readonly revision: number;
}
export interface ConnectionTokens {
  readonly subject: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
}
export interface StoredConnection {
  readonly revision: number;
  readonly generation: string;
  readonly credentialEpoch: string;
  readonly connectionConfigRevision: string;
  readonly providerDigest: string;
  readonly providerId: string;
  readonly state: 'unconfigured' | 'ready' | 'reauth_required' | 'revoked';
  readonly subject?: string;
  readonly tokens?: ConnectionTokens;
  readonly pending: readonly PendingConnection[];
}
export interface ConnectionTransaction {
  read(): Promise<StoredConnection | undefined>;
  write(value: StoredConnection): Promise<void>;
}
export interface ConnectionStore {
  /** Serializes all writers and refreshes for one connection across processes in the production adapter. */
  transact<T>(
    key: ConnectionKey,
    work: (transaction: ConnectionTransaction) => Promise<T>,
  ): Promise<T>;
  /** State handles contain only a hash plus exact scope; never tokens or a reusable credential. */
  putState(stateHash: string, key: ConnectionKey, expiresAt: number): Promise<void>;
  getState(stateHash: string, now: number): Promise<ConnectionKey | undefined>;
  deleteState(stateHash: string): Promise<void>;
}
export class ConnectionError extends Error {
  constructor(
    readonly code:
      | 'connection_conflict'
      | 'connection_invalid'
      | 'connection_unavailable'
      | 'connection_denied',
  ) {
    super(code);
  }
}

export type ConnectionView = Readonly<ApplicationConnectionsProjection['connections'][number]>;
export interface ConnectionCallback {
  readonly state: string;
  readonly sessionBinding: string;
  readonly code?: string | undefined;
  readonly error?: string | undefined;
  readonly iss?: string | undefined;
}

/** Handler-facing port; deployment OAuth implementation and credential custody stay outside the CLI. */
export interface ApplicationConnections {
  readonly localProvider: LocalExternalCredentialProvider;
  readonly connections: {
    inspect(target: ConnectionTarget): Promise<ConnectionView>;
    connect(
      target: ConnectionTarget,
      input: { expectedRevision: number; returnUrl: string; sessionBinding: string },
      actor: string,
    ): Promise<{ authorizationUrl: string }>;
    callback(input: ConnectionCallback, actor: string): Promise<{ returnUrl: string }>;
    disconnect(
      target: ConnectionTarget,
      expectedRevision: number,
      actor: string,
    ): Promise<ConnectionView>;
  };
  readonly resolveConnectionTargets: (
    installation: SolutionInstallation,
  ) => Promise<readonly ConnectionTarget[]>;
  readonly readGenerations: (target: ServedTarget) => Promise<Readonly<Record<string, string>>>;
  readonly sourceCredentials: SourceCredentialAuthority;
}
