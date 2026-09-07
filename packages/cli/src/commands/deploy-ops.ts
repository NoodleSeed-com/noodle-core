/**
 * Hosted deployment operations: deploy and open — plus the missing-secret prompt flow and deploy
 * failure recovery helpers. The `status`/`rollback`/`access` deployment-state operations live in
 * the sibling `deploy-status-ops.ts`.
 */
import { basename, extname, resolve } from 'node:path';
import { deploymentOwnerSubjectSchema } from '@noodle-borg/wire-contracts';
import type { ConfigLocation } from '../config.js';
import { appendServer, readConfig } from '../config.js';
import { resolveControlPlaneToken } from '../control-plane.js';
import { type AccessMode, deploy } from '../deploy.js';
import { printRecovery } from '../diagnostics.js';
import type { PluginMode } from '../plugin-mode/profile.js';
import { pluginServiceCompatibilityFailure } from '../plugin-mode/service-compatibility.js';
import {
  readNoodleProjectConfig,
  readProjectDeployment,
  readProjectLink,
  readResolvedProjectConfig,
  resolveLinkedEntrypoint,
  writeProjectDeployment,
  writeProjectLink,
} from '../project.js';
import { startSpinner } from '../status.js';
import { handleProductionCapacityFailure } from './billing-admission-output.js';
import {
  customerDeployAuthReadiness,
  printAuthReadinessWarnings,
} from './deploy-auth-readiness.js';
import { publicEmbedSnippet } from './deploy-embed-snippet.js';
import {
  completeDeployResume,
  prepareCanonicalDeploy,
  verifyHostedDeploy,
} from './deploy-first-flow.js';
import { maybePrintGithubHint } from './deploy-github-hint.js';
import {
  assetFailureRecovery,
  deployExitCode,
  deployFailureFix,
  deployFailureNext,
  formatAssetSummary,
} from './deploy-output.js';
import { runDeployPreflight, validateDeployPreflightArgs } from './deploy-preflight-command.js';
import {
  deployTargetLabel,
  findDeployProjectRoot,
  isLocalServiceUrl,
  listDeployedServerVersions,
  refreshDeployDefaultOrg,
} from './deploy-target.js';
import { resolveDeployServerVersion } from './deploy-version-resolution.js';
import { isNoodleSeedCloudServiceUrl, projectDashboardUrl } from './open-ops.js';
import { EXIT, printJsonFailure, printJsonOk, printRawJsonForHumanDebug } from './output.js';
import { isAccessMode, missingProjectEntrypoint, printCliFailure } from './shared.js';

export { productionCapacityRecovery } from './billing-admission-output.js';
export { assetFailureRecovery, formatAssetSummary } from './deploy-output.js';
export { isLocalServiceUrl } from './deploy-target.js';

