import { existsSync, readFileSync } from 'node:fs';
import { release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestSchema, prepareLocalAssets } from '@noodle-borg/compiler';
import { compileConnectors } from '@noodle-borg/connector-defs';
import { getAuthMetadata } from './auth-discovery.js';
import { type ChecklistItem, renderChecklist } from './checklist.js';
import { EXIT, printJsonOk } from './commands/output.js';
import type { ConfigLocation } from './config.js';
import { readConfig } from './config.js';
import { resolveControlPlaneToken, serviceJson } from './control-plane.js';
import { readDeployInput } from './deploy.js';
import { detectColorMode, detectGlyphMode } from './gradient.js';
import { findExecutableOnPath, wslPlatformChecks } from './platform-support.js';
import { readProjectDeployment, readProjectLink, resolveLinkedEntrypoint } from './project.js';
import { currentCliVersion } from './update.js';
import { validate } from './validate.js';

export interface DoctorOptions {
  readonly rest: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly home: ConfigLocation;
}

type CheckLevel = 'PASS' | 'WARN' | 'FAIL';

interface DoctorCheck {
  readonly level: CheckLevel;
  readonly name: string;
  readonly message: string;
  readonly cause?: string;
  readonly fix?: string;
  readonly next?: string;
}

interface DoctorArgs {
  readonly service?: string;
  readonly authToken?: string;
  readonly org?: string;
  readonly app?: string;
  readonly targetEnv?: string;
  readonly entrypoint?: string;
  readonly connectorsPath?: string;
  readonly agentOutput?: boolean;
  readonly json?: boolean;
}

type DoctorCheckStatus = 'pass' | 'warn' | 'fail';

interface DoctorJsonCheck {
  readonly name: string;
  readonly status: DoctorCheckStatus;
  readonly detail?: string;
  readonly fix?: string;
  readonly next?: string;
}

