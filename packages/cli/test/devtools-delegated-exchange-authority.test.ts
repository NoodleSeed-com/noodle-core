import { execFile } from 'node:child_process';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { exportPKCS8, generateKeyPair, importPKCS8 } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLocalDevtoolsDelegatedExchangeAuthority,
  LocalDevtoolsDelegatedExchangeAuthorityError,
} from '../src/devtools-delegated-exchange-authority.js';

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const KEY_RELATIVE_PATH = join('.noodle', 'devtools', 'delegated-exchange-signing-key.pem');
const TRUST_STATE_RELATIVE_PATH = join('.noodle', 'devtools', 'delegated-exchange-last-issuer');
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'] as const;

function keyPath(projectRoot: string): string {
  return join(projectRoot, KEY_RELATIVE_PATH);
}

function trustStatePath(projectRoot: string): string {
  return join(projectRoot, TRUST_STATE_RELATIVE_PATH);
}

function devtoolsDirectory(projectRoot: string): string {
  return dirname(keyPath(projectRoot));
}

function safeErrorMessage(path: string): string {
  return `Local delegated-exchange key is unsafe or unreadable. Stop Devtools, secure or remove ${JSON.stringify(path)}, then start again and update development endpoint trust.`;
}

async function createValidKeyFile(projectRoot: string): Promise<string> {
  const path = keyPath(projectRoot);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const pair = await generateKeyPair('RS256', { extractable: true });
  await writeFile(path, await exportPKCS8(pair.privateKey), { mode: 0o600 });
  return path;
}