export async function runDeploy(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
  pluginMode?: PluginMode,
): Promise<number> {
  const preflightOnly = rest[0] === 'preflight';
  if (preflightOnly) {
    rest = rest.slice(1);
    const invalid = validateDeployPreflightArgs(rest);
    if (invalid !== undefined) return invalid;
  }
  let manifestPath: string | undefined;
  let connectorsPath: string | undefined;
  let serviceFlag: string | undefined;
  let authFlag: string | undefined;
  let org: string | undefined;
  let app: string | undefined;
  let targetEnv: string | undefined;
  let saveLegacy = false;
  let noSave = false;
  let noPrompt = preflightOnly;
  const json = rest.includes('--json');
  let accessMode: AccessMode | undefined;
  let ownerSubject: string | undefined;
  let ownerSubjectFlagSeen = false;
  let serverVersionFlag: string | undefined;
  let explicitManifestPath = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--service') serviceFlag = rest[++i];
    else if (arg === '--connectors') connectorsPath = rest[++i];
    else if (arg === '--secrets') {
      if (json) {
        return printJsonFailure(
          {
            code: 'deprecated_option',
            message: 'deploy: --secrets is no longer supported',
            fix: 'Store managed secrets with `noodle secrets set`.',
            next: 'noodle secrets set <NAME>',
          },
          EXIT.USAGE,
        );
      }
      console.error('deploy: --secrets is no longer supported; use `noodle secrets set`');
      return EXIT.USAGE;
    } else if (arg === '--auth-token') authFlag = rest[++i];
    else if (arg === '--org') org = rest[++i];
    else if (arg === '--app') app = rest[++i];
    else if (arg === '--env') targetEnv = rest[++i];
    else if (arg === '--version') serverVersionFlag = rest[++i];
    else if (arg === '--owner-subject') {
      ownerSubjectFlagSeen = true;
      ownerSubject = rest[++i];
    } else if (arg === '--save') saveLegacy = true;
    else if (arg === '--no-save') noSave = true;
    else if (arg === '--no-prompt') noPrompt = true;
    else if (arg === '--json') continue;
    else if (arg === '--private') accessMode = 'owner-only';
    else if (arg === '--access') {
      const value = rest[++i];
      if (!isAccessMode(value)) {
        if (json) {
          return printJsonFailure(
            {
              code: value === 'caller-key' ? 'deprecated_access' : 'invalid_access',
              message:
                value === 'caller-key'
                  ? 'deploy: caller-key access has been removed'
                  : 'deploy: --access must be owner-only, org-members, authenticated, public, mixed, or customers',
              fix:
                value === 'caller-key'
                  ? 'Use identity-based hosted access.'
                  : 'Choose one of the supported access modes.',
              next: 'noodle deploy --access owner-only --json',
            },
            EXIT.USAGE,
          );
        }
        if (value === 'caller-key') {
          printRecovery({
            command: 'deploy',
            cause: 'caller-key access has been removed.',
            fix: 'Use identity-based hosted access.',
            next: 'noodle deploy --access owner-only or noodle deploy --access org-members',
          });
        } else {
          printRecovery({
            command: 'deploy',
            cause:
              '--access must be owner-only, org-members, authenticated, public, mixed, or customers.',
            fix: 'Choose one of the supported access modes (public/mixed serve anonymous MCP).',
            next: 'noodle deploy --access owner-only',
          });
        }
        return EXIT.USAGE;
      }
      accessMode = value;
    } else if (!manifestPath && arg !== undefined && !arg.startsWith('--')) {
      manifestPath = arg;
      explicitManifestPath = true;
    }
  }
  const projectRoot = findDeployProjectRoot() ?? process.cwd();
  const project = readProjectLink(projectRoot);
  const projectDeployment = readProjectDeployment(projectRoot);
  const projectConfig = readNoodleProjectConfig(projectRoot);
  const projectEntrypoint = resolveLinkedEntrypoint(projectRoot);
  if (!manifestPath) manifestPath = projectEntrypoint;
  if (!manifestPath) return missingProjectEntrypoint('deploy', json);
  const useProjectTarget =
    projectEntrypoint !== undefined &&
    (!explicitManifestPath || resolve(manifestPath) === resolve(projectEntrypoint));
  const resolvedProject = useProjectTarget ? readResolvedProjectConfig(projectRoot) : {};

  const { serviceUrl, token } = await resolveControlPlaneToken({
    serviceFlag:
      serviceFlag ??
      (env.NOODLE_SERVICE_URL === undefined && resolvedProject.serviceUrl !== undefined
        ? resolvedProject.serviceUrl
        : undefined),
    authFlag,
    env,
    home,
  });
  const config = readConfig(home);
  const refreshedDefaultOrg =
    org === undefined && resolvedProject.org === undefined && token !== undefined
      ? await refreshDeployDefaultOrg({
          serviceUrl,
          token,
          home,
          persist: !preflightOnly,
          ...(config.defaultOrg !== undefined ? { fallback: config.defaultOrg } : {}),
        })
      : config.defaultOrg;
  const resolvedOrg = org ?? resolvedProject.org ?? refreshedDefaultOrg;
  const resolvedApp = app ?? resolvedProject.app;
  const resolvedEnv = targetEnv ?? resolvedProject.env ?? config.defaultEnv;
  const resolvedAccessMode = accessMode ?? resolvedProject.accessMode;
  if (ownerSubjectFlagSeen) {
    const parsedOwner = deploymentOwnerSubjectSchema.safeParse(ownerSubject);
    if (!parsedOwner.success || (resolvedAccessMode ?? 'owner-only') !== 'owner-only') {
      return printCliFailure(
        'deploy',
        {
          code: 'invalid_owner_subject_mode',
          message: '--owner-subject requires a valid subject and owner-only access.',
          cause: 'A deployment owner can be bound only when --access owner-only is effective.',
          fix: 'Use --access owner-only with one exact OAuth subject.',
          next: 'noodle deploy --access owner-only --owner-subject <subject>',
          exitCode: EXIT.USAGE,
        },
        json,
      );
    }
    ownerSubject = parsedOwner.data;
  }
  const resolvedMembershipSources = resolvedProject.orgMembershipSources;
  // The deploy app name, resolved once: an explicit --org/link app, else the manifest's basename.
  const inferredApp = resolvedApp ?? basename(manifestPath, extname(manifestPath));

  // Authenticated to a HOSTED service, but no deploy target resolved (no --org, project link, or default
  // org): fail with a repairable envelope instead of silently deploying to a bogus `local` org. Excluded:
  // the not-logged-in case (`token === undefined`) is handled by the auth guard immediately below; and a
  // LOCAL loopback control plane (`noodle dev`/e2e/tests), where the implicit `local` org is correct and
  // an org-less deploy must keep working.
  if (resolvedOrg === undefined && token !== undefined && !isLocalServiceUrl(serviceUrl)) {
    const cause = 'No deploy target is resolved (no --org, project link, or default org).';
    const fix = 'Pass --org and --app, or run noodle link.';
    const next = `noodle link --org <org> --app ${inferredApp}`;
    if (json) {
      return printJsonFailure({ code: 'missing_target', message: cause, fix, next }, EXIT.USAGE);
    }
    printRecovery({ command: 'deploy', cause, fix, next });
    return EXIT.USAGE;
  }

  // Not signed in to a HOSTED service: surface the actionable auth error (next: noodle login) here,
  // ahead of the server-version hard-fail below — otherwise `deploy --no-prompt` without a version leads
  // with `missing_server_version` instead of "sign in first". A LOCAL loopback control plane
  // (`noodle dev`/e2e/tests) needs no account, so it is excluded and its 401 (if any) still flows through
  // `deploy()`; hosted with a present-but-invalid token also still flows through `deploy()`'s 401.
  if (token === undefined && !isLocalServiceUrl(serviceUrl)) {
    const cause = 'Not signed in to the deploy service.';
    const fix = deployFailureFix(401);
    const next = deployFailureNext(401, serviceUrl);
    if (json) {
      return printJsonFailure(
        { code: 'deploy_failed', message: cause, fix, next, detail: { status: 401 } },
        EXIT.AUTH,
      );
    }
    printRecovery({ command: 'deploy', cause, fix, next });
    return EXIT.AUTH;
  }

  const compatibilityFailure = await pluginServiceCompatibilityFailure({
    ...(pluginMode !== undefined ? { pluginMode } : {}),
    serviceUrl,
  });
  if (compatibilityFailure !== undefined) {
    return printCliFailure('deploy', compatibilityFailure, json);
  }

  // Auth + target are settled; now require a concrete server version. Kept after the guards above so a
  // missing version never masks the more actionable auth/target error (ADR: OOTB deploy error ordering).
  const serverVersion = await resolveDeployServerVersion({
    manifestPath,
    ...(serverVersionFlag !== undefined ? { versionFlag: serverVersionFlag } : {}),
    ...(useProjectTarget &&
    projectDeployment !== undefined &&
    projectDeployment.org === resolvedOrg &&
    projectDeployment.app === resolvedApp &&
    projectDeployment.env === resolvedEnv &&
    projectDeployment.serverVersion !== undefined
      ? { linkedVersion: projectDeployment.serverVersion }
      : {}),
    ...(resolvedOrg !== undefined && resolvedApp !== undefined && resolvedEnv !== undefined
      ? {
          deployedVersions: () =>
            listDeployedServerVersions({
              serviceUrl,
              token,
              org: resolvedOrg,
              app: resolvedApp,
              env: resolvedEnv,
            }),
        }
      : {}),
    noPrompt,
    json,
  });
  if (!serverVersion.ok) return serverVersion.exitCode;

  const interactive = !json && process.stdout.isTTY === true;
  const deployTarget = {
    org: resolvedOrg ?? 'local',
    app: inferredApp,
    env: resolvedEnv ?? 'prod',
  };
  if (preflightOnly)
    return runDeployPreflight({
      manifestPath,
      ...(connectorsPath !== undefined ? { connectorsPath } : {}),
      serviceUrl,
      ...(token !== undefined ? { token } : {}),
      target: deployTarget,
      ...(resolvedAccessMode !== undefined ? { accessMode: resolvedAccessMode } : {}),
      ...(ownerSubject !== undefined ? { ownerSubject } : {}),
      ...(resolvedMembershipSources !== undefined
        ? { orgMembershipSources: resolvedMembershipSources }
        : {}),
      serverVersion: serverVersion.value,
      json,
    });
  const preparation = await prepareCanonicalDeploy({
    manifestPath,
    ...(connectorsPath !== undefined ? { connectorsPath } : {}),
    serviceUrl,
    ...(token !== undefined ? { token } : {}),
    target: deployTarget,
    ...(resolvedAccessMode !== undefined ? { accessMode: resolvedAccessMode } : {}),
    ...(ownerSubject !== undefined ? { ownerSubject } : {}),
    ...(resolvedMembershipSources !== undefined
      ? { orgMembershipSources: resolvedMembershipSources }
      : {}),
    serverVersion: serverVersion.value,
    projectRoot,
    saveLegacy,
    noSave,
    noPrompt,
    json,
    interactive:
      pluginMode === undefined &&
      env.CI === undefined &&
      interactive &&
      process.stdin.isTTY === true,
  });
  if (!preparation.ok) return preparation.exitCode;

  // Progress spinner for the network deploy — interactive TTY only, so piped/CI/--json output is unchanged.
  const spinnerTarget = deployTargetLabel({
    org: resolvedOrg,
    app: resolvedApp,
    env: resolvedEnv,
    manifestPath,
  });
  let deployStatus = interactive ? startSpinner(`Deploying to ${spinnerTarget}…`) : undefined;
  const outcome = await deploy({
    manifestPath,
    ...(connectorsPath ? { connectorsPath } : {}),
    ...(serviceUrl ? { serviceUrl } : {}),
    ...(token ? { authToken: token } : {}),
    ...(resolvedOrg !== undefined ? { org: resolvedOrg } : {}),
    ...(resolvedApp !== undefined ? { app: resolvedApp } : {}),
    ...(resolvedEnv !== undefined ? { env: resolvedEnv } : {}),
    ...(resolvedAccessMode !== undefined ? { accessMode: resolvedAccessMode } : {}),
    ...(ownerSubject !== undefined ? { ownerSubject } : {}),
    ...(resolvedMembershipSources !== undefined
      ? { orgMembershipSources: resolvedMembershipSources }
      : {}),
    ...(preparation.idempotencyKey !== undefined
      ? { idempotencyKey: preparation.idempotencyKey }
      : {}),
    serverVersion: serverVersion.value,
  });

  if (deployStatus && !outcome.ok) {
    deployStatus.stop(); // failure detail / recovery printing takes over below
    deployStatus = undefined;
  }

  if (!outcome.ok) {
    const missingSecrets = missingSecretNames(outcome.errors);
    const capacityFailure = handleProductionCapacityFailure(outcome, resolvedOrg ?? 'local', json);
    if (capacityFailure !== undefined) return capacityFailure;
    if (hasServerAuthRequired(outcome.errors)) {
      const cause = 'customers access mode requires server.auth';
      const fix =
        'Add auth to server.ts with customerAuth.federatedOidc(...), customerAuth.oidc(...), or a managed adapter like customerAuth.firebase(...).';
      const next = 'noodle deploy --access customers (after adding server.auth)';
      if (json) {
        return printJsonFailure(
          { code: 'server_auth_required', message: cause, fix, next },
          EXIT.USAGE,
        );
      }
      printRecovery({ command: 'deploy', cause, fix, next });
      return EXIT.USAGE;
    }
    if (missingSecrets.length > 0) {
      const target = {
        org: resolvedOrg ?? 'local',
        app: inferredApp,
        env: resolvedEnv ?? 'prod',
      };
      if (json) {
        return printJsonFailure(
          {
            code: 'missing_secret',
            message: `Missing required managed secret(s): ${missingSecrets.join(', ')}`,
            fix: 'Set the missing secret(s) at the environment scope.',
            next: secretSetCommand(missingSecrets[0] as string, target),
          },
          EXIT.FAILURE,
        );
      }
      printRecovery({
        command: 'deploy',
        cause: `Missing required managed secret(s): ${missingSecrets.join(', ')}`,
        fix: 'Set the missing secret(s) at the environment scope.',
        next: secretSetCommand(missingSecrets[0] as string, target),
      });
    } else {
      const exitCode = deployExitCode(outcome.status);
      const is403 = outcome.status === 403;
      if (json) {
        return printJsonFailure(
          {
            code: outcome.stage !== undefined ? 'asset_failed' : 'deploy_failed',
            message: outcome.message,
            fix: is403
              ? 'Confirm the target is one of your orgs, or link this project to the intended org/app.'
              : deployFailureFix(outcome.status),
            next: is403 ? 'noodle whoami' : deployFailureNext(outcome.status, serviceUrl),
            // Non-standard deploy specifics live under `detail` so the top-level error shape stays uniform.
            detail: {
              status: outcome.status,
              ...(outcome.stage !== undefined ? { stage: outcome.stage } : {}),
              ...(is403
                ? {
                    target: deployTargetLabel({
                      org: resolvedOrg,
                      app: resolvedApp,
                      env: resolvedEnv,
                      manifestPath,
                    }),
                  }
                : {}),
              ...(outcome.errors !== undefined ? { errors: outcome.errors } : {}),
            },
          },
          exitCode,
        );
      }
      if (outcome.stage !== undefined) {
        printRecovery({
          command: 'deploy',
          ...assetFailureRecovery(outcome.stage, outcome.message),
        });
      } else
        printRecovery({
          command: 'deploy',
          cause: is403
            ? `${outcome.message} (target: ${deployTargetLabel({
                org: resolvedOrg,
                app: resolvedApp,
                env: resolvedEnv,
                manifestPath,
              })})`
            : outcome.message,
          fix: is403
            ? 'Confirm the target is one of your orgs, or link this project to the intended org/app.'
            : deployFailureFix(outcome.status),
          next: is403 ? 'noodle whoami' : deployFailureNext(outcome.status, serviceUrl),
        });
      if (outcome.errors !== undefined) {
        printRawJsonForHumanDebug(outcome.errors, 2, console.error);
      }
      return exitCode;
    }
    return EXIT.FAILURE;
  }

  // Persist the resolved deploy target so a follow-up `noodle deploy` reuses it without a separate
  // `link` step — this is what lets the first hosted deploy work without the user learning `noodle link`.
  // Gated exactly like the deployment-metadata write below: an org must resolve, the user must not have
  // opted out (`--no-save`), and it must be the discovered project's own entrypoint (`useProjectTarget`)
  // with an existing link or `noodle.json` — so `deploy path/to/other.ts` never rewrites its link.
  const deployedOrg = resolvedOrg ?? 'local';
  const deployedApp = inferredApp;
  const deployedEnv = resolvedEnv ?? 'prod';
  const createdAt = new Date().toISOString();
  const linkedTarget = resolvedOrg !== undefined ? deployTarget : undefined;
  const persistLink =
    linkedTarget !== undefined &&
    !noSave &&
    useProjectTarget &&
    (project !== undefined || projectConfig !== undefined);
  let linkPersisted = false;
  if (persistLink && linkedTarget !== undefined) {
    // Best-effort: the deploy already succeeded, so a failed convenience link write must not fail it.
    try {
      writeProjectLink({
        ...linkedTarget,
        serviceUrl,
        accessMode: outcome.accessMode ?? resolvedAccessMode ?? 'owner-only',
        cwd: projectRoot,
      });
      linkPersisted = true;
    } catch {
      // Link persistence is a convenience; ignore write failures (permissions, read-only fs).
    }
  }

  let deploymentMetadataPersisted = false;
  if (!noSave && useProjectTarget && (project !== undefined || projectConfig !== undefined)) {
    writeProjectDeployment(
      {
        deploymentId: outcome.deploymentId,
        serverVersion: outcome.serverVersion,
        url: outcome.url,
        defaultUrl: outcome.defaultUrl,
        org: deployedOrg,
        app: deployedApp,
        env: deployedEnv,
        accessMode: outcome.accessMode,
        serviceUrl,
        createdAt,
      },
      projectRoot,
    );
    deploymentMetadataPersisted = true;
  }
  let legacyMetadataPersisted = false;
  if (!noSave && saveLegacy) {
    appendServer(
      {
        deploymentId: outcome.deploymentId,
        url: outcome.url,
        createdAt,
      },
      home,
    );
    legacyMetadataPersisted = true;
  }

  const verification = await verifyHostedDeploy({
    required: preparation.verificationRequired,
    serviceUrl,
    ...(token !== undefined ? { token } : {}),
    target: deployTarget,
  });
  if (!verification.ok) {
    deployStatus?.stop();
    const message =
      verification.message ?? 'The deployment was created, but hosted readiness did not pass.';
    if (json) {
      return printJsonFailure({
        code: 'deploy_verification_failed',
        message,
        cause: 'The deployment exists, but its post-deploy readiness check failed.',
        fix: 'Repair the reported readiness problem, then rerun the same deploy command.',
        next: preparation.resumeCommand,
        detail: {
          deploymentId: outcome.deploymentId,
          deployed: true,
          verification: {
            ok: false,
            ...(verification.checks !== undefined ? { checks: verification.checks } : {}),
            ...(verification.message !== undefined ? { message: verification.message } : {}),
          },
        },
      });
    }
    printRecovery({
      command: 'deploy',
      message,
      cause: `Deployment ${outcome.deploymentId} exists, but readiness verification failed.`,
      fix: 'Repair the reported readiness problem; rerunning deploy safely resumes this operation.',
      next: preparation.resumeCommand,
    });
    return EXIT.FAILURE;
  }
  completeDeployResume(projectRoot, preparation.idempotencyKey);

  const authReadiness = await customerDeployAuthReadiness(
    manifestPath,
    outcome.accessMode === 'customers' || resolvedAccessMode === 'customers',
  );

  if (json) {
    printJsonOk({
      deploymentId: outcome.deploymentId,
      serverVersion: outcome.serverVersion,
      url: outcome.url,
      defaultUrl: outcome.defaultUrl,
      accessMode: outcome.accessMode,
      ...(outcome.ownerSubject !== undefined ? { ownerSubject: outcome.ownerSubject } : {}),
      assets: outcome.assets,
      service: serviceUrl,
      ...(outcome.embedId !== undefined ? { embedId: outcome.embedId } : {}),
      ...(verification.required
        ? {
            verification: {
              ok: true,
              ...(verification.checks ? { checks: verification.checks } : {}),
            },
          }
        : {}),
      ...(authReadiness !== undefined ? { authReadiness } : {}),
      // Signal to an agent that the target is now persisted, and echo it so a chained command can reuse it.
      // Only claim `linked` when the write actually succeeded — a read-only workspace must not be told
      // the target persisted (the agent would skip `noodle link` and the next command runs unlinked).
      ...(linkPersisted && linkedTarget !== undefined
        ? { linked: true, target: linkedTarget }
        : {}),
    });
    return 0;
  }

  // Interactive: the spinner settles to a ✔ line. Non-interactive (piped/CI): print the same
  // confirmation plainly, so redirected logs keep an explicit success indicator.
  if (deployStatus) {
    deployStatus.succeed(`Deployed to ${spinnerTarget}`);
  } else {
    console.log(`Deployed to ${spinnerTarget}`);
  }
  const tenantFlags = tenantCommandFlags(deployedOrg, deployedApp, deployedEnv);
  const selfHostedCompose = env.NOODLE_SELF_HOST_ADMIN_TOKEN !== undefined;
  console.log(`deploymentId: ${outcome.deploymentId}`);
  console.log(`Version:      ${outcome.serverVersion}`);
  console.log(`Endpoint:  ${outcome.url}`);
  console.log(`Default:   ${outcome.defaultUrl}`);
  if (isNoodleSeedCloudServiceUrl(serviceUrl)) {
    console.log(`Dashboard: ${projectDashboardUrl(serviceUrl, deployedOrg, deployedApp)}`);
  } else if (selfHostedCompose) {
    console.log('Console:   not included in Noodle Core.');
  } else {
    console.log('Dashboard: unavailable for this service; use the CLI to operate it.');
  }
  console.log(`Assets:    ${formatAssetSummary(outcome.assets)}`);
  if (verification.required) console.log('Verified:  deployment readiness passed.');
  if (outcome.accessMode === 'owner-only') {
    console.log('Access:    owner-only — only the bound owner can connect.');
    if (outcome.ownerSubject !== undefined) console.log(`Owner:     ${outcome.ownerSubject}`);
    console.log(
      '           Connect from an MCP client (e.g. Claude.ai) and sign in when prompted.',
    );
  } else if (outcome.accessMode === 'org-members') {
    console.log('Access:    org-members — members of the deployment org can call it via login.');
    console.log(
      '           Connect from an MCP client (e.g. Claude.ai) and sign in when prompted.',
    );
  } else if (outcome.accessMode === 'authenticated') {
    console.log('Access:    authenticated — any signed-in Noodle user can call it.');
    console.log(
      '           Connect from an MCP client (e.g. Claude.ai) and sign in when prompted.',
    );
  } else if (outcome.accessMode === 'customers') {
    console.log(
      'Access:    customers — your app customers sign in through the configured customer auth.',
    );
    if (authReadiness?.ready === false) printAuthReadinessWarnings(authReadiness);
  }
  if (outcome.embedId !== undefined) {
    for (const line of publicEmbedSnippet(outcome.embedId, serviceUrl)) console.log(line);
  }
  if (selfHostedCompose) {
    console.log('Next:      docker compose logs --follow noodle');
    console.log(`Next:      docker compose run --build --rm cli smoke ${tenantFlags}`);
    console.log(
      `Next:      npx @noodleseed/one@latest connect claude-code --endpoint ${outcome.url}`,
    );
  } else {
    console.log(`Next:      noodle logs --tail ${tenantFlags}`);
    console.log(`Next:      noodle smoke ${tenantFlags}`);
    console.log(`Next:      noodle connect claude-code --endpoint ${outcome.url}`);
  }
  if (deploymentMetadataPersisted) {
    console.log('Saved deployment metadata to .noodle/deployment.json.');
  }
  if (legacyMetadataPersisted) {
    console.log('Saved legacy deployment metadata to ~/.noodle/servers.json.');
  }
  if (interactive) maybePrintGithubHint();
  return 0;
}

