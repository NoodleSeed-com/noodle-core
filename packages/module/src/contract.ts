import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AssetStore } from './asset-store.js';
import type { NamedDeploymentActivationHook } from './deployment-activation.js';
import type { DeploymentAutomationAuthorizer } from './deployment-automation.js';
import type { OrganizationProvisioningHook } from './organization-provisioning.js';
import type { PlatformHumanIdentityContribution } from './platform-human-identity.js';
import type { NamedToolDispatchHook } from './tool-dispatch.js';

export const LEGACY_MODULE_API_VERSION = 1;
export const MODULE_API_VERSION = 2;

export interface ModuleLogger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface ModuleRoute {
  readonly id: string;
  match(method: string | undefined, url: URL): boolean;
  handle(req: IncomingMessage, res: ServerResponse, ctx: ModuleRouteContext): void | Promise<void>;
}

export interface ModuleRouteContext {
  readonly logger: ModuleLogger;
  readonly controlPlane?: ControlPlaneAuthorizer;
  /** Tenant-scoped control-plane authorization; modules must call this before deployment lookup. */
  readonly tenantControl?: TenantControlAuthorizer;
  /** Narrow deployment/App Package projection for hosted package operations. */
  readonly deploymentPackages?: DeploymentPackageView;
  /** Minimal live deployment/package identity used only after an opaque delivery lookup. */
  readonly distributionDelivery?: DistributionDeliveryView;
  /** Host audit sink for route-emitted audit events; absent means the host has no audit trail. */
  readonly audit?: AuditSink;
  /** Narrow account-recovery projection; available only to the private platform identity module. */
  readonly platformIdentityRecovery?: PlatformIdentityRecovery;
}

export interface PlatformIdentityRecoveryPlan {
  readonly action: 'quarantine' | 'rollback';
  readonly apps: readonly { readonly org: string; readonly app: string }[];
  readonly archivedAt: string;
}

export interface PlatformIdentityRecoveryProjection {
  readonly deploymentId: string;
  readonly manifest: string;
  readonly serverAuth: unknown;
}

export interface PlatformIdentityRecovery {
  reconcile(plan: PlatformIdentityRecoveryPlan): void | Promise<void>;
  customerAuthRestoreProjections(
    deploymentIds: readonly string[],
  ): Promise<readonly PlatformIdentityRecoveryProjection[]>;
}

export interface ControlPlaneAuthorizer {
  authorize(req: IncomingMessage): Promise<ControlPlaneAuthResult> | ControlPlaneAuthResult;
}

export interface ControlPlaneIdentity {
  /** Server-produced provenance from the exact Google workload verifier; never request data. */
  readonly authenticationKind?: 'google-workload';
  readonly subject: string;
  readonly email: string;
  readonly superAdmin: boolean;
}

export type ControlPlaneAuthResult =
  | { readonly ok: true; readonly identity?: ControlPlaneIdentity }
  | { readonly ok: false; readonly status: 401 | 403; readonly message: string };

export type TenantControlPermission =
  | 'cloud:read'
  | 'deployments:write'
  | 'org:member'
  | 'org:manage';

export interface TenantControlAuthorizer {
  authorize(
    req: IncomingMessage,
    input: { readonly org: string; readonly permission: TenantControlPermission },
  ): Promise<TenantControlAuthResult> | TenantControlAuthResult;
}

export type TenantControlAuthResult =
  | { readonly ok: true; readonly identity: ControlPlaneIdentity }
  | { readonly ok: false; readonly status: 401 | 403; readonly message: string };

export interface DeploymentPackageView {
  get(
    req: IncomingMessage,
    input: { readonly org: string; readonly deploymentId: string },
  ): Promise<DeploymentPackageBinding | undefined>;
}

export interface DistributionDeliveryView {
  get(
    req: IncomingMessage,
    input: { readonly org: string; readonly deploymentId: string },
  ): Promise<DistributionDeliveryBinding | undefined>;
}

/** No skill, endpoint, actor, or package contents cross the anonymous delivery-check seam. */
export interface DistributionDeliveryBinding {
  readonly deploymentId: string;
  readonly appSlug: string;
  readonly environment: string;
  readonly serverVersion?: string;
  readonly active: boolean;
  readonly archivedAt?: string;
  readonly accessMode: AccessMode;
  readonly snapshotSha256: string;
}