export async function runDoctor(options: DoctorOptions): Promise<number> {
  const args = parseDoctorArgs(options.rest);
  const project = readProjectLink();
  const config = readConfig(options.home);
  const checks: DoctorCheck[] = [];

  const node = nodeCheck();
  checks.push(node);
  const npmPath = findExecutableOnPath('npm', options.env.PATH ?? process.env.PATH);
  checks.push(
    ...wslPlatformChecks({
      platform: process.platform,
      env: options.env,
      cwd: process.cwd(),
      nodePath: process.execPath,
      ...(npmPath !== undefined ? { npmPath } : {}),
      kernelRelease: release(),
    }),
  );
  checks.push({ level: 'PASS', name: 'CLI', message: currentCliVersion() });

  const {
    serviceUrl,
    token,
    config: resolvedConfig,
  } = await resolveControlPlaneToken({
    serviceFlag:
      args.service ??
      (options.env.NOODLE_SERVICE_URL === undefined && project?.serviceUrl !== undefined
        ? project.serviceUrl
        : undefined),
    authFlag: args.authToken,
    env: options.env,
    home: options.home,
  });

  const hasLogin =
    token !== undefined ||
    resolvedConfig.identity !== undefined ||
    config.identity !== undefined ||
    config.authToken !== undefined;
  checks.push(
    hasLogin
      ? {
          level: 'PASS',
          name: 'Login',
          message: resolvedConfig.identity?.email ?? config.identity?.email ?? 'token available',
        }
      : {
          level: 'FAIL',
          name: 'Login',
          message: 'missing',
          cause: 'No saved Noodle login token or identity was found.',
          fix: 'Sign in to Noodle Seed Cloud before deploy and management commands.',
          next: 'noodle login',
        },
  );

  checks.push(await serviceCheck(serviceUrl));

  const entrypoint = args.entrypoint ?? resolveLinkedEntrypoint();
  const target = {
    org: args.org ?? project?.org ?? config.defaultOrg ?? 'local',
    app: args.app ?? project?.app ?? config.defaultApp ?? appFromEntrypoint(entrypoint ?? 'app'),
    env: args.targetEnv ?? project?.env ?? config.defaultEnv ?? 'prod',
  };

  checks.push(await orgMembershipCheck(serviceUrl, token, target.org));

  if (project === undefined && args.entrypoint === undefined) {
    checks.push({
      level: 'FAIL',
      name: 'Project link',
      message: 'missing',
      cause: 'No readable .noodle/project.json was found in this directory.',
      fix: 'Create or bind a local Noodle project.',
      next: 'noodle init && noodle link --org <org> --app <app>',
    });
  } else {
    checks.push({
      level: 'PASS',
      name: 'Project link',
      message:
        project !== undefined
          ? `${project.org}/${project.app}/${project.env}`
          : 'explicit entrypoint',
    });
  }

  if (entrypoint === undefined || !existsSync(entrypoint)) {
    checks.push({
      level: 'FAIL',
      name: 'Entrypoint',
      message: 'missing',
      cause: 'The linked or supplied project entrypoint does not exist.',
      fix: 'Point the project at a deployable server.ts file.',
      next: 'noodle link --entrypoint <path>',
    });
  } else {
    checks.push({ level: 'PASS', name: 'Entrypoint', message: entrypoint });
    const validation = await validate({
      manifestPath: entrypoint,
      ...(args.connectorsPath !== undefined ? { connectorsPath: args.connectorsPath } : {}),
    });
    if (validation.ok) {
      checks.push({ level: 'PASS', name: 'Validate', message: 'manifest compiles locally' });
      checks.push(
        await packagedAssetsCheck({
          entrypoint,
          serviceUrl,
          target,
          ...(token !== undefined ? { token } : {}),
        }),
      );
      checks.push(
        await secretsCheck({
          entrypoint,
          serviceUrl,
          target,
          ...(args.connectorsPath !== undefined ? { connectorsPath: args.connectorsPath } : {}),
          ...(token !== undefined ? { token } : {}),
        }),
      );
    } else {
      const first = validation.errors[0];
      checks.push({
        level: 'FAIL',
        name: 'Validate',
        message: `${validation.errors.length} error(s)`,
        cause:
          first !== undefined
            ? `${first.code}${first.path ? ` at ${first.path}` : ''}: ${first.message}`
            : 'The project did not compile.',
        fix: 'Fix the manifest or authored server before running dev or deploy.',
        next: 'noodle validate',
      });
    }
  }

  checks.push(await endpointHealthCheck({ target, serviceUrl }));

  if (args.agentOutput) {
    console.log(agentDoctorOutput(checks));
    return checks.some((check) => check.level === 'FAIL') ? 1 : 0;
  }

  if (args.json) {
    printJsonOk({ checks: checks.map(toJsonCheck), summary: summarizeChecks(checks) });
    return checks.some((check) => check.level === 'FAIL') ? EXIT.FAILURE : EXIT.OK;
  }

  console.log(
    renderChecklist(checks.map(toChecklistItem), {
      color: detectColorMode(process.stdout),
      glyph: detectGlyphMode(),
    }),
  );
  const next = checks.find((check) => check.level === 'FAIL' && check.next !== undefined)?.next;
  console.log(`Next: ${next ?? 'noodle dev'}`);
  return checks.some((check) => check.level === 'FAIL') ? 1 : 0;
}

/** Map a doctor check onto the shared checklist convention (`checklist.ts`). */
function toChecklistItem(check: DoctorCheck): ChecklistItem {
  const tone = check.level === 'PASS' ? 'ok' : check.level === 'WARN' ? 'warn' : 'fail';
  return {
    label: check.name,
    tone,
    detail: check.message,
    ...(check.cause !== undefined ? { cause: check.cause } : {}),
    ...(check.fix !== undefined ? { fix: check.fix } : {}),
    ...(check.next !== undefined ? { command: check.next } : {}),
  };
}

function toJsonCheck(check: DoctorCheck): DoctorJsonCheck {
  const detail = check.cause ?? check.message;
  return {
    name: check.name,
    status: check.level.toLowerCase() as DoctorCheckStatus,
    ...(detail !== undefined ? { detail } : {}),
    ...(check.fix !== undefined ? { fix: check.fix } : {}),
    ...(check.next !== undefined ? { next: check.next } : {}),
  };
}

function summarizeChecks(checks: readonly DoctorCheck[]): {
  readonly pass: number;
  readonly warn: number;
  readonly fail: number;
} {
  let pass = 0;
  let warn = 0;
  let fail = 0;
  for (const check of checks) {
    if (check.level === 'PASS') pass++;
    else if (check.level === 'WARN') warn++;
    else fail++;
  }
  return { pass, warn, fail };
}

