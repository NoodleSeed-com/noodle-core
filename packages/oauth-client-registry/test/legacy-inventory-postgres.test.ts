import { spawn } from 'node:child_process';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DATABASE_URL = process.env.DATABASE_URL_TEST;
const ROOT = resolve(import.meta.dirname, '../../..');
const SUCCESS_SCHEMA = `oauth_inventory_success_${process.pid}`;
const FAILURE_SCHEMA = `oauth_inventory_failure_${process.pid}`;
const APPLICATION_NAME = 'noodle-oauth-redirect-inventory';

describe.skipIf(!DATABASE_URL)('OAuth redirect inventory PostgreSQL boundary', () => {
  let admin: Pool;
  let keyDirectory: string;
  let keyPath: string;

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await installInventoryFixture(admin, SUCCESS_SCHEMA, false);
    await installInventoryFixture(admin, FAILURE_SCHEMA, true);
    keyDirectory = await mkdtemp(join(tmpdir(), 'noodle-oauth-inventory-postgres-'));
    keyPath = join(keyDirectory, 'fingerprint-key');
    const key = await open(keyPath, 'wx', 0o600);
    await key.writeFile('ab'.repeat(32), 'utf8');
    await key.close();
  });

  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS "${SUCCESS_SCHEMA}" CASCADE`);
    await admin.query(`DROP SCHEMA IF EXISTS "${FAILURE_SCHEMA}" CASCADE`);
    await admin.end();
    await rm(keyDirectory, { recursive: true });
  });

  it('uses a narrow keyset query in one read-only repeatable-read snapshot and visits every row once', async () => {
    const execution = runInventoryCommand(SUCCESS_SCHEMA);
    const [result, observedQuery] = await Promise.all([execution, waitForInventoryQuery(admin)]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain(keyPath);
    expect(result.stderr).not.toContain(DATABASE_URL as string);
    const summary = JSON.parse(result.stdout) as InventoryOutput;
    expect(summary).toMatchObject({
      schemaVersion: 1,
      complete: true,
      scannedClientCount: 109,
      normalizedCount: 102,
      legacyClasses: {
        safe_https: { count: 1 },
        safe_loopback_legacy: { count: 1 },
        unsafe_legacy: { count: 4 },
        malformed_legacy: { count: 1 },
      },
    });
    expect(summary.legacyClasses.safe_loopback_legacy.clientFingerprints).toHaveLength(1);
    expect(summary.legacyClasses.unsafe_legacy.clientFingerprints).toHaveLength(4);
    expect(summary.legacyClasses.malformed_legacy.clientFingerprints).toHaveLength(1);
    expect(summary.legacyClasses.safe_https).not.toHaveProperty('clientFingerprints');

    const normalizedQuery = observedQuery.replace(/\s+/g, ' ').trim();
    expect(normalizedQuery).toContain('SELECT client_id,');
    for (const field of [
      'application_type',
      'redirect_uris',
      'token_endpoint_auth_method',
      'noodle_redirect_policy_version',
    ]) {
      expect(normalizedQuery).toContain(`'present', client ? '${field}'`);
      expect(normalizedQuery).toContain(`'value', client -> '${field}'`);
      expect(normalizedQuery).toContain(`AS ${field}`);
    }
    expect(normalizedQuery.match(/client \? '[^']+'/g)).toEqual([
      "client ? 'application_type'",
      "client ? 'redirect_uris'",
      "client ? 'token_endpoint_auth_method'",
      "client ? 'noodle_redirect_policy_version'",
    ]);
    expect(normalizedQuery.match(/client -> '[^']+'/g)).toEqual([
      "client -> 'application_type'",
      "client -> 'redirect_uris'",
      "client -> 'token_endpoint_auth_method'",
      "client -> 'noodle_redirect_policy_version'",
    ]);
    expect(normalizedQuery).toContain('client_id COLLATE "C" >');
    expect(normalizedQuery).toContain('ORDER BY client_id COLLATE "C" ASC');
    expect(normalizedQuery).toContain('LIMIT $2');
    expect(normalizedQuery).not.toMatch(/SELECT\s+client(?:\s|,|$)/i);
    expect(normalizedQuery).not.toContain('client_secret');
    expect(normalizedQuery).not.toContain('oauth_refresh_tokens');
    expect(normalizedQuery).not.toContain('oauth_authorization_codes');
    expect(normalizedQuery).not.toContain('oauth_pending_authorizations');

    const serialized = JSON.stringify(summary);
    for (const forbidden of [
      '000-probe-normalized',
      'z01-safe-https',
      'z02-safe-loopback',
      'z00-marked-loopback',
      'z03-explicit-web-loopback',
      'z04-unsafe',
      'z05-malformed',
      'z06-null-application-type',
      'z07-null-token-method',
      'https://normalized.example/callback',
      'https://legacy.example/callback',
      'http://127.0.0.1:4567/callback',
      'http://attacker.example/callback',
      'not a URI',
      'stored-client-secret',
      'stored-refresh-token',
      'stored-request-state',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('returns non-zero and emits no summary when the database fails after the first page', async () => {
    const result = await runInventoryCommand(FAILURE_SCHEMA);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('OAuth redirect inventory failed; no summary was emitted.\n');
    expect(result.stderr).not.toContain(keyPath);
    expect(result.stderr).not.toContain(DATABASE_URL as string);
  });

  function runInventoryCommand(schema: string): Promise<CommandResult> {
    return runCommand(
      'pnpm',
      [
        '--silent',
        'oauth:dcr:inventory',
        '--',
        '--fingerprint-key-file',
        keyPath,
        '--format',
        'json',
      ],
      {
        ...process.env,
        NOODLE_OAUTH_INVENTORY_DATABASE_URL: databaseUrlForSchema(DATABASE_URL as string, schema),
      },
    );
  }
});

async function installInventoryFixture(admin: Pool, schema: string, failMidScan: boolean) {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.query(`
    CREATE TABLE "${schema}".inventory_clients (
      client_id text PRIMARY KEY,
      client jsonb NOT NULL,
      client_secret text NOT NULL
    );
    CREATE TABLE "${schema}".oauth_refresh_tokens (token text NOT NULL);
    CREATE TABLE "${schema}".oauth_pending_authorizations (state text NOT NULL);
  `);
  await admin.query(
    `CREATE FUNCTION "${schema}".guard_inventory_row(input_client_id text, input_client jsonb)
       RETURNS jsonb
       LANGUAGE plpgsql
       AS $function$
       BEGIN
         IF current_setting('transaction_isolation') <> 'repeatable read'
            OR current_setting('transaction_read_only') <> 'on' THEN
           RAISE EXCEPTION 'inventory transaction is not repeatable-read and read-only';
         END IF;
         IF input_client_id = '000-probe-normalized' THEN
           PERFORM pg_sleep(1);
         END IF;
         IF ${failMidScan ? 'TRUE' : 'FALSE'} AND input_client_id = 'z05-malformed' THEN
           RAISE EXCEPTION 'forced private mid-scan failure';
         END IF;
         RETURN input_client;
       END
       $function$`,
  );
  await admin.query(`
    CREATE VIEW "${schema}".oauth_clients AS
      SELECT client_id,
             "${schema}".guard_inventory_row(client_id, client) AS client,
             client_secret
        FROM "${schema}".inventory_clients
  `);

  const clients = [
    fixtureClient('000-probe-normalized', {
      application_type: 'web',
      redirect_uris: ['https://normalized.example/callback'],
      token_endpoint_auth_method: 'none',
    }),
    ...Array.from({ length: 100 }, (_, index) =>
      fixtureClient(`1${String(index).padStart(2, '0')}-normalized`, {
        application_type: 'web',
        redirect_uris: ['https://normalized.example/callback'],
        token_endpoint_auth_method: 'none',
      }),
    ),
    fixtureClient('z00-marked-loopback', {
      application_type: 'web',
      redirect_uris: ['http://127.0.0.1:4567/callback'],
      token_endpoint_auth_method: 'none',
      noodle_redirect_policy_version: 1,
    }),
    fixtureClient('z01-safe-https', {
      redirect_uris: ['https://legacy.example/callback'],
      token_endpoint_auth_method: 'none',
    }),
    fixtureClient('z02-safe-loopback', {
      redirect_uris: ['http://127.0.0.1:4567/callback'],
      token_endpoint_auth_method: 'none',
    }),
    fixtureClient('z03-explicit-web-loopback', {
      application_type: 'web',
      redirect_uris: ['http://127.0.0.1:4567/callback'],
      token_endpoint_auth_method: 'none',
    }),
    fixtureClient('z04-unsafe', {
      redirect_uris: ['http://attacker.example/callback'],
      token_endpoint_auth_method: 'none',
    }),
    fixtureClient('z05-malformed', {
      redirect_uris: ['not a URI'],
      token_endpoint_auth_method: 'none',
    }),
    fixtureClient('z06-null-application-type', {
      application_type: null,
      redirect_uris: ['https://explicit-null.example/callback'],
      token_endpoint_auth_method: 'none',
    }),
    fixtureClient('z07-null-token-method', {
      application_type: 'web',
      redirect_uris: ['http://127.0.0.1:9876/callback'],
      token_endpoint_auth_method: null,
      noodle_redirect_policy_version: 1,
    }),
  ];
  for (const client of clients) {
    await admin.query(
      `INSERT INTO "${schema}".inventory_clients (client_id, client, client_secret)
       VALUES ($1, $2::jsonb, 'stored-client-secret')`,
      [client.clientId, JSON.stringify(client.metadata)],
    );
  }
  await admin.query(
    `INSERT INTO "${schema}".oauth_refresh_tokens VALUES ('stored-refresh-token');
     INSERT INTO "${schema}".oauth_pending_authorizations VALUES ('stored-request-state')`,
  );
}

function fixtureClient(clientId: string, metadata: Record<string, unknown>) {
  return { clientId, metadata: { ...metadata, client_secret: 'stored-client-secret' } };
}

async function waitForInventoryQuery(admin: Pool): Promise<string> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const result = await admin.query<{ readonly query: string }>(
      `SELECT query FROM pg_stat_activity
       WHERE application_name = $1 AND state = 'active' AND query LIKE '%FROM oauth_clients%'
       LIMIT 1`,
      [APPLICATION_NAME],
    );
    const query = result.rows[0]?.query;
    if (query !== undefined) return query;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error('inventory query was not observed');
}

function databaseUrlForSchema(databaseUrl: string, schema: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}

function runCommand(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (exitCode) => resolveResult({ exitCode, stdout, stderr }));
  });
}

interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface InventoryOutput {
  readonly schemaVersion: 1;
  readonly complete: true;
  readonly scannedClientCount: number;
  readonly normalizedCount: number;
  readonly legacyClasses: {
    readonly safe_https: { readonly count: number };
    readonly safe_loopback_legacy: {
      readonly count: number;
      readonly clientFingerprints: readonly string[];
    };
    readonly unsafe_legacy: {
      readonly count: number;
      readonly clientFingerprints: readonly string[];
    };
    readonly malformed_legacy: {
      readonly count: number;
      readonly clientFingerprints: readonly string[];
    };
  };
}
