import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { SecretEnvelope } from '../store.js';
import type {
  DeviceAuthorizationIdentity,
  DeviceAuthorizationPoll,
  DeviceAuthorizationRecord,
  DeviceAuthorizationStore,
  DeviceBrowserSessionRecord,
} from './device-store.js';
import { publicOAuthScope } from './fresh-auth.js';

/**
 * Durable state for the self-hosted OAuth authorization server (OA-2,
 * [ADR 0042](../../../../docs/decisions/0042-self-hosted-oauth-authorization-server.md)). All four record
 * kinds are short-lived OAuth state that must be **multi-instance-safe** (any Cloud Run instance can complete
 * a flow another instance started — [ADR 0036](../../../../docs/decisions/0036-stateless-registry-lazy-recompile.md)),
 * so they live in the shared store, not process memory.
 *
 * Opaque secrets (authorization codes, refresh tokens, upstream-login `state` nonces) are keyed by their
 * **hash** — the caller hashes the raw value and passes only the hash here, so a store dump never yields a
 * usable credential. This module is the dumb keyed store; entropy, hashing, and TTL policy live in the
 * provider layer.
 */

/** A PKCE-bound, single-use authorization code (the `code` field is the hash of the raw code). */
export interface AuthorizationCodeRecord {
  readonly code: string;
  readonly clientId: string;
  /** PKCE `code_challenge` (S256). Validated by the SDK token handler before redemption. */
  readonly codeChallenge: string;
  readonly redirectUri: string;
  /** Canonical tenant MCP URL the resulting token is bound to (RFC 8707 audience). */
  readonly resource: string;
  /** The authenticated owner's canonical Noodle principal. */
  readonly ownerSubject: string;
  readonly ownerEmail?: string;
  readonly ownerLocale?: string;
  readonly ownerTimeZone?: string;
  readonly scope?: string;
  readonly roles?: readonly string[];
  readonly authTime?: number;
  /** Expiry of the verified upstream customer assertion that supplied role claims. */
  readonly upstreamExpiresAt?: number;
  readonly identityKind?: 'platform' | 'customer';
  readonly identityProvider?: string;
  readonly customerIssuer?: string;
  readonly developerGrantId?: string;
  /** Expiry, epoch seconds. */
  readonly expiresAt: number;
}

/** State carried across the selected upstream-human round-trip (`state` is stored only as a hash). */
export type PendingAuthorizationCallbackKind =
  | 'google'
  | 'workos'
  | 'upstream_choice'
  | 'customer_firebase'
  | 'customer_microsoft';

export interface PendingAuthorizationRecord {
  readonly state: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  /** Exact callback family selected by the authorization server for this one browser transaction. */
  readonly upstreamProvider: PendingAuthorizationCallbackKind;
  /** The MCP client's own `state`, echoed back on the final redirect. */
  readonly clientState?: string;
  readonly resource: string;
  readonly scope?: string;
  readonly expiresAt: number;
}

/** A rotating, revocable refresh token (`token` is the hash of the raw refresh token). */
export interface RefreshTokenRecord {
  readonly token: string;
  readonly clientId: string;
  readonly ownerSubject: string;
  readonly ownerEmail?: string;
  readonly ownerLocale?: string;
  readonly ownerTimeZone?: string;
  readonly resource: string;
  readonly scope?: string;
  readonly roles?: readonly string[];
  readonly authTime?: number;
  /** Expiry of the verified upstream customer assertion that supplied role claims. */
  readonly upstreamExpiresAt?: number;
  readonly identityKind?: 'platform' | 'customer';
  readonly identityProvider?: string;
  readonly customerIssuer?: string;
  readonly developerGrantId?: string;
  readonly expiresAt: number;
  /**
   * Stable identifier for the rotation chain this token belongs to. Created at initial issuance and
   * **inherited** through every rotation, so out-of-window reuse can revoke the whole family. Optional during
   * the additive rollout (slice 1): only {@link OAuthStore.rotateRefreshToken} consumers set it. A record
   * without a `familyId` is revoked as a singleton family.
   */
  readonly familyId?: string;
  /** Epoch seconds the token was rotated (set by the store, not the caller). `undefined` = still live/unused. */
  readonly rotatedAt?: number;
  /** Hash of the successor token minted when this one was first rotated (set by the store). */
  readonly supersededBy?: string;
}