/**
 * Safe primitives a trusted module needs to verify a host archive against one persisted App Package.
 * The host derives this only from a validated snapshot; modules never receive a registry or store handle.
 */
export interface DeploymentPackageBinding {
  readonly deploymentId: string;
  readonly appSlug: string;
  readonly environment: string;
  readonly serverVersion?: string;
  readonly active: boolean;
  readonly archivedAt?: string;
  readonly accessMode: AccessMode;
  readonly endpointUrl: string;
  readonly snapshotSha256: string;
  readonly appPackage: {
    readonly name: string;
    readonly version: string;
    readonly sourceManifestSha256: string;
    readonly mcpSurfaceSha256: string;
    readonly skillMarkdown: string;
    readonly referenceMarkdown: string;
  };
}

export type ReadinessProbe = () => boolean | Promise<boolean>;
export type ModuleDispose = () => void | Promise<void>;

export interface ModuleHostContext {
  readonly logger: ModuleLogger;
  readonly clock: () => Date;
  readonly options?: Readonly<Record<string, unknown>>;
  readonly stores?: ModuleStores;
  readonly tenants?: TenantRegistryView;
}

export interface ModuleStores {
  postgresPool?(): unknown;
}

export interface TenantRegistryView {
  getActiveDeployment(ref: TenantRouteRef): Promise<DeploymentView | undefined>;
}

export interface TenantRouteRef {
  readonly org: string;
  readonly app: string;
  readonly env: string;
  readonly serverVersion?: string;
}

export interface PublicMcpRouteRef {
  readonly mcpSubdomain: string;
  readonly app: string;
  readonly env: string;
  readonly serverVersion?: string;
}

export interface DeploymentView {
  readonly deploymentId: string;
  readonly accessMode?: AccessMode;
}

export interface ServiceModuleV1 {
  readonly name: string;
  readonly version: string;
  readonly apiVersion: typeof LEGACY_MODULE_API_VERSION;
  init(ctx: ModuleHostContext): ModuleContributionsV1 | Promise<ModuleContributionsV1>;
}

export interface ServiceModuleV2 {
  readonly name: string;
  readonly version: string;
  readonly apiVersion: typeof MODULE_API_VERSION;
  init(ctx: ModuleHostContext): ModuleContributions | Promise<ModuleContributions>;
}

export type ServiceModule = ServiceModuleV2;

export interface ModuleContributionsV1 {
  readonly routes?: readonly ModuleRoute[];
  readonly admission?: NamedAdmissionHook;
  readonly auditSinks?: readonly AuditSink[];
  readonly auditStore?: AuditStore;
  readonly policyGate?: PolicyGate;
  readonly authVerifier?: OwnerTokenVerifier;
  readonly dataPlaneAuthorizer?: DataPlaneIdentityAuthorizer;
  readonly readiness?: ReadinessProbe;
  readonly dispose?: ModuleDispose;
}

/** Verified current authority; absence must not synthesize a commercial tier. */
export interface ActivityHistoryAllowance {
  readonly maximumDays: number;
  readonly defaultDays: number;
  readonly revision: string;
  /** Read-only scenarios; this is not evidence that a plan change is selected or scheduled. */
  readonly preview?: {
    readonly asOf: string;
    readonly paidPeriodEnd: string;
    readonly scenarios: readonly {
      readonly id: string;
      readonly label: string;
      readonly maximumDays: number;
    }[];
  };
}
export type ResolveActivityHistoryAllowance = (
  org: string,
  options?: { readonly includePreview: true },
) => Promise<ActivityHistoryAllowance | undefined>;

export interface ModuleContributions extends ModuleContributionsV1 {
  readonly resolveActivityHistoryAllowance?: ResolveActivityHistoryAllowance;
  readonly assetStore?: AssetStore;
  readonly deploymentAutomation?: DeploymentAutomationAuthorizer;
  readonly platformHumanIdentity?: PlatformHumanIdentityContribution;
  readonly toolDispatch?: NamedToolDispatchHook;
  readonly deploymentActivation?: NamedDeploymentActivationHook;
  readonly organizationProvisioning?: OrganizationProvisioningHook;
}

export interface NamedAdmissionHook {
  readonly id: string;
  readonly order?: number;
  gate(context: AdmissionContext): Promise<AdmissionDecision>;
}

