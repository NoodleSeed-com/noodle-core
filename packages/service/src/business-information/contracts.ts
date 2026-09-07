import type { ArtifactVariableDeclaration, ManagedCollectionControls } from '@noodle-borg/compiler';
import type { ManagedRecordQuery } from '@noodle-borg/wire-contracts';
import type { BusinessNoticeStore } from './business-notice.js';
import type { BusinessPrincipalProvider } from './principal-authority.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export const MANAGED_RETENTION_DAYS = [7, 30, 90] as const;
export type ManagedRetentionDays = (typeof MANAGED_RETENTION_DAYS)[number];

export const BUSINESS_ROLES = ['administrator', 'manager', 'operator', 'viewer'] as const;
export type BusinessRole = (typeof BUSINESS_ROLES)[number];
export type BusinessPermission =
  | 'installation:administer'
  | 'grants:manage'
  | 'records:create'
  | 'records:read'
  | 'records:update'
  | 'records:assign'
  | 'records:status'
  | 'records:note'
  | 'records:delete'
  | 'records:export';

export const MANAGED_REQUEST_STATUSES = ['new', 'in_progress', 'resolved', 'closed'] as const;
export type ManagedRequestStatus = (typeof MANAGED_REQUEST_STATUSES)[number];

export const BUILT_IN_PROFILE_KEYS = ['travel', 'b2b_saas', 'ecommerce', 'restaurant'] as const;
export type BuiltInProfileKey = (typeof BUILT_IN_PROFILE_KEYS)[number];

export interface NativeCollectionAuthority {
  readonly authority: 'native';
}

export interface ExternalCollectionAuthority {
  readonly authority: 'external';
  readonly connectorAlias: string;
  readonly connectorId: string;
  readonly connectorVersion: string;
  readonly scanOperation: string;
  readonly scanSignatureHash: string;
}

export type CollectionAuthority = NativeCollectionAuthority | ExternalCollectionAuthority;

export interface InstalledCollectionDefinition extends ManagedCollectionControls {
  readonly key: string;
  readonly title: string;
  readonly singularTitle: string;
  readonly description: string;
  readonly schemaVersion: number;
  readonly schemaDigest: string;
  readonly recordSchema: JsonObject;
  readonly summaryFields: readonly string[];
  readonly authority: CollectionAuthority;
  /** Historical release decoder only. New definitions use independently optional management controls. */
  readonly behavior?: { readonly kind: 'request' };
}

export type SolutionDefinitionReference =
  | {
      readonly kind: 'managed';
      readonly definitionId: 'travel' | 'ecommerce' | 'restaurant';
      readonly release: number;
      readonly digest: string;
    }
  | {
      readonly kind: 'private';
      readonly publisherOrg: string;
      readonly app: string;
      readonly env: string;
      readonly deploymentId: string;
      readonly version: string;
      readonly digest: string;
    }
  | {
      readonly kind: 'legacy';
      readonly definitionId: 'b2b_saas';
      readonly release: number;
      readonly digest: string;
    };

export interface SolutionDefinitionSnapshot {
  readonly reference: SolutionDefinitionReference;
  readonly title: string;
  readonly description: string;
  readonly collections: readonly InstalledCollectionDefinition[];
  readonly variables?: readonly ArtifactVariableDeclaration[];
}

export interface InstallationScope {
  readonly org: string;
  readonly app: string;
  readonly env: string;
  readonly installationId: string;
}

export interface SolutionInstallation {
  readonly scope: InstallationScope;
  /** Opaque stable identifier for public channel resolution; never grants access by possession. */
  readonly publicId: string;
  /** Legacy storage key retained while old installations are served and backfilled. */
  readonly profileKey: string;
  readonly profileVersion: number;
  readonly managedCollections: readonly string[];
  readonly definition: SolutionDefinitionSnapshot;
  readonly retentionDays: ManagedRetentionDays;
  /** Public native-record intake exposure; authorized records remain operable while paused. */
  readonly intakeActive: boolean;
  /** Internal binding to the authoritative app incarnation; never a Portal configuration value. */
  readonly applicationGeneration?: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly createdBySubject: string;
  readonly updatedAt: string;
  readonly updatedBySubject: string;
}