/** Owner/audience identity carried out of a rotation so the provider can mint the successor access token. */
export interface RefreshIdentity {
  readonly ownerSubject: string;
  readonly ownerEmail?: string;
  readonly ownerLocale?: string;
  readonly ownerTimeZone?: string;
  readonly resource: string;
  readonly scope?: string;
  readonly roles?: readonly string[];
  readonly authTime?: number;
  readonly upstreamExpiresAt?: number;
  readonly familyId?: string;
  readonly identityKind?: 'platform' | 'customer';
  readonly identityProvider?: string;
  readonly customerIssuer?: string;
  readonly developerGrantId?: string;
}

/**
 * Outcome of {@link OAuthStore.rotateRefreshToken}. `rotated`/`grace`/`recovered` mean the caller may issue
 * tokens (the successor was inserted and {@link RefreshIdentity} describes the owner); `reuse`/`unknown` mean
 * the caller must reject the exchange with `invalid_grant`.
 */
export type RefreshRotation =
  | { readonly status: 'rotated'; readonly identity: RefreshIdentity }
  | { readonly status: 'grace'; readonly identity: RefreshIdentity }
  | { readonly status: 'recovered'; readonly identity: RefreshIdentity }
  /** A known canonical platform principal was suspended while refreshing; no successor may be minted. */
  | { readonly status: 'suspended' }
  | { readonly status: 'reuse' }
  | { readonly status: 'unknown' };

/** Input to {@link OAuthStore.rotateRefreshToken}. Times are epoch seconds; the caller owns the clock. */
export interface RefreshRotationInput {
  /** Hash of the refresh token the client presented. */
  readonly oldTokenHash: string;
  readonly clientId: string;
  /** Hash of the provider-minted successor token to insert on `rotated`/`grace`. */
  readonly newTokenHash: string;
  /** Successor expiry, epoch seconds. */
  readonly newExpiresAt: number;
  /** How long after rotation a reuse is still treated as benign (concurrent/retried) rather than theft. */
  readonly graceSeconds: number;
  /**
   * How long after rotation an old token may recover from a lost response when its successor has never been
   * used. This is longer than the concurrency grace window but still bounded to avoid masking real replay.
   */
  readonly recoverySeconds: number;
  /** Current time, epoch seconds (injected for deterministic grace/expiry decisions). */
  readonly nowSeconds: number;
}

export type ConsentGrantIdentityKind = 'platform' | 'customer';

/** A remembered consent approval with explicit platform/customer provenance. */
export interface ConsentGrantRecord {
  readonly clientId: string;
  readonly ownerSubject: string;
  /** Canonical resource (RFC 8707 audience) the consent was granted for. */
  readonly resource: string;
  readonly identityKind: ConsentGrantIdentityKind;
}

/** A sealed customer credential captured during tenant customer auth for later connector delegation. */
export interface DelegatedCredentialRecord {
  readonly resource: string;
  readonly provider: string;
  readonly subject: string;
  readonly credential: SecretEnvelope;
  readonly updatedAt: string;
}

export interface DelegatedCredentialLookup {
  readonly resource: string;
  readonly provider: string;
  readonly subject: string;
}

export interface OAuthStore extends DeviceAuthorizationStore {
  /** Dynamic client registration (RFC 7591): persist + read the SDK-generated client info. */
  getClient(clientId: string): Promise<OAuthClientInformationFull | undefined>;
  /** Durable server-owned purpose; absent registration is distinct from a known dynamic client. */
  getClientPurpose(clientId: string): Promise<'console' | 'portal' | 'dynamic' | undefined>;
  putClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull>;
  /** Atomically reserves or reconciles a server-owned client without taking over a DCR registration. */
  putFirstPartyClient(
    owner: 'console' | 'portal',
    client: OAuthClientInformationFull,
  ): Promise<OAuthClientInformationFull>;

