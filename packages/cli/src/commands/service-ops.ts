import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAPABILITY_NAMES,
  type CapabilityName,
  isCapabilityName,
  isServiceProfileName,
  SERVICE_PROFILE_NAMES,
} from '@noodle-borg/capabilities';
import { parseNoodleServiceYaml, resolveServiceConfigSource } from '@noodle-borg/service/local';
import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, serviceJson } from '../control-plane.js';
import { reconcileSelfHostFiles, serviceConfigTemplate } from '../self-host-init.js';
import { runAppPurgeReconciliation } from './app-purge-reconciliation-ops.js';
import { EXIT, printJsonFailure, printJsonOk } from './output.js';
import { parseCommandFlags, printCliFailure, serviceFailure } from './shared.js';

interface ServiceCapabilitiesResponse {
  readonly ok: true;
  readonly capabilities: readonly string[];
  readonly modules?: readonly {
    readonly name: string;
    readonly capabilities: readonly string[];
  }[];
}

export async function runServiceCommand(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const [action, ...tail] = rest;
  if (action === 'capabilities') return runServiceCapabilities(tail, env, home);
  if (action === 'app-purge') return runAppPurgeReconciliation(tail, env, home);
  if (action === 'init') return runServiceInit(tail);
  if (action === 'doctor') return runServiceDoctor(tail, env, home);
  console.error(
    'usage: noodle service app-purge|capabilities|init|doctor [--service <url>] [--json] [--advanced]',
  );
  return 2;
}

function runServiceInit(rest: readonly string[]): number {
  const flags = parseCommandFlags(rest, {
    values: { '--profile': 'profile' },
    booleans: {
      '--force': 'force',
      '--compose': 'compose',
      '--replace-secrets': 'replaceSecrets',
    },
  });
  const { profile, force, compose, replaceSecrets, parseError, positional } = flags;
  if (parseError !== undefined) {
    console.error(`service init: ${parseError}`);
    return 2;
  }
  if (positional.length > 0) {
    console.error('service init: does not accept positional arguments');
    return 2;
  }
  if (!isServiceProfileName(profile)) {
    console.error(`service init: --profile must be one of ${SERVICE_PROFILE_NAMES.join(', ')}`);
    return 2;
  }
  if (compose && profile !== 'open-core') {
    console.error('service init: --compose requires --profile open-core');
    return 2;
  }
  if (replaceSecrets && !compose) {
    console.error('service init: --replace-secrets requires --compose');
    return 2;
  }
  if (compose) {
    try {
      if (replaceSecrets) {
        console.warn('warning: replacing every generated self-host secret');
      }
      const results = reconcileSelfHostFiles({
        root: process.cwd(),
        force,
        replaceSecrets,
      });
      for (const result of results) console.log(`${result.status} ${result.path}`);
      console.log(
        'docker compose up --build --wait postgres noodle && docker compose run --build --rm bootstrap',
      );
      return 0;
    } catch (error) {
      console.error(
        `service init: ${error instanceof Error ? error.message : 'self-host initialization failed'}`,
      );
      return 2;
    }
  }
  const target = join(process.cwd(), 'noodle.service.yaml');
  const content = serviceConfigTemplate(profile);
  if (existsSync(target)) {
    const current = readFileSync(target, 'utf8');
    if (current === content) {
      // Idempotent re-run: the on-disk config already matches the requested profile.
      console.log(`unchanged ${target}`);
      return 0;
    }
    if (!force) {
      console.error('service init: noodle.service.yaml already exists; pass --force to overwrite');
      return 2;
    }
  }
  writeFileSync(target, content);
  console.log(`Wrote ${target}`);
  return 0;
}

