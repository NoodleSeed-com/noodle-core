import { mkdtemp, open, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectLegacyOAuthRedirectInventory,
  fingerprintOAuthClientId,
  readOAuthInventoryFingerprintKey,
  runLegacyOAuthRedirectInventoryCommand,
} from '../src/legacy-inventory.js';

const KEY_A_HEX = '01'.repeat(32);
const KEY_B_HEX = '02'.repeat(32);
const DATABASE_URL = 'postgresql://inventory-user:inventory-password@db.example/inventory';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('OAuth redirect inventory fingerprint key', () => {
  it.each([
    ['no terminator', KEY_A_HEX],
    ['one LF', `${KEY_A_HEX}\n`],
    ['one CRLF', `${KEY_A_HEX}\r\n`],
  ])('accepts 32 hex-encoded bytes with %s', async (_name, content) => {
    const path = await createKeyFile(content);

    await expect(readOAuthInventoryFingerprintKey(path)).resolves.toEqual(
      Buffer.from(KEY_A_HEX, 'hex'),
    );
  });

  it.each([
    ['a relative path', 'relative-key', KEY_A_HEX],
    ['group-readable mode', undefined, KEY_A_HEX, 0o640],
    ['too few bytes', undefined, '01'.repeat(31)],
    ['non-hex text', undefined, 'zz'.repeat(32)],
    ['two terminal newlines', undefined, `${KEY_A_HEX}\n\n`],
    ['a lone terminal CR', undefined, `${KEY_A_HEX}\r`],
  ])('rejects %s without reflecting the value or path', async (_name, suppliedPath, content, mode) => {
    const path = suppliedPath ?? (await createKeyFile(content, mode));

    const error = await readOAuthInventoryFingerprintKey(path).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(path);
    expect(String(error)).not.toContain(content);
  });

  it('rejects directories and symbolic links', async () => {
    const directory = await createTemporaryDirectory();
    const target = await createKeyFile(KEY_A_HEX, 0o600, directory);
    const link = join(directory, 'key-link');
    await symlink(target, link);

    await expect(readOAuthInventoryFingerprintKey(directory)).rejects.toThrow();
    await expect(readOAuthInventoryFingerprintKey(link)).rejects.toThrow();
  });

  it('rejects a large key file without reflecting its path or contents', async () => {
    const privateContent = `private-large-key-${'ab'.repeat(512 * 1024)}`;
    const path = await createKeyFile(privateContent);

    const error = await readOAuthInventoryFingerprintKey(path).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toBe('Error: OAuth inventory fingerprint key is invalid');
    expect(String(error)).not.toContain(path);
    expect(String(error)).not.toContain('private-large-key');
  });
});

describe('OAuth client fingerprints', () => {
  it('is deterministic for one key and isolated across keys', () => {
    const first = fingerprintOAuthClientId('private-client-id', Buffer.from(KEY_A_HEX, 'hex'));

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprintOAuthClientId('private-client-id', Buffer.from(KEY_A_HEX, 'hex'))).toBe(
      first,
    );
    expect(fingerprintOAuthClientId('private-client-id', Buffer.from(KEY_B_HEX, 'hex'))).not.toBe(
      first,
    );
  });
});