export type AccessMode =
  | 'owner-only'
  | 'org-members'
  | 'authenticated'
  | 'public'
  | 'mixed'
  | 'customers';

/**
 * How a caller may become an `org-members` member of a deployment's org. A deployment enables a subset;
 * absent means every source. Enforcement is symmetric, so narrowing to one source excludes the others
 * ([ADR 0183](../../../docs/decisions/0183-per-deployment-org-membership-source-narrowing.md)). A future
 * directory-group source is a new value here, not a new shape.
 */
export type OrgMembershipSource = 'explicit' | 'domain';

export interface OwnerCallerIdentity {
  readonly subject: string;
  readonly email?: string;
  readonly name?: string;
  readonly locale?: string;
  readonly timeZone?: string;
  readonly scopes?: readonly string[];
  /** Canonical roles projected from an explicitly configured verified claim. */
  readonly roles?: readonly string[];
  /** Exact transport-derived MCP resource bound to this verified request. */
  readonly audience?: string;
  /** Verified upstream token expiry, used to clamp customer bridge credentials. */
  readonly expiresAt?: number;
  /** Verified upstream authentication event time in integer Unix seconds. */
  readonly authTime?: number;
  readonly identityKind?: 'platform' | 'customer' | 'service' | 'anonymous';
  readonly identityProvider?: string;
  /** Opaque server-side Developer Access Grant binding carried by a plugin/managed-CLI token. */
  readonly developerGrantId?: string;
  /** OAuth client bound to the Developer Access Grant. */
  readonly oauthClientId?: string;
}

export interface OwnerTokenVerification {
  readonly caller: OwnerCallerIdentity;
  /** Verified customer IdP issuer, private to downstream credential binding. */
  readonly customerIssuer?: string;
  readonly customerRouting?: Readonly<Record<string, string>>;
}

export type OwnerTokenVerifier = (
  token: string,
  resource: string,
) => Promise<OwnerTokenVerification | null>;

/**
 * Why a caller was admitted, so audit can distinguish an explicit member from one inferred from an org
 * domain. New membership sources (directory groups) add a `via` value without changing this shape.
 */
export interface DataPlaneAuthorizationResult {
  readonly allowed: boolean;
  readonly via?: 'explicit' | 'domain';
}

export type DataPlaneIdentityAuthorizer = (input: {
  readonly accessMode: AccessMode;
  readonly org: string;
  readonly subject: string;
  readonly email?: string;
  readonly membershipSources?: readonly OrgMembershipSource[];
}) => Promise<DataPlaneAuthorizationResult>;

export type AdmissionCategory = 'protocol' | 'discovery' | 'read' | 'execute';

export interface AdmissionContext {
  readonly routeId: string;
  readonly requestId?: string | number | null;
  readonly method: string;
  readonly category: AdmissionCategory;
  readonly name?: string;
  readonly subject?: string;
  readonly org?: string;
  readonly app?: string;
  readonly env?: string;
  readonly serverVersion?: string;
  readonly accessMode?: AccessMode;
  readonly deploymentId?: string;
  readonly remoteAddress?: string;
}

export type AdmissionDecision =
  | { readonly allow: true; readonly reason?: string }
  | {
      readonly allow: false;
      readonly reason: string;
      readonly status?: 403 | 429;
      readonly code?: -32001 | -32002 | -32003;
      readonly policyId?: string;
      readonly policyVersion?: number;
      readonly retryAfterSeconds?: number;
      readonly resetAt?: string;
    };

export type AdmissionGate = (context: AdmissionContext) => Promise<AdmissionDecision>;

export interface PolicyContext {
  readonly toolName: string;
  readonly connectorId: string;
  readonly connectorVersion: string;
  readonly operation: string;
  readonly bindingId?: string;
  readonly connectionId?: string;
  readonly connectionConfigRevision?: string;
  readonly profile?: string;
  readonly presentation?:
    | { readonly kind: 'bearer' }
    | { readonly kind: 'apiKey'; readonly header: string };
  readonly requiredScopes?: readonly string[];
  readonly requiredAudience?: string;
  readonly tenantId?: string;
  readonly deploymentId?: string;
}

export type PolicyDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string };

