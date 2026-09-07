import { createHmac } from 'node:crypto';
import { constants, type FileHandle, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  classifyStoredOAuthRedirectPolicy,
  type OAuthRedirectClientMetadata,
  type StoredRedirectPolicyClass,
} from '@noodle-borg/auth';
import { Pool, type QueryResult, type QueryResultRow } from 'pg';

const INVENTORY_PAGE_SIZE = 100;
const INVENTORY_APPLICATION_NAME = 'noodle-oauth-redirect-inventory';
const FAILED_MESSAGE = 'OAuth redirect inventory failed; no summary was emitted.\n';

const INVENTORY_PAGE_QUERY = `
  SELECT client_id,
         jsonb_build_object(
           'present', client ? 'application_type',
           'value', client -> 'application_type'
         ) AS application_type,
         jsonb_build_object(
           'present', client ? 'redirect_uris',
           'value', client -> 'redirect_uris'
         ) AS redirect_uris,
         jsonb_build_object(
           'present', client ? 'token_endpoint_auth_method',
           'value', client -> 'token_endpoint_auth_method'
         ) AS token_endpoint_auth_method,
         jsonb_build_object(
           'present', client ? 'noodle_redirect_policy_version',
           'value', client -> 'noodle_redirect_policy_version'
         ) AS noodle_redirect_policy_version
    FROM oauth_clients
   WHERE ($1::text IS NULL OR client_id COLLATE "C" > $1::text COLLATE "C")
   ORDER BY client_id COLLATE "C" ASC
   LIMIT $2
`;

type LegacyPolicyClass = Exclude<StoredRedirectPolicyClass, 'normalized'>;
type FingerprintedLegacyPolicyClass = Exclude<LegacyPolicyClass, 'safe_https'>;
type InventoryFormat = 'json' | 'text';

interface InventoryRow extends QueryResultRow {
  readonly client_id: string;
  readonly application_type: InventoryFieldEnvelope;
  readonly redirect_uris: InventoryFieldEnvelope;
  readonly token_endpoint_auth_method: InventoryFieldEnvelope;
  readonly noodle_redirect_policy_version: InventoryFieldEnvelope;
}

interface InventoryFieldEnvelope {
  readonly present: boolean;
  readonly value: unknown;
}

interface FingerprintedClassSummary {
  count: number;
  clientFingerprints: string[];
}

interface LegacyOAuthRedirectInventoryCounts {
  readonly scannedClientCount: number;
  readonly normalizedCount: number;
  readonly legacyClasses: {
    readonly safe_https: { readonly count: number };
    readonly safe_loopback_legacy: FingerprintedClassSummary;
    readonly unsafe_legacy: FingerprintedClassSummary;
    readonly malformed_legacy: FingerprintedClassSummary;
  };
}

interface LegacyOAuthRedirectInventorySummary {
  readonly schemaVersion: 1;
  readonly complete: true;
  readonly scannedClientCount: number;
  readonly normalizedCount: number;
  readonly legacyClasses: {
    readonly safe_https: { readonly count: number };
    readonly safe_loopback_legacy: FingerprintedClassSummary;
    readonly unsafe_legacy: FingerprintedClassSummary;
    readonly malformed_legacy: FingerprintedClassSummary;
  };
}

interface WritableOutput {
  write(value: string): unknown;
}

export interface LegacyOAuthRedirectInventoryCommandOptions {
  readonly argv?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdout?: WritableOutput;
  readonly stderr?: WritableOutput;
  readonly poolFactory?: (databaseUrl: string) => Pool;
}

