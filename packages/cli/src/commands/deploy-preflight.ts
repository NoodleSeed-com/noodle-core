import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import {
  type CompileError,
  type HostedPackagedAsset,
  manifestSchema,
  prepareLocalAssets,
} from '@noodle-borg/compiler';
import { deployPayloadLimitMessage } from '@noodle-borg/deploy-client';
import {
  DEPLOY_PREFLIGHT_CLIENT_TIMEOUT_MS,
  type DeployPreflightRequest,
  type DeployPreflightResponse,
  deployIdempotencyMaterial,
  deployPreflightResponseSchema,
} from '@noodle-borg/wire-contracts';
import { ServiceRequestError, serviceJson } from '../control-plane.js';
import { type AccessMode, type OrgMembershipSource, readDeployInput } from '../deploy.js';

export interface HostedDeployTarget {
  readonly org: string;
  readonly app: string;
  readonly env: string;
}

export interface HostedDeployPreflightInput {
  readonly manifestPath: string;
  readonly connectorsPath?: string;
  readonly serviceUrl: string;
  readonly token?: string;
  readonly target: HostedDeployTarget;
  readonly accessMode?: AccessMode;
  readonly ownerSubject?: string;
  readonly orgMembershipSources?: readonly OrgMembershipSource[];
  readonly serverVersion: string;
  readonly fetchImpl?: typeof fetch;
}

export interface HostedDeployPreflight {
  readonly response: DeployPreflightResponse;
  /** Value-free fingerprint used only to match a retry state to the same deploy input. */
  readonly fingerprint: string;
}

export class DeployPreflightInputError extends Error {
  readonly errors: readonly CompileError[];

  constructor(errors: readonly CompileError[]) {
    super(errors.map((error) => error.message).join('; '));
    this.name = 'DeployPreflightInputError';
    this.errors = errors;
  }
}

export class DeployOwnerMismatchError extends Error {
  readonly requestedOwnerSubject: string;
  readonly returnedOwnerSubject: string | undefined;

  constructor(requestedOwnerSubject: string, returnedOwnerSubject?: string) {
    super('deploy preflight did not confirm the requested owner subject');
    this.name = 'DeployOwnerMismatchError';
    this.requestedOwnerSubject = requestedOwnerSubject;
    this.returnedOwnerSubject = returnedOwnerSubject;
  }
}

/** A preflight attempt is read-only; a transport failure leaves its readiness outcome unknown. */
export class DeployPreflightRequestError extends ServiceRequestError {
  constructor(error: ServiceRequestError) {
    const code =
      error.code === 'request_timeout'
        ? 'deploy_preflight_timeout'
        : error.status === 0
          ? 'deploy_preflight_transport_failed'
          : (error.code ?? (error.status >= 500 ? 'deploy_preflight_service_failed' : undefined));
    super({
      status: error.status,
      message: error.message,
      ...(code !== undefined ? { code } : {}),
      phase: error.phase === undefined ? 'preflight' : `preflight.${error.phase}`,
      ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
      ...(error.elapsedMs !== undefined ? { elapsedMs: error.elapsedMs } : {}),
      ...(error.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : {}),
    });
  }
}

/**
 * Compile and inspect a hosted deploy without creating an app/environment, planning uploads, or
 * sending asset bytes. Hosted asset metadata is deterministic placeholder data used only so the
 * service can validate the complete compiled surface.
 */
export async function preflightHostedDeploy(
  input: HostedDeployPreflightInput,
): Promise<HostedDeployPreflight> {
  const service = input.serviceUrl.replace(/\/+$/, '');
  const authored = await readDeployInput(input.manifestPath);
  const connectors =
    input.connectorsPath !== undefined
      ? readFileSync(input.connectorsPath, 'utf8')
      : authored.connectors;
  const hostedAssets = preparePreflightAssets(authored.manifest, authored.rootDir);
  const request: DeployPreflightRequest = {
    manifest: authored.manifest,
    ...(connectors !== undefined ? { connectors } : {}),
    ...(hostedAssets.length > 0 ? { hostedAssets: [...hostedAssets] } : {}),
    accessMode: input.accessMode ?? 'owner-only',
    ...(input.ownerSubject !== undefined ? { ownerSubject: input.ownerSubject } : {}),
    ...(input.orgMembershipSources !== undefined
      ? { orgMembershipSources: [...input.orgMembershipSources] }
      : {}),
    serverVersion: input.serverVersion,
    deploymentSource: 'cli',
  };
  const requestBody = JSON.stringify(request);
  const sizeError = deployPayloadLimitMessage(requestBody, authored.manifest);
  if (sizeError !== undefined) {
    throw new ServiceRequestError({
      status: 413,
      code: 'deploy_payload_too_large',
      phase: 'preflight.validation',
      message: `Local preflight: ${sizeError}`,
    });
  }
  // Gzipped like the deploy call: real manifests carry multi-megabyte inline widget bundles,
  // and the fingerprint below stays on the uncompressed bytes so resume matching is unchanged.
  const raw = await serviceJson<unknown>(
    `${service}/v1/orgs/${encodeURIComponent(input.target.org)}` +
      `/apps/${encodeURIComponent(input.target.app)}` +
      `/envs/${encodeURIComponent(input.target.env)}/deploy/preflight`,
    input.token,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'x-request-id': randomUUID(),
      },
      body: gzipSync(requestBody),
    },
    input.fetchImpl,
    { timeoutMs: DEPLOY_PREFLIGHT_CLIENT_TIMEOUT_MS },
  ).catch((error: unknown) => {
    if (error instanceof ServiceRequestError) throw new DeployPreflightRequestError(error);
    throw error;
  });
  const response = deployPreflightResponseSchema.parse(raw);
  if (
    response.target.org !== input.target.org ||
    response.target.app !== input.target.app ||
    response.target.env !== input.target.env
  )
    throw new Error('deploy preflight returned a different target');
  if (input.ownerSubject !== undefined && response.ownerSubject !== input.ownerSubject) {
    throw new DeployOwnerMismatchError(input.ownerSubject, response.ownerSubject);
  }
  if (
    response.ready &&
    (!response.config.ready ||
      response.errors.length > 0 ||
      response.config.missingSecrets.length > 0 ||
      response.config.missingVariables.length > 0)
  ) {
    throw new Error('deploy preflight returned inconsistent readiness');
  }
  const fingerprint = createHash('sha256')
    .update(deployIdempotencyMaterial(input.target, requestBody))
    .digest('hex');
  return { response, fingerprint };
}

function preparePreflightAssets(manifest: string, rootDir: string): readonly HostedPackagedAsset[] {
  let raw: unknown;
  try {
    raw = JSON.parse(manifest) as unknown;
  } catch {
    return [];
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) return [];
  const prepared = prepareLocalAssets(parsed.data, { rootDir });
  if (prepared.errors.length > 0) throw new DeployPreflightInputError(prepared.errors);
  return prepared.assets.map(({ absolutePath: _absolutePath, ...asset }) => ({
    ...asset,
    publicUrl:
      `https://deploy-preflight.invalid/__noodle/deploy-preflight/${encodeURIComponent(asset.logicalId)}/` +
      encodeURIComponent(asset.sourcePath),
    objectKey: `deploy-preflight/${asset.contentHash}/${asset.logicalId}`,
  }));
}
