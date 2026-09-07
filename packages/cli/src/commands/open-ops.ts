/** Open a saved MCP endpoint or the managed Noodle Seed Cloud project dashboard. */
import { presentUrl } from '../browser.js';
import type { ConfigLocation } from '../config.js';
import { readServers } from '../config.js';
import { DEFAULT_SERVICE_URL } from '../deploy.js';
import { printRecovery } from '../diagnostics.js';
import { readProjectDeployment } from '../project.js';
import { isLocalServiceUrl } from './deploy-target.js';

export async function runOpen(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  let printOnly = false;
  let dashboard = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--print') printOnly = true;
    else if (arg === '--dashboard') dashboard = true;
  }
  const projectDeployment = readProjectDeployment();
  const legacy = readServers(home).at(-1);
  if (dashboard && projectDeployment === undefined && legacy !== undefined) {
    printRecovery({
      command: 'open',
      message: 'Saved legacy deployment metadata cannot identify a project dashboard.',
      cause: 'Legacy global metadata records an MCP endpoint but not its project coordinates.',
      fix: 'Deploy this project again to save complete project deployment metadata.',
      next: 'noodle deploy',
    });
    return 1;
  }
  if (
    dashboard &&
    projectDeployment !== undefined &&
    !isNoodleSeedCloudServiceUrl(projectDeployment.serviceUrl)
  ) {
    const tenantFlags = tenantCommandFlags(
      projectDeployment.org,
      projectDeployment.app,
      projectDeployment.env,
    );
    printRecovery({
      command: 'open',
      message: 'No web dashboard is available for this deployment.',
      cause: 'The managed Noodle Seed Console is not part of Noodle Core or custom services.',
      fix: 'Operate this deployment through the CLI instead.',
      next: isLocalServiceUrl(projectDeployment.serviceUrl)
        ? `docker compose run --build --rm cli status ${tenantFlags}`
        : `noodle status ${tenantFlags}`,
    });
    return 1;
  }
  const url = dashboard
    ? projectDeployment === undefined
      ? undefined
      : projectDashboardUrl(
          projectDeployment.serviceUrl,
          projectDeployment.org,
          projectDeployment.app,
        )
    : (projectDeployment?.defaultUrl ?? projectDeployment?.url ?? legacy?.url);
  if (url === undefined) {
    printRecovery({
      command: 'open',
      cause: 'No saved deployment metadata found.',
      fix: 'Deploy this project first so the CLI can remember its endpoint.',
      next: 'noodle deploy',
    });
    return 1;
  }
  await printOrOpenUrl(url, env, printOnly);
  return 0;
}

/** True only when an interactive terminal may open a browser without surprising CI or a pipe. */
export function shouldOpenBrowser(env: NodeJS.ProcessEnv): boolean {
  return env.CI !== 'true' && process.stdout.isTTY === true;
}

/** Print a URL in headless contexts and open it from an interactive terminal. */
export async function printOrOpenUrl(
  url: string,
  env: NodeJS.ProcessEnv,
  printOnly: boolean,
): Promise<void> {
  await presentUrl(url, { shouldOpen: !printOnly && shouldOpenBrowser(env) });
}

export function projectDashboardUrl(serviceUrl: string, org: string, app: string): string {
  return `${serviceUrl.replace(/\/+$/, '')}/projects/${encodeURIComponent(org)}/${encodeURIComponent(app)}`;
}

export function isNoodleSeedCloudServiceUrl(serviceUrl: string): boolean {
  return serviceUrl.replace(/\/+$/, '') === DEFAULT_SERVICE_URL;
}

function tenantCommandFlags(org: string, app: string, env: string): string {
  return `--org ${org} --app ${app} --env ${env}`;
}