async function expectUnsafeKey(projectRoot: string, forbiddenText?: string): Promise<void> {
  const path = keyPath(projectRoot);
  const authority = createLocalDevtoolsDelegatedExchangeAuthority(projectRoot);
  expect(authority.trustDocument()).toBeUndefined();

  let thrown: unknown;
  try {
    await authority.resolve();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(LocalDevtoolsDelegatedExchangeAuthorityError);
  expect(thrown).toMatchObject({
    name: 'LocalDevtoolsDelegatedExchangeAuthorityError',
    code: 'local_delegated_exchange_key_invalid',
    path,
    message: safeErrorMessage(path),
  });
  if (forbiddenText !== undefined) {
    expect((thrown as Error).message).not.toContain(forbiddenText);
  }
  expect(authority.trustDocument()).toBeUndefined();
}

async function expectUnsafeTrustState(projectRoot: string): Promise<void> {
  const path = trustStatePath(projectRoot);
  const authority = createLocalDevtoolsDelegatedExchangeAuthority(projectRoot);

  await expect(authority.resolve()).rejects.toMatchObject({
    name: 'LocalDevtoolsDelegatedExchangeAuthorityError',
    code: 'local_delegated_exchange_trust_state_invalid',
    path,
    message: `Local delegated-exchange trust state is unsafe or unreadable. Stop Devtools, secure or remove ${JSON.stringify(path)}, then start again and update development endpoint trust.`,
  });
  expect(authority.trustDocument()).toBeUndefined();
}

describe('local Devtools delegated-exchange authority', () => {
  let projectRoot: string | undefined;

  async function makeProject(): Promise<string> {
    projectRoot = await mkdtemp(join(tmpdir(), 'noodle-local-authority-'));
    return projectRoot;
  }

  afterEach(async () => {
    if (projectRoot !== undefined) {
      await rm(projectRoot, { recursive: true, force: true });
      projectRoot = undefined;
    }
  });

  it('is lazy and creates no Devtools directory or key during construction', async () => {
    const root = await makeProject();
    const authority = createLocalDevtoolsDelegatedExchangeAuthority(root);

    expect(authority.trustDocument()).toBeUndefined();
    await expect(stat(devtoolsDirectory(root))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(keyPath(root))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('persists a PKCS#8 RS256 key with owner-only permissions and publishes its trust document', async () => {
    const root = await makeProject();
    const authority = createLocalDevtoolsDelegatedExchangeAuthority(root);
    const firstPromise = authority.resolve();
    const secondPromise = authority.resolve();

    expect(firstPromise).toBe(secondPromise);
    const [resolved, sameResolved] = await Promise.all([firstPromise, secondPromise]);
    expect(sameResolved).toBe(resolved);

    const path = keyPath(root);
    const privateKeyPem = await readFile(path, 'utf8');
    await expect(importPKCS8(privateKeyPem, 'RS256')).resolves.toBeDefined();
    expect(privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect((await stat(devtoolsDirectory(root))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const trust = authority.trustDocument();
    const signingKey = await resolved.signer.signingKey();
    expect(trust).toEqual({
      issuer: `urn:noodleseed:devtools:${signingKey.kid}`,
      jwks: await resolved.signer.publicJwks(),
      trustChanged: false,
    });
    expect(await readFile(trustStatePath(root), 'utf8')).toBe(trust?.issuer);
    expect((await stat(trustStatePath(root))).mode & 0o777).toBe(0o600);
    expect(resolved.issuer).toBe(trust?.issuer);
    expect(Object.isFrozen(trust)).toBe(true);
    expect(Object.isFrozen(trust?.jwks)).toBe(true);
    expect(Object.isFrozen(trust?.jwks.keys)).toBe(true);
    expect(Object.isFrozen(trust?.jwks.keys[0])).toBe(true);
  });

  it('reuses one project key across authority instances', async () => {
    const root = await makeProject();
    const first = createLocalDevtoolsDelegatedExchangeAuthority(root);
    const firstResolved = await first.resolve();
    const firstTrust = first.trustDocument();
    const second = createLocalDevtoolsDelegatedExchangeAuthority(root);
    const secondResolved = await second.resolve();
    const secondTrust = second.trustDocument();

    expect(secondResolved.issuer).toBe(firstResolved.issuer);
    expect((await secondResolved.signer.signingKey()).kid).toBe(
      (await firstResolved.signer.signingKey()).kid,
    );
    expect(secondTrust?.jwks).toEqual(firstTrust?.jwks);
  });

  it('publishes exactly one public RS256 signing JWK and no private key material', async () => {
    const root = await makeProject();
    const authority = createLocalDevtoolsDelegatedExchangeAuthority(root);
    const resolved = await authority.resolve();
    const trust = authority.trustDocument();
    const jwk = trust?.jwks.keys[0];

    expect(trust?.jwks.keys).toHaveLength(1);
    expect(Object.keys(jwk ?? {}).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use']);
    expect(jwk).toMatchObject({
      kty: 'RSA',
      kid: (await resolved.signer.signingKey()).kid,
      alg: 'RS256',
      use: 'sig',
    });
    expect(typeof jwk?.n).toBe('string');
    expect(typeof jwk?.e).toBe('string');
    for (const member of PRIVATE_JWK_MEMBERS) {
      expect(jwk).not.toHaveProperty(member);
    }
    expect(JSON.stringify(trust?.jwks)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(trust?.jwks)).not.toContain('-----BEGIN');
  });

  it('creates a different project issuer after an offline key deletion', async () => {
    const root = await makeProject();
    const first = createLocalDevtoolsDelegatedExchangeAuthority(root);
    const firstIssuer = (await first.resolve()).issuer;

    await rm(keyPath(root));
    const replacement = createLocalDevtoolsDelegatedExchangeAuthority(root);
    const replacementIssuer = (await replacement.resolve()).issuer;

    expect(replacementIssuer).not.toBe(firstIssuer);
    expect(replacement.trustDocument()?.issuer).toBe(replacementIssuer);
    expect(replacement.trustDocument()?.trustChanged).toBe(true);

    const restarted = createLocalDevtoolsDelegatedExchangeAuthority(root);
    await restarted.resolve();
    expect(restarted.trustDocument()?.trustChanged).toBe(false);
  });

  it('fails closed for malformed PEM without exposing parser text or file contents', async () => {
    const root = await makeProject();
    const marker = 'private-malformed-key-marker';
    const path = keyPath(root);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, marker, { mode: 0o600 });

    await expectUnsafeKey(root, marker);
  });

  it('fails closed when persisted trust state is a symlink', async () => {
    const root = await makeProject();
    await createValidKeyFile(root);
    const outside = join(root, 'outside-trust-state');
    await writeFile(outside, 'urn:noodleseed:devtools:outside', { mode: 0o600 });
    await symlink(outside, trustStatePath(root));

    await expectUnsafeTrustState(root);
  });

  it.each([
    ['group-readable', 0o640],
    ['world-readable', 0o604],
  ])('fails closed when the key is %s', async (_label, mode) => {
    const root = await makeProject();
    const path = await createValidKeyFile(root);
    await chmod(path, mode);
    try {
      await expectUnsafeKey(root);
    } finally {
      await chmod(path, 0o600);
    }
  });

  it('fails closed when the key path is a symlink', async () => {
    const root = await makeProject();
    const path = keyPath(root);
    const target = join(root, 'outside-key.pem');
    const marker = 'symlink-target-private-marker';
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(target, marker, { mode: 0o600 });
    await symlink(target, path);

    await expectUnsafeKey(root, marker);
  });

  it('fails closed when the key path is not a regular file', async () => {
    const root = await makeProject();
    const path = keyPath(root);
    await mkdir(path, { recursive: true, mode: 0o700 });

    await expectUnsafeKey(root);
  });

  it('fails closed promptly when the key path is a FIFO', async () => {
    const root = await makeProject();
    const path = keyPath(root);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await execFileAsync('mkfifo', [path]);
    const authority = createLocalDevtoolsDelegatedExchangeAuthority(root);
    const resolution = authority.resolve().then(
      () => undefined,
      (error: unknown) => error,
    );
    const timeout = Symbol('FIFO open remained blocked');
    const settledBeforeWriter = await Promise.race([
      resolution,
      new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), 200)),
    ]);

    if (settledBeforeWriter === timeout) {
      const writer = await open(path, 'w');
      await writer.close();
    }
    const thrown = await resolution;

    expect(settledBeforeWriter).not.toBe(timeout);
    expect(thrown).toBeInstanceOf(LocalDevtoolsDelegatedExchangeAuthorityError);
    expect(thrown).toMatchObject({
      code: 'local_delegated_exchange_key_invalid',
      path,
      message: safeErrorMessage(path),
    });
    expect(authority.trustDocument()).toBeUndefined();
  });

  it('fails closed when the key file exceeds 16 KiB', async () => {
    const root = await makeProject();
    const path = keyPath(root);
    const marker = 'oversized-private-marker';
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${marker}${'x'.repeat(16 * 1024)}`, { mode: 0o600 });

    await expectUnsafeKey(root, marker);
  });

  it('fails closed when an existing key has extra hard links', async () => {
    const root = await makeProject();
    const path = await createValidKeyFile(root);
    await link(path, join(root, 'linked-private-key.pem'));

    await expectUnsafeKey(root);
  });

  it('fails closed when the Devtools state path is not a directory', async () => {
    const root = await makeProject();
    const directory = devtoolsDirectory(root);
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    await writeFile(directory, 'not-a-directory', { mode: 0o600 });

    await expectUnsafeKey(root, 'not-a-directory');
  });

  it("fails closed when the project's .noodle ancestor redirects to another project", async () => {
    const root = await makeProject();
    const otherProject = join(root, 'other-project');
    await mkdir(otherProject, { mode: 0o700 });
    const otherAuthority = createLocalDevtoolsDelegatedExchangeAuthority(otherProject);
    await otherAuthority.resolve();
    const otherKeyBefore = await readFile(keyPath(otherProject), 'utf8');
    await symlink(join(otherProject, '.noodle'), join(root, '.noodle'));

    await expectUnsafeKey(root);

    expect(await readFile(keyPath(otherProject), 'utf8')).toBe(otherKeyBefore);
  });

  it.each([
    ['group-accessible', 0o750],
    ['world-accessible', 0o705],
  ])('fails closed when the Devtools state directory is %s', async (_label, mode) => {
    const root = await makeProject();
    const directory = devtoolsDirectory(root);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, mode);
    try {
      await expectUnsafeKey(root);
    } finally {
      await chmod(directory, 0o700);
    }
  });

  it('atomically converges concurrent first use on one complete project key', async () => {
    const root = await makeProject();
    const path = keyPath(root);
    const authorities = Array.from({ length: 8 }, () =>
      createLocalDevtoolsDelegatedExchangeAuthority(root),
    );
    let resolutionsComplete = false;
    let observedPublishedKey = false;
    let observationError: unknown;
    const observePublishedKey = (async () => {
      while (!resolutionsComplete) {
        try {
          const privateKeyPem = await readFile(path, 'utf8');
          observedPublishedKey = true;
          await importPKCS8(privateKeyPem, 'RS256');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            observationError = error;
            return;
          }
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();

    let resolved: Awaited<ReturnType<(typeof authorities)[number]['resolve']>>[];
    try {
      resolved = await Promise.all(authorities.map((authority) => authority.resolve()));
    } finally {
      resolutionsComplete = true;
      await observePublishedKey;
    }
    if (observationError !== undefined) {
      throw observationError;
    }

    expect(new Set(resolved.map((authority) => authority.issuer))).toHaveLength(1);
    expect(new Set(authorities.map((authority) => authority.trustDocument()?.issuer))).toHaveLength(
      1,
    );
    expect(observedPublishedKey).toBe(true);
    expect((await readdir(devtoolsDirectory(root))).sort()).toEqual([
      'delegated-exchange-last-issuer',
      'delegated-exchange-signing-key.pem',
    ]);
    expect((await stat(path)).nlink).toBe(1);
  });

  it('keeps the project key path ignored by git', async () => {
    const { stdout } = await execFileAsync(
      'git',
      ['check-ignore', '.noodle/devtools/delegated-exchange-signing-key.pem'],
      { cwd: REPOSITORY_ROOT },
    );

    expect(stdout.trim()).toBe('.noodle/devtools/delegated-exchange-signing-key.pem');
  });
});
