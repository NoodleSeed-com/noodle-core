import { createHash } from 'node:crypto';
import type {
  DistributionLifecycle,
  DistributionTarget,
  DistributionVersion,
} from '@noodle-borg/wire-contracts';
import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken } from '../control-plane.js';
import { EXIT } from './output.js';
import { authRequired, resolveOrgTarget } from './resource-shared.js';
import { type CliFailure, printCliFailure, usageError } from './shared.js';

export const PUBLISH_USAGE =
  'noodle distributions publish <deployment-id> [server.ts] --target <openai|claude>';
export const LIST_USAGE = 'noodle distributions list <deployment-id> [--target <openai|claude>]';
export const INSPECT_USAGE = 'noodle distributions inspect <distribution-id>';
export const DOWNLOAD_USAGE =
  'noodle distributions download <distribution-id> --output <archive.zip>';

export interface CommonDistributionArgs {
  readonly org?: string;
  readonly service?: string;
  readonly authToken?: string;
  readonly json: boolean;
}

export interface DistributionHostedContext {
  readonly org: string;
  readonly serviceUrl: string;
  readonly token: string;
}

export function commonDistributionArgs(input: CommonDistributionArgs): CommonDistributionArgs {
  return {
    ...(input.org === undefined ? {} : { org: input.org }),
    ...(input.service === undefined ? {} : { service: input.service }),
    ...(input.authToken === undefined ? {} : { authToken: input.authToken }),
    json: input.json,
  };
}

export async function resolveDistributionHostedContext(
  common: CommonDistributionArgs,
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
  command: string,
): Promise<DistributionHostedContext | number> {
  const target = resolveOrgTarget(common.org, home);
  if (!target.ok) return printCliFailure(command, target.error, common.json);
  const resolved = await resolveControlPlaneToken({
    serviceFlag: common.service ?? target.serviceUrl,
    authFlag: common.authToken,
    env,
    home,
  });
  if (resolved.token === undefined) {
    return printCliFailure(command, authRequired(), common.json);
  }
  return { org: target.org, serviceUrl: resolved.serviceUrl, token: resolved.token };
}

export function distributionDeploymentUrl(
  context: DistributionHostedContext,
  deploymentId: string,
): string {
  return (
    `${context.serviceUrl}/v1/orgs/${encodeURIComponent(context.org)}` +
    `/deployments/${encodeURIComponent(deploymentId)}`
  );
}

export function distributionVersionUrl(
  context: DistributionHostedContext,
  distributionId: string,
): string {
  return (
    `${context.serviceUrl}/v1/orgs/${encodeURIComponent(context.org)}` +
    `/distributions/${encodeURIComponent(distributionId)}`
  );
}

export function deploymentDistributionEligibilityFailure(
  deployment: {
    readonly active: boolean;
    readonly archivedAt?: string | undefined;
    readonly accessMode: string;
    readonly endpointUrl?: string | undefined;
  },
  packageActive: boolean,
  target: DistributionTarget,
): CliFailure | undefined {
  if (!deployment.active || !packageActive || deployment.archivedAt !== undefined) {
    return distributionFailure(
      'distribution_deployment_inactive',
      'Only an active, unarchived deployment can be distributed.',
      'Select the active deployment or deploy the current project.',
      'noodle deployments list',
    );
  }
  if (deployment.accessMode !== 'public') {
    return distributionFailure(
      'distribution_public_access_required',
      `Hosted package storage supports only deployments with "public" (anonymous) access; this deployment uses "${deployment.accessMode}".`,
      'Keep this protected deployment and export the host package locally, or use a separate public deployment only when anonymous access is intended.',
      `noodle export plugin ${target} --help`,
    );
  }
  if (deployment.endpointUrl === undefined) {
    return distributionFailure(
      'distribution_mcp_url_unavailable',
      'The deployment does not expose an authoritative MCP URL.',
      'Wait for deployment readiness or redeploy the project.',
      'noodle status',
    );
  }
  return undefined;
}

export function distributionDownloadMatches(
  metadata: DistributionVersion,
  bytes: Uint8Array,
  headers: Headers,
): boolean {
  if (bytes.byteLength !== metadata.byteLength) return false;
  if (createHash('sha256').update(bytes).digest('hex') !== metadata.archiveSha256) return false;
  const etag = headers.get('etag');
  if (etag !== null && etag !== `"${metadata.archiveSha256}"`) return false;
  const contentLength = headers.get('content-length');
  return contentLength === null || Number(contentLength) === bytes.byteLength;
}

export function isDistributionTarget(value: string | undefined): value is DistributionTarget {
  return value === 'openai' || value === 'claude';
}

export function distributionUsageFailure(message: string, next: string, json: boolean): number {
  return printCliFailure('distributions', usageError(message, next), json);
}

export function distributionFailure(
  code: string,
  message: string,
  fix: string,
  next: string,
  exitCode: number = EXIT.FAILURE,
): CliFailure {
  return { code, message, cause: message, fix, next, exitCode };
}

export function printPublishedDistribution(version: DistributionVersion, replayed: boolean): void {
  console.log(`${replayed ? 'reused' : 'published'}: ${version.id}`);
  console.log(`target:    ${version.target}`);
  console.log(`version:   ${version.version}`);
  console.log(`sha256:    ${version.archiveSha256}`);
  console.log(
    `next:      noodle distributions download ${version.id} --output ${version.appSlug}-${version.target}.zip`,
  );
}

export function printDistributionVersions(versions: readonly DistributionVersion[]): void {
  if (versions.length === 0) {
    console.log('No distribution versions found for this deployment.');
    return;
  }
  console.log('DISTRIBUTION\tTARGET\tVERSION\tCREATED');
  for (const version of versions) {
    console.log(`${version.id}\t${version.target}\t${version.version}\t${version.createdAt}`);
  }
}

export function printDistributionVersion(
  version: DistributionVersion,
  lifecycle?: DistributionLifecycle,
): void {
  console.log(`distribution: ${version.id}`);
  console.log(`deployment:   ${version.deploymentId}`);
  console.log(`target:       ${version.target}`);
  console.log(`version:      ${version.version}`);
  console.log(`created:      ${version.createdAt}`);
  console.log(`sha256:       ${version.archiveSha256}`);
  console.log(`bytes:        ${version.byteLength}`);
  if (lifecycle !== undefined) {
    console.log(`readiness:    ${lifecycle.readiness.status}`);
    console.log(`disposition:  ${lifecycle.disposition.status}`);
    if (lifecycle.review !== undefined)
      console.log(`review:       ${lifecycle.review.reportedStatus}`);
    if (lifecycle.release !== undefined) {
      console.log(`release:      ${lifecycle.release.id}`);
      console.log(`visibility:   ${lifecycle.release.visibility}`);
    }
  }
}
