import type { DeployError } from './registry-types.js';
import type {
  AppRestorePrecondition,
  ArtifactStore,
  DeployRecord,
  TenantAuthConfig,
  TenantRef,
} from './store.js';

interface CustomerAuthAudienceBinding {
  readonly issuer: string;
  readonly audience: string;
}

/** Safe lifecycle error; tenant identities and configured values never enter its public message. */
export class CustomerAuthAudienceConflictError extends Error {
  readonly code = 'customer_auth_audience_conflict';

  constructor() {
    super('Customer OIDC issuer/audience bindings must be unique to one app and environment.');
    this.name = 'CustomerAuthAudienceConflictError';
  }
}

/** Internal fail-closed signal for a missing or malformed denormalized auth projection. */
export class CustomerAuthAudienceProjectionError extends CustomerAuthAudienceConflictError {
  constructor() {
    super();
    this.name = 'CustomerAuthAudienceProjectionError';
  }
}

/** Translate database-trigger failures without retaining PostgreSQL details or configured values. */
export function translateCustomerAuthAudienceDatabaseError(error: unknown): unknown {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
  if (code === 'NDA01') return new CustomerAuthAudienceConflictError();
  if (code === 'NDA02') return new CustomerAuthAudienceProjectionError();
  return error;
}

/** Runtime guard shared by persistence adapters that read untrusted legacy JSON/JSONB records. */
export function isTenantAuthConfig(value: unknown): value is TenantAuthConfig {
  if (typeof value !== 'object' || value === null) return false;
  const auth = value as {
    readonly kind?: unknown;
    readonly issuer?: unknown;
    readonly audience?: unknown;
    readonly provider?: unknown;
    readonly issuers?: unknown;
  };
  if (auth.kind === 'bridge') {
    return typeof auth.provider === 'string' && auth.provider.trim().length > 0;
  }
  if (auth.kind === 'federatedOidc') {
    return (
      Array.isArray(auth.issuers) &&
      auth.issuers.length > 0 &&
      auth.issuers.every(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as { readonly issuer?: unknown }).issuer === 'string' &&
          (entry as { readonly issuer: string }).issuer.trim().length > 0 &&
          typeof (entry as { readonly audience?: unknown }).audience === 'string' &&
          (entry as { readonly audience: string }).audience.trim().length > 0,
      )
    );
  }
  if (auth.kind !== undefined && auth.kind !== 'oidc') return false;
  return (
    typeof auth.issuer === 'string' &&
    auth.issuer.trim().length > 0 &&
    typeof auth.audience === 'string' &&
    auth.audience.trim().length > 0
  );
}

/** Customer-serving records must exactly project the compiler-authoritative auth declaration. */
export function hasExactCustomerAuthProjection(
  record: DeployRecord,
  compiledAuth: TenantAuthConfig | undefined,
): boolean {
  if (record.accessMode !== 'customers') return true;
  if (compiledAuth === undefined || !isTenantAuthConfig(record.serverAuth)) return false;
  try {
    return (
      JSON.stringify(canonicalJson(record.serverAuth)) ===
      JSON.stringify(canonicalJson(compiledAuth))
    );
  } catch {
    return false;
  }
}

/** Require an exact compiler-authenticated snapshot before clearing customer app archive stamps. */
export function assertCustomerAuthRestorePrecondition(
  records: readonly DeployRecord[],
  precondition: AppRestorePrecondition | undefined,
): void {
  const candidates = records.filter((record) => record.active && record.accessMode === 'customers');
  const projections = precondition?.customerAuthProjections ?? [];
  if (candidates.length !== projections.length) {
    throw new CustomerAuthAudienceProjectionError();
  }
  const byDeployment = new Map(
    projections.map((projection) => [projection.deploymentId, projection]),
  );
  if (byDeployment.size !== projections.length) {
    throw new CustomerAuthAudienceProjectionError();
  }
  for (const record of candidates) {
    const projection = byDeployment.get(record.deploymentId);
    if (
      projection === undefined ||
      projection.manifest !== record.manifest ||
      !isTenantAuthConfig(projection.serverAuth) ||
      !hasExactCustomerAuthProjection(record, projection.serverAuth)
    ) {
      throw new CustomerAuthAudienceProjectionError();
    }
  }
}