async function runServiceDoctor(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const flags = parseCommandFlags(rest, {
    values: {
      '--config': 'config',
      '--service': 'serviceFlag',
      '--auth-token': 'authFlag',
      '--org': 'org',
      '--app': 'app',
      '--env': 'targetEnv',
    },
    booleans: { '--assets': 'assets', '--json': 'json' },
  });
  const { serviceFlag, authFlag, assets, json } = flags;
  const org = flags.org ?? 'local';
  const app = flags.app ?? 'app';
  const targetEnv = flags.targetEnv ?? 'prod';
  const explicit =
    flags.config === 'yaml' || flags.config === 'typescript' ? flags.config : undefined;
  if (assets) {
    return runServiceAssetDoctor({
      env,
      home,
      target: { org, app, env: targetEnv },
      json,
      ...(serviceFlag !== undefined ? { serviceFlag } : {}),
      ...(authFlag !== undefined ? { authFlag } : {}),
    });
  }
  const source = resolveServiceConfigSource({
    ...(explicit !== undefined ? { explicit } : {}),
  });
  if (!source.ok) {
    if (json) {
      return printJsonFailure(
        {
          code: 'service_config_conflict',
          message: 'Service config sources conflict.',
          cause: source.error,
          fix: 'Remove one file or choose the source explicitly.',
          next: 'noodle service doctor --config yaml --json',
        },
        EXIT.FAILURE,
      );
    }
    console.log('FAIL Service config: conflicting sources');
    console.log(`  Cause: ${source.error}`);
    console.log('  Fix: Remove one file or choose the source explicitly.');
    console.log('  Next: noodle service doctor --config yaml');
    return 1;
  }
  if (source.source.kind === 'none') {
    if (json) {
      printJsonOk({
        status: 'missing',
        source: source.source,
        next: 'noodle service init --profile open-core',
      });
      return EXIT.OK;
    }
    console.log('WARN Service config: missing');
    console.log('  Next: noodle service init --profile open-core');
    return 0;
  }
  if (source.source.kind === 'typescript') {
    if (json) {
      printJsonOk({ status: 'valid', source: source.source });
      return EXIT.OK;
    }
    console.log(`PASS Service config: ${source.source.path}`);
    return 0;
  }
  const text = existsSync(source.source.path) ? readFileSync(source.source.path, 'utf8') : '';
  const parsed = parseNoodleServiceYaml(text);
  if (!parsed.ok) {
    if (json) {
      return printJsonFailure(
        {
          code: 'service_config_invalid',
          message: 'Service config is invalid.',
          cause: parsed.error,
          fix: 'Edit noodle.service.yaml to use a canonical profile and capability names.',
          next: 'noodle service init --profile open-core --force',
          detail: { source: source.source },
        },
        EXIT.FAILURE,
      );
    }
    console.log('FAIL Service config: invalid');
    console.log(`  Cause: ${parsed.error}`);
    console.log('  Fix: Edit noodle.service.yaml to use a canonical profile and capability names.');
    console.log('  Next: noodle service init --profile open-core --force');
    return 1;
  }
  if (json) {
    printJsonOk({
      status: 'valid',
      source: source.source,
      capabilities: parsed.capabilities,
    });
    return EXIT.OK;
  }
  console.log(`PASS Service config: ${source.source.path}`);
  console.log(`capabilities: ${parsed.capabilities.join(', ')}`);
  return 0;
}