export interface BusinessGrant {
  readonly scope: InstallationScope;
  readonly subject: string;
  readonly email?: string;
  readonly role: BusinessRole;
  readonly revision: number;
  readonly createdAt: string;
  readonly createdBySubject: string;
  readonly updatedAt: string;
  readonly updatedBySubject: string;
  readonly revokedAt?: string;
}

export interface BusinessInvitation {
  readonly scope: InstallationScope;
  readonly invitationId: string;
  readonly email: string;
  readonly role: BusinessRole;
  /** SHA-256 digest of the high-entropy bearer token; the raw token is never persisted. */
  readonly tokenDigest: string;
  readonly idempotencyDigest: string;
  readonly createFingerprint: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly createdBySubject: string;
  readonly acceptedAt?: string;
  readonly acceptedBySubject?: string;
  readonly revokedAt?: string;
  readonly revokedBySubject?: string;
}

export interface ManagedRequestOrigin {
  readonly kind: 'embedded' | 'mcp' | 'portal' | 'api' | 'import';
  readonly reference?: string;
}

export interface ManagedRequestNote {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
  readonly createdBySubject: string;
}

export interface ManagedRequestContent {
  readonly payload: JsonObject;
  readonly notes: readonly ManagedRequestNote[];
}

export interface ManagedRequestRecord {
  readonly originalSchema?: {
    readonly profileVersion: number;
    readonly schemaVersion: number;
    readonly schemaDigest: string;
  };
  readonly scope: InstallationScope;
  readonly collectionKey: string;
  readonly id: string;
  readonly profileKey: string;
  readonly profileVersion: number;
  readonly schemaVersion: number;
  readonly schemaDigest: string;
  readonly status?: ManagedRequestStatus;
  readonly assigneeSubject?: string;
  readonly origin: ManagedRequestOrigin;
  readonly revision: number;
  readonly retentionExpiresAt: string;
  readonly createdAt: string;
  readonly createdBySubject: string;
  readonly updatedAt: string;
  readonly updatedBySubject: string;
  readonly deletedAt?: string;
  readonly deletionReason?: 'customer_request' | 'retention_expired';
  readonly content?: ManagedRequestContent;
}

/** Payload-free identity of a schema that has accepted at least one durable business record. */
export type AcceptedBusinessInformationSchema = Pick<
  ManagedRequestRecord,
  'profileKey' | 'profileVersion' | 'collectionKey' | 'schemaVersion' | 'schemaDigest'
>;

export type ManagedRequestActivityKind =
  | 'created'
  | 'updated'
  | 'assigned'
  | 'status_changed'
  | 'note_added'
  | 'schema_migrated'
  | 'deleted'
  | 'retention_expired';

export interface RequestActivityPage {
  readonly activities: readonly ManagedRequestActivity[];
  readonly nextCursor?: string;
}

export interface ManagedRequestActivity {
  readonly scope: InstallationScope;
  readonly collectionKey: string;
  readonly recordId: string;
  readonly revision: number;
  readonly kind: ManagedRequestActivityKind;
  readonly status?: ManagedRequestStatus;
  readonly assigneeSubject?: string;
  readonly occurredAt: string;
  readonly actorSubject: string;
  readonly content?: ManagedRequestContent;
}

export interface PayloadCipherContext extends InstallationScope {
  readonly collectionKey: string;
  readonly recordId: string;
  readonly revision: number;
}

/** An opaque authenticated-encryption envelope. Implementations own nonce/tag encoding in ciphertext. */
export interface SealedPayload {
  readonly version: 1;
  readonly algorithm: string;
  readonly keyId: string;
  readonly ciphertext: string;
}

export interface PayloadCipher {
  seal(plaintext: Uint8Array, context: PayloadCipherContext): Promise<SealedPayload>;
  open(payload: SealedPayload, context: PayloadCipherContext): Promise<Uint8Array>;
}

export type InstallationCreateResult =
  | { readonly disposition: 'created' | 'replayed'; readonly installation: SolutionInstallation }
  | { readonly disposition: 'conflict'; readonly installation: SolutionInstallation };

export type GrantMutationResult =
  | { readonly ok: true; readonly grant: BusinessGrant }
  | {
      readonly ok: false;
      readonly reason: 'not_found' | 'conflict' | 'last_administrator';
      readonly currentRevision: number;
    };

