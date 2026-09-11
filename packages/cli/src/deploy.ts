import { readFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import type { DistributionMetadataV1 } from '@noodle-borg/authoring';
import {
  type AuthoredEntrypoint,
  loadAuthoredModule,
  loadAuthoredTypeScriptEntry,
  prepareAuthoringRuntimeDir,
} from '@noodle-borg/authoring/load-authored';
import {
  type HostedPackagedAsset,
  manifestSchema,
  prepareLocalAssets,
} from '@noodle-borg/compiler';
import {
  type AccessMode,
  type AssetUploadTarget,
  assetPreflightResponseSchema,
  type DeploymentAuthentication,
  deployErrorResponseSchema,
  deploySuccessResponseSchema,
  type OrgMembershipSource,
} from '@noodle-borg/wire-contracts';

export type { OrgMembershipSource } from '@noodle-borg/wire-contracts';

import {
  deployPayloadLimitMessage,
  inferDeployVersionFromPath,
  KnowledgeDeployError,
  normalizeDeployVersion,
  prepareKnowledgeDocumentsForDeploy,
  rewriteManifestKnowledgeHashes,
} from '@noodle-borg/deploy-client';
import { parse as parseYaml } from 'yaml';
import { requireMixedCustomerAuth, ServiceRequestError } from './control-plane-request.js';
import { delegatedTokenExchangeDeployErrors } from './delegated-token-exchange-preflight.js';
import { buildReactWidgetViews } from './react-widget-build.js';
import { assertCliSdkCompatibility } from './sdk-version-skew.js';

export const DEFAULT_SERVICE_URL = 'https://cloud.noodleseed.dev';

export interface DeployOptions {
  readonly manifestPath: string;
  /** Optional declarative connector-catalog file, so deployed tools can call APIs. */
  readonly connectorsPath?: string;
  readonly serviceUrl?: string;
  /** Control-plane bearer token for hosted management endpoints (`Authorization: Bearer <token>`). */
  readonly authToken?: string;
  readonly org?: string;
  readonly app?: string;
  readonly env?: string;
  /**
   * Access mode for the deployed endpoint. Defaults to `owner-only`; use `org-members` to share with the
   * deployment org, `authenticated` for signed-in platform apps, or `customers` for the tenant IdP declared
   * by `server.auth`.
   */
  readonly accessMode?: AccessMode;
  /** Exact OAuth subject to bind when `accessMode` is `owner-only`. */
  readonly ownerSubject?: string;
  /**
   * For `org-members`: which membership sources admit callers. Absent means every source, so an org
   * domain admits everyone at that domain. Narrow it to keep one sensitive app on the explicit member
   * list (ADR 0183).
   */
  readonly orgMembershipSources?: readonly OrgMembershipSource[];
  /** Developer-facing hosted MCP server version. Defaults to an inferred path version, then `1`. */
  readonly serverVersion?: string;
  /** Retry key owned by the command-level deploy operation; omitted for ordinary programmatic calls. */
  readonly idempotencyKey?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Human-facing summary of the packaged-asset work a deploy performed. `checked` is every referenced
 * asset; `uploaded` were newly pushed to object storage; `reused` were already present (content-hash
 * match); `uploadedBytes` is the total bytes uploaded this deploy. All zero when an app packages no
 * assets, so callers can render a stable "none packaged" line.
 */
export interface AssetDeploySummary {
  readonly checked: number;
  readonly uploaded: number;
  readonly reused: number;
  readonly uploadedBytes: number;
}

export type DeployOutcome =
  | {
      readonly ok: true;
      readonly deploymentId: string;
      readonly serverVersion: string;
      readonly url: string;
      readonly defaultUrl: string;
      readonly accessMode: AccessMode;
      readonly authentication?: DeploymentAuthentication;
      readonly ownerSubject?: string;
      readonly assets: AssetDeploySummary;
      /**
       * The non-secret id a public website surface is embedded by (ADR 0201). Present only when the
       * deployed app declares a public or mixed surface, so its absence is the normal case.
       */
      readonly embedId?: string;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly message: string;
      readonly code?: string;
      readonly errors?: unknown;
      /** Which packaged-asset step failed, when the failure is asset-specific (HTTP 422). */
      readonly stage?: AssetDeployStage;
    };

/** Which packaged-asset step a deploy failed at, so the CLI can give a stage-specific repair hint. */
export type AssetDeployStage = 'validate' | 'preflight' | 'upload';

/** HTTP-like status the CLI assigns to packaged-asset failures, distinct from a generic deploy 400. */
const ASSET_FAILURE_STATUS = 422;

/**
 * A packaged-asset failure with a stable stage. `validate` = local file/MIME/size/path problems caught
 * before upload; `preflight` = the service rejected the upload plan (quota, hosting policy); `upload` =
 * an object store rejected the bytes (checksum, size, expired target). The message is already
 * author-facing and project-relative — it never carries a local absolute path.
 */
class AssetDeployError extends Error {
  readonly stage: AssetDeployStage;
  constructor(stage: AssetDeployStage, message: string) {
    super(message);
    this.name = 'AssetDeployError';
    this.stage = stage;
  }
}

/**
 * Read a manifest file and POST it to a deploy service. Returns the deployed server's id + endpoint URL,
 * or a structured failure (unreachable service, or a `4xx` with compile errors).
 */
export async function deploy(options: DeployOptions): Promise<DeployOutcome> {
  const service = (options.serviceUrl ?? DEFAULT_SERVICE_URL).replace(/\/+$/, '');
  const org = slug(options.org ?? 'local');
  const app = slug(options.app ?? basename(options.manifestPath, extname(options.manifestPath)));
  const env = slug(options.env ?? 'prod');
  const accessMode = options.accessMode ?? 'owner-only';
  const serverVersion = normalizeDeployVersion(
    options.serverVersion ?? inferDeployVersionFromPath(options.manifestPath) ?? '1',
  );
  const doFetch = options.fetchImpl ?? fetch;

  let manifest: string;
  let connectors: string | undefined;
  let hostedAssets: readonly HostedPackagedAsset[] | undefined;
  let assetSummary: AssetDeploySummary = EMPTY_ASSET_SUMMARY;
  try {
    const input = await readDeployInput(options.manifestPath);
    manifest = input.manifest;
    // Author-side mirror of the service rule in packages/service/src/registry.ts (same code,
    // path, and message), surfaced before any network call instead of as an opaque HTTP 400.
    if (accessMode === 'customers' && !manifestDeclaresServerAuth(manifest)) {
      const message = 'customers access mode requires server.auth';
      return {
        ok: false,
        status: 0,
        message,
        errors: [{ code: 'server_auth_required', path: 'server.auth', message }],
      };
    }
    // Author-side mirror of the service rule (same code, path, and message), so a misconfigured
    // noodle.json fails before any network call instead of as an opaque HTTP 400.
    if (options.orgMembershipSources !== undefined && accessMode !== 'org-members') {
      const message = 'orgMembershipSources requires the org-members access mode';
      return {
        ok: false,
        status: 0,
        message,
        errors: [
          {
            code: 'membership_sources_requires_org_members',
            path: 'orgMembershipSources',
            message,
          },
        ],
      };
    }
    // An explicit --connectors file overrides any catalog an authored server emits.
    if (options.connectorsPath !== undefined) {
      connectors = readFileSync(options.connectorsPath, 'utf8');
    } else if (input.connectors !== undefined) {
      connectors = input.connectors;
    }
    const identityErrors = delegatedTokenExchangeDeployErrors({
      manifest,
      connectors,
      rootDir: input.rootDir,
    });
    if (identityErrors.length > 0) {
      return {
        ok: false,
        status: 0,
        message:
          identityErrors[0]?.message ?? 'delegated token exchange requires customer identity',
        errors: identityErrors,
      };
    }
    if (accessMode === 'mixed' && manifestDeclaresServerAuth(manifest)) {
      await requireMixedCustomerAuth(service, options.authToken, doFetch);
    }
    const prepared = await prepareHostedAssetsForDeploy({
      manifest,
      rootDir: input.rootDir,
      service,
      org,
      app,
      env,
      ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
      fetchImpl: doFetch,
    });
    hostedAssets = prepared.assets;
    assetSummary = prepared.summary;
    await prepareKnowledgeDocumentsForDeploy({
      manifest,
      rootDir: input.rootDir,
      service,
      org,
      app,
      env,
      ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
      fetchImpl: doFetch,
    });
  } catch (error) {
    if (error instanceof ServiceRequestError) {
      return {
        ok: false,
        status: error.status,
        message: error.message,
        ...(error.code === undefined ? {} : { code: error.code }),
      };
    }
    if (error instanceof AssetDeployError) {
      return {
        ok: false,
        status: ASSET_FAILURE_STATUS,
        message: error.message,
        stage: error.stage,
      };
    }
    if (error instanceof KnowledgeDeployError) {
      return {
        ok: false,
        status: ASSET_FAILURE_STATUS,
        message: error.message,
        stage: error.stage,
      };
    }
    return { ok: false, status: 0, message: `cannot read input file: ${(error as Error).message}` };
  }

  let res: Response;
  const deployBody = JSON.stringify({
    manifest,
    ...(connectors !== undefined ? { connectors } : {}),
    ...(hostedAssets !== undefined && hostedAssets.length > 0 ? { hostedAssets } : {}),
    accessMode,
    ...(options.ownerSubject !== undefined ? { ownerSubject: options.ownerSubject } : {}),
    ...(options.orgMembershipSources !== undefined
      ? { orgMembershipSources: options.orgMembershipSources }
      : {}),
    serverVersion,
    deploymentSource: 'cli',
  });
  const payloadLimitMessage = deployPayloadLimitMessage(deployBody, manifest);
  if (payloadLimitMessage !== undefined) {
    return { ok: false, status: 413, message: payloadLimitMessage };
  }
  try {
    const compressedDeployBody = gzipSync(deployBody);
    res = await doFetch(`${service}/v1/orgs/${org}/apps/${app}/envs/${env}/deploy`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        ...(options.idempotencyKey !== undefined
          ? { 'idempotency-key': options.idempotencyKey }
          : {}),
        ...(options.authToken ? { authorization: `Bearer ${options.authToken}` } : {}),
      },
      body: compressedDeployBody,
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      message: `could not reach the deploy service at ${service}: ${(error as Error).message}`,
    };
  }

  const rawBody: unknown = await res.json().catch(() => ({}));

  if (res.status === 201) {
    const success = deploySuccessResponseSchema.safeParse(rawBody);
    if (success.success) {
      return {
        ok: true,
        deploymentId: success.data.deploymentId,
        serverVersion: success.data.serverVersion,
        url: success.data.url,
        defaultUrl: success.data.defaultUrl,
        accessMode: success.data.accessMode,
        ...(success.data.authentication === undefined
          ? {}
          : { authentication: success.data.authentication }),
        ...(success.data.ownerSubject !== undefined
          ? { ownerSubject: success.data.ownerSubject }
          : {}),
        assets: assetSummary,
        ...(success.data.embedId !== undefined ? { embedId: success.data.embedId } : {}),
      };
    }
    return {
      ok: false,
      status: res.status,
      message: 'deploy succeeded but the service response did not match the v1 wire contract',
    };
  }
  const failure = deployErrorResponseSchema.safeParse(rawBody);
  const errorMessage = failure.success ? failure.data.error : undefined;
  if (res.status === 401) {
    return {
      ok: false,
      status: 401,
      message:
        errorMessage !== undefined && errorMessage !== 'unauthorized'
          ? errorMessage
          : 'deploy unauthorized — set --auth-token or NOODLE_AUTH_TOKEN',
    };
  }
  return {
    ok: false,
    status: res.status,
    message: errorMessage ?? `deploy failed (HTTP ${res.status})`,
    ...(failure.success && failure.data.code !== undefined ? { code: failure.data.code } : {}),
    ...(failure.success && failure.data.errors !== undefined
      ? { errors: failure.data.errors }
      : {}),
  };
}

// The canonical access-mode set lives in the deploy-lane wire contract (ADR 0055 / ADR 0150).
export type { AccessMode } from '@noodle-borg/wire-contracts';

/**
 * Whether the authored manifest declares `server.auth`. Parsing failures fall through to the
 * service, which owns full manifest validation — this preflight only mirrors one rule.
 */
export function manifestDeclaresServerAuth(manifest: string): boolean {
  try {
    const parsed = parseYaml(manifest) as { server?: { auth?: unknown } } | undefined;
    return parsed?.server?.auth !== undefined;
  } catch {
    return true;
  }
}

/** Canonical app-slug normalizer shared by deploy, project scaffolding, dev, and local targets. */
export function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'app'
  );
}

