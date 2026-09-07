import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  COMPOSE_INIT_VERSION,
  generateSelfHostSecrets,
  reconcileSelfHostFiles,
} from '../src/self-host-init.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function compatibleRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'noodle-self-host-init-'));
  roots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({
      name: 'noodle-core',
      private: true,
      noodleCore: { composeInitVersion: COMPOSE_INIT_VERSION },
    })}\n`,
  );
  return root;
}

function deterministicRandom(offset = 0): {
  readonly random: (bytes: number) => Buffer;
  readonly calls: number[];
} {
  const calls: number[] = [];
  return {
    calls,
    random: (bytes) => {
      calls.push(bytes);
      return Buffer.alloc(bytes, calls.length + offset);
    },
  };
}

function parseEnv(root: string, filename = '.env'): Readonly<Record<string, string>> {
  return Object.fromEntries(
    readFileSync(join(root, '.self-host', filename), 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

describe('self-host initialization', () => {
  it('generates independent secrets with the required byte lengths and encodings', () => {
    const { random, calls } = deterministicRandom();

    const secrets = generateSelfHostSecrets(random);

    expect(calls).toEqual([32, 24, 32, 32]);
    expect(secrets.adminToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secrets.postgresPassword).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(secrets.secretMasterKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(secrets.secretMasterKey, 'base64')).toHaveLength(32);
    expect(secrets.assetIdentitySalt).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(Object.values(secrets))).toHaveLength(4);
  });

  it('creates protected state atomically without placing secret literals in non-secret files', () => {
    const root = compatibleRoot();
    const { random, calls } = deterministicRandom();

    const results = reconcileSelfHostFiles({ root, random });

    expect(results).toEqual([
      { path: '.self-host/.env', status: 'created' },
      { path: '.self-host/.env.postgres', status: 'created' },
      { path: '.self-host/.env.noodle', status: 'created' },
      { path: '.self-host/.env.operator', status: 'created' },
      { path: '.self-host/compose.generated.yaml', status: 'created' },
      { path: 'noodle.service.yaml', status: 'created' },
    ]);
    expect(calls).toEqual([32, 24, 32, 32]);
    expect(statSync(join(root, '.self-host')).mode & 0o777).toBe(0o700);
    for (const filename of ['.env', '.env.postgres', '.env.noodle', '.env.operator']) {
      expect(statSync(join(root, '.self-host', filename)).mode & 0o777).toBe(0o600);
    }
    expect(statSync(join(root, '.self-host', 'compose.generated.yaml')).mode & 0o777).toBe(0o644);
    expect(statSync(join(root, 'noodle.service.yaml')).mode & 0o777).toBe(0o644);

    const env = parseEnv(root);
    expect(env.POSTGRES_PASSWORD).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(env.DATABASE_URL).toBe(
      `postgresql://noodle:${env.POSTGRES_PASSWORD}@postgres:5432/noodle`,
    );
    expect(env.NOODLE_SECRET_MASTER_KEY).toBeDefined();
    expect(env.NOODLE_SELF_HOST_ADMIN_TOKEN).toBeDefined();
    expect(env.NOODLE_ASSET_IDENTITY_SALT).toBeDefined();
    expect(env.PUBLIC_BASE_URL).toBe('http://127.0.0.1:8787');
    expect(parseEnv(root, '.env.postgres')).toEqual({
      POSTGRES_DB: env.POSTGRES_DB,
      POSTGRES_PASSWORD: env.POSTGRES_PASSWORD,
      POSTGRES_USER: env.POSTGRES_USER,
    });
    expect(parseEnv(root, '.env.operator')).toEqual({
      NOODLE_SELF_HOST_ADMIN_TOKEN: env.NOODLE_SELF_HOST_ADMIN_TOKEN,
    });
    expect(parseEnv(root, '.env.noodle')).toEqual({
      DATABASE_URL: env.DATABASE_URL,
      HOST: env.HOST,
      NOODLE_ASSET_IDENTITY_SALT: env.NOODLE_ASSET_IDENTITY_SALT,
      NOODLE_ASSET_ROOT: env.NOODLE_ASSET_ROOT,
      NOODLE_SECRET_MASTER_KEY: env.NOODLE_SECRET_MASTER_KEY,
      NOODLE_SELF_HOST_ADMIN_TOKEN: env.NOODLE_SELF_HOST_ADMIN_TOKEN,
      PORT: env.PORT,
      PUBLIC_BASE_URL: env.PUBLIC_BASE_URL,
    });

    const publicFiles = [
      readFileSync(join(root, '.self-host', 'compose.generated.yaml'), 'utf8'),
      readFileSync(join(root, 'noodle.service.yaml'), 'utf8'),
    ].join('\n');
    for (const secret of [
      env.POSTGRES_PASSWORD,
      env.NOODLE_SECRET_MASTER_KEY,
      env.NOODLE_SELF_HOST_ADMIN_TOKEN,
      env.NOODLE_ASSET_IDENTITY_SALT,
      env.DATABASE_URL,
    ]) {
      expect(publicFiles).not.toContain(secret);
    }
    expect(existsSync(join(root, '.self-host', '.env.tmp'))).toBe(false);
  });

  it('is byte-identical on rerun and does not request fresh randomness', () => {
    const root = compatibleRoot();
    reconcileSelfHostFiles({ root, random: deterministicRandom().random });
    const before = readFileSync(join(root, '.self-host', '.env'));
    const unexpected: number[] = [];

    const results = reconcileSelfHostFiles({
      root,
      random: (bytes) => {
        unexpected.push(bytes);
        return Buffer.alloc(bytes);
      },
    });

    expect(results.every((result) => result.status === 'unchanged')).toBe(true);
    expect(unexpected).toEqual([]);
    expect(readFileSync(join(root, '.self-host', '.env'))).toEqual(before);
  });

  it('projects portable OAuth only into the service environment', () => {
    const root = compatibleRoot();
    reconcileSelfHostFiles({ root, random: deterministicRandom().random });
    const canonicalPath = join(root, '.self-host', '.env');
    writeFileSync(
      canonicalPath,
      `${readFileSync(canonicalPath, 'utf8')}NOODLE_OAUTH_ISSUER=https://auth.example\nNOODLE_OAUTH_JWKS_URI=https://auth.example/jwks\n`,
    );

    reconcileSelfHostFiles({ root });

    expect(parseEnv(root, '.env.noodle')).toMatchObject({
      NOODLE_OAUTH_ISSUER: 'https://auth.example',
      NOODLE_OAUTH_JWKS_URI: 'https://auth.example/jwks',
    });
    expect(parseEnv(root, '.env.postgres')).not.toHaveProperty('NOODLE_OAUTH_ISSUER');
    expect(parseEnv(root, '.env.operator')).not.toHaveProperty('NOODLE_OAUTH_ISSUER');
  });

  it('never projects unrelated canonical secrets into service-specific environments', () => {
    const root = compatibleRoot();
    reconcileSelfHostFiles({ root, random: deterministicRandom().random });
    const canonicalPath = join(root, '.self-host', '.env');
    writeFileSync(
      canonicalPath,
      `${readFileSync(canonicalPath, 'utf8')}AWS_SECRET_ACCESS_KEY=unrelated-secret\nUNRELATED_SETTING=operator-value\n`,
    );

    reconcileSelfHostFiles({ root });

    for (const filename of ['.env.postgres', '.env.noodle', '.env.operator']) {
      expect(parseEnv(root, filename)).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
      expect(parseEnv(root, filename)).not.toHaveProperty('UNRELATED_SETTING');
    }
  });

  it('rebuilds service-specific files after the canonical environment is restored', () => {
    const root = compatibleRoot();
    reconcileSelfHostFiles({ root, random: deterministicRandom().random });
    const canonical = readFileSync(join(root, '.self-host', '.env'));
    const originalNoodle = readFileSync(join(root, '.self-host', '.env.noodle'));
    const originalPostgres = readFileSync(join(root, '.self-host', '.env.postgres'));
    const originalOperator = readFileSync(join(root, '.self-host', '.env.operator'));
    reconcileSelfHostFiles({
      root,
      replaceSecrets: true,
      random: deterministicRandom(20).random,
    });
    writeFileSync(join(root, '.self-host', '.env'), canonical);

    reconcileSelfHostFiles({ root });

    expect(readFileSync(join(root, '.self-host', '.env.noodle'))).toEqual(originalNoodle);
    expect(readFileSync(join(root, '.self-host', '.env.postgres'))).toEqual(originalPostgres);
    expect(readFileSync(join(root, '.self-host', '.env.operator'))).toEqual(originalOperator);
  });

  it('reconciles partial state and changes non-secret templates only with force', () => {
    const root = compatibleRoot();
    mkdirSync(join(root, '.self-host'), { mode: 0o755 });
    writeFileSync(join(root, 'noodle.service.yaml'), 'profile: open-core\n# operator edit\n');

    const first = reconcileSelfHostFiles({ root, random: deterministicRandom().random });
    expect(first).toContainEqual({ path: 'noodle.service.yaml', status: 'skipped' });
    expect(readFileSync(join(root, 'noodle.service.yaml'), 'utf8')).toContain('# operator edit');
    expect(statSync(join(root, '.self-host')).mode & 0o777).toBe(0o700);

    const originalEnv = readFileSync(join(root, '.self-host', '.env'));
    const second = reconcileSelfHostFiles({
      root,
      force: true,
      random: () => {
        throw new Error('force must not rotate existing secrets');
      },
    });
    expect(second).toContainEqual({ path: 'noodle.service.yaml', status: 'replaced' });
    expect(readFileSync(join(root, 'noodle.service.yaml'), 'utf8')).toBe('profile: open-core\n');
    expect(readFileSync(join(root, '.self-host', '.env'))).toEqual(originalEnv);
  });

  it('rotates all secrets together only when replaceSecrets is explicit', () => {
    const root = compatibleRoot();
    reconcileSelfHostFiles({ root, random: deterministicRandom().random });
    const before = parseEnv(root);
    const replacement = deterministicRandom(10);

    const results = reconcileSelfHostFiles({
      root,
      replaceSecrets: true,
      random: replacement.random,
    });
    const after = parseEnv(root);

    expect(results).toContainEqual({ path: '.self-host/.env', status: 'replaced' });
    expect(replacement.calls).toEqual([32, 24, 32, 32]);
    for (const key of [
      'POSTGRES_PASSWORD',
      'DATABASE_URL',
      'NOODLE_SECRET_MASTER_KEY',
      'NOODLE_SELF_HOST_ADMIN_TOKEN',
      'NOODLE_ASSET_IDENTITY_SALT',
    ]) {
      expect(after[key]).not.toBe(before[key]);
    }
  });

  it.each([
    '.self-host',
    '.self-host/.env',
    '.self-host/.env.postgres',
    '.self-host/.env.noodle',
    '.self-host/.env.operator',
    '.self-host/compose.generated.yaml',
    'noodle.service.yaml',
  ])('rejects a symlink at %s before generating secrets', (relativePath) => {
    const root = compatibleRoot();
    if (relativePath !== '.self-host') mkdirSync(join(root, '.self-host'), { mode: 0o700 });
    symlinkSync(join(root, 'package.json'), join(root, relativePath));
    const calls: number[] = [];

    expect(() =>
      reconcileSelfHostFiles({
        root,
        random: (bytes) => {
          calls.push(bytes);
          return Buffer.alloc(bytes);
        },
      }),
    ).toThrow(/symbolic link/i);
    expect(calls).toEqual([]);
  });

  it('rejects a symlink at an atomic temporary target', () => {
    const root = compatibleRoot();
    mkdirSync(join(root, '.self-host'), { mode: 0o700 });
    symlinkSync(join(root, 'package.json'), join(root, '.self-host', '.env.tmp'));

    expect(() => reconcileSelfHostFiles({ root, random: deterministicRandom().random })).toThrow(
      /temporary.*symbolic link/i,
    );
  });

  it('removes a temporary file when its atomic rename fails', () => {
    const root = compatibleRoot();

    expect(() =>
      reconcileSelfHostFiles({
        root,
        random: deterministicRandom().random,
        rename: () => {
          throw new Error('simulated rename failure');
        },
      }),
    ).toThrow('simulated rename failure');
    expect(existsSync(join(root, '.self-host', '.env.tmp'))).toBe(false);
  });

  it.each([
    undefined,
    { composeInitVersion: COMPOSE_INIT_VERSION + 1 },
    { composeInitVersion: '1' },
  ])('rejects a missing or incompatible repository marker before writing', (noodleCore) => {
    const root = compatibleRoot();
    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify({ name: 'noodle-core', private: true, noodleCore })}\n`,
    );

    expect(() => reconcileSelfHostFiles({ root, random: deterministicRandom().random })).toThrow(
      /compatible Noodle Core checkout/i,
    );
    expect(existsSync(join(root, '.self-host'))).toBe(false);
    expect(existsSync(join(root, 'noodle.service.yaml'))).toBe(false);
  });

  it('repairs generated file modes without changing their bytes', () => {
    const root = compatibleRoot();
    reconcileSelfHostFiles({ root, random: deterministicRandom().random });
    chmodSync(join(root, '.self-host', '.env'), 0o644);
    chmodSync(join(root, '.self-host', '.env.noodle'), 0o644);
    chmodSync(join(root, '.self-host', 'compose.generated.yaml'), 0o600);

    reconcileSelfHostFiles({
      root,
      random: () => {
        throw new Error('mode repair must not rotate secrets');
      },
    });

    expect(lstatSync(join(root, '.self-host', '.env')).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(root, '.self-host', '.env.noodle')).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(root, '.self-host', 'compose.generated.yaml')).mode & 0o777).toBe(0o644);
  });
});