async function orgMembershipCheck(
  serviceUrl: string,
  token: string | undefined,
  org: string,
): Promise<DoctorCheck> {
  if (token === undefined) {
    return {
      level: 'WARN',
      name: 'Org membership',
      message: 'skipped',
      cause: 'No login token was available to verify org membership.',
      fix: 'Sign in before deploying to hosted Noodle Seed Cloud.',
      next: 'noodle login',
    };
  }
  try {
    const body = await serviceJson<{
      ok: true;
      identity: { email: string; subject: string; superAdmin: boolean };
      orgs: readonly { slug: string }[];
    }>(`${serviceUrl}/v1/whoami`, token);
    if (body.identity.superAdmin || body.orgs.some((item) => item.slug === org)) {
      return { level: 'PASS', name: 'Org membership', message: org };
    }
    return {
      level: 'FAIL',
      name: 'Org membership',
      message: org,
      cause: `The current identity is not a member of org "${org}".`,
      fix: 'Ask an org owner to add this identity before deploying.',
      next: `noodle members add --org ${org} --email <email> --subject <subject>`,
    };
  } catch (error) {
    return {
      level: 'WARN',
      name: 'Org membership',
      message: 'could not verify',
      cause: error instanceof Error ? error.message : String(error),
      fix: 'Confirm login and service reachability.',
      next: `noodle login --service ${serviceUrl}`,
    };
  }
}

async function endpointHealthCheck(input: {
  readonly target: { readonly org: string; readonly app: string; readonly env: string };
  readonly serviceUrl: string;
}): Promise<DoctorCheck> {
  const latest = readProjectDeployment();
  if (latest === undefined) {
    return {
      level: 'WARN',
      name: 'Endpoint health',
      message: 'no project deployment metadata',
      next: 'noodle deploy',
    };
  }
  if (
    latest.org !== input.target.org ||
    latest.app !== input.target.app ||
    latest.env !== input.target.env ||
    latest.serviceUrl !== input.serviceUrl
  ) {
    return {
      level: 'WARN',
      name: 'Endpoint health',
      message: 'stale project deployment metadata',
      cause: 'Saved deployment metadata does not match the current project link.',
      fix: 'Deploy the current project target before checking endpoint health.',
      next: 'noodle deploy',
    };
  }
  try {
    const res = await fetch(latest.url, { method: 'HEAD' });
    if (res.status < 500) return { level: 'PASS', name: 'Endpoint health', message: latest.url };
    return {
      level: 'FAIL',
      name: 'Endpoint health',
      message: latest.url,
      cause: `Endpoint returned HTTP ${res.status}.`,
      fix: 'Check deployment status and service logs.',
      next: 'noodle deploy',
    };
  } catch (error) {
    return {
      level: 'WARN',
      name: 'Endpoint health',
      message: latest.url,
      cause: error instanceof Error ? error.message : String(error),
      fix: 'Confirm the saved deployment endpoint is still reachable.',
      next: 'noodle deploy',
    };
  }
}

function parseDoctorArgs(rest: readonly string[]): DoctorArgs {
  let service: string | undefined;
  let authToken: string | undefined;
  let org: string | undefined;
  let app: string | undefined;
  let targetEnv: string | undefined;
  let entrypoint: string | undefined;
  let connectorsPath: string | undefined;
  let agentOutput = false;
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--service') service = rest[++i];
    else if (arg === '--auth-token') authToken = rest[++i];
    else if (arg === '--org') org = rest[++i];
    else if (arg === '--app') app = rest[++i];
    else if (arg === '--env') targetEnv = rest[++i];
    else if (arg === '--entrypoint') entrypoint = resolve(rest[++i] ?? 'server.ts');
    else if (arg === '--connectors') connectorsPath = rest[++i];
    else if (arg === '--agent-output' || arg === '--fix-prompt') agentOutput = true;
    else if (arg === '--json') json = true;
  }
  return {
    ...(service !== undefined ? { service } : {}),
    ...(authToken !== undefined ? { authToken } : {}),
    ...(org !== undefined ? { org } : {}),
    ...(app !== undefined ? { app } : {}),
    ...(targetEnv !== undefined ? { targetEnv } : {}),
    ...(entrypoint !== undefined ? { entrypoint } : {}),
    ...(connectorsPath !== undefined ? { connectorsPath } : {}),
    ...(agentOutput ? { agentOutput } : {}),
    ...(json ? { json } : {}),
  };
}

function agentDoctorOutput(checks: readonly DoctorCheck[]): string {
  const failed = checks.filter((check) => check.level === 'FAIL');
  return [
    'Fix this Noodle project readiness failure from `doctor`.',
    '',
    ...(failed.length > 0
      ? failed.map(
          (check) =>
            `- ${check.name}: ${check.cause ?? check.message}. Next: ${check.next ?? 'noodle doctor'}`,
        )
      : [
          '- No blocking failures. Keep using `noodle validate`, `noodle test`, and `noodle deploy`.',
        ]),
    '',
    'Do not inspect or print tokens, `.env.noodle`, or secret values.',
  ].join('\n');
}