async function runServiceAssetDoctor(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly home: ConfigLocation;
  readonly serviceFlag?: string;
  readonly authFlag?: string;
  readonly target: { readonly org: string; readonly app: string; readonly env: string };
  readonly json: boolean;
}): Promise<number> {
  const checks: Array<{ level: 'PASS' | 'FAIL'; name: string; message: string; cause?: string }> =
    [];
  const resolved = await resolveControlPlaneToken({
    serviceFlag: input.serviceFlag,
    authFlag: input.authFlag,
    env: input.env,
    home: input.home,
  });
  try {
    const preflight = await assetPreflight(resolved.serviceUrl, resolved.token, input.target);
    checks.push({ level: 'PASS', name: 'Asset service', message: 'preflight accepted' });
    const upload = preflight.uploads[0];
    if (upload !== undefined) {
      const uploaded = await fetch(upload.uploadUrl, {
        method: upload.method,
        headers: upload.headers,
        body: DOCTOR_PNG,
      });
      if (uploaded.status < 200 || uploaded.status >= 300) {
        checks.push({
          level: 'FAIL',
          name: 'Asset upload',
          message: `HTTP ${uploaded.status}`,
          cause: 'The synthetic image upload target rejected the PUT.',
        });
      } else {
        checks.push({ level: 'PASS', name: 'Asset upload', message: 'synthetic image uploaded' });
      }
    } else {
      checks.push({
        level: 'PASS',
        name: 'Asset upload',
        message: 'synthetic image already present',
      });
    }
    const hosted = preflight.assets[0];
    if (hosted === undefined) throw new Error('asset preflight returned no hosted asset');
    const head = await fetch(hosted.publicUrl, { method: 'HEAD' });
    const headerError = assetHeaderError(head);
    if (!head.ok || headerError !== undefined) {
      checks.push({
        level: 'FAIL',
        name: 'Asset edge',
        message: new URL(hosted.publicUrl).origin,
        cause: headerError ?? `HEAD returned HTTP ${head.status}`,
      });
    } else {
      checks.push({ level: 'PASS', name: 'Asset edge', message: new URL(hosted.publicUrl).origin });
    }
  } catch (error) {
    checks.push({
      level: 'FAIL',
      name: 'Asset service',
      message: 'not ready',
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  if (input.json) {
    if (checks.some((check) => check.level === 'FAIL')) {
      printJsonFailure(
        {
          code: 'service_doctor_failed',
          message: 'Service readiness checks failed.',
          fix: 'Repair each failed check, then rerun service doctor.',
          next: 'noodle service doctor --json',
          detail: { checks },
        },
        EXIT.FAILURE,
      );
    } else {
      printJsonOk({ checks });
    }
  } else {
    for (const check of checks) {
      console.log(`${check.level} ${check.name}: ${check.message}`);
      if (check.cause !== undefined) console.log(`  Cause: ${check.cause}`);
    }
  }
  return checks.some((check) => check.level === 'FAIL') ? 1 : 0;
}

const DOCTOR_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

async function assetPreflight(
  serviceUrl: string,
  token: string | undefined,
  target: { readonly org: string; readonly app: string; readonly env: string },
): Promise<{
  readonly assets: Array<{ readonly publicUrl: string }>;
  readonly uploads: Array<{
    readonly uploadUrl: string;
    readonly method: 'PUT';
    readonly headers: Record<string, string>;
  }>;
}> {
  const hash = createHash('sha256').update(DOCTOR_PNG).digest('hex');
  const url = `${serviceUrl}/v1/orgs/${target.org}/apps/${target.app}/envs/${target.env}/assets/preflight`;
  const body = {
    assets: [
      {
        logicalId: 'doctor_asset',
        sourcePath: 'assets/__doctor.png',
        contentHash: `sha256:${hash}`,
        mimeType: 'image/png',
        byteLength: DOCTOR_PNG.byteLength,
        width: 1,
        height: 1,
      },
    ],
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    assets?: Array<{ publicUrl: string }>;
    uploads?: Array<{ uploadUrl: string; method: 'PUT'; headers: Record<string, string> }>;
  };
  if (!res.ok || !parsed.ok || !Array.isArray(parsed.assets)) {
    throw new Error(parsed.error ?? `asset preflight failed (HTTP ${res.status})`);
  }
  return { assets: parsed.assets, uploads: parsed.uploads ?? [] };
}

function assetHeaderError(res: Response): string | undefined {
  if (res.headers.get('x-content-type-options')?.toLowerCase() !== 'nosniff') {
    return 'asset edge did not return X-Content-Type-Options: nosniff';
  }
  const cache = res.headers.get('cache-control') ?? '';
  if (!cache.includes('immutable')) return 'asset edge did not return immutable cache headers';
  if (res.headers.has('set-cookie')) return 'asset edge returned a Set-Cookie header';
  const type = res.headers.get('content-type') ?? '';
  if (!type.startsWith('image/')) return `asset edge returned unexpected content type "${type}"`;
  return undefined;
}

async function runServiceCapabilities(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  let serviceFlag: string | undefined;
  let authFlag: string | undefined;
  const json = rest.includes('--json');
  let advanced = false;
  const filters: CapabilityName[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--service') serviceFlag = rest[++i];
    else if (arg === '--auth-token') authFlag = rest[++i];
    else if (arg === '--json') continue;
    else if (arg === '--advanced') advanced = true;
    else if (arg === '--capability') {
      const value = rest[++i];
      if (!isCapabilityName(value)) {
        if (json) {
          return printJsonFailure(
            {
              code: 'invalid_capability',
              message: `service capabilities: --capability must be one of ${CAPABILITY_NAMES.join(', ')}`,
              fix: 'Choose a canonical service capability name.',
              next: 'noodle service capabilities --json',
            },
            EXIT.USAGE,
          );
        }
        console.error(
          `service capabilities: --capability must be one of ${CAPABILITY_NAMES.join(', ')}`,
        );
        return EXIT.USAGE;
      }
      filters.push(value);
    }
  }

  const resolved = await resolveControlPlaneToken({
    serviceFlag,
    authFlag,
    env,
    home,
  });
  const url = `${resolved.serviceUrl}/v1/service/capabilities${advanced ? '?advanced=1' : ''}`;
  try {
    const body = await serviceJson<ServiceCapabilitiesResponse>(url, resolved.token);
    const capabilities = filterCapabilities(body.capabilities, filters);
    const modules =
      advanced && body.modules !== undefined
        ? body.modules
            .map((module) => ({
              ...module,
              capabilities: filterCapabilities(module.capabilities, filters),
            }))
            .filter((module) => module.capabilities.length > 0 || filters.length === 0)
        : body.modules;
    if (json) {
      printJsonOk({ capabilities, modules, service: resolved.serviceUrl });
      return 0;
    }
    console.log(`service: ${resolved.serviceUrl}`);
    console.log(`capabilities: ${capabilities.join(', ') || '(none)'}`);
    for (const capability of capabilities) {
      if (!isCapabilityName(capability)) continue;
      console.log(`${capability}: ${CAPABILITY_EXPLANATIONS[capability]}`);
    }
    if (advanced && modules !== undefined) {
      for (const module of modules) {
        console.log(`module: ${module.name} -> ${module.capabilities.join(', ') || '(none)'}`);
      }
    }
    return 0;
  } catch (error) {
    return printCliFailure(
      'service capabilities',
      serviceFailure('service capabilities', error, 'noodle service capabilities --service <url>'),
      json,
    );
  }
}

const CAPABILITY_EXPLANATIONS: Record<CapabilityName, string> = {
  identity: 'end-user and workforce identity verification',
  access: 'authorization decisions for orgs, apps, environments, and tools',
  controls: 'runtime controls such as admission, quotas, and rate limits',
  audit: 'durable event trail for governance and incident review',
  observability: 'health, readiness, metrics, logs, and traces',
  secrets: 'credential storage and brokered secret access',
  connectors: 'curated connector catalog and operation execution',
  apps: 'MCP Apps widgets and UI resources',
};

function filterCapabilities(
  capabilities: readonly string[],
  filters: readonly CapabilityName[],
): readonly string[] {
  if (filters.length === 0) return capabilities;
  const allowed = new Set(filters);
  return capabilities.filter((capability) => allowed.has(capability as CapabilityName));
}
