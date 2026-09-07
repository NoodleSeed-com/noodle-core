export interface DeveloperPromptDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly messages: readonly {
    readonly role: 'user';
    readonly content: { readonly type: 'text'; readonly text: string };
  }[];
}

const WORKFLOW_REFERENCE =
  'Read noodle://developer/workflow/v2 and the host-specific noodle://developer/hosts/*/v1 resource first.';

export const DEVELOPER_PROMPTS: readonly DeveloperPromptDefinition[] = [
  {
    name: 'build_mcp_app',
    title: 'Build a Noodle MCP app',
    description: 'Guide the existing coding agent through the canonical local authoring workflow.',
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `${WORKFLOW_REFERENCE} Inspect the workspace, help the existing coding agent implement the MCP server or app, validate it with the plugin-managed CLI, and deploy only when the user requests it.`,
        },
      },
    ],
  },
  {
    name: 'inspect_mcp_app',
    title: 'Inspect a deployed Noodle MCP app',
    description: 'Use scoped Cloud evidence to explain the deployed app state.',
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `${WORKFLOW_REFERENCE} Use get_context, choose the intended organization from current access, and pass that explicit org to read-only inspection tools. Describe the deployed app without requesting source code or secret values.`,
        },
      },
    ],
  },
  {
    name: 'debug_mcp_app',
    title: 'Debug a deployed Noodle MCP app',
    description: 'Gather bounded evidence before the coding agent changes source.',
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `${WORKFLOW_REFERENCE} Use get_context to resolve the intended organization, pass that explicit org to diagnose_app, inspect its cited evidence, then ask the existing coding agent to check the local source only where that evidence points.`,
        },
      },
    ],
  },
];

export function registerDeveloperPrompts(registrar: McpServer): void {
  for (const prompt of DEVELOPER_PROMPTS) {
    registrar.registerPrompt(
      prompt.name,
      { title: prompt.title, description: prompt.description },
      async () => ({ messages: prompt.messages.map((message) => ({ ...message })) }),
    );
  }
}

import type { McpServer } from '@modelcontextprotocol/server';
