export const DEVELOPER_MCP_PATH = '/developer/mcp';
export const DEVELOPER_CLI_PATH = '/developer/cli';
export const DEVELOPER_ASSISTANT_PATH = '/developer/assistant';

export const DEVELOPER_CAPABILITIES = [
  'cloud:read',
  'deployments:write',
  'deployments:rollback',
  'config:write',
] as const;

export type DeveloperCapability = (typeof DEVELOPER_CAPABILITIES)[number];

const DEVELOPER_CAPABILITY_SET = new Set<string>(DEVELOPER_CAPABILITIES);
const MCP_CAPABILITIES = Object.freeze<readonly DeveloperCapability[]>([
  'cloud:read',
  'deployments:rollback',
]);
// `config:write` is CLI-only on purpose: managing an environment's variables and secrets is part of
// the local build/deploy loop the plugin-managed CLI drives. A chat-host MCP connection inspects and
// rolls back; it never configures. Neither resource can reveal a secret value.
const CLI_CAPABILITIES = Object.freeze<readonly DeveloperCapability[]>([
  'cloud:read',
  'deployments:write',
  'config:write',
]);
// The onboarding assistant reads the operator's world and deploys the confirm-gated first app —
// never rollback and never config: the ceiling is structural, so a token minted through the
// control-plane exchange can never store those capabilities (ADR 0218).
const ASSISTANT_CAPABILITIES = Object.freeze<readonly DeveloperCapability[]>([
  'cloud:read',
  'deployments:write',
]);

export function isDeveloperCapability(value: unknown): value is DeveloperCapability {
  return typeof value === 'string' && DEVELOPER_CAPABILITY_SET.has(value);
}

export function developerResourcePath(resource: string): string | undefined {
  try {
    const path = new URL(resource, 'https://developer-resource.invalid').pathname.replace(
      /\/$/,
      '',
    );
    return path === '' ? '/' : path;
  } catch {
    return undefined;
  }
}

export function isDeveloperResource(resource: string): boolean {
  const path = developerResourcePath(resource);
  return (
    path === DEVELOPER_MCP_PATH || path === DEVELOPER_CLI_PATH || path === DEVELOPER_ASSISTANT_PATH
  );
}

export function capabilitiesForDeveloperResource(resource: string): readonly DeveloperCapability[] {
  const path = developerResourcePath(resource);
  if (path === DEVELOPER_MCP_PATH) return MCP_CAPABILITIES;
  if (path === DEVELOPER_CLI_PATH) return CLI_CAPABILITIES;
  if (path === DEVELOPER_ASSISTANT_PATH) return ASSISTANT_CAPABILITIES;
  return [];
}
