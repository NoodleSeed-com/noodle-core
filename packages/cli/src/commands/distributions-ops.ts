import {
  renderProductSkillBundle,
  validateRenderedProductSkillFiles,
} from '@noodle-borg/agent-kit';
import { createAppPackageSnapshotV1 } from '@noodle-borg/app-package';
import { packageClaudePlugin, packageOpenAiPlugin } from '@noodle-borg/plugin-distribution';
import {
  readDistributionAssets,
  writeDistributionArchiveAtomically,
} from '@noodle-borg/plugin-distribution/command';
import {
  DeploymentPackageResponseShapeSchema,
  DeploymentResponseSchema,
  DistributionListResponseSchema,
  DistributionPublishRequestSchema,
  DistributionPublishResponseSchema,
  DistributionResponseSchema,
} from '@noodle-borg/wire-contracts';
import type { ConfigLocation } from '../config.js';
import { serviceBinary, serviceJson } from '../control-plane.js';
import { compileLocalInput } from '../local-compile.js';
import { resolveLocalEntrypoint } from '../project.js';
import { runDistributionLifecycle } from './distribution-lifecycle-ops.js';
import {
  commonDistributionArgs,
  DOWNLOAD_USAGE,
  deploymentDistributionEligibilityFailure,
  distributionDeploymentUrl,
  distributionDownloadMatches,
  distributionFailure,
  distributionUsageFailure,
  distributionVersionUrl,
  INSPECT_USAGE,
  isDistributionTarget,
  LIST_USAGE,
  PUBLISH_USAGE,
  printDistributionVersion,
  printDistributionVersions,
  printPublishedDistribution,
  resolveDistributionHostedContext,
} from './distribution-ops-support.js';
import { EXIT, printJsonOk } from './output.js';
import { parseCommandFlags, printCliFailure, serviceFailure } from './shared.js';

export async function runDistributions(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const [subcommand, ...tail] = rest;
  if (subcommand === 'publish') return publishDistribution(tail, env, home);
  if (subcommand === 'list') return listDistributions(tail, env, home);
  if (subcommand === 'inspect') return inspectDistribution(tail, env, home);
  if (subcommand === 'download') return downloadDistribution(tail, env, home);
  const lifecycle = await runDistributionLifecycle(subcommand, tail, env, home);
  if (lifecycle !== undefined) return lifecycle;
  return distributionUsageFailure(
    'noodle distributions requires a publish, read, or lifecycle action',
    PUBLISH_USAGE,
    rest.includes('--json'),
  );
}