/** The signed issuer/audience pairs that identify one customer OIDC app/environment boundary. */
export function customerAuthAudienceBindings(
  auth: TenantAuthConfig,
): readonly CustomerAuthAudienceBinding[] {
  if (auth.kind === 'bridge') return [];
  const configured = auth.kind === 'federatedOidc' ? auth.issuers : [auth];
  const unique = new Map<string, CustomerAuthAudienceBinding>();
  for (const entry of configured) {
    const binding = {
      issuer: entry.issuer.replace(/\/+$/u, ''),
      audience: entry.audience,
    };
    unique.set(JSON.stringify([binding.issuer, binding.audience]), binding);
  }
  return [...unique.values()];
}

/** Find another active app/environment that owns any issuer/audience pair in `auth`. */
export function findActiveCustomerAuthAudienceConflict(
  records: readonly DeployRecord[],
  tenant: TenantRef,
  auth: TenantAuthConfig,
): TenantRef | undefined {
  const candidateKeys = new Set(
    customerAuthAudienceBindings(auth).map((binding) =>
      JSON.stringify([binding.issuer, binding.audience]),
    ),
  );
  if (candidateKeys.size === 0) return undefined;
  for (const record of records) {
    if (
      !record.active ||
      record.archivedAt !== undefined ||
      record.accessMode !== 'customers' ||
      sameTenant(record, tenant)
    ) {
      continue;
    }
    if (!isTenantAuthConfig(record.serverAuth)) continue;
    const overlaps = customerAuthAudienceBindings(record.serverAuth).some((binding) =>
      candidateKeys.has(JSON.stringify([binding.issuer, binding.audience])),
    );
    if (overlaps) {
      return { org: record.orgSlug, app: record.appSlug, env: record.environment };
    }
  }
  return undefined;
}

/** Assert global ownership after applying one proposed atomic lifecycle mutation. */
export function assertUniqueActiveCustomerAuthAudienceBindings(
  records: readonly DeployRecord[],
): void {
  const owners = new Map<string, string>();
  for (const record of records) {
    if (!record.active || record.archivedAt !== undefined || record.accessMode !== 'customers') {
      continue;
    }
    if (!isTenantAuthConfig(record.serverAuth)) {
      throw new CustomerAuthAudienceProjectionError();
    }
    const owner = `${record.orgSlug}/${record.appSlug}/${record.environment}`;
    for (const binding of customerAuthAudienceBindings(record.serverAuth)) {
      const key = JSON.stringify([binding.issuer, binding.audience]);
      const existing = owners.get(key);
      if (existing !== undefined && existing !== owner) {
        throw new CustomerAuthAudienceConflictError();
      }
      owners.set(key, owner);
    }
  }
}

/** Shared registry guard with an optimized durable-store path and an in-memory fallback. */
export async function hasActiveCustomerAuthAudienceConflict(
  store: ArtifactStore | undefined,
  records: ReadonlyMap<string, DeployRecord>,
  record: DeployRecord,
  auth: TenantAuthConfig | undefined,
): Promise<boolean> {
  if (record.accessMode !== 'customers' || auth === undefined || auth.kind === 'bridge')
    return false;
  const tenant = { org: record.orgSlug, app: record.appSlug, env: record.environment };
  const conflict =
    store?.findActiveCustomerAuthAudienceConflict !== undefined
      ? await store.findActiveCustomerAuthAudienceConflict(tenant, auth)
      : findActiveCustomerAuthAudienceConflict(
          store === undefined ? [...records.values()] : await store.loadAll(),
          tenant,
          auth,
        );
  return conflict !== undefined;
}

export function customerAuthAudienceConflictFailure(): {
  readonly ok: false;
  readonly errors: readonly DeployError[];
} {
  return {
    ok: false,
    errors: [
      {
        code: 'customer_auth_audience_conflict',
        path: 'server.auth.audience',
        message:
          'Customer OIDC issuer/audience bindings must be unique to one app and environment.',
      },
    ],
  };
}

function sameTenant(record: DeployRecord, tenant: TenantRef): boolean {
  return (
    record.orgSlug === tenant.org &&
    record.appSlug === tenant.app &&
    record.environment === tenant.env
  );
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value !== 'object' || value === null) return value;
  const normalized: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value).sort()) {
    normalized[key] = canonicalJson((value as Record<string, unknown>)[key]);
  }
  return normalized;
}
