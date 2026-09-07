export const CAPABILITY_NAMES = [
  'identity',
  'access',
  'controls',
  'audit',
  'observability',
  'secrets',
  'connectors',
  'apps',
] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

export type CompatibilityHost = 'claude' | 'chatgpt' | 'embedded';
export type FeatureStage = 'supported' | 'preview' | 'planned' | 'unsupported';

export interface ProductFeature {
  readonly id: string;
  readonly title: string;
  readonly since: string;
  readonly description: string;
  readonly hosts: Readonly<Record<CompatibilityHost, FeatureStage>>;
}

/** Single public compatibility registry used by CLI output, docs, and release notes. */
export const PRODUCT_FEATURES: readonly ProductFeature[] = [
  {
    id: 'mcp-core',
    title: 'MCP tools, resources, and prompts',
    since: '0.1.0',
    description: 'Portable MCP server surfaces with schema-backed TypeScript authoring.',
    hosts: { claude: 'supported', chatgpt: 'supported', embedded: 'supported' },
  },
  {
    id: 'mcp-apps',
    title: 'MCP Apps',
    since: '0.35.0',
    description:
      'ui:// resources, lifecycle, app tool/resource calls, messages, context, allowlisted links, and layout. ChatGPT remains preview until a dated live-host smoke is recorded.',
    hosts: { claude: 'supported', chatgpt: 'preview', embedded: 'supported' },
  },
  {
    id: 'core-v2-portable-auth',
    title: 'Core v2 portable customer authentication',
    since: 'next',
    description:
      'Direct or federated OIDC resource-server verification assigns customer identity at the trusted verifier boundary; Firebase and Microsoft remain built-in adapters.',
    hosts: { claude: 'supported', chatgpt: 'supported', embedded: 'supported' },
  },
  {
    id: 'explicit-context-provider',
    title: 'Explicit context-provider tool',
    since: 'next',
    description:
      'A normal zero-input MCP tool may be designated as the portable context provider; the embedded host preloads it once per turn.',
    hosts: { claude: 'supported', chatgpt: 'supported', embedded: 'supported' },
  },
  {
    id: 'delegated-token-exchange',
    title: 'Delegated token exchange',
    since: '0.35.0',
    description:
      'Verified customer identity exchanged for downstream-scoped connector credentials.',
    hosts: { claude: 'supported', chatgpt: 'supported', embedded: 'supported' },
  },
  {
    id: 'per-turn-page-context',
    title: 'Per-turn typed page context',
    since: 'next',
    description: 'Fresh application context is carried as bounded, explicitly untrusted turn data.',
    hosts: { claude: 'unsupported', chatgpt: 'unsupported', embedded: 'supported' },
  },
  {
    id: 'auth-doctor-live',
    title: 'Live delegated-credential diagnosis',
    since: 'next',
    description:
      '`noodle auth doctor --live` performs one real broker exchange for a verified customer without invoking a business tool; `--version <version>` targets that exact deployed MCP resource.',
    hosts: { claude: 'supported', chatgpt: 'supported', embedded: 'supported' },
  },
  {
    id: 'mcp-2026-07-28',
    title: 'MCP 2026-07-28 dual-era serving',
    since: 'next',
    description:
      'One endpoint negotiates modern 2026-07-28 requests while preserving the frozen 2025-era initialize path; host support remains preview until dated production smokes are recorded.',
    hosts: { claude: 'preview', chatgpt: 'preview', embedded: 'preview' },
  },
  {
    id: 'mcp-mrtr',
    title: 'MCP multi-round tool results',
    since: 'next',
    description:
      'Negotiated 2026-07-28 requests use sealed, bounded input_required retries with single-use confirmation state; host support remains preview pending dated live-host proof.',
    hosts: { claude: 'preview', chatgpt: 'preview', embedded: 'preview' },
  },
  {
    id: 'mcp-oauth-client-credentials',
    title: 'MCP OAuth Client Credentials',
    since: 'next',
    description:
      'Organization-owned service principals authenticate headless MCP callers with resource-bound short-lived tokens, least-privilege grants, and live grant and credential revocation.',
    hosts: { claude: 'preview', chatgpt: 'preview', embedded: 'preview' },
  },
  {
    id: 'sampling',
    title: 'MCP Apps sampling',
    since: 'future',
    description: 'Sampling is intentionally not advertised by the embedded host.',
    hosts: { claude: 'preview', chatgpt: 'preview', embedded: 'unsupported' },
  },
  {
    id: 'tasks',
    title: 'MCP tasks',
    since: 'future',
    description: 'Task APIs remain outside the current compatibility release.',
    hosts: { claude: 'preview', chatgpt: 'planned', embedded: 'unsupported' },
  },
] as const;

