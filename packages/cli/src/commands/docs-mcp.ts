/**
 * Out-of-the-box docs assistant: `noodle init` registers the first-party, Noodle-authenticated docs
 * assistant MCP in the project's Claude Code `.mcp.json`, so a coding agent can answer from the latest docs
 * from the very first project. The endpoint is authenticated (the existing OAuth authorization server /
 * upstream human sign-in, `access: authenticated`) — not anonymous — so the agent runs the branded consent flow on
 * first connect, and Noodle Seed knows which developers are using it. See ADR 0113.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mcpType } from './connect-config.js';

/** The stable name of the docs assistant server in a project's `.mcp.json`. */
export const DOCS_MCP_NAME = 'noodle-docs';

/**
 * The hosted docs assistant MCP endpoint. Noodle-authenticated; overridable via `NOODLE_DOCS_MCP_URL` for
 * staging or self-host. The concrete production URL is provisioned when the docs assistant is deployed.
 */
export function docsMcpUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.NOODLE_DOCS_MCP_URL?.trim();
  return override && override.length > 0 ? override : 'https://docs.noodleseed.dev/mcp';
}

export interface DocsMcpResult {
  readonly action: 'created' | 'updated' | 'unchanged' | 'would-add' | 'would-update';
  readonly path: string;
  readonly name: string;
  readonly url: string;
}

/**
 * Merge the docs assistant MCP into the project's Claude Code `.mcp.json`, idempotently and
 * non-destructively: create the file when absent, add our entry without touching other servers, and leave an
 * identical entry unchanged. A malformed existing file is the user's — never clobber it. Returns what
 * changed so the caller can report it.
 */
export function writeDocsMcpConfig(
  cwd: string,
  options: { readonly url?: string; readonly name?: string; readonly dryRun?: boolean } = {},
): DocsMcpResult {
  const name = options.name ?? DOCS_MCP_NAME;
  const url = (options.url ?? docsMcpUrl()).trim();
  const path = join(cwd, '.mcp.json');
  const entry = { type: mcpType(url), url };

  let existing: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (parsed !== null && typeof parsed === 'object') existing = parsed as typeof existing;
    } catch {
      // Preserve a malformed `.mcp.json` the user owns rather than overwrite it.
      return { action: 'unchanged', path, name, url };
    }
  }

  const servers = { ...(existing.mcpServers ?? {}) } as Record<string, unknown>;
  const current = servers[name];
  const alreadyPresent = name in servers;
  const identical =
    current !== null &&
    typeof current === 'object' &&
    (current as { url?: unknown }).url === url &&
    (current as { type?: unknown }).type === entry.type;
  if (identical) return { action: 'unchanged', path, name, url };

  const action: DocsMcpResult['action'] = options.dryRun
    ? alreadyPresent
      ? 'would-update'
      : 'would-add'
    : alreadyPresent
      ? 'updated'
      : 'created';
  if (options.dryRun !== true) {
    servers[name] = entry;
    writeFileSync(path, `${JSON.stringify({ ...existing, mcpServers: servers }, null, 2)}\n`);
  }
  return { action, path, name, url };
}
