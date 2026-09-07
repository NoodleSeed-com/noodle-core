/**
 * Pure builders for MCP client registration config (M5, plugin-packaging track). Given a deployed server
 * name + endpoint URL, emit the configuration each host needs to reach it.
 *
 * Format verification (2026-06-29): only the `mcpServers` JSON config (Claude Code / Claude Desktop) and the
 * `claude mcp add-json` command are officially documented and stable, along with the URL-paste connector flow
 * for Claude.ai / ChatGPT and the MCP Inspector command. The `.claude-plugin` bundle, MCPB internal, and Codex
 * CLI MCP config formats are NOT publicly specified, so we do not fabricate them — for those clients we emit
 * the standard `mcpServers` block as a starting point and mark it unverified.
 */

export type McpType = 'http' | 'https';

export function mcpType(url: string): McpType {
  return url.trim().toLowerCase().startsWith('http://') ? 'http' : 'https';
}

export interface McpServersConfig {
  readonly mcpServers: Record<string, { readonly type: McpType; readonly url: string }>;
}

/** The documented Claude Code / Claude Desktop `mcpServers` config block for a remote server. */
export function mcpServersConfig(name: string, url: string): McpServersConfig {
  return { mcpServers: { [name]: { type: mcpType(url), url: url.trim() } } };
}

/** The documented one-shot `claude mcp add-json` registration command. */
export function claudeAddJsonCommand(name: string, url: string): string {
  const entry = JSON.stringify({ type: mcpType(url), url: url.trim() });
  return `claude mcp add-json ${name} '${entry}'`;
}

export interface ConnectConfig {
  readonly client: string;
  readonly title: string;
  /** A config block to write/paste when the client consumes a file. */
  readonly config?: McpServersConfig;
  /** A one-shot CLI command that registers the server, when one is documented. */
  readonly command?: string;
  /** Human steps when there is no documented file format (e.g. claude.ai paste-URL). */
  readonly steps?: readonly string[];
  /** True when this client's registration format is officially documented and stable. */
  readonly verified: boolean;
}

export function connectConfig(client: string, name: string, url: string): ConnectConfig {
  const endpoint = url.trim();
  const config = mcpServersConfig(name, endpoint);
  switch (client) {
    case 'claude-code':
      return {
        client,
        title: 'Claude Code / Claude Desktop',
        config,
        command: claudeAddJsonCommand(name, endpoint),
        verified: true,
      };
    case 'codex':
      return { client, title: 'OpenAI Codex', config, verified: false };
    case 'cursor':
    case 'vscode':
    case 'gemini':
      return { client, title: client, config, verified: false };
    case 'claude':
    case 'chatgpt':
      return {
        client,
        title: client === 'claude' ? 'Claude.ai' : 'ChatGPT',
        steps: [
          `Open ${client === 'claude' ? 'Claude' : 'ChatGPT'} settings, then Connectors, then Add custom connector.`,
          `Paste the MCP URL: ${endpoint}`,
          'Authenticate if prompted, then save.',
        ],
        verified: true,
      };
    case 'inspector':
      return {
        client,
        title: 'MCP Inspector',
        command: `npx @modelcontextprotocol/inspector ${endpoint}`,
        verified: true,
      };
    default:
      return {
        client,
        title: client,
        steps: [`Add the MCP URL to ${client}: ${endpoint}`],
        verified: false,
      };
  }
}
