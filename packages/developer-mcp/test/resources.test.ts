import { describe, expect, it } from 'vitest';

import { DEVELOPER_PROMPTS, registerDeveloperPrompts } from '../src/prompts.js';
import { DEVELOPER_RESOURCES, registerDeveloperResources } from '../src/resources.js';

describe('Developer MCP guidance resources', () => {
  it('publishes a versioned capability, workflow, and host catalog', () => {
    expect(DEVELOPER_RESOURCES.map((resource) => resource.uri)).toEqual([
      'noodle://developer/capabilities/v2',
      'noodle://developer/workflow/v2',
      'noodle://developer/hosts/chatgpt/v1',
      'noodle://developer/hosts/codex/v1',
      'noodle://developer/hosts/claude-code/v1',
    ]);
  });

  it('keeps the coding agent, managed CLI, and remote Cloud boundaries explicit', () => {
    const workflow = DEVELOPER_RESOURCES.find(
      (resource) => resource.uri === 'noodle://developer/workflow/v2',
    );
    expect(workflow?.text).toContain('coding agent writes and edits source code');
    expect(workflow?.text).toContain('plugin-managed Noodle CLI validates, builds, and deploys');
    expect(workflow?.text).toContain('remote Developer MCP inspects and operates Noodle Cloud');
    expect(workflow?.text).toContain('calls get_context and passes an explicit organization');
    expect(workflow?.text).toContain('current organizations and roles');
    expect(workflow?.text).not.toContain('vibe coding');
  });

  it('does not claim local execution for ChatGPT', () => {
    const chatgpt = DEVELOPER_RESOURCES.find(
      (resource) => resource.uri === 'noodle://developer/hosts/chatgpt/v1',
    );
    expect(chatgpt?.text).toContain('cannot execute a CLI on the user machine');
  });

  it('assembles guidance-only prompts with no mutation side effects', () => {
    expect(DEVELOPER_PROMPTS.map((prompt) => prompt.name)).toEqual([
      'build_mcp_app',
      'inspect_mcp_app',
      'debug_mcp_app',
    ]);
    for (const prompt of DEVELOPER_PROMPTS) {
      expect(prompt.messages).toHaveLength(1);
      expect(prompt.messages[0]?.content.text).toContain('noodle://developer/workflow/v2');
    }
  });

  it('registers readable resources and prompts through the composition seam', async () => {
    const resourceCallbacks: (() => Promise<unknown>)[] = [];
    registerDeveloperResources({
      registerResource: (_name, _uri, _config, callback) => resourceCallbacks.push(callback),
    });
    const promptCallbacks: (() => Promise<unknown>)[] = [];
    registerDeveloperPrompts({
      registerPrompt: (_name, _config, callback) => promptCallbacks.push(callback),
    });

    expect(resourceCallbacks).toHaveLength(9);
    expect(promptCallbacks).toHaveLength(3);
    await expect(resourceCallbacks[0]?.()).resolves.toMatchObject({
      contents: [{ uri: 'noodle://developer/capabilities/v2', mimeType: 'text/markdown' }],
    });
    await expect(resourceCallbacks[5]?.()).resolves.toMatchObject({
      contents: [
        {
          uri: 'ui://noodle-developer/app-overview/v1',
          mimeType: 'text/html;profile=mcp-app',
        },
      ],
    });
    await expect(promptCallbacks[0]?.()).resolves.toMatchObject({ messages: [{ role: 'user' }] });
  });
});
