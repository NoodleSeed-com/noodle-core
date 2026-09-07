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
  readonly profileKey: BuiltInProfileKey;
  readonly profileVersion: number;
  readonly managedCollections: readonly string[];
  readonly retentionDays: ManagedRetentionDays;
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
  readonly scope: InstallationScope;
  readonly collectionKey: string;
  readonly id: string;
  readonly profileKey: BuiltInProfileKey;
  readonly profileVersion: number;
  readonly schemaVersion: number;
  readonly schemaDigest: string;
  readonly status: ManagedRequestStatus;
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

export type ManagedRequestActivityKind =
  | 'created'
  | 'updated'
  | 'assigned'
  | 'status_changed'
  | 'note_added'
  | 'deleted'
  | 'retention_expired';

export interface ManagedRequestActivity {
  readonly scope: InstallationScope;
  readonly collectionKey: string;
  readonly recordId: string;
  readonly revision: number;
  readonly kind: ManagedRequestActivityKind;
  readonly status: ManagedRequestStatus;
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

export type RequestCreateResult =
  | { readonly disposition: 'created' | 'replayed'; readonly record: ManagedRequestRecord }
  | { readonly disposition: 'conflict'; readonly record: ManagedRequestRecord };

export type RequestMutationResult =
  | { readonly ok: true; readonly record: ManagedRequestRecord }
  | {
      readonly ok: false;
      readonly reason: 'not_found' | 'conflict' | 'invalid_transition';
      readonly currentRevision: number;
    };

export type ManagedRequestOperation =
  | { readonly kind: 'update'; readonly payload: unknown }
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
  createInstallation(input: {
    readonly scope: InstallationScope;
    readonly profileKey: BuiltInProfileKey;
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
}

export interface ManagedRequestStore {
  createRequest(input: {
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
  listRequests(input: {
    readonly scope: InstallationScope;
    readonly collectionKey: string;
    readonly status?: ManagedRequestStatus;
    readonly assigneeSubject?: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly includeDeleted?: boolean;
  }): Promise<RequestPage>;
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
  ): Promise<readonly ManagedRequestActivity[]>;
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
    BusinessGrantStore,
    ManagedRequestStore {}