export interface PolicyGate {
  before(context: PolicyContext): Promise<PolicyDecision>;
  after(context: PolicyContext, output: unknown): Promise<unknown>;
}

export type AuditDecision = 'allow' | 'deny';
export type AuditDetails = Readonly<Record<string, string | number | boolean>>;

export interface AuditEventInput {
  readonly eventType: string;
  readonly org: string;
  readonly app?: string;
  readonly env?: string;
  readonly deploymentId?: string;
  readonly actorSubject?: string;
  readonly actorEmail?: string;
  readonly decision?: AuditDecision;
  readonly status?: string | number;
  readonly reasonCode?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface AuditEvent {
  readonly id: string;
  readonly schemaVersion: number;
  readonly eventType: string;
  readonly org: string;
  readonly app?: string;
  readonly env?: string;
  readonly deploymentId?: string;
  readonly actorSubject?: string;
  readonly actorEmail?: string;
  readonly decision?: AuditDecision;
  readonly status?: string;
  readonly reasonCode?: string;
  readonly createdAt: string;
  readonly details?: AuditDetails;
}

export interface AuditFilter {
  readonly org: string;
  readonly app?: string;
  readonly env?: string;
  readonly eventType?: string;
  readonly limit?: number;
}

export interface AuditSink {
  emit(event: AuditEventInput): Promise<void>;
}

export interface AuditStore extends AuditSink {
  list(filter: AuditFilter): Promise<readonly AuditEvent[]>;
}

export const AUDIT_SCHEMA_VERSION = 1;

export const SERVER_VERSION_PATTERN = /^\d+(?:\.\d+){0,2}$/;
export const TENANT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const RESERVED_TENANT_SLUGS = new Set(['deploy', 'healthz', 'readyz', 'v1', 'o', 'mcp']);
const RESERVED_MCP_SUBDOMAINS = new Set(['local']);

/**
 * Developer-facing hosted MCP server version. The canonical form is a numeric dotted version such as
 * `1`, `2.0`, or `2.0.6`. URL path segments use `v` plus underscores for dots: `v2_0_6`.
 */
export type ServerVersion = string;

export function normalizeServerVersion(input: string): ServerVersion {
  const trimmed = input.trim();
  const withoutPrefix = trimmed.startsWith('v') ? trimmed.slice(1) : trimmed;
  const dotted = withoutPrefix.replaceAll('_', '.');
  if (!SERVER_VERSION_PATTERN.test(dotted)) {
    throw new Error(`invalid server version "${input}"; use a numeric version like 1 or 2.0.6`);
  }
  return dotted
    .split('.')
    .map((part) => String(BigInt(part)))
    .join('.');
}

export function serverVersionPathSegment(version: ServerVersion): string {
  return `v${normalizeServerVersion(version).replaceAll('.', '_')}`;
}

export function serverVersionFromPathSegment(segment: string): ServerVersion | undefined {
  if (!segment.startsWith('v')) return undefined;
  try {
    return normalizeServerVersion(segment);
  } catch {
    return undefined;
  }
}

export function compareServerVersions(a: ServerVersion, b: ServerVersion): number {
  const left = serverVersionParts(a);
  const right = serverVersionParts(b);
  for (let i = 0; i < 3; i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function formatPublicMcpUrl(publicBaseDomain: string, ref: PublicMcpRouteRef): string {
  const baseDomain = normalizePublicBaseDomain(publicBaseDomain);
  const versionPath =
    ref.serverVersion !== undefined ? `/${serverVersionPathSegment(ref.serverVersion)}` : '';
  const envPath = ref.env === 'prod' ? '' : `/env/${encodeURIComponent(ref.env)}`;
  return `https://${encodeURIComponent(ref.mcpSubdomain)}.${baseDomain}/${encodeURIComponent(ref.app)}${envPath}${versionPath}/mcp`;
}

export function formatLegacyTenantMcpPath(ref: TenantRouteRef): string {
  const versionPath =
    ref.serverVersion !== undefined ? `/${serverVersionPathSegment(ref.serverVersion)}` : '';
  return ref.env === 'prod'
    ? `/o/${encodeURIComponent(ref.org)}/${encodeURIComponent(ref.app)}${versionPath}/mcp`
    : `/o/${encodeURIComponent(ref.org)}/${encodeURIComponent(ref.app)}/${encodeURIComponent(ref.env)}${versionPath}/mcp`;
}

export function parseLegacyTenantMcpPath(pathname: string): TenantRouteRef | undefined {
  const segments = splitSafePath(pathname);
  if (segments === undefined || segments[0] !== 'o') return undefined;
  const rest = segments.slice(1);
  if (rest.length === 3 && rest[2] === 'mcp') {
    return tenantRef(rest[0], rest[1], 'prod');
  }
  if (rest.length === 4 && rest[3] === 'mcp') {
    const maybeVersion = serverVersionFromPathSegment(rest[2] as string);
    if (maybeVersion !== undefined) {
      return tenantRef(rest[0], rest[1], 'prod', maybeVersion);
    }
    if ((rest[2] as string).startsWith('v')) return undefined;
    return tenantRef(rest[0], rest[1], rest[2]);
  }
  if (rest.length === 5 && rest[4] === 'mcp') {
    const maybeVersion = serverVersionFromPathSegment(rest[3] as string);
    if (maybeVersion === undefined) return undefined;
    return tenantRef(rest[0], rest[1], rest[2], maybeVersion);
  }
  return undefined;
}

export function parsePublicMcpUrl(
  input: string,
  allowedBaseDomains: readonly string[],
): PublicMcpRouteRef | undefined {
  if (hasUnsafePathSyntax(input)) return undefined;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  const hostname = url.hostname.toLowerCase();
  const baseDomain = matchingBaseDomain(hostname, allowedBaseDomains);
  if (baseDomain === undefined) return undefined;
  const mcpSubdomain = hostname.slice(0, hostname.length - baseDomain.length - 1);
  if (mcpSubdomain.length === 0 || mcpSubdomain.includes('.') || !isMcpSubdomain(mcpSubdomain)) {
    return undefined;
  }
  if (url.search !== '' || url.hash !== '') return undefined;

  const segments = splitSafePath(url.pathname);
  if (segments === undefined) return undefined;
  if (segments.length === 2 && segments[1] === 'mcp') {
    return publicMcpRef(mcpSubdomain, segments[0], 'prod');
  }
  if (segments.length === 3 && segments[2] === 'mcp') {
    const maybeVersion = serverVersionFromPathSegment(segments[1] as string);
    if (maybeVersion === undefined) return undefined;
    return publicMcpRef(mcpSubdomain, segments[0], 'prod', maybeVersion);
  }
  if (segments.length === 4 && segments[1] === 'env' && segments[3] === 'mcp') {
    return publicMcpRef(mcpSubdomain, segments[0], segments[2]);
  }
  if (segments.length === 5 && segments[1] === 'env' && segments[4] === 'mcp') {
    const maybeVersion = serverVersionFromPathSegment(segments[3] as string);
    if (maybeVersion === undefined) return undefined;
    return publicMcpRef(mcpSubdomain, segments[0], segments[2], maybeVersion);
  }
  return undefined;
}

export function parseCanonicalPublicMcpUrl(
  input: string,
  allowedBaseDomains: readonly string[],
): PublicMcpRouteRef | undefined {
  const ref = parsePublicMcpUrl(input, allowedBaseDomains);
  if (ref === undefined) return undefined;
  return allowedBaseDomains.some((baseDomain) => formatPublicMcpUrl(baseDomain, ref) === input)
    ? ref
    : undefined;
}

export function parseCanonicalLegacyTenantMcpUrl(
  input: string,
  legacyOrigin: string,
): TenantRouteRef | undefined {
  let resource: URL;
  let origin: URL;
  try {
    resource = new URL(input);
    origin = new URL(legacyOrigin);
  } catch {
    return undefined;
  }
  if (
    origin.pathname !== '/' ||
    origin.search !== '' ||
    origin.hash !== '' ||
    resource.search !== '' ||
    resource.hash !== '' ||
    resource.origin !== origin.origin
  ) {
    return undefined;
  }
  const ref = parseLegacyTenantMcpPath(resource.pathname);
  return ref !== undefined && `${origin.origin}${formatLegacyTenantMcpPath(ref)}` === input
    ? ref
    : undefined;
}

export const OPENAI_APPS_CHALLENGE_PATH = '/.well-known/openai-apps-challenge';

export interface PublicOrgWellKnownRef {
  readonly mcpSubdomain: string;
}

export function parsePublicOrgWellKnownUrl(
  input: string,
  allowedBaseDomains: readonly string[],
  expectedPath: string,
): PublicOrgWellKnownRef | undefined {
  if (!expectedPath.startsWith('/') || hasUnsafePathSyntax(input)) return undefined;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.pathname !== expectedPath) return undefined;
  if (url.search !== '' || url.hash !== '') return undefined;
  const hostname = url.hostname.toLowerCase();
  const baseDomain = matchingBaseDomain(hostname, allowedBaseDomains);
  if (baseDomain === undefined) return undefined;
  const mcpSubdomain = hostname.slice(0, hostname.length - baseDomain.length - 1);
  if (mcpSubdomain.length === 0 || mcpSubdomain.includes('.') || !isMcpSubdomain(mcpSubdomain)) {
    return undefined;
  }
  return { mcpSubdomain };
}

export function normalizePublicBaseDomain(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new Error('public MCP base domain is required');
  const candidate = trimmed.includes('://') ? new URL(trimmed).hostname : trimmed;
  const normalized = candidate.toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}\.)+[a-z0-9-]{2,63}$/.test(normalized)) {
    throw new Error(`invalid public MCP base domain "${input}"`);
  }
  return normalized;
}