export function featureRegistryMarkdown(features = PRODUCT_FEATURES): string {
  return [
    '# Compatibility feature registry and changelog',
    '',
    '**Owns:** Generated host support stages and first-shipped compatibility versions.',
    '**Read when:** Choosing a host surface or reviewing compatibility changes.',
    '**Do not put here:** Manual host-smoke evidence; use `mcp-apps-host-compatibility.md`.',
    '**Update when:** Change `PRODUCT_FEATURES` and regenerate this file.',
    '',
    '> Generated from `@noodle-borg/capabilities`. Do not edit this table by hand.',
    '',
    '| Feature | Since | Claude | ChatGPT | Embedded |',
    '| --- | --- | --- | --- | --- |',
    ...features.map(
      (feature) =>
        `| ${feature.title} | ${feature.since} | ${feature.hosts.claude} | ${feature.hosts.chatgpt} | ${feature.hosts.embedded} |`,
    ),
    '',
    ...features.flatMap((feature) => [`## ${feature.title}`, '', feature.description, '']),
  ].join('\n');
}

export const CAPABILITY_REQUIREMENT_NAMES = [
  'identity',
  'access',
  'controls',
  'audit',
  'apps',
] as const;

export type CapabilityRequirementName = (typeof CAPABILITY_REQUIREMENT_NAMES)[number];

export const SERVICE_PROFILE_NAMES = [
  'noodle-cloud-managed',
  'open-core',
  'enterprise-governed',
  'public-saas',
  'agency-managed',
] as const;

export type ServiceProfileName = (typeof SERVICE_PROFILE_NAMES)[number];

export interface LiteralNameSchema<T extends string> {
  safeParse(
    value: unknown,
  ): { readonly success: true; readonly data: T } | { readonly success: false };
}

export const capabilityNameSchema = literalNameSchema(CAPABILITY_NAMES);
export const capabilityRequirementNameSchema = literalNameSchema(CAPABILITY_REQUIREMENT_NAMES);
export const serviceProfileNameSchema = literalNameSchema(SERVICE_PROFILE_NAMES);

const REQUIREMENT_ALIASES: Readonly<Record<string, CapabilityRequirementName>> = {
  auth: 'identity',
  customerAuth: 'identity',
  customer_auth: 'identity',
  rateLimits: 'controls',
  rate_limits: 'controls',
  quotas: 'controls',
  policy: 'access',
  authorization: 'access',
};

export function isCapabilityName(value: unknown): value is CapabilityName {
  return typeof value === 'string' && includesName(CAPABILITY_NAMES, value);
}

export function isCapabilityRequirementName(value: unknown): value is CapabilityRequirementName {
  return typeof value === 'string' && includesName(CAPABILITY_REQUIREMENT_NAMES, value);
}

export function isServiceProfileName(value: unknown): value is ServiceProfileName {
  return typeof value === 'string' && includesName(SERVICE_PROFILE_NAMES, value);
}

export function suggestCapabilityRequirementName(
  value: string,
): CapabilityRequirementName | undefined {
  const directAlias = REQUIREMENT_ALIASES[value];
  if (directAlias !== undefined) return directAlias;
  if (/audit/i.test(value)) return 'audit';
  if (/app|widget|ui/i.test(value)) return 'apps';
  if (/identity|login|oauth|oidc|saml|authn/i.test(value)) return 'identity';
  if (/access|role|scope|member|permission|authz/i.test(value)) return 'access';
  if (/rate|quota|limit|control|admission|approval|consent/i.test(value)) return 'controls';
  return undefined;
}

function literalNameSchema<const T extends readonly string[]>(
  names: T,
): LiteralNameSchema<T[number]> {
  return {
    safeParse(value) {
      if (typeof value === 'string' && includesName(names, value)) {
        return { success: true, data: value };
      }
      return { success: false };
    },
  };
}

function includesName<const T extends readonly string[]>(
  names: T,
  value: string,
): value is T[number] {
  return (names as readonly string[]).includes(value);
}