function nodeCheck(): DoctorCheck {
  const required = requiredNodeMajor();
  const actual = Number(process.versions.node.split('.')[0]);
  if (Number.isFinite(actual) && actual >= required) {
    return { level: 'PASS', name: 'Node', message: `v${process.versions.node}` };
  }
  return {
    level: 'FAIL',
    name: 'Node',
    message: `v${process.versions.node}`,
    cause: `Noodle CLI requires Node ${required} or newer.`,
    fix: `Install and select Node ${required} LTS.`,
    next: `nvm install ${required} && nvm use ${required}`,
  };
}

function requiredNodeMajor(): number {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as {
      engines?: { node?: string };
    };
    const match = /^>=(\d+)/.exec(pkg.engines?.node ?? '');
    return match ? Number(match[1]) : 24;
  } catch {
    return 24;
  }
}

async function serviceCheck(serviceUrl: string): Promise<DoctorCheck> {
  try {
    await getAuthMetadata(serviceUrl);
    return { level: 'PASS', name: 'Service', message: serviceUrl };
  } catch {}
  try {
    const ready = await fetch(`${serviceUrl}/readyz`, { headers: { accept: 'application/json' } });
    if (ready.ok) return { level: 'PASS', name: 'Service', message: serviceUrl };
    return serviceFailure(serviceUrl, `ready check returned HTTP ${ready.status}`);
  } catch (error) {
    return serviceFailure(serviceUrl, error instanceof Error ? error.message : String(error));
  }
}

function serviceFailure(serviceUrl: string, cause: string): DoctorCheck {
  return {
    level: 'FAIL',
    name: 'Service',
    message: serviceUrl,
    cause: `Could not reach ${serviceUrl}: ${cause}`,
    fix: 'Check the service URL and network connection.',
    next: `noodle login --service ${serviceUrl}`,
  };
}

async function secretsCheck(input: {
  readonly entrypoint: string;
  readonly connectorsPath?: string;
  readonly serviceUrl: string;
  readonly token?: string;
  readonly target: { readonly org: string; readonly app: string; readonly env: string };
}): Promise<DoctorCheck> {
  const refs = await requiredSecretRefs(input.entrypoint, input.connectorsPath);
  if (!refs.ok) {
    return {
      level: 'FAIL',
      name: 'Secrets',
      message: 'could not inspect connector secrets',
      cause: refs.message,
      fix: 'Fix connector definitions before deploying.',
      next: 'noodle validate',
    };
  }
  if (refs.names.length === 0) {
    return { level: 'PASS', name: 'Secrets', message: 'no required connector secrets' };
  }
  const available = await availableManagedSecretNames(input.serviceUrl, input.token, input.target);
  if (!available.ok) {
    return {
      level: 'FAIL',
      name: 'Secrets',
      message: 'could not inspect managed secrets',
      cause: available.message,
      fix: 'Confirm your login and service target before deploy.',
      next: 'noodle login',
    };
  }
  const missing = refs.names.filter((name) => !available.names.has(name));
  if (missing.length === 0) {
    return {
      level: 'PASS',
      name: 'Secrets',
      message: `${refs.names.length} required secret(s) configured`,
    };
  }
  return {
    level: 'FAIL',
    name: 'Secrets',
    message: `missing ${missing.join(', ')}`,
    cause: `Missing required managed secret(s): ${missing.join(', ')}`,
    fix: 'Set the missing secret(s) at the environment scope.',
    next: secretSetCommand(missing[0] as string, input.target),
  };
}

async function requiredSecretRefs(
  entrypoint: string,
  connectorsPath: string | undefined,
): Promise<
  | { readonly ok: true; readonly names: readonly string[] }
  | { readonly ok: false; readonly message: string }