export function isTenantSlug(value: string): boolean {
  return TENANT_SLUG_PATTERN.test(value) && !RESERVED_TENANT_SLUGS.has(value);
}

function isMcpSubdomain(value: string): boolean {
  return isTenantSlug(value) && !RESERVED_MCP_SUBDOMAINS.has(value);
}

export function redactDetails(
  details: Readonly<Record<string, unknown>> | undefined,
): AuditDetails | undefined {
  if (details === undefined) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined || value === null) continue;
    out[key] = auditScalar(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Structural coercion (ADR 0031/0110): a non-scalar value becomes the `[unloggable]` marker rather
 * than ever being serialized. Key safety is the caller's allowlist; the field set IS the contract. */
function auditScalar(value: unknown): string | number | boolean {
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') {
    return value as string | number | boolean;
  }
  return '[unloggable]';
}

function serverVersionParts(version: ServerVersion): readonly number[] {
  return normalizeServerVersion(version)
    .split('.')
    .map((part) => Number(part));
}

function tenantRef(
  org: string | undefined,
  app: string | undefined,
  env: string | undefined,
  serverVersion?: string,
): TenantRouteRef | undefined {
  if (org === undefined || app === undefined || env === undefined) return undefined;
  if (!isTenantSlug(org) || !isTenantSlug(app) || !isTenantSlug(env)) return undefined;
  return {
    org,
    app,
    env,
    ...(serverVersion !== undefined ? { serverVersion } : {}),
  };
}