export type InvitationCreateResult =
  | { readonly disposition: 'created' | 'replayed'; readonly invitation: BusinessInvitation }
  | { readonly disposition: 'conflict'; readonly invitation: BusinessInvitation };

export type InvitationMutationResult =
  | { readonly ok: true; readonly invitation: BusinessInvitation }
  | {
      readonly ok: false;
      readonly reason: 'not_found' | 'conflict' | 'already_used';
      readonly currentRevision: number;
    };

export type InvitationClaimResult =
  | { readonly ok: true; readonly invitation: BusinessInvitation; readonly grant: BusinessGrant }
  | {
      readonly ok: false;
      readonly reason:
        | 'not_found'
        | 'expired'
        | 'revoked'
        | 'already_used'
        | 'email_mismatch'
        | 'last_administrator';
    };

export type RequestCreateResult =
  | { readonly disposition: 'created' | 'replayed'; readonly record: ManagedRequestRecord }
  | { readonly disposition: 'conflict'; readonly record: ManagedRequestRecord }
  | { readonly disposition: 'paused' };

export type RequestCreateProbeResult =
  | { readonly disposition: 'missing' }
  | { readonly disposition: 'replayed' | 'conflict'; readonly record: ManagedRequestRecord };

export type InstallationMutationResult =
  | { readonly ok: true; readonly installation: SolutionInstallation }
  | {
      readonly ok: false;
      readonly reason: 'not_found' | 'conflict' | 'invalid_state' | 'application_unavailable';
      readonly currentRevision: number;
    };

export type RequestMutationResult =
  | { readonly ok: true; readonly record: ManagedRequestRecord }
  | {
      readonly ok: false;
      readonly reason: 'not_found' | 'conflict' | 'invalid_transition' | 'invalid_assignee';
      readonly currentRevision: number;
    };

export type ManagedRequestOperation =
  | { readonly kind: 'update'; readonly payload: unknown; readonly unset?: readonly string[] }
  | { readonly kind: 'assign'; readonly assigneeSubject: string | undefined }
  | { readonly kind: 'set_status'; readonly status: ManagedRequestStatus }
  | { readonly kind: 'add_note'; readonly note: string };

export interface RequestPage {
  readonly records: readonly ManagedRequestRecord[];
  readonly nextCursor?: string;
}

export interface RequestExportPage extends RequestPage {
  readonly snapshotAt: string;
}

export interface SolutionInstallationStore {
  bindApplication(scope: InstallationScope, generation: string): Promise<boolean>;
  pauseApplication(org: string, app: string, at: string, retired?: boolean): Promise<void>;
  createInstallation(input: {
    readonly scope: InstallationScope;
    readonly profileKey?: BuiltInProfileKey;
    readonly definition?: SolutionDefinitionSnapshot;
    readonly managedCollections: readonly string[];
    readonly retentionDays?: ManagedRetentionDays;
    readonly actorSubject: string;
    readonly actorEmail?: string;
  }): Promise<InstallationCreateResult>;
  getInstallation(scope: InstallationScope): Promise<SolutionInstallation | undefined>;
  getInstallationById(
    org: string,
    installationId: string,
  ): Promise<SolutionInstallation | undefined>;
  resolveInstallationByPublicId(publicId: string): Promise<SolutionInstallation | undefined>;
  listInstallations(org: string): Promise<readonly SolutionInstallation[]>;
  listInstallationsForSubject(
    subject: string,
  ): Promise<
    readonly { readonly installation: SolutionInstallation; readonly grant: BusinessGrant }[]
  >;
  setIntakeState(input: {
    readonly scope: InstallationScope;
    readonly expectedRevision: number;
    readonly active: boolean;
    readonly actorSubject: string;
  }): Promise<InstallationMutationResult>;
}