  /** Pending authorization (single-use). A provider mismatch leaves the record live for its real callback. */
  createPendingAuthorization(record: PendingAuthorizationRecord): Promise<void>;
  consumePendingAuthorization(
    state: string,
    expectedUpstreamProvider: PendingAuthorizationCallbackKind,
  ): Promise<PendingAuthorizationRecord | undefined>;

  /** Authorization code: created after consent, read non-destructively for the PKCE challenge, then redeemed once. */
  createAuthorizationCode(record: AuthorizationCodeRecord): Promise<void>;
  getAuthorizationCode(code: string): Promise<AuthorizationCodeRecord | undefined>;
  /** Atomic single-use redeem — returns the record only on the first call for a live, unredeemed code. */
  redeemAuthorizationCode(code: string): Promise<AuthorizationCodeRecord | undefined>;

  /** Refresh token: created on token issuance, consumed once on rotation (reuse → `undefined`). */
  createRefreshToken(record: RefreshTokenRecord): Promise<void>;
  /** Non-destructive lookup used to fail closed on a suspended platform principal before rotation. */
  getRefreshToken(token: string): Promise<RefreshTokenRecord | undefined>;
  consumeRefreshToken(token: string): Promise<RefreshTokenRecord | undefined>;

  /**
   * Concurrency- and retry-safe refresh-token rotation (the fix for the deploy-time reconnect loop —
   * [spec/auth-and-policy.md](../../../../docs/spec/auth-and-policy.md)). Atomically
   * claims the presented token and inserts the successor, classifying the outcome:
   * - `rotated` — first use of a live token; the successor is inserted in the same family.
   * - `grace` — reuse within `graceSeconds` of rotation (benign concurrent/retried refresh); a fresh
   *   successor is inserted in the same family, so the racing caller also ends up with a usable token.
   * - `recovered` — reuse after grace but within `recoverySeconds` when the prior successor was never used;
   *   the abandoned successor is invalidated and replaced.
   * - `reuse` — reuse outside the grace window (genuine replay/theft); the **entire family is revoked**.
   * - `unknown` — token not found, wrong client, or expired.
   */
  rotateRefreshToken(input: RefreshRotationInput): Promise<RefreshRotation>;

  /**
   * Remembered consent (standard OAuth). Persist the human's approval of a `(clientId, ownerSubject, resource)`
   * tuple at consent time, and look it up on a later authorization so the consent interstitial is shown only
   * the first time — a client that re-runs authorization does not re-prompt the user. The confused-deputy
   * guard ([ADR 0042](../../../../docs/decisions/0042-self-hosted-oauth-authorization-server.md)) is preserved
   * because a new client or resource has no grant and still requires explicit consent.
   */
  createConsentGrant(grant: ConsentGrantRecord): Promise<void>;
  hasConsentGrant(
    clientId: string,
    ownerSubject: string,
    resource: string,
    identityKind: ConsentGrantIdentityKind,
  ): Promise<boolean>;

  /** Store and load sealed per-customer delegated credentials for connector broker use. */
  putDelegatedCredential(record: DelegatedCredentialRecord): Promise<void>;
  getDelegatedCredential(
    lookup: DelegatedCredentialLookup,
  ): Promise<DelegatedCredentialRecord | undefined>;
}

function live(expiresAt: number): boolean {
  return expiresAt * 1000 > Date.now();
}

/** Stable key for a remembered-consent tuple. `|` is absent from client IDs, principal IDs, and the
 * canonical http(s) resource URLs, so it cannot collide across the three parts. */
function consentKey(
  clientId: string,
  ownerSubject: string,
  resource: string,
  identityKind: ConsentGrantIdentityKind,
): string {
  return `${clientId}|${ownerSubject}|${resource}|${identityKind}`;
}