function publicMcpRef(
  mcpSubdomain: string | undefined,
  app: string | undefined,
  env: string | undefined,
  serverVersion?: string,
): PublicMcpRouteRef | undefined {
  if (mcpSubdomain === undefined || app === undefined || env === undefined) return undefined;
  if (!isMcpSubdomain(mcpSubdomain) || !isTenantSlug(app) || !isTenantSlug(env)) return undefined;
  return {
    mcpSubdomain,
    app,
    env,
    ...(serverVersion !== undefined ? { serverVersion } : {}),
  };
}

function splitSafePath(pathname: string): readonly string[] | undefined {
  if (!pathname.startsWith('/')) return undefined;
  const raw = pathname.split('/').slice(1);
  if (raw.length === 0 || raw.some((segment) => segment.length === 0)) return undefined;
  const decoded: string[] = [];
  for (const segment of raw) {
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      return undefined;
    }
    if (value === '.' || value === '..' || value.includes('/')) return undefined;
    decoded.push(value);
  }
  return decoded;
}

function matchingBaseDomain(
  hostname: string,
  allowedBaseDomains: readonly string[],
): string | undefined {
  for (const candidate of allowedBaseDomains) {
    let base: string;
    try {
      base = normalizePublicBaseDomain(candidate);
    } catch {
      continue;
    }
    if (hostname.endsWith(`.${base}`)) return base;
  }
  return undefined;
}

function hasUnsafePathSyntax(input: string): boolean {
  const lower = input.toLowerCase();
  return lower.includes('/..') || lower.includes('%2e') || lower.includes('%2f');
}