function tenantCommandFlags(org: string, app: string, env: string): string {
  return `--org ${org} --app ${app} --env ${env}`;
}

/** True when the (local-preflight or service) deploy errors carry `server_auth_required`. */
function hasServerAuthRequired(errors: unknown): boolean {
  if (!Array.isArray(errors)) return false;
  return errors.some(
    (error) =>
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'server_auth_required',
  );
}

function missingSecretNames(errors: unknown): string[] {
  if (!Array.isArray(errors)) return [];
  const names = new Set<string>();
  for (const error of errors) {
    if (typeof error !== 'object' || error === null) continue;
    const item = error as { code?: unknown; path?: unknown; message?: unknown };
    if (item.code !== 'missing_secret') continue;
    if (typeof item.path === 'string' && item.path.startsWith('secrets.')) {
      names.add(item.path.slice('secrets.'.length));
      continue;
    }
    if (typeof item.message === 'string') {
      const match = /required secret "([^"]+)"/.exec(item.message);
      if (match?.[1]) names.add(match[1]);
    }
  }
  return [...names].sort();
}

function secretSetCommand(
  name: string,
  target: { readonly org: string; readonly app: string; readonly env: string },
): string {
  return (
    `noodle secrets set ${name} --runtime cloud --scope env --org ${target.org}` +
    ` --app ${target.app} --env ${target.env} --from-env ${name}`
  );
}