/** Loads the one-run correlation key without exposing its contents or location in errors. */
export async function readOAuthInventoryFingerprintKey(path: string): Promise<Buffer> {
  if (!isAbsolute(path)) throw invalidFingerprintKey();

  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile() || (stats.mode & 0o7777) !== 0o600) throw invalidFingerprintKey();
    const boundedContent = Buffer.alloc(67);
    const { bytesRead } = await handle.read(boundedContent, 0, boundedContent.length, 0);
    const content = boundedContent.subarray(0, bytesRead);
    const encoded = removeOneTerminalLineEnding(content);
    if (encoded.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(encoded.toString('ascii'))) {
      throw invalidFingerprintKey();
    }
    const key = Buffer.from(encoded.toString('ascii'), 'hex');
    if (key.length !== 32) throw invalidFingerprintKey();
    return key;
  } catch {
    throw invalidFingerprintKey();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Produces a run-key-bound identifier that cannot be correlated after key rotation. */
export function fingerprintOAuthClientId(clientId: string, key: Buffer): string {
  if (key.length !== 32) throw invalidFingerprintKey();
  return createHmac('sha256', key).update(clientId, 'utf8').digest('hex');
}

/** Reads one complete database snapshot and returns only private, incomplete inventory counts. */
export async function collectLegacyOAuthRedirectInventory(
  pool: Pool,
  fingerprintKey: Buffer,
): Promise<LegacyOAuthRedirectInventoryCounts> {
  if (fingerprintKey.length !== 32) throw invalidFingerprintKey();
  const client = await pool.connect();
  let released = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const counts = mutableCounts();
    let cursor: string | null = null;

    for (;;) {
      const page: QueryResult<InventoryRow> = await client.query<InventoryRow>(
        INVENTORY_PAGE_QUERY,
        [cursor, INVENTORY_PAGE_SIZE],
      );
      if (page.rows.length > INVENTORY_PAGE_SIZE) throw new Error('invalid inventory page');
      for (const row of page.rows) addRowToCounts(counts, row, fingerprintKey);
      if (page.rows.length === 0) break;

      const nextCursor: string | undefined = page.rows.at(-1)?.client_id;
      if (typeof nextCursor !== 'string' || nextCursor === cursor) {
        throw new Error('invalid inventory cursor');
      }
      cursor = nextCursor;
      if (page.rows.length < INVENTORY_PAGE_SIZE) break;
    }

    await client.query('COMMIT');
    return counts;
  } catch (error) {
    let destroy = false;
    try {
      await client.query('ROLLBACK');
    } catch {
      destroy = true;
    }
    client.release(destroy);
    released = true;
    throw error;
  } finally {
    if (!released) client.release();
  }
}

/** Internal operator command entry point. It emits a summary only after scan, commit, and pool shutdown. */
export async function runLegacyOAuthRedirectInventoryCommand(
  options: LegacyOAuthRedirectInventoryCommandOptions = {},
): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  let pool: Pool | undefined;

  try {
    const parsed = parseArguments(argv);
    const databaseUrl = env.NOODLE_OAUTH_INVENTORY_DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.length === 0)
      throw new Error('missing database URL');
    const fingerprintKey = await readOAuthInventoryFingerprintKey(parsed.fingerprintKeyFile);
    const poolFactory = options.poolFactory ?? defaultPoolFactory;
    pool = poolFactory(databaseUrl);
    const counts = await collectLegacyOAuthRedirectInventory(pool, fingerprintKey);
    await pool.end();
    pool = undefined;
    const summary = completeInventorySummary(counts);
    const output = formatLegacyOAuthRedirectInventory(summary, parsed.format);
    stdout.write(output);
    return 0;
  } catch {
    await pool?.end().catch(() => undefined);
    stderr.write(FAILED_MESSAGE);
    return 1;
  }
}

/** Serializes only the documented, privacy-bounded summary fields. */
function formatLegacyOAuthRedirectInventory(
  summary: LegacyOAuthRedirectInventorySummary,
  format: InventoryFormat,
): string {
  if (format === 'json') return `${JSON.stringify(summary)}\n`;
  const { legacyClasses } = summary;
  return [
    `schema_version: ${summary.schemaVersion}`,
    `complete: ${summary.complete}`,
    `scanned_client_count: ${summary.scannedClientCount}`,
    `normalized_count: ${summary.normalizedCount}`,
    `safe_https_count: ${legacyClasses.safe_https.count}`,
    `safe_loopback_legacy_count: ${legacyClasses.safe_loopback_legacy.count}`,
    ...fingerprintLines(
      'safe_loopback_legacy',
      legacyClasses.safe_loopback_legacy.clientFingerprints,
    ),
    `unsafe_legacy_count: ${legacyClasses.unsafe_legacy.count}`,
    ...fingerprintLines('unsafe_legacy', legacyClasses.unsafe_legacy.clientFingerprints),
    `malformed_legacy_count: ${legacyClasses.malformed_legacy.count}`,
    ...fingerprintLines('malformed_legacy', legacyClasses.malformed_legacy.clientFingerprints),
    '',
  ].join('\n');
}

function defaultPoolFactory(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: 1,
    application_name: INVENTORY_APPLICATION_NAME,
  });
}

