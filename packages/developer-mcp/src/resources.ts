import type { McpServer } from '@modelcontextprotocol/server';
import { DEVELOPER_WIDGETS, renderDeveloperWidget } from './widgets/resources.js';

export interface DeveloperResourceDefinition {
  readonly name: string;
  readonly uri: string;
  readonly title: string;
  readonly description: string;
  readonly text: string;
}

export const DEVELOPER_RESOURCES: readonly DeveloperResourceDefinition[] = [
  {
    name: 'developer-capabilities-v2',
    uri: 'noodle://developer/capabilities/v2',
    title: 'Noodle Developer capabilities',
    description:
      'The bounded capabilities and trust boundaries of the Noodle Developer connection.',
    text: `# Noodle Developer capabilities v2

The remote connection reads Noodle Cloud apps, deployments, logs, metrics, events, and sessions in organizations the signed-in user can currently access. It can diagnose from bounded evidence. Rollback is capability-gated and requires the user to be a current organization owner.

It cannot receive or edit source code, build source, deploy source, read secret values, or manage members, billing, or policy. Call get_context to discover current organizations and roles, then pass an explicit org to every organization-scoped tool. Membership and role changes take effect without reconnecting.`,
  },
  {
    name: 'developer-workflow-v2',
    uri: 'noodle://developer/workflow/v2',
    title: 'Noodle Developer workflow',
    description: 'How coding agents, the managed CLI, and remote Cloud operations work together.',
    text: `# Noodle Developer workflow v2

1. The user's coding agent writes and edits source code in the developer's workspace.
2. The plugin-managed Noodle CLI validates, builds, and deploys that workspace through the canonical Noodle Cloud deploy path.
3. The remote Developer MCP inspects and operates Noodle Cloud. Unlike the local CLI, which may keep a default organization for convenience, it calls get_context and passes an explicit organization to each scoped tool.
4. Remote access follows the signed-in user's current organizations and roles; the authorization page does not freeze an organization or environment selection.

Noodle Developer guides and operates this workflow. It is not a second coding agent and does not provide its own source-generation surface.`,
  },
  {
    name: 'developer-host-chatgpt-v1',
    uri: 'noodle://developer/hosts/chatgpt/v1',
    title: 'Using Noodle Developer in ChatGPT',
    description: 'ChatGPT-specific execution boundaries.',
    text: `# ChatGPT host guidance v1

ChatGPT uses the remote Developer MCP for guidance, inspection, diagnosis, and authorized Cloud operations. A chat-only connection cannot execute a CLI on the user machine. Local validation and deployment require a coding-agent host with the plugin-managed CLI profile.`,
  },
  {
    name: 'developer-host-codex-v1',
    uri: 'noodle://developer/hosts/codex/v1',
    title: 'Using Noodle Developer in Codex',
    description: 'Codex-specific local and remote workflow guidance.',
    text: `# Codex host guidance v1

Codex edits the local project. Use the plugin-managed Noodle CLI profile for validation and deployment, and use the remote Developer MCP for scoped Noodle Cloud evidence and operations. Keep source in the workspace; never send it to the remote management server.`,
  },
  {
    name: 'developer-host-claude-code-v1',
    uri: 'noodle://developer/hosts/claude-code/v1',
    title: 'Using Noodle Developer in Claude Code',
    description: 'Claude Code-specific local and remote workflow guidance.',
    text: `# Claude Code host guidance v1

Claude Code edits the local project. Use the plugin-managed Noodle CLI profile for validation and deployment, and use the remote Developer MCP for scoped Noodle Cloud evidence and operations. Keep source in the workspace; never send it to the remote management server.`,
  },
];

export function registerDeveloperResources(
  registrar: McpServer,
  options: { readonly widgets?: boolean } = {},
): void {
  for (const resource of DEVELOPER_RESOURCES) {
    registrar.registerResource(
      resource.name,
      resource.uri,
      {
        title: resource.title,
        description: resource.description,
        mimeType: 'text/markdown',
      },
      async () => ({
        contents: [{ uri: resource.uri, mimeType: 'text/markdown', text: resource.text }],
      }),
    );
  }
  if (options.widgets === false) return;
  for (const widget of DEVELOPER_WIDGETS) {
    registrar.registerResource(
      widget.name,
      widget.uri,
      {
        title: widget.title,
        description: widget.description,
        mimeType: widget.mimeType,
        _meta: widget._meta,
      },
      async () => {
        const rendered = renderDeveloperWidget(widget.uri);
        if (rendered === undefined) throw new Error(`unknown developer widget: ${widget.uri}`);
        return {
          contents: [
            {
              uri: rendered.uri,
              mimeType: rendered.mimeType,
              text: rendered.text,
              _meta: rendered._meta,
            },
          ],
        };
      },
    );
  }
}