function delegatedCredentialKey(input: DelegatedCredentialLookup): string {
  return `${input.resource}|${input.provider}|${input.subject}`;
}

/**
 * In-memory {@link OAuthStore} for tests and non-persistent dev. Single-use operations are atomic by
 * construction: the check-and-delete runs synchronously (no `await` between read and mutation), so two
 * concurrent redemptions of the same code/token resolve with exactly one winner.
 */
export class InMemoryOAuthStore implements OAuthStore {
  readonly #clients = new Map<string, OAuthClientInformationFull>();
  readonly #firstPartyClientOwners = new Map<string, 'console' | 'portal'>();
  readonly #pending = new Map<string, PendingAuthorizationRecord>();
  readonly #codes = new Map<string, AuthorizationCodeRecord>();
  readonly #refresh = new Map<string, RefreshTokenRecord>();
  readonly #consent = new Set<string>();
  readonly #delegated = new Map<string, DelegatedCredentialRecord>();
  readonly #devices = new Map<string, DeviceAuthorizationRecord>();
  readonly #deviceUsers = new Map<string, string>();
  readonly #deviceBrowserSessions = new Map<string, DeviceBrowserSessionRecord>();

  getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return Promise.resolve(this.#clients.get(clientId));
  }

  getClientPurpose(clientId: string): Promise<'console' | 'portal' | 'dynamic' | undefined> {
    return Promise.resolve(
      this.#firstPartyClientOwners.get(clientId) ??
        (this.#clients.has(clientId) ? 'dynamic' : undefined),
    );
  }

  putClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    if (this.#firstPartyClientOwners.has(client.client_id)) {
      return Promise.reject(new Error('OAuth client ID is reserved by a first-party client'));
    }
    this.#clients.set(client.client_id, client);
    return Promise.resolve(client);
  }

  putFirstPartyClient(
    owner: 'console' | 'portal',
    client: OAuthClientInformationFull,
  ): Promise<OAuthClientInformationFull> {
    const existingOwner = this.#firstPartyClientOwners.get(client.client_id);
    if (this.#clients.has(client.client_id) && existingOwner !== owner) {
      return Promise.reject(new Error('OAuth client ID is already registered through DCR'));
    }
    this.#clients.set(client.client_id, client);
    this.#firstPartyClientOwners.set(client.client_id, owner);
    return Promise.resolve(client);
  }

  createPendingAuthorization(record: PendingAuthorizationRecord): Promise<void> {
    this.#pending.set(record.state, record);
    return Promise.resolve();
  }

  consumePendingAuthorization(
    state: string,
    expectedUpstreamProvider: PendingAuthorizationRecord['upstreamProvider'],
  ): Promise<PendingAuthorizationRecord | undefined> {
    const record = this.#pending.get(state);
    if (record !== undefined && record.upstreamProvider !== expectedUpstreamProvider) {
      return Promise.resolve(undefined);
    }
    this.#pending.delete(state); // single-use: gone whether or not it was still live
    return Promise.resolve(record && live(record.expiresAt) ? record : undefined);
  }

  createAuthorizationCode(record: AuthorizationCodeRecord): Promise<void> {
    this.#codes.set(record.code, record);
    return Promise.resolve();
  }

  getAuthorizationCode(code: string): Promise<AuthorizationCodeRecord | undefined> {
    const record = this.#codes.get(code);
    return Promise.resolve(record && live(record.expiresAt) ? record : undefined);
  }

  redeemAuthorizationCode(code: string): Promise<AuthorizationCodeRecord | undefined> {
    const record = this.#codes.get(code);
    if (record === undefined) return Promise.resolve(undefined);
    this.#codes.delete(code); // atomic single-use: the second concurrent redeem sees nothing
    return Promise.resolve(live(record.expiresAt) ? record : undefined);
  }