function parseArguments(argv: readonly string[]): {
  readonly fingerprintKeyFile: string;
  readonly format: InventoryFormat;
} {
  const commandArguments = argv[0] === '--' ? argv.slice(1) : argv;
  let fingerprintKeyFile: string | undefined;
  let format: InventoryFormat = 'text';
  let formatSeen = false;
  for (let index = 0; index < commandArguments.length; index += 2) {
    const flag = commandArguments[index];
    const value = commandArguments[index + 1];
    if (value === undefined) throw new Error('invalid arguments');
    if (flag === '--fingerprint-key-file' && fingerprintKeyFile === undefined) {
      fingerprintKeyFile = value;
      continue;
    }
    if (flag === '--format' && !formatSeen && (value === 'json' || value === 'text')) {
      format = value;
      formatSeen = true;
      continue;
    }
    throw new Error('invalid arguments');
  }
  if (fingerprintKeyFile === undefined) throw new Error('invalid arguments');
  return { fingerprintKeyFile, format };
}

function removeOneTerminalLineEnding(content: Buffer): Buffer {
  if (content.at(-1) !== 0x0a) return content;
  const withoutLf = content.subarray(0, -1);
  return withoutLf.at(-1) === 0x0d ? withoutLf.subarray(0, -1) : withoutLf;
}

function invalidFingerprintKey(): Error {
  return new Error('OAuth inventory fingerprint key is invalid');
}

function mutableCounts(): {
  scannedClientCount: number;
  normalizedCount: number;
  legacyClasses: {
    safe_https: { count: number };
    safe_loopback_legacy: FingerprintedClassSummary;
    unsafe_legacy: FingerprintedClassSummary;
    malformed_legacy: FingerprintedClassSummary;
  };
} {
  return {
    scannedClientCount: 0,
    normalizedCount: 0,
    legacyClasses: {
      safe_https: { count: 0 },
      safe_loopback_legacy: { count: 0, clientFingerprints: [] },
      unsafe_legacy: { count: 0, clientFingerprints: [] },
      malformed_legacy: { count: 0, clientFingerprints: [] },
    },
  };
}

function addRowToCounts(
  counts: ReturnType<typeof mutableCounts>,
  row: InventoryRow,
  fingerprintKey: Buffer,
): void {
  if (typeof row.client_id !== 'string') throw new Error('invalid inventory row');
  const metadata: OAuthRedirectClientMetadata = {};
  addInventoryField(metadata, 'application_type', row.application_type);
  addInventoryField(metadata, 'redirect_uris', row.redirect_uris);
  addInventoryField(metadata, 'token_endpoint_auth_method', row.token_endpoint_auth_method);
  addInventoryField(metadata, 'noodle_redirect_policy_version', row.noodle_redirect_policy_version);
  const policyClass = classifyStoredOAuthRedirectPolicy(metadata);
  counts.scannedClientCount += 1;
  if (policyClass === 'normalized') {
    counts.normalizedCount += 1;
    return;
  }

  counts.legacyClasses[policyClass].count += 1;
  if (policyClass !== 'safe_https') {
    counts.legacyClasses[policyClass].clientFingerprints.push(
      fingerprintOAuthClientId(row.client_id, fingerprintKey),
    );
  }
}

function addInventoryField(
  metadata: OAuthRedirectClientMetadata,
  field: keyof OAuthRedirectClientMetadata,
  envelope: InventoryFieldEnvelope,
): void {
  if (
    typeof envelope !== 'object' ||
    envelope === null ||
    typeof envelope.present !== 'boolean' ||
    !Object.hasOwn(envelope, 'value')
  ) {
    throw new Error('invalid inventory row');
  }
  if (envelope.present) metadata[field] = envelope.value;
}

function completeInventorySummary(
  counts: LegacyOAuthRedirectInventoryCounts,
): LegacyOAuthRedirectInventorySummary {
  return {
    schemaVersion: 1,
    complete: true,
    scannedClientCount: counts.scannedClientCount,
    normalizedCount: counts.normalizedCount,
    legacyClasses: counts.legacyClasses,
  };
}

function fingerprintLines(
  policyClass: FingerprintedLegacyPolicyClass,
  fingerprints: readonly string[],
): string[] {
  return fingerprints.map((fingerprint) => `${policyClass}_fingerprint: ${fingerprint}`);
}