async function publishDistribution(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const parsed = parseCommandFlags(rest, {
    values: {
      '--target': 'target',
      '--category': 'category',
      '--connectors': 'connectors',
      '--org': 'org',
      '--service': 'service',
      '--auth-token': 'authToken',
    },
    booleans: { '--json': 'json' },
  });
  const common = commonDistributionArgs(parsed);
  if (parsed.parseError !== undefined) {
    return distributionUsageFailure(parsed.parseError, PUBLISH_USAGE, common.json);
  }
  const [deploymentId, explicitEntrypoint, ...extra] = parsed.positional;
  if (deploymentId === undefined || extra.length > 0) {
    return distributionUsageFailure(
      'publish requires one deployment id and accepts at most one server.ts entrypoint',
      PUBLISH_USAGE,
      common.json,
    );
  }
  if (!isDistributionTarget(parsed.target)) {
    return distributionUsageFailure(
      'publish requires --target openai or claude',
      PUBLISH_USAGE,
      common.json,
    );
  }
  if (parsed.target === 'openai' && parsed.category === undefined) {
    return distributionUsageFailure(
      'OpenAI publishing requires --category',
      PUBLISH_USAGE,
      common.json,
    );
  }
  if (parsed.target === 'claude' && parsed.category !== undefined) {
    return distributionUsageFailure(
      '--category is only valid with --target openai',
      PUBLISH_USAGE,
      common.json,
    );
  }
  const entrypoint = explicitEntrypoint ?? resolveLocalEntrypoint();
  if (entrypoint === undefined) {
    return printCliFailure(
      'distributions publish',
      distributionFailure(
        'project_entrypoint_required',
        'No project entrypoint was found.',
        'Pass server.ts explicitly or link the current project.',
        PUBLISH_USAGE,
        EXIT.USAGE,
      ),
      common.json,
    );
  }
  const hosted = await resolveDistributionHostedContext(common, env, home, 'distributions publish');
  if (typeof hosted === 'number') return hosted;

  try {
    const deploymentUrl = distributionDeploymentUrl(hosted, deploymentId);
    const [deploymentBody, packageBody] = await Promise.all([
      serviceJson<unknown>(deploymentUrl, hosted.token),
      serviceJson<unknown>(`${deploymentUrl}/package`, hosted.token),
    ]);
    const deployment = DeploymentResponseSchema.parse(deploymentBody).data;
    const deployedPackage = DeploymentPackageResponseShapeSchema.parse(packageBody).data;
    const eligibilityFailure = deploymentDistributionEligibilityFailure(
      deployment,
      deployedPackage.active,
      parsed.target,
    );
    if (eligibilityFailure !== undefined) {
      return printCliFailure('distributions publish', eligibilityFailure, common.json);
    }

    const compiled = await compileLocalInput({
      manifestPath: entrypoint,
      ...(parsed.connectors === undefined ? {} : { connectorsPath: parsed.connectors }),
    });
    if (!compiled.ok) {
      return printCliFailure(
        'distributions publish',
        {
          ...distributionFailure(
            'distribution_compile_failed',
            'The local project could not be compiled for distribution.',
            'Fix the compiler findings, then publish again.',
            'noodle validate --json',
          ),
          errors: compiled.errors,
        },
        common.json,
      );
    }
    if (compiled.compiled.appPackage === undefined || compiled.distribution === undefined) {
      return printCliFailure(
        'distributions publish',
        distributionFailure(
          'distribution_unavailable',
          'Hosted distribution requires both agentGuide and distribution metadata.',
          'Add the missing authoring metadata and validate the project.',
          'noodle validate --json',
        ),
        common.json,
      );
    }
    const localSnapshot = createAppPackageSnapshotV1(
      compiled.compiled.appPackage,
      renderProductSkillBundle,
      validateRenderedProductSkillFiles,
    );
    if (localSnapshot.snapshotSha256 !== deployedPackage.snapshot.snapshotSha256) {
      return printCliFailure(
        'distributions publish',
        distributionFailure(
          'distribution_source_mismatch',
          'Local source does not match the immutable package deployed under this id.',
          'Deploy the current source, or publish from the exact source used for this deployment.',
          `noodle deployments package ${deploymentId} --org ${hosted.org}`,
        ),
        common.json,
      );
    }

    let assets: ReturnType<typeof readDistributionAssets>;
    try {
      assets = readDistributionAssets(compiled.distribution, compiled.rootDir);
    } catch {
      return printCliFailure(
        'distributions publish',
        distributionFailure(
          'distribution_assets_invalid',
          'Distribution assets could not be read safely.',
          'Use existing project-relative image files declared through asset(...).',
          'noodle validate --json',
        ),
        common.json,
      );
    }
    const request = {
      appPackage: compiled.compiled.appPackage,
      distribution: compiled.distribution,
      mcpServer: { url: deployment.endpointUrl as string, transport: 'streamable-http' as const },
      assets,
    };
    const packaged =
      parsed.target === 'openai'
        ? packageOpenAiPlugin(request, {
            state: 'submission',
            category: parsed.category as string,
          })
        : packageClaudePlugin(request);
    if (!packaged.ok) {
      return printCliFailure(
        'distributions publish',
        {
          ...distributionFailure(
            'distribution_package_invalid',
            `The ${parsed.target} adapter rejected this package.`,
            'Resolve each target finding, then publish again.',
            PUBLISH_USAGE,
          ),
          errors: packaged.issues.map(({ code, path, message }) => ({ code, path, message })),
        },
        common.json,
      );
    }
    const publishRequest = DistributionPublishRequestSchema.parse({
      schemaVersion: 1,
      target: parsed.target,
      variant: parsed.target === 'openai' ? 'submission' : 'plugin',
      snapshotSha256: localSnapshot.snapshotSha256,
      archive: {
        encoding: 'base64',
        content: Buffer.from(packaged.archive.bytes).toString('base64'),
        byteLength: packaged.archive.byteLength,
        sha256: packaged.archive.sha256,
        treeSha256: packaged.treeSha256,
        adapterVersion: packaged.adapterVersion,
      },
    });
    const response = DistributionPublishResponseSchema.parse(
      await serviceJson<unknown>(`${deploymentUrl}/distributions`, hosted.token, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(publishRequest),
      }),
    );
    const data = { distribution: response.data, replayed: response.replayed };
    if (common.json) printJsonOk(data);
    else printPublishedDistribution(response.data, response.replayed);
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      'distributions publish',
      serviceFailure('distributions publish', error, PUBLISH_USAGE),
      common.json,
    );
  }
}