describe('OAuth redirect inventory summary', () => {
  it('preserves absent versus explicit-null policy fields and emits no private values', async () => {
    const rows = [
      inventoryRow('normalized-client', {
        application_type: 'web',
        redirect_uris: ['https://normalized.example/callback'],
        token_endpoint_auth_method: 'none',
      }),
      inventoryRow('safe-https-client', {
        redirect_uris: ['https://legacy.example/callback'],
        token_endpoint_auth_method: 'none',
      }),
      inventoryRow('null-application-type-client', {
        application_type: null,
        redirect_uris: ['https://explicit-null.example/callback'],
        token_endpoint_auth_method: 'none',
      }),
      inventoryRow('marked-loopback-client', {
        application_type: 'web',
        redirect_uris: ['http://127.0.0.1:4321/callback'],
        token_endpoint_auth_method: 'none',
        noodle_redirect_policy_version: 1,
      }),
      inventoryRow('loopback-client', {
        redirect_uris: ['http://127.0.0.1:4321/callback'],
        token_endpoint_auth_method: 'none',
      }),
      inventoryRow('explicit-web-loopback-client', {
        application_type: 'web',
        redirect_uris: ['http://127.0.0.1:4321/callback'],
        token_endpoint_auth_method: 'none',
      }),
      inventoryRow('null-token-method-client', {
        application_type: 'web',
        redirect_uris: ['http://127.0.0.1:9876/callback'],
        token_endpoint_auth_method: null,
        noodle_redirect_policy_version: 1,
      }),
      inventoryRow('unsafe-client', {
        redirect_uris: ['http://attacker.example/callback'],
        token_endpoint_auth_method: 'none',
      }),
      inventoryRow('malformed-client', {
        redirect_uris: ['not a URI'],
        token_endpoint_auth_method: 'none',
      }),
    ];
    const pool = poolReturningPages([rows]);
    const key = Buffer.from(KEY_A_HEX, 'hex');

    const counts = await collectLegacyOAuthRedirectInventory(pool, key);

    expect(counts).toEqual({
      scannedClientCount: 9,
      normalizedCount: 2,
      legacyClasses: {
        safe_https: { count: 1 },
        safe_loopback_legacy: {
          count: 1,
          clientFingerprints: [fingerprintOAuthClientId('loopback-client', key)],
        },
        unsafe_legacy: {
          count: 4,
          clientFingerprints: [
            fingerprintOAuthClientId('null-application-type-client', key),
            fingerprintOAuthClientId('explicit-web-loopback-client', key),
            fingerprintOAuthClientId('null-token-method-client', key),
            fingerprintOAuthClientId('unsafe-client', key),
          ],
        },
        malformed_legacy: {
          count: 1,
          clientFingerprints: [fingerprintOAuthClientId('malformed-client', key)],
        },
      },
    });

    const jsonOutput = captureOutput();
    const jsonExitCode = await runLegacyOAuthRedirectInventoryCommand({
      argv: ['--fingerprint-key-file', await createKeyFile(KEY_A_HEX), '--format', 'json'],
      env: { NOODLE_OAUTH_INVENTORY_DATABASE_URL: DATABASE_URL },
      ...jsonOutput,
      poolFactory: () => poolReturningPages([rows]),
    });
    const textOutput = captureOutput();
    const textExitCode = await runLegacyOAuthRedirectInventoryCommand({
      argv: ['--fingerprint-key-file', await createKeyFile(KEY_A_HEX), '--format', 'text'],
      env: { NOODLE_OAUTH_INVENTORY_DATABASE_URL: DATABASE_URL },
      ...textOutput,
      poolFactory: () => poolReturningPages([rows]),
    });

    expect(jsonExitCode).toBe(0);
    expect(textExitCode).toBe(0);
    const json = jsonOutput.stdoutText();
    const text = textOutput.stdoutText();
    expect(JSON.parse(json)).toMatchObject({ complete: true, scannedClientCount: 9 });
    for (const privateValue of [
      ...rows.map((row) => row.client_id),
      ...rows.flatMap((row) => row.redirect_uris.value as string[]),
    ]) {
      expect(json).not.toContain(privateValue);
      expect(text).not.toContain(privateValue);
    }
    expect(json).not.toContain(fingerprintOAuthClientId('safe-https-client', key));
    expect(text).not.toContain(fingerprintOAuthClientId('safe-https-client', key));
    expect(json).not.toContain(fingerprintOAuthClientId('marked-loopback-client', key));
    expect(text).not.toContain(fingerprintOAuthClientId('marked-loopback-client', key));
    expect(json).not.toContain(KEY_A_HEX);
    expect(text).not.toContain(KEY_A_HEX);
  });
});

