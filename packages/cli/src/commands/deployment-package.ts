import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, ServiceRequestError, serviceJson } from '../control-plane.js';
import { EXIT, printJsonOk } from './output.js';
import {
  authRequired,
  type DeploymentPackageData,
  type DeploymentPackageResponse,
  notFoundDeployment,
  parseResourceArgs,
  resolveOrgTarget,
} from './resource-shared.js';
import {
  type CliFailure,
  printCliFailure,
  printCommandUsageFailure,
  serviceFailure,
} from './shared.js';

const DEPLOYMENT_PACKAGE_USAGE =
  'noodle deployments package <deployment-id> [--org <org>] [--service <url>] [--auth-token <token>] [--json]';
const PACKAGE_VALUE_FLAGS = new Set(['--org', '--service', '--auth-token']);

function packageGrammar(rest: readonly string[]): 'valid' | 'missing-id' | 'invalid' {
  const seen = new Set<string>();
  let positionalCount = 0;
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index];
    if (argument === undefined) continue;
    if (argument === '--json') {
      if (seen.has(argument)) return 'invalid';
      seen.add(argument);
      continue;
    }
    if (PACKAGE_VALUE_FLAGS.has(argument)) {
      if (seen.has(argument)) return 'invalid';
      seen.add(argument);
      const value = rest[++index];
      if (value === undefined || value.length === 0 || value.startsWith('-')) return 'invalid';
      continue;
    }
    if (argument.startsWith('-')) return 'invalid';
    positionalCount++;
  }
  if (positionalCount === 0) return 'missing-id';
  return positionalCount === 1 ? 'valid' : 'invalid';
}

function invalidPackageArguments(json: boolean): number {
  return printCliFailure(
    'deployments package',
    {
      code: 'usage_error',
      message: 'invalid noodle deployments package arguments',
      cause: 'The command accepts exactly one deployment id and only its documented flags.',
      fix: 'Remove extra arguments and unsupported flags.',
      next: DEPLOYMENT_PACKAGE_USAGE,
      exitCode: EXIT.USAGE,
    },
    json,
  );
}

export async function runDeploymentPackage(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const grammar = packageGrammar(rest);
  const json = rest.includes('--json');
  if (grammar === 'invalid') return invalidPackageArguments(json);
  const { common, positional } = parseResourceArgs(rest);
  const deploymentId = positional[0];
  if (grammar === 'missing-id' || deploymentId === undefined) {
    return printCommandUsageFailure(
      'deployments',
      'noodle deployments package requires a deployment id',
      DEPLOYMENT_PACKAGE_USAGE,
      common.json,
    );
  }
  const target = resolveOrgTarget(common.org, home);
  if (!target.ok) return printCliFailure('deployments package', target.error, common.json);
  const resolved = await resolveControlPlaneToken({
    serviceFlag: common.service ?? target.serviceUrl,
    authFlag: common.authToken,
    env,
    home,
  });
  if (resolved.token === undefined) {
    return printCliFailure('deployments package', authRequired(), common.json);
  }

  try {
    const url =
      `${resolved.serviceUrl}/v1/orgs/${encodeURIComponent(target.org)}` +
      `/deployments/${encodeURIComponent(deploymentId)}/package`;
    const body = await serviceJson<DeploymentPackageResponse>(url, resolved.token);
    if (common.json) printJsonOk(body.data);
    else printDeploymentPackage(target.org, body.data);
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      'deployments package',
      packageFailure(error, target.org, deploymentId),
      common.json,
    );
  }
}

function packageFailure(error: unknown, org: string, deploymentId: string): CliFailure {
  if (error instanceof ServiceRequestError) {
    if (error.status === 401) return authRequired();
    if (error.status === 404) return notFoundDeployment(org, deploymentId);
    if (error.status === 409 && error.code === 'package_unavailable') {
      return {
        code: 'package_unavailable',
        message: 'Deployment package is unavailable.',
        cause: 'This deployment does not have a valid stored package snapshot.',
        fix: 'Redeploy the app to create a new immutable package snapshot.',
        next: 'noodle deploy',
        exitCode: EXIT.FAILURE,
      };
    }
  }
  return serviceFailure('deployments package', error, 'noodle deployments list');
}

function printDeploymentPackage(org: string, data: DeploymentPackageData): void {
  const { artifact } = data.snapshot;
  const status =
    data.archivedAt !== undefined
      ? `archived ${data.archivedAt}`
      : data.active
        ? 'active'
        : 'inactive';
  console.log(`deployment: ${data.deploymentId}`);
  console.log(`org:        ${org}`);
  console.log(`app:        ${data.appSlug}`);
  console.log(`env:        ${data.environment}`);
  console.log(`status:     ${status}`);
  console.log(`version:    ${data.serverVersion ?? '-'}`);
  console.log(
    `package:    ${artifact.app.name} (${artifact.app.version}, schema ${artifact.schemaVersion})`,
  );
  console.log(`compiler:   ${artifact.provenance.compilerVersion}`);
  console.log(`renderer:   ${data.snapshot.rendererVersion}`);
  console.log(`source:     ${artifact.provenance.sourceManifestSha256}`);
  console.log(`surface:    ${artifact.provenance.mcpSurfaceSha256}`);
  console.log(`snapshot:   ${data.snapshot.snapshotSha256}`);
  console.log('files:');
  for (const file of data.snapshot.files) {
    console.log(`  ${file.target}  ${file.path}  ${file.byteLength} B  ${file.sha256}`);
  }
}
