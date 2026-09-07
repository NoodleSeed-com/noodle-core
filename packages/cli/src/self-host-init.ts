import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { ServiceProfileName } from '@noodle-borg/capabilities';

export const COMPOSE_INIT_VERSION = 1;

export interface SelfHostSecrets {
  readonly adminToken: string;
  readonly postgresPassword: string;
  readonly secretMasterKey: string;
  readonly assetIdentitySalt: string;
}

export interface FileResult {
  readonly path: string;
  readonly status: 'created' | 'unchanged' | 'skipped' | 'replaced';
}

export interface SelfHostInitInput {
  readonly root: string;
  readonly force?: boolean;
  readonly replaceSecrets?: boolean;
  readonly random?: (bytes: number) => Buffer;
  readonly rename?: (source: string, destination: string) => void;
}

interface RepositoryPackage {
  readonly name?: unknown;
  readonly noodleCore?: { readonly composeInitVersion?: unknown };
}

interface GeneratedFile {
  readonly relativePath: string;
  readonly mode: number;
  readonly content: string;
}

export function generateSelfHostSecrets(random: (bytes: number) => Buffer): SelfHostSecrets {
  return {
    adminToken: random(32).toString('base64url'),
    postgresPassword: random(24).toString('base64url'),
    secretMasterKey: random(32).toString('base64'),
    assetIdentitySalt: random(32).toString('base64url'),
  };
}

export function reconcileSelfHostFiles(input: SelfHostInitInput): readonly FileResult[] {
  assertCompatibleRepository(input.root);
  const stateDirectory = join(input.root, '.self-host');
  const files = [
    { relativePath: '.self-host/.env', mode: 0o600 },
    { relativePath: '.self-host/.env.postgres', mode: 0o600 },
    { relativePath: '.self-host/.env.noodle', mode: 0o600 },
    { relativePath: '.self-host/.env.operator', mode: 0o600 },
    { relativePath: '.self-host/compose.generated.yaml', mode: 0o644 },
    { relativePath: 'noodle.service.yaml', mode: 0o644 },
  ] as const;

  rejectSymlink(stateDirectory, 'state directory');
  for (const file of files) {
    const target = join(input.root, file.relativePath);
    rejectSymlink(target, 'generated target');
    rejectTemporaryTarget(`${target}.tmp`);
  }

  if (existsSync(stateDirectory)) {
    if (!lstatSync(stateDirectory).isDirectory()) {
      throw new Error('self-host state path exists but is not a directory');
    }
    chmodSync(stateDirectory, 0o700);
  } else {
    mkdirSync(stateDirectory, { mode: 0o700 });
  }

  const rename = input.rename ?? renameSync;
  const envPath = join(input.root, files[0].relativePath);
  const results: FileResult[] = [];
  if (existsSync(envPath) && !input.replaceSecrets) {
    chmodSync(envPath, files[0].mode);
    results.push({ path: files[0].relativePath, status: 'unchanged' });
  } else {
    const secrets = generateSelfHostSecrets(input.random ?? randomBytes);
    const status = existsSync(envPath) ? 'replaced' : 'created';
    atomicWrite(envPath, renderEnvironment(secrets), files[0].mode, rename);
    results.push({ path: files[0].relativePath, status });
  }

  const canonicalEnvironment = parseEnvironment(readFileSync(envPath, 'utf8'));
  const derivedEnvironmentFiles: readonly GeneratedFile[] = [
    {
      relativePath: files[1].relativePath,
      mode: files[1].mode,
      content: renderSelectedEnvironment(canonicalEnvironment, [
        'POSTGRES_DB',
        'POSTGRES_PASSWORD',
        'POSTGRES_USER',
      ]),
    },
    {
      relativePath: files[2].relativePath,
      mode: files[2].mode,
      content: renderNoodleEnvironment(canonicalEnvironment),
    },
    {
      relativePath: files[3].relativePath,
      mode: files[3].mode,
      content: renderSelectedEnvironment(canonicalEnvironment, ['NOODLE_SELF_HOST_ADMIN_TOKEN']),
    },
  ];
  for (const file of derivedEnvironmentFiles) {
    results.push(reconcileGeneratedFile(input.root, file, true, rename));
  }

  const generated: readonly GeneratedFile[] = [
    {
      relativePath: files[4].relativePath,
      mode: files[4].mode,
      content: generatedComposeTemplate(),
    },
    {
      relativePath: files[5].relativePath,
      mode: files[5].mode,
      content: serviceConfigTemplate('open-core'),
    },
  ];
  for (const file of generated) {
    results.push(reconcileGeneratedFile(input.root, file, input.force ?? false, rename));
  }
  return results;
}