export interface BusinessGrantStore {
  getGrant(scope: InstallationScope, subject: string): Promise<BusinessGrant | undefined>;
  listGrants(scope: InstallationScope): Promise<readonly BusinessGrant[]>;
  setGrant(input: {
    readonly scope: InstallationScope;
    readonly subject: string;
    readonly email: string;
    readonly role: BusinessRole;
    readonly expectedRevision: number;
    readonly actorSubject: string;
  }): Promise<GrantMutationResult>;
  revokeGrant(input: {
    readonly scope: InstallationScope;
    readonly subject: string;
    readonly expectedRevision: number;
    readonly actorSubject: string;
  }): Promise<GrantMutationResult>;
  createInvitation(input: {
    readonly scope: InstallationScope;
    readonly invitationId: string;
    readonly email: string;
    readonly role: BusinessRole;
    readonly tokenDigest: string;
    readonly idempotencyKey: string;
    readonly expiresAt: Date;
    readonly actorSubject: string;
  }): Promise<InvitationCreateResult>;
  listInvitations(scope: InstallationScope): Promise<readonly BusinessInvitation[]>;
  revokeInvitation(input: {
    readonly scope: InstallationScope;
    readonly invitationId: string;
    readonly expectedRevision: number;
    readonly actorSubject: string;
  }): Promise<InvitationMutationResult>;
  claimInvitation(input: {
    readonly tokenDigest: string;
    readonly subject: string;
    readonly email: string;
  }): Promise<InvitationClaimResult>;
}

export interface ManagedRequestStore {
  /** Explicit authorized release migration; no read-time rewrite or broader record grants. */
  migrateLegacyRequest(input: {
    readonly scope: InstallationScope;
    readonly collectionKey: string;
    readonly id: string;
    readonly expectedRevision: number;
    readonly actorSubject: string;
  }): Promise<RequestMutationResult>;
  /** Authoritative, de-duplicated inventory used to prove release reader compatibility. */
  listAcceptedSchemaInventory(): Promise<readonly AcceptedBusinessInformationSchema[]>;
  /** Read completed idempotency evidence without creating a record or spending admission. */
  probeRequest(input: {
    readonly publicInput?: true;
    readonly scope: InstallationScope;
    readonly collectionKey: string;
    readonly idempotencyKey: string;
    readonly payload: unknown;
    readonly origin: ManagedRequestOrigin;
    readonly actorSubject: string;
  }): Promise<RequestCreateProbeResult>;
  createRequest(input: {
    readonly publicInput?: true;
    readonly scope: InstallationScope;
    readonly collectionKey: string;
    readonly idempotencyKey: string;
    readonly payload: unknown;
    readonly origin: ManagedRequestOrigin;
    readonly actorSubject: string;
  }): Promise<RequestCreateResult>;
  getRequest(
    scope: InstallationScope,
    collectionKey: string,
    id: string,
    options?: { readonly includeDeleted?: boolean },
  ): Promise<ManagedRequestRecord | undefined>;
  listRequests(
    input: ManagedRecordQuery & {
      readonly scope: InstallationScope;
      readonly collectionKey: string;
      readonly status?: ManagedRequestStatus;
      readonly assigneeSubject?: string;
      readonly cursor?: string;
      readonly limit?: number;
      readonly includeDeleted?: boolean;
    },
  ): Promise<RequestPage>;
  mutateRequest(input: {
    readonly scope: InstallationScope;
    readonly collectionKey: string;
    readonly id: string;
    readonly expectedRevision: number;
    readonly actorSubject: string;
    readonly operation: ManagedRequestOperation;
  }): Promise<RequestMutationResult>;
  deleteRequest(input: {
    readonly scope: InstallationScope;
    readonly collectionKey: string;
    readonly id: string;
    readonly expectedRevision: number;
    readonly actorSubject: string;
    readonly reason: 'customer_request';
  }): Promise<RequestMutationResult>;
  listActivity(
    scope: InstallationScope,
    collectionKey: string,
    id: string,
    paging?: { readonly cursor?: string; readonly limit?: number },
  ): Promise<RequestActivityPage>;
  exportRequests(input: {
    readonly scope: InstallationScope;
    readonly collectionKey: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly includeDeleted?: boolean;
  }): Promise<RequestExportPage>;
  /** Erases expired content and retains payload-free tombstones. */
  purgeExpired(input: {
    readonly scope?: InstallationScope;
    readonly limit?: number;
  }): Promise<number>;
}

export interface BusinessInformationStore
  extends SolutionInstallationStore,
    BusinessNoticeStore,
    BusinessGrantStore,
    ManagedRequestStore {
  configurePrincipalAuthority(provider: BusinessPrincipalProvider | undefined): void;
  listEligibleAssignees(scope: InstallationScope): Promise<readonly BusinessGrant[]>;
}