  createDeviceAuthorization(record: DeviceAuthorizationRecord): Promise<void> {
    this.#devices.set(record.deviceCode, record);
    this.#deviceUsers.set(record.userCode, record.deviceCode);
    return Promise.resolve();
  }

  getDeviceAuthorizationByUserCode(
    userCode: string,
  ): Promise<DeviceAuthorizationRecord | undefined> {
    const deviceCode = this.#deviceUsers.get(userCode);
    const record = deviceCode === undefined ? undefined : this.#devices.get(deviceCode);
    return Promise.resolve(
      record !== undefined && record.status === 'pending' && live(record.expiresAt)
        ? record
        : undefined,
    );
  }

  createDeviceBrowserSession(record: DeviceBrowserSessionRecord): Promise<void> {
    this.#deviceBrowserSessions.set(record.state, record);
    return Promise.resolve();
  }

  consumeDeviceBrowserSession(state: string): Promise<DeviceBrowserSessionRecord | undefined> {
    const record = this.#deviceBrowserSessions.get(state);
    this.#deviceBrowserSessions.delete(state);
    return Promise.resolve(record !== undefined && live(record.expiresAt) ? record : undefined);
  }

  approveDeviceAuthorization(
    deviceCode: string,
    identity: DeviceAuthorizationIdentity,
  ): Promise<boolean> {
    const record = this.#devices.get(deviceCode);
    if (record === undefined || record.status !== 'pending' || !live(record.expiresAt)) {
      return Promise.resolve(false);
    }
    this.#devices.set(deviceCode, { ...record, ...identity, status: 'approved' });
    return Promise.resolve(true);
  }

  denyDeviceAuthorization(deviceCode: string): Promise<boolean> {
    const record = this.#devices.get(deviceCode);
    if (record === undefined || record.status !== 'pending' || !live(record.expiresAt)) {
      return Promise.resolve(false);
    }
    this.#devices.set(deviceCode, { ...record, status: 'denied' });
    return Promise.resolve(true);
  }