/**
 * Read a public developer deploy input into `{ manifest, connectors? }`. App authors use TypeScript/JS
 * modules that export a Noodle server definition; manifests, connector catalogs, and runtime artifacts are
 * internal system data used after this boundary.
 *
 * Exported so `validate` reuses the exact same input-loading path as `deploy`, keeping author-time
 * validation faithful to what a deploy would compile.
 */
export async function readDeployInput(inputPath: string): Promise<{
  manifest: string;
  connectors?: string;
  distribution?: DistributionMetadataV1;
  rootDir: string;
}> {
  // Resolve to an absolute path up front: a relative entrypoint leaves `rootDir` relative, which then
  // breaks `createRequire(join(rootDir, 'package.json'))` in the React widget build ("filename must be
  // an absolute path"). Every command (validate/dev/devtools/deploy) reads its entrypoint through here.
  const path = resolve(inputPath);
  assertCliSdkCompatibility(path);
  const ext = extname(path);
  const rootDir = dirname(path);
  let authored: AuthoredEntrypoint;
  if (ext === '.ts' || ext === '.mts') {
    authored = await loadAuthoredTypeScriptEntry(path, { sdkModulesDir: packageNodeModules() });
  } else if (ext === '.js' || ext === '.mjs') {
    prepareAuthoringRuntimeDir(rootDir, { sdkModulesDir: packageNodeModules() });
    authored = await loadAuthoredModule(path);
  } else {
    throw new Error(
      'public app authoring uses TypeScript: pass a server.ts entrypoint exported from @noodleseed/one',
    );
  }
  return {
    ...authored,
    // The authored manifest carries knowledge documents as bare path descriptors; hashing needs
    // the project files, so it happens here — the shared boundary every command (validate/dev/
    // deploy) reads through — or the service preflight rejects the deploy as `knowledge_unhashed`.
    manifest: rewriteManifestKnowledgeHashes({
      manifest: await buildReactWidgetViews(authored.manifest, { rootDir }),
      rootDir,
    }),
    rootDir,
  };
}