function assertCompatibleRepository(root: string): void {
  const rootPackage = readPackage(join(root, 'package.json'));
  const candidate =
    rootPackage?.name === 'noodle-borg'
      ? readPackage(join(root, 'opensource', 'overlay', 'package.json'))
      : rootPackage;
  if (
    candidate?.name !== 'noodle-core' ||
    candidate.noodleCore?.composeInitVersion !== COMPOSE_INIT_VERSION
  ) {
    throw new Error(
      `this is not a compatible Noodle Core checkout (requires composeInitVersion ${COMPOSE_INIT_VERSION}); use the checkout-local CLI or a matching pinned @noodleseed/one version`,
    );
  }
}

function readPackage(path: string): RepositoryPackage | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RepositoryPackage;
  } catch {
    return undefined;
  }
}

function rejectSymlink(path: string, label: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`${label} must not be a symbolic link: ${path}`);
    }
  } catch (error) {
    if (isMissingPath(error)) return;
    throw error;
  }
}

function rejectTemporaryTarget(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new Error(`temporary target must not be a symbolic link: ${path}`);
    }
    throw new Error(`temporary target already exists: ${path}`);
  } catch (error) {
    if (isMissingPath(error)) return;
    throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}

function atomicWrite(
  target: string,
  content: string,
  mode: number,
  rename: (source: string, destination: string) => void,
): void {
  const temporary = `${target}.tmp`;
  mkdirSync(dirname(target), { recursive: true });
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', mode);
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    rename(temporary, target);
    chmodSync(target, mode);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
}

function reconcileGeneratedFile(
  root: string,
  file: GeneratedFile,
  force: boolean,
  rename: (source: string, destination: string) => void,
): FileResult {
  const target = join(root, file.relativePath);
  if (existsSync(target)) {
    const current = readFileSync(target, 'utf8');
    chmodSync(target, file.mode);
    if (current === file.content) return { path: file.relativePath, status: 'unchanged' };
    if (!force) return { path: file.relativePath, status: 'skipped' };
    atomicWrite(target, file.content, file.mode, rename);
    return { path: file.relativePath, status: 'replaced' };
  }
  atomicWrite(target, file.content, file.mode, rename);
  return { path: file.relativePath, status: 'created' };
}

function renderEnvironment(secrets: SelfHostSecrets): string {
  return [
    'POSTGRES_DB=noodle',
    'POSTGRES_USER=noodle',
    `POSTGRES_PASSWORD=${secrets.postgresPassword}`,
    `DATABASE_URL=postgresql://noodle:${secrets.postgresPassword}@postgres:5432/noodle`,
    `NOODLE_SECRET_MASTER_KEY=${secrets.secretMasterKey}`,
    `NOODLE_SELF_HOST_ADMIN_TOKEN=${secrets.adminToken}`,
    'NOODLE_ASSET_ROOT=/var/lib/noodle/assets',
    `NOODLE_ASSET_IDENTITY_SALT=${secrets.assetIdentitySalt}`,
    'HOST=0.0.0.0',
    'PORT=8787',
    'PUBLIC_BASE_URL=http://127.0.0.1:8787',
    '',
  ].join('\n');
}

