export const PLUGIN_COMPATIBILITY_SCHEMA_VERSION = 2 as const;
export const DEVELOPMENT_CLI_VERSION = '0.0.0';
export const DEVELOPMENT_MCP_CAPABILITY_VERSION = '0.0.0';
export const DEFAULT_DEVELOPER_MCP_URL = 'https://cloud.noodleseed.dev/developer/mcp';

export interface LegacyPluginCompatibilityManifest {
  readonly schemaVersion: 1;
  readonly pluginVersion: string;
  readonly cliVersion: string;
  readonly developerMcpUrl: string;
  readonly developerMcpCapabilityVersion: string;
}

export interface CurrentPluginCompatibilityManifest {
  readonly schemaVersion: 2;
  readonly pluginVersion: string;
  readonly agentKitVersion: string;
  readonly pluginContentHash: string;
  readonly cliVersion: string;
  readonly developerMcpUrl: string;
  readonly developerMcpCapabilityVersion: string;
}

export type PluginCompatibilityManifest =
  | LegacyPluginCompatibilityManifest
  | CurrentPluginCompatibilityManifest;

export interface CreatePluginCompatibilityOptions {
  readonly mode?: 'development' | 'release';
  readonly pluginVersion: string;
  readonly agentKitVersion?: string;
  readonly pluginContentHash?: string;
  readonly cliVersion?: string;
  readonly developerMcpUrl?: string;
  readonly developerMcpCapabilityVersion?: string;
}

const MANIFEST_FIELDS = new Set([
  'schemaVersion',
  'pluginVersion',
  'agentKitVersion',
  'pluginContentHash',
  'cliVersion',
  'developerMcpUrl',
  'developerMcpCapabilityVersion',
]);
const EXACT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CAPABILITY_VERSION = /^[0-9A-Za-z](?:[0-9A-Za-z._-]{0,63})$/;
const CONTENT_HASH = /^sha256:[a-f0-9]{64}$/;
export const DEVELOPMENT_CONTENT_HASH = `sha256:${'0'.repeat(64)}`;

export function createPluginCompatibility(
  options: CreatePluginCompatibilityOptions,
): PluginCompatibilityManifest {
  const release = options.mode === 'release';
  return parsePluginCompatibility({
    schemaVersion: PLUGIN_COMPATIBILITY_SCHEMA_VERSION,
    pluginVersion: options.pluginVersion,
    agentKitVersion: requiredOrDefault(
      'agentKitVersion',
      options.agentKitVersion,
      release,
      options.pluginVersion,
    ),
    pluginContentHash: requiredOrDefault(
      'pluginContentHash',
      options.pluginContentHash,
      release,
      DEVELOPMENT_CONTENT_HASH,
    ),
    cliVersion: requiredOrDefault(
      'cliVersion',
      options.cliVersion,
      release,
      DEVELOPMENT_CLI_VERSION,
    ),
    developerMcpUrl: requiredOrDefault(
      'developerMcpUrl',
      options.developerMcpUrl,
      release,
      DEFAULT_DEVELOPER_MCP_URL,
    ),
    developerMcpCapabilityVersion: requiredOrDefault(
      'developerMcpCapabilityVersion',
      options.developerMcpCapabilityVersion,
      release,
      DEVELOPMENT_MCP_CAPABILITY_VERSION,
    ),
  });
}

export function parsePluginCompatibility(value: unknown): PluginCompatibilityManifest {
  if (!isRecord(value)) throw new Error('plugin compatibility manifest must be an object');
  for (const field of Object.keys(value)) {
    if (!MANIFEST_FIELDS.has(field)) {
      throw new Error(`plugin compatibility manifest has unknown field "${field}"`);
    }
  }
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2) {
    throw new Error('plugin compatibility schemaVersion must be 1 or 2');
  }
  const pluginVersion = exactSemver('pluginVersion', value.pluginVersion);
  const cliVersion = exactSemver('cliVersion', value.cliVersion);
  const developerMcpUrl = canonicalDeveloperMcpUrl(value.developerMcpUrl);
  const developerMcpCapabilityVersion = capabilityVersion(value.developerMcpCapabilityVersion);
  const shared = {
    pluginVersion,
    cliVersion,
    developerMcpUrl,
    developerMcpCapabilityVersion,
  };
  if (value.schemaVersion === 1) {
    if (value.agentKitVersion !== undefined || value.pluginContentHash !== undefined) {
      throw new Error('plugin compatibility schemaVersion 1 does not support provenance fields');
    }
    return { schemaVersion: 1, ...shared };
  }
  return {
    schemaVersion: 2,
    ...shared,
    agentKitVersion: exactSemver('agentKitVersion', value.agentKitVersion),
    pluginContentHash: contentHash(value.pluginContentHash),
  };
}

export function renderPluginCompatibilityJson(manifest: PluginCompatibilityManifest): string {
  const validated = parsePluginCompatibility(manifest);
  return `${JSON.stringify(
    validated.schemaVersion === 1
      ? {
          cliVersion: validated.cliVersion,
          developerMcpCapabilityVersion: validated.developerMcpCapabilityVersion,
          developerMcpUrl: validated.developerMcpUrl,
          pluginVersion: validated.pluginVersion,
          schemaVersion: validated.schemaVersion,
        }
      : {
          agentKitVersion: validated.agentKitVersion,
          cliVersion: validated.cliVersion,
          developerMcpCapabilityVersion: validated.developerMcpCapabilityVersion,
          developerMcpUrl: validated.developerMcpUrl,
          pluginVersion: validated.pluginVersion,
          pluginContentHash: validated.pluginContentHash,
          schemaVersion: validated.schemaVersion,
        },
    null,
    2,
  )}\n`;
}

function contentHash(value: unknown): string {
  if (typeof value !== 'string' || !CONTENT_HASH.test(value)) {
    throw new Error('pluginContentHash must be a sha256 content hash');
  }
  return value;
}

function requiredOrDefault(
  field: string,
  value: string | undefined,
  release: boolean,
  fallback: string,
): string {
  if (value !== undefined) return value;
  if (release) throw new Error(`release plugin rendering requires ${field}`);
  return fallback;
}

function exactSemver(field: string, value: unknown): string {
  if (typeof value !== 'string' || !EXACT_SEMVER.test(value)) {
    throw new Error(`${field} must be an exact semantic version`);
  }
  return value;
}

function canonicalDeveloperMcpUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('developerMcpUrl must be an HTTPS URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('developerMcpUrl must be an HTTPS URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.pathname !== '/developer/mcp' ||
    url.href !== value
  ) {
    throw new Error('developerMcpUrl must be a canonical credential-free HTTPS /developer/mcp URL');
  }
  return value;
}

function capabilityVersion(value: unknown): string {
  if (typeof value !== 'string' || !CAPABILITY_VERSION.test(value)) {
    throw new Error('developerMcpCapabilityVersion must be a bounded version identifier');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