  pollDeviceAuthorization(input: {
    readonly deviceCode: string;
    readonly clientId: string;
    readonly resource?: string;
    readonly nowSeconds: number;
  }): Promise<DeviceAuthorizationPoll> {
    const record = this.#devices.get(input.deviceCode);
    if (record === undefined || record.expiresAt <= input.nowSeconds) {
      if (record !== undefined) this.#deleteDevice(record);
      return Promise.resolve({ status: 'expired_token' });
    }
    if (
      record.clientId !== input.clientId ||
      (input.resource !== undefined && record.resource !== input.resource)
    ) {
      return Promise.resolve({ status: 'invalid_grant' });
    }
    if (record.status === 'denied') {
      this.#deleteDevice(record);
      return Promise.resolve({ status: 'access_denied' });
    }
    if (record.status === 'approved') {
      return Promise.resolve({ status: 'approved', record });
    }
    if (input.nowSeconds < record.nextPollAt) {
      this.#devices.set(input.deviceCode, {
        ...record,
        nextPollAt: record.nextPollAt + record.intervalSeconds,
      });
      return Promise.resolve({ status: 'slow_down' });
    }
    this.#devices.set(input.deviceCode, {
      ...record,
      nextPollAt: input.nowSeconds + record.intervalSeconds,
    });
    return Promise.resolve({ status: 'authorization_pending' });
  }

  completeDeviceTokenIssuance(deviceCode: string, clientId: string): Promise<boolean> {
    const record = this.#devices.get(deviceCode);
    if (record === undefined || record.status !== 'approved' || record.clientId !== clientId) {
      return Promise.resolve(false);
    }
    this.#deleteDevice(record);
    return Promise.resolve(true);
  }

  #deleteDevice(record: DeviceAuthorizationRecord): void {
    this.#devices.delete(record.deviceCode);
    this.#deviceUsers.delete(record.userCode);
  }

  createRefreshToken(record: RefreshTokenRecord): Promise<void> {
    this.#refresh.set(record.token, record);
    return Promise.resolve();
  }

  getRefreshToken(token: string): Promise<RefreshTokenRecord | undefined> {
    const record = this.#refresh.get(token);
    if (record === undefined || !live(record.expiresAt)) return Promise.resolve(undefined);
    return Promise.resolve(record);
  }

  consumeRefreshToken(token: string): Promise<RefreshTokenRecord | undefined> {
    const record = this.#refresh.get(token);
    if (record === undefined) return Promise.resolve(undefined);
    this.#refresh.delete(token); // rotation: a refresh token is single-use; reuse → undefined
    return Promise.resolve(live(record.expiresAt) ? record : undefined);
  }

  createConsentGrant(grant: ConsentGrantRecord): Promise<void> {
    this.#consent.add(
      consentKey(grant.clientId, grant.ownerSubject, grant.resource, grant.identityKind),
    );
    return Promise.resolve();
  }

  hasConsentGrant(
    clientId: string,
    ownerSubject: string,
    resource: string,
    identityKind: ConsentGrantIdentityKind,
  ): Promise<boolean> {
    return Promise.resolve(
      this.#consent.has(consentKey(clientId, ownerSubject, resource, identityKind)),
    );
  }

  putDelegatedCredential(record: DelegatedCredentialRecord): Promise<void> {
    this.#delegated.set(delegatedCredentialKey(record), record);
    return Promise.resolve();
  }

  getDelegatedCredential(
    lookup: DelegatedCredentialLookup,
  ): Promise<DelegatedCredentialRecord | undefined> {
    return Promise.resolve(this.#delegated.get(delegatedCredentialKey(lookup)));
  }

  rotateRefreshToken(input: RefreshRotationInput): Promise<RefreshRotation> {
    const {
      oldTokenHash,
      clientId,
      newTokenHash,
      newExpiresAt,
      graceSeconds,
      recoverySeconds,
      nowSeconds,
    } = input;
    const record = this.#refresh.get(oldTokenHash);
    // Unknown: not found, or a different client's token (never leak existence across clients).
    if (record === undefined || record.clientId !== clientId) {
      return Promise.resolve({ status: 'unknown' });
    }
    // Expired: treat as unknown and clean up. The check-and-set below runs with no intervening `await`,
    // so two concurrent rotations of the same token resolve with exactly one `rotated` winner.
    if (record.expiresAt <= nowSeconds) {
      this.#refresh.delete(oldTokenHash);
      return Promise.resolve({ status: 'unknown' });
    }
    const sanitizedRecord = withPublicOAuthScope(record);
    const identity = identityOf(sanitizedRecord);
    if (record.rotatedAt === undefined) {
      // First rotation: claim the old token and insert the successor in the same family.
      this.#refresh.set(oldTokenHash, {
        ...sanitizedRecord,
        rotatedAt: nowSeconds,
        supersededBy: newTokenHash,
      });
      this.#insertSuccessor(sanitizedRecord, newTokenHash, newExpiresAt, clientId);
      return Promise.resolve({ status: 'rotated', identity });
    }
    // Already rotated: benign reuse within the window, or genuine reuse → revoke the family.
    if (nowSeconds - record.rotatedAt <= graceSeconds) {
      this.#refresh.set(oldTokenHash, sanitizedRecord);
      this.#insertSuccessor(sanitizedRecord, newTokenHash, newExpiresAt, clientId);
      return Promise.resolve({ status: 'grace', identity });
    }
    if (nowSeconds - record.rotatedAt <= recoverySeconds && record.supersededBy !== undefined) {
      const successor = this.#refresh.get(record.supersededBy);
      if (
        successor !== undefined &&
        successor.clientId === clientId &&
        successor.rotatedAt === undefined &&
        sameFamily(record, successor) &&
        successor.expiresAt > nowSeconds
      ) {
        this.#refresh.delete(successor.token);
        this.#refresh.set(oldTokenHash, { ...sanitizedRecord, supersededBy: newTokenHash });
        this.#insertSuccessor(sanitizedRecord, newTokenHash, newExpiresAt, clientId);
        return Promise.resolve({ status: 'recovered', identity });
      }
    }
    this.#revokeFamily(sanitizedRecord);
    return Promise.resolve({ status: 'reuse' });
  }

  #insertSuccessor(
    old: RefreshTokenRecord,
    newTokenHash: string,
    newExpiresAt: number,
    clientId: string,
  ): void {
    this.#refresh.set(newTokenHash, {
      token: newTokenHash,
      clientId,
      ownerSubject: old.ownerSubject,
      ...(old.ownerEmail !== undefined ? { ownerEmail: old.ownerEmail } : {}),
      ...(old.ownerLocale !== undefined ? { ownerLocale: old.ownerLocale } : {}),
      ...(old.ownerTimeZone !== undefined ? { ownerTimeZone: old.ownerTimeZone } : {}),
      resource: old.resource,
      ...(old.scope !== undefined ? { scope: old.scope } : {}),
      ...(old.roles !== undefined ? { roles: [...old.roles] } : {}),
      ...(old.authTime !== undefined ? { authTime: old.authTime } : {}),
      ...(old.upstreamExpiresAt !== undefined ? { upstreamExpiresAt: old.upstreamExpiresAt } : {}),
      ...(old.identityKind !== undefined ? { identityKind: old.identityKind } : {}),
      ...(old.identityProvider !== undefined ? { identityProvider: old.identityProvider } : {}),
      ...(old.customerIssuer !== undefined ? { customerIssuer: old.customerIssuer } : {}),
      ...(old.developerGrantId !== undefined ? { developerGrantId: old.developerGrantId } : {}),
      expiresAt: newExpiresAt,
      ...(old.familyId !== undefined ? { familyId: old.familyId } : {}),
    });
  }

  #revokeFamily(record: RefreshTokenRecord): void {
    if (record.familyId === undefined) {
      this.#refresh.delete(record.token); // no family → revoke just this token
      return;
    }
    for (const [key, value] of this.#refresh) {
      if (value.familyId === record.familyId) this.#refresh.delete(key);
    }
  }
}