function parseEnvironment(contents: string): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    const key = line.slice(0, separator);
    if (separator < 1 || !/^[A-Z][A-Z0-9_]*$/.test(key) || key in environment) {
      throw new Error('self-host environment contains an invalid or duplicate entry');
    }
    environment[key] = line.slice(separator + 1);
  }
  for (const key of [
    'POSTGRES_DB',
    'POSTGRES_USER',
    'POSTGRES_PASSWORD',
    'DATABASE_URL',
    'NOODLE_SECRET_MASTER_KEY',
    'NOODLE_SELF_HOST_ADMIN_TOKEN',
    'NOODLE_ASSET_ROOT',
    'NOODLE_ASSET_IDENTITY_SALT',
    'HOST',
    'PORT',
    'PUBLIC_BASE_URL',
  ]) {
    if (!environment[key]) throw new Error(`self-host environment is missing ${key}`);
  }
  return environment;
}

function renderSelectedEnvironment(
  environment: Readonly<Record<string, string>>,
  keys: readonly string[],
): string {
  return `${keys.map((key) => `${key}=${environment[key]}`).join('\n')}\n`;
}

function renderNoodleEnvironment(environment: Readonly<Record<string, string>>): string {
  const allowedKeys = [
    'DATABASE_URL',
    'NOODLE_SECRET_MASTER_KEY',
    'NOODLE_SELF_HOST_ADMIN_TOKEN',
    'NOODLE_ASSET_ROOT',
    'NOODLE_ASSET_IDENTITY_SALT',
    'HOST',
    'PORT',
    'PUBLIC_BASE_URL',
    'NOODLE_OAUTH_ISSUER',
    'NOODLE_OAUTH_JWKS_URI',
    'NOODLE_OAUTH_SIGNING_KEY_BASE64',
    'NOODLE_OAUTH_GOOGLE_CLIENT_ID',
    'NOODLE_OAUTH_GOOGLE_CLIENT_SECRET',
    'NOODLE_OAUTH_GOOGLE_REDIRECT_URI',
    'NOODLE_OAUTH_ALLOWED_EMAIL_DOMAIN',
  ] as const;
  return `${allowedKeys
    .filter((key) => key in environment)
    .map((key) => `${key}=${environment[key]}`)
    .join('\n')}\n`;
}