const EMPTY_ASSET_SUMMARY: AssetDeploySummary = {
  checked: 0,
  uploaded: 0,
  reused: 0,
  uploadedBytes: 0,
};

interface PreparedHostedAssets {
  readonly assets?: readonly HostedPackagedAsset[];
  readonly summary: AssetDeploySummary;
}

async function prepareHostedAssetsForDeploy(input: {
  readonly manifest: string;
  readonly rootDir: string;
  readonly service: string;
  readonly org: string;
  readonly app: string;
  readonly env: string;
  readonly authToken?: string;
  readonly fetchImpl: typeof fetch;
}): Promise<PreparedHostedAssets> {
  let raw: unknown;
  try {
    raw = JSON.parse(input.manifest) as unknown;
  } catch {
    return { summary: EMPTY_ASSET_SUMMARY };
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) return { summary: EMPTY_ASSET_SUMMARY };
  const prepared = prepareLocalAssets(parsed.data, { rootDir: input.rootDir });
  if (prepared.errors.length > 0) {
    throw new AssetDeployError('validate', prepared.errors.map((e) => e.message).join('; '));
  }
  if (prepared.assets.length === 0) return { summary: EMPTY_ASSET_SUMMARY };

  const preflightUrl = `${input.service}/v1/orgs/${input.org}/apps/${input.app}/envs/${input.env}/assets/preflight`;
  const preflightBody = JSON.stringify({
    assets: prepared.assets.map(({ absolutePath: _absolutePath, ...asset }) => asset),
  });
  const runPreflight = async (): Promise<{
    assets: readonly HostedPackagedAsset[];
    uploads: readonly AssetUploadTarget[];
  }> => {
    const response = await input.fetchImpl(preflightUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(input.authToken ? { authorization: `Bearer ${input.authToken}` } : {}),
      },
      body: preflightBody,
    });
    const raw: unknown = await response.json().catch(() => ({}));
    const parsed = assetPreflightResponseSchema.safeParse(raw);
    if (response.status !== 200 || !parsed.success) {
      const failure = deployErrorResponseSchema.safeParse(raw);
      throw new AssetDeployError(
        'preflight',
        (failure.success ? failure.data.error : undefined) ??
          `asset preflight failed (HTTP ${response.status})`,
      );
    }
    return { assets: parsed.data.assets, uploads: parsed.data.uploads };
  };

  // Upload each missing object to its signed target. Upload URLs are short-lived; if one has expired
  // (proactively by its `expiresAt`, or reactively when the store rejects it with 410/403), re-preflight
  // once to refresh the remaining targets and continue. Re-preflight naturally returns only the still-
  // missing objects, so already-uploaded assets are not re-sent.
  let plan = await runPreflight();
  let remaining = [...plan.uploads];
  let refreshed = false;
  let uploaded = 0;
  let uploadedBytes = 0;
  while (remaining.length > 0) {
    const target = remaining[0] as AssetUploadTarget;
    if (!refreshed && isUploadTargetExpired(target.expiresAt)) {
      plan = await runPreflight();
      remaining = [...plan.uploads];
      refreshed = true;
      continue;
    }
    const asset = prepared.assets.find((candidate) => candidate.logicalId === target.logicalId);
    if (asset === undefined)
      throw new Error(`asset upload plan referenced unknown asset ${target.logicalId}`);
    const response = await input.fetchImpl(target.uploadUrl, {
      method: target.method,
      headers: target.headers,
      body: readFileSync(asset.absolutePath),
    });
    if (!refreshed && isUploadExpiryStatus(response.status)) {
      plan = await runPreflight();
      remaining = [...plan.uploads];
      refreshed = true;
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      const errorBody = (await response.json().catch(() => ({}))) as { error?: string };
      throw new AssetDeployError(
        'upload',
        errorBody.error ?? `asset upload failed (HTTP ${response.status})`,
      );
    }
    uploaded += 1;
    uploadedBytes += asset.byteLength;
    remaining = remaining.slice(1);
  }
  return {
    assets: plan.assets,
    summary: {
      checked: prepared.assets.length,
      uploaded,
      reused: prepared.assets.length - uploaded,
      uploadedBytes,
    },
  };
}

/** Tolerance for clock skew + upload duration: treat a target within this window of expiry as stale. */
const UPLOAD_EXPIRY_SKEW_MS = 5_000;

function isUploadTargetExpired(expiresAt: string | undefined): boolean {
  if (expiresAt === undefined) return false;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return false;
  return at - Date.now() <= UPLOAD_EXPIRY_SKEW_MS;
}

/** Object stores signal an expired signed upload with 410 (in-memory fake) or 403 (GCS). */
function isUploadExpiryStatus(status: number): boolean {
  return status === 410 || status === 403;
}

function packageNodeModules(): string {
  return join(packageRoot(), 'node_modules');
}

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}