describe('OAuth redirect inventory command', () => {
  it('accepts one package-manager argument separator before the documented flags', async () => {
    const keyPath = await createKeyFile(KEY_A_HEX);
    const output = captureOutput();

    const exitCode = await runLegacyOAuthRedirectInventoryCommand({
      argv: ['--', '--fingerprint-key-file', keyPath, '--format', 'json'],
      env: { NOODLE_OAUTH_INVENTORY_DATABASE_URL: DATABASE_URL },
      ...output,
      poolFactory: () => poolReturningPages([[]]),
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.stdoutText())).toMatchObject({
      complete: true,
      scannedClientCount: 0,
    });
    expect(output.stderrText()).toBe('');
  });

  it('requires the database URL from its dedicated environment variable', async () => {
    const keyPath = await createKeyFile(KEY_A_HEX);
    const output = captureOutput();
    const poolFactory = vi.fn();

    const exitCode = await runLegacyOAuthRedirectInventoryCommand({
      argv: ['--fingerprint-key-file', keyPath, '--format', 'json'],
      env: {},
      ...output,
      poolFactory,
    });

    expect(exitCode).toBe(1);
    expect(output.stdoutText()).toBe('');
    expect(output.stderrText()).not.toContain(keyPath);
    expect(poolFactory).not.toHaveBeenCalled();
  });

  it('rejects database URLs and unknown values on the command line without reflecting them', async () => {
    const keyPath = await createKeyFile(KEY_A_HEX);
    const output = captureOutput();
    const poolFactory = vi.fn();

    const exitCode = await runLegacyOAuthRedirectInventoryCommand({
      argv: ['--fingerprint-key-file', keyPath, '--database-url', DATABASE_URL, '--format', 'json'],
      env: { NOODLE_OAUTH_INVENTORY_DATABASE_URL: DATABASE_URL },
      ...output,
      poolFactory,
    });

    expect(exitCode).toBe(1);
    expect(output.stdoutText()).toBe('');
    expect(output.stderrText()).not.toContain(DATABASE_URL);
    expect(output.stderrText()).not.toContain(keyPath);
    expect(poolFactory).not.toHaveBeenCalled();
  });

  it.each([
    ['a page query fails after an earlier full page', 'page'],
    ['the transaction commit fails', 'commit'],
    ['the pool shutdown fails', 'shutdown'],
  ])('emits no complete-looking output when %s', async (_name, failure) => {
    const keyPath = await createKeyFile(KEY_A_HEX);
    const rows = Array.from({ length: 100 }, (_, index) =>
      inventoryRow(`client-${String(index).padStart(3, '0')}`, {
        redirect_uris: ['https://legacy.example/callback'],
        token_endpoint_auth_method: 'none',
      }),
    );
    const pool = poolReturningPages([rows], failure);
    const output = captureOutput();

    const exitCode = await runLegacyOAuthRedirectInventoryCommand({
      argv: ['--fingerprint-key-file', keyPath, '--format', 'json'],
      env: { NOODLE_OAUTH_INVENTORY_DATABASE_URL: DATABASE_URL },
      ...output,
      poolFactory: () => pool,
    });

    expect(exitCode).toBe(1);
    expect(output.stdoutText()).toBe('');
    expect(output.stderrText()).toBe('OAuth redirect inventory failed; no summary was emitted.\n');
    expect(output.stderrText()).not.toContain(DATABASE_URL);
    expect(output.stderrText()).not.toContain(keyPath);
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'noodle-oauth-inventory-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function createKeyFile(content: string, mode = 0o600, parent?: string): Promise<string> {
  const directory = parent ?? (await createTemporaryDirectory());
  const path = join(directory, `fingerprint-key-${Math.random().toString(16).slice(2)}`);
  const handle = await open(path, 'wx', mode);
  await handle.writeFile(content, 'utf8');
  await handle.close();
  return path;
}

function inventoryRow(
  clientId: string,
  metadata: {
    readonly application_type?: unknown;
    readonly redirect_uris: readonly string[];
    readonly token_endpoint_auth_method?: unknown;
    readonly noodle_redirect_policy_version?: unknown;
  },
) {
  return {
    client_id: clientId,
    application_type: inventoryField(metadata, 'application_type'),
    redirect_uris: inventoryField(metadata, 'redirect_uris'),
    token_endpoint_auth_method: inventoryField(metadata, 'token_endpoint_auth_method'),
    noodle_redirect_policy_version: inventoryField(metadata, 'noodle_redirect_policy_version'),
  };
}

function inventoryField(metadata: object, key: string) {
  return {
    present: Object.hasOwn(metadata, key),
    value: Reflect.get(metadata, key) as unknown,
  };
}

function poolReturningPages(
  pages: readonly (readonly ReturnType<typeof inventoryRow>[])[],
  failure?: string,
): Pool {
  let pageIndex = 0;
  const query = vi.fn(async (sql: string) => {
    if (sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') return { rows: [] };
    if (sql === 'COMMIT') {
      if (failure === 'commit') throw new Error('sensitive commit failure');
      return { rows: [] };
    }
    if (sql === 'ROLLBACK') return { rows: [] };
    if (failure === 'page' && pageIndex > 0) throw new Error('sensitive page failure');
    return { rows: pages[pageIndex++] ?? [] };
  });
  return {
    connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    end:
      failure === 'shutdown'
        ? vi.fn().mockRejectedValue(new Error('sensitive shutdown failure'))
        : vi.fn().mockResolvedValue(undefined),
  } as unknown as Pool;
}

function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout: {
      write: (value: string) => {
        stdout.push(value);
        return true;
      },
    },
    stderr: {
      write: (value: string) => {
        stderr.push(value);
        return true;
      },
    },
    stdoutText: () => stdout.join(''),
    stderrText: () => stderr.join(''),
  };
}