function generatedComposeTemplate(): string {
  return [
    '# Generated by noodle service init --profile open-core --compose.',
    '# Re-run the command to reconcile this file; do not put secrets here.',
    'services:',
    '  postgres:',
    '    image: postgres:16',
    '    user: postgres',
    '    env_file:',
    '      - .env.postgres',
    '    volumes:',
    '      - postgres-data:/var/lib/postgresql/data',
    '    healthcheck:',
    '      test:',
    '        - CMD-SHELL',
    '        - \'pg_isready -U "$${POSTGRES_USER}" -d "$${POSTGRES_DB}"\'',
    '      interval: 2s',
    '      timeout: 3s',
    '      retries: 30',
    '    restart: unless-stopped',
    '    stop_grace_period: 30s',
    '    read_only: true',
    '    cap_drop:',
    '      - ALL',
    '    security_opt:',
    '      - no-new-privileges:true',
    '    tmpfs:',
    '      - /tmp:rw,noexec,nosuid,size=64m',
    '      - /var/run/postgresql:rw,noexec,nosuid,size=16m,uid=999,gid=999,mode=0775',
    '  noodle:',
    '    build:',
    '      context: ..',
    '      dockerfile: Dockerfile',
    '      target: service-runtime',
    '    user: node',
    '    env_file:',
    '      - .env.noodle',
    '    ports:',
    '      - 127.0.0.1:8787:8787',
    '    volumes:',
    '      - asset-data:/var/lib/noodle/assets',
    '    depends_on:',
    '      postgres:',
    '        condition: service_healthy',
    '    healthcheck:',
    '      test:',
    '        - CMD',
    '        - node',
    '        - -e',
    '        - "fetch(\'http://127.0.0.1:8787/readyz\').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"',
    '      interval: 2s',
    '      timeout: 3s',
    '      retries: 30',
    '    restart: unless-stopped',
    '    stop_grace_period: 30s',
    '    init: true',
    '    read_only: true',
    '    cap_drop:',
    '      - ALL',
    '    security_opt:',
    '      - no-new-privileges:true',
    '    tmpfs:',
    '      - /tmp:rw,noexec,nosuid,size=64m',
    '  bootstrap:',
    '    build:',
    '      context: ..',
    '      dockerfile: Dockerfile',
    '      target: cli-runtime',
    '    user: node',
    '    env_file:',
    '      - .env.operator',
    '    environment:',
    '      NOODLE_SERVICE_URL: http://noodle:8787',
    '    depends_on:',
    '      noodle:',
    '        condition: service_healthy',
    '    entrypoint:',
    '      - /bin/sh',
    '      - -eu',
    '      - -c',
    '    command:',
    '      - |',
    '        export NOODLE_AUTH_TOKEN="$${NOODLE_SELF_HOST_ADMIN_TOKEN}"',
    '        exec node dist/bin.js orgs create noodle-local --display-name "Noodle Local" --json',
    '    restart: no',
    '    init: true',
    '    read_only: true',
    '    cap_drop:',
    '      - ALL',
    '    security_opt:',
    '      - no-new-privileges:true',
    '    tmpfs:',
    '      - /tmp:rw,noexec,nosuid,size=64m',
    '  cli:',
    '    profiles:',
    '      - tools',
    '    build:',
    '      context: ..',
    '      dockerfile: Dockerfile',
    '      target: cli-runtime',
    '    user: node',
    '    env_file:',
    '      - .env.operator',
    '    environment:',
    '      NOODLE_SERVICE_URL: http://noodle:8787',
    '    volumes:',
    '      - ./e2e:/app/e2e:ro',
    '    depends_on:',
    '      noodle:',
    '        condition: service_healthy',
    '    entrypoint:',
    '      - /bin/sh',
    '      - -eu',
    '      - -c',
    '      - |',
    '        export NOODLE_AUTH_TOKEN="$${NOODLE_SELF_HOST_ADMIN_TOKEN}"',
    '        exec node dist/bin.js "$@"',
    '      - --',
    '    command:',
    '      - --help',
    '    restart: no',
    '    init: true',
    '    read_only: true',
    '    cap_drop:',
    '      - ALL',
    '    security_opt:',
    '      - no-new-privileges:true',
    '    tmpfs:',
    '      - /tmp:rw,noexec,nosuid,size=64m',
    '      - /app/.noodle:rw,noexec,nosuid,size=16m',
    'volumes:',
    '  postgres-data: {}',
    '  asset-data: {}',
    '',
  ].join('\n');
}

export function serviceConfigTemplate(profile: ServiceProfileName): string {
  if (profile === 'enterprise-governed') {
    return [
      'profile: enterprise-governed',
      '',
      'identity:',
      '  admin:',
      '    provider: google-workspace',
      '',
      'access:',
      '  mode: org-members',
      '',
      'audit:',
      '  store: postgres',
      '',
      'controls:',
      '  rateLimits:',
      '    default:',
      '      perMinute: 60',
      '',
      'apps:',
      '  enabled: true',
      '',
    ].join('\n');
  }
  if (profile === 'agency-managed') {
    return [
      'profile: agency-managed',
      '',
      'org:',
      '  slug: acme',
      '  template: mid-market',
      '',
      'audit:',
      '  store: postgres',
      '',
      'access:',
      '  mode: org-members',
      '',
      'controls:',
      '  preset: standard',
      '',
      'apps:',
      '  enabled: true',
      '',
    ].join('\n');
  }
  return [`profile: ${profile}`, ''].join('\n');
}