async function listDistributions(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const parsed = parseCommandFlags(rest, {
    values: {
      '--target': 'target',
      '--org': 'org',
      '--service': 'service',
      '--auth-token': 'authToken',
    },
    booleans: { '--json': 'json' },
  });
  const common = commonDistributionArgs(parsed);
  if (parsed.parseError !== undefined) {
    return distributionUsageFailure(parsed.parseError, LIST_USAGE, common.json);
  }
  const [deploymentId, ...extra] = parsed.positional;
  if (deploymentId === undefined || extra.length > 0) {
    return distributionUsageFailure(
      'list requires exactly one deployment id',
      LIST_USAGE,
      common.json,
    );
  }
  if (parsed.target !== undefined && !isDistributionTarget(parsed.target)) {
    return distributionUsageFailure('--target must be openai or claude', LIST_USAGE, common.json);
  }
  const hosted = await resolveDistributionHostedContext(common, env, home, 'distributions list');
  if (typeof hosted === 'number') return hosted;
  try {
    const url = new URL(`${distributionDeploymentUrl(hosted, deploymentId)}/distributions`);
    if (parsed.target !== undefined) url.searchParams.set('target', parsed.target);
    const response = DistributionListResponseSchema.parse(
      await serviceJson<unknown>(url.toString(), hosted.token),
    );
    if (common.json) printJsonOk(response.data);
    else printDistributionVersions(response.data.versions);
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      'distributions list',
      serviceFailure('distributions list', error, LIST_USAGE),
      common.json,
    );
  }
}

async function inspectDistribution(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const parsed = parseCommandFlags(rest, {
    values: { '--org': 'org', '--service': 'service', '--auth-token': 'authToken' },
    booleans: { '--json': 'json' },
  });
  const common = commonDistributionArgs(parsed);
  if (parsed.parseError !== undefined) {
    return distributionUsageFailure(parsed.parseError, INSPECT_USAGE, common.json);
  }
  const [distributionId, ...extra] = parsed.positional;
  if (distributionId === undefined || extra.length > 0) {
    return distributionUsageFailure(
      'inspect requires exactly one distribution id',
      INSPECT_USAGE,
      common.json,
    );
  }
  const hosted = await resolveDistributionHostedContext(common, env, home, 'distributions inspect');
  if (typeof hosted === 'number') return hosted;
  try {
    const response = DistributionResponseSchema.parse(
      await serviceJson<unknown>(distributionVersionUrl(hosted, distributionId), hosted.token),
    );
    const data = {
      ...response.data,
      ...(response.lifecycle === undefined ? {} : { lifecycle: response.lifecycle }),
    };
    if (common.json) printJsonOk(data);
    else printDistributionVersion(response.data, response.lifecycle);
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      'distributions inspect',
      serviceFailure('distributions inspect', error, INSPECT_USAGE),
      common.json,
    );
  }
}

async function downloadDistribution(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const parsed = parseCommandFlags(rest, {
    values: {
      '--output': 'output',
      '--org': 'org',
      '--service': 'service',
      '--auth-token': 'authToken',
    },
    booleans: { '--json': 'json' },
  });
  const common = commonDistributionArgs(parsed);
  if (parsed.parseError !== undefined) {
    return distributionUsageFailure(parsed.parseError, DOWNLOAD_USAGE, common.json);
  }
  const [distributionId, ...extra] = parsed.positional;
  if (distributionId === undefined || extra.length > 0 || parsed.output === undefined) {
    return distributionUsageFailure(
      'download requires one distribution id and --output <archive.zip>',
      DOWNLOAD_USAGE,
      common.json,
    );
  }
  const hosted = await resolveDistributionHostedContext(
    common,
    env,
    home,
    'distributions download',
  );
  if (typeof hosted === 'number') return hosted;
  try {
    const base = distributionVersionUrl(hosted, distributionId);
    const metadata = DistributionResponseSchema.parse(
      await serviceJson<unknown>(base, hosted.token),
    ).data;
    const downloaded = await serviceBinary(`${base}/archive`, hosted.token);
    if (!distributionDownloadMatches(metadata, downloaded.bytes, downloaded.headers)) {
      return printCliFailure(
        'distributions download',
        distributionFailure(
          'distribution_download_integrity_failed',
          'Downloaded archive bytes do not match the immutable distribution metadata.',
          'Do not use these bytes; retry the download or inspect the distribution.',
          `noodle distributions inspect ${distributionId} --org ${hosted.org}`,
        ),
        common.json,
      );
    }
    try {
      writeDistributionArchiveAtomically(parsed.output, downloaded.bytes, metadata.target);
    } catch {
      return printCliFailure(
        'distributions download',
        distributionFailure(
          'distribution_download_write_failed',
          'The verified archive could not be written.',
          'Choose a writable output path and retry.',
          DOWNLOAD_USAGE,
        ),
        common.json,
      );
    }
    const data = {
      distribution: metadata,
      output: parsed.output,
      archiveSha256: metadata.archiveSha256,
      byteLength: metadata.byteLength,
    };
    if (common.json) printJsonOk(data);
    else {
      console.log(`downloaded: ${parsed.output}`);
      console.log(`sha256:     ${metadata.archiveSha256}`);
      console.log(`bytes:      ${metadata.byteLength}`);
    }
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      'distributions download',
      serviceFailure('distributions download', error, DOWNLOAD_USAGE),
      common.json,
    );
  }
}