> {
  try {
    const input = await readDeployInput(entrypoint);
    const connectors =
      connectorsPath !== undefined ? readFileSync(connectorsPath, 'utf8') : input.connectors;
    if (connectors === undefined || connectors.trim() === '') return { ok: true, names: [] };
    const compiled = compileConnectors(connectors);
    if (!compiled.ok) {
      return {
        ok: false,
        message: compiled.errors.map((error) => `${error.code}: ${error.message}`).join('; '),
      };
    }
    return {
      ok: true,
      names: [
        ...new Set(
          compiled.secretBindings
            .map((binding) => binding.secretRef)
            .filter((name): name is string => name !== undefined),
        ),
      ].sort(),
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function availableManagedSecretNames(
  serviceUrl: string,
  token: string | undefined,
  target: { readonly org: string; readonly app: string; readonly env: string },
): Promise<
  | { readonly ok: true; readonly names: ReadonlySet<string> }
  | { readonly ok: false; readonly message: string }
> {
  const paths = [
    `/v1/orgs/${encodeURIComponent(target.org)}/secrets`,
    `/v1/orgs/${encodeURIComponent(target.org)}/apps/${encodeURIComponent(target.app)}/secrets`,
    `/v1/orgs/${encodeURIComponent(target.org)}/apps/${encodeURIComponent(target.app)}/envs/${encodeURIComponent(target.env)}/secrets`,
  ];
  const names = new Set<string>();
  try {
    for (const path of paths) {
      const body = await serviceJson<{ ok: true; values: readonly { name: string }[] }>(
        `${serviceUrl}${path}`,
        token,
      );
      for (const value of body.values) names.add(value.name);
    }
    return { ok: true, names };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function packagedAssetsCheck(input: {
  readonly entrypoint: string;
  readonly serviceUrl: string;
  readonly token?: string;
  readonly target: { readonly org: string; readonly app: string; readonly env: string };
}): Promise<DoctorCheck> {
  let prepared: ReturnType<typeof prepareLocalAssets>;
  try {
    const deployInput = await readDeployInput(input.entrypoint);
    const raw = JSON.parse(deployInput.manifest) as unknown;
    const parsed = manifestSchema.safeParse(raw);
    if (!parsed.success) return { level: 'PASS', name: 'Assets', message: 'none packaged' };
    prepared = prepareLocalAssets(parsed.data, { rootDir: dirname(resolve(input.entrypoint)) });
  } catch (error) {
    return {
      level: 'WARN',
      name: 'Assets',
      message: 'could not inspect packaged assets',
      cause: error instanceof Error ? error.message : String(error),
      next: 'noodle validate',
    };
  }
  if (prepared.assets.length === 0)
    return { level: 'PASS', name: 'Assets', message: 'none packaged' };
  if (prepared.errors.length > 0) {
    return {
      level: 'FAIL',
      name: 'Assets',
      message: `${prepared.errors.length} invalid asset(s)`,
      cause: prepared.errors[0]?.message ?? 'Packaged asset validation failed.',
      next: 'noodle validate',
    };
  }
  if (input.token === undefined) {
    return {
      level: 'WARN',
      name: 'Assets',
      message: `${prepared.assets.length} packaged asset(s), preflight skipped`,
      cause: 'No login token was available to verify hosted asset preflight.',
      next: 'noodle login',
    };
  }
  try {
    const url = `${input.serviceUrl}/v1/orgs/${input.target.org}/apps/${input.target.app}/envs/${input.target.env}/assets/preflight`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.token}`,
      },
      body: JSON.stringify({
        assets: prepared.assets.map(({ absolutePath: _absolutePath, ...asset }) => asset),
      }),
    });
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!response.ok || body.ok !== true) {
      return {
        level: 'FAIL',
        name: 'Assets',
        message: 'hosted preflight failed',
        cause: body.error ?? `asset preflight returned HTTP ${response.status}`,
        next: 'noodle deploy',
      };
    }
    const firstPath = prepared.assets[0]?.sourcePath;
    return {
      level: 'PASS',
      name: 'Assets',
      message: `${prepared.assets.length} packaged asset(s) preflight-ready${firstPath ? ` (${firstPath})` : ''}`,
    };
  } catch (error) {
    return {
      level: 'WARN',
      name: 'Assets',
      message: `${prepared.assets.length} packaged asset(s), preflight unavailable`,
      cause: error instanceof Error ? error.message : String(error),
      next: 'noodle deploy',
    };
  }
}

function secretSetCommand(
  name: string,
  target: { readonly org: string; readonly app: string; readonly env: string },
): string {
  return (
    `noodle secrets set ${name} --scope env --org ${target.org}` +
    ` --app ${target.app} --env ${target.env} --value <value>`
  );
}

function appFromEntrypoint(entrypoint: string): string {
  return (
    entrypoint
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.[^.]+$/, '') ?? 'app'
  );
}

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}