function identityOf(record: RefreshTokenRecord): RefreshIdentity {
  return {
    ownerSubject: record.ownerSubject,
    ...(record.ownerEmail !== undefined ? { ownerEmail: record.ownerEmail } : {}),
    ...(record.ownerLocale !== undefined ? { ownerLocale: record.ownerLocale } : {}),
    ...(record.ownerTimeZone !== undefined ? { ownerTimeZone: record.ownerTimeZone } : {}),
    resource: record.resource,
    ...(record.scope !== undefined ? { scope: record.scope } : {}),
    ...(record.roles !== undefined ? { roles: [...record.roles] } : {}),
    ...(record.authTime !== undefined ? { authTime: record.authTime } : {}),
    ...(record.upstreamExpiresAt !== undefined
      ? { upstreamExpiresAt: record.upstreamExpiresAt }
      : {}),
    ...(record.familyId !== undefined ? { familyId: record.familyId } : {}),
    ...(record.identityKind !== undefined ? { identityKind: record.identityKind } : {}),
    ...(record.identityProvider !== undefined ? { identityProvider: record.identityProvider } : {}),
    ...(record.customerIssuer !== undefined ? { customerIssuer: record.customerIssuer } : {}),
    ...(record.developerGrantId !== undefined ? { developerGrantId: record.developerGrantId } : {}),
  };
}

function withPublicOAuthScope(record: RefreshTokenRecord): RefreshTokenRecord {
  const scope = publicOAuthScope(record.scope);
  if (scope === record.scope) return record;
  const { scope: _internalScope, ...recordWithoutScope } = record;
  return scope === undefined ? recordWithoutScope : { ...recordWithoutScope, scope };
}

function sameFamily(a: RefreshTokenRecord, b: RefreshTokenRecord): boolean {
  if (a.familyId === undefined || b.familyId === undefined) return a.token === b.token;
  return a.familyId === b.familyId;
}
