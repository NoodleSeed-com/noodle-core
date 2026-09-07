import { describe, expect, it } from 'vitest';
import { AGENT_KIT_VERSION } from '../src/index.js';
import { PLUGIN_NAME, renderMarketplaceRepo, renderPluginBundle } from '../src/plugin-bundle.js';
import { renderOfficialDirectoryPlugin } from '../src/plugin-directory-bundle.js';

function filesByPath(files: ReturnType<typeof renderOfficialDirectoryPlugin>): Map<string, string> {
  return new Map(files.map((file) => [file.path, file.content]));
}

describe('official-directory plugin projection', () => {
  it('packages one shared Claude and OpenAI implementation with exactly one remote MCP', () => {
    const files = filesByPath(renderOfficialDirectoryPlugin());

    expect([...files.keys()].sort()).toEqual(
      [
        '.claude-plugin/plugin.json',
        '.codex-plugin/plugin.json',
        '.mcp.json',
        'README.md',
        'bin/noodle-plugin.mjs',
        'noodle-plugin-compatibility.json',
        `skills/${PLUGIN_NAME}/SKILL.md`,
        `skills/${PLUGIN_NAME}/agents/openai.yaml`,
        `skills/${PLUGIN_NAME}/scripts/noodle-plugin.mjs`,
      ].sort(),
    );

    expect(JSON.parse(files.get('.mcp.json') ?? 'null')).toEqual({
      mcpServers: {
        'noodle-developer': {
          type: 'http',
          url: 'https://cloud.noodleseed.dev/developer/mcp',
        },
      },
    });

    expect(JSON.parse(files.get('.codex-plugin/plugin.json') ?? 'null')).toMatchObject({
      name: 'noodle-seed',
      skills: './skills/',
      mcpServers: './.mcp.json',
      interface: {
        displayName: 'Noodle Seed',
        shortDescription: expect.any(String),
        longDescription: expect.any(String),
        developerName: 'Noodle Seed',
        category: 'Developer Tools',
        capabilities: expect.arrayContaining(['MCP servers', 'MCP apps', 'Hosted deployment']),
        defaultPrompt: expect.arrayContaining(['Create a ChatGPT app for my support workflow']),
      },
    });

    const openAi = files.get(`skills/${PLUGIN_NAME}/agents/openai.yaml`) ?? '';
    expect(openAi).toContain('type: "mcp"');
    expect(openAi).toContain('value: "noodle-developer"');
    expect(openAi).toContain('transport: "streamable_http"');
    expect(openAi).toContain('url: "https://cloud.noodleseed.dev/developer/mcp"');
    expect(openAi.match(/type: "mcp"/g)).toHaveLength(1);
    expect(openAi).not.toContain('noodle-readiness');
  });

  it('reuses the release-pinned skill, launchers, manifest, and compatibility bytes', () => {
    const direct = new Map(
      renderPluginBundle({
        version: '2.3.4',
        agentKitVersion: '8.9.0',
        cliVersion: '5.6.7',
      }).map((file) => [file.path, file.content]),
    );
    const official = filesByPath(
      renderOfficialDirectoryPlugin({
        version: '2.3.4',
        agentKitVersion: '8.9.0',
        cliVersion: '5.6.7',
      }),
    );

    for (const path of [
      '.claude-plugin/plugin.json',
      'bin/noodle-plugin.mjs',
      'noodle-plugin-compatibility.json',
      `skills/${PLUGIN_NAME}/SKILL.md`,
      `skills/${PLUGIN_NAME}/scripts/noodle-plugin.mjs`,
    ]) {
      expect(official.get(path), path).toBe(direct.get(path));
    }
    expect(JSON.parse(official.get('.claude-plugin/plugin.json') ?? 'null').version).toBe('2.3.4');
    expect(JSON.parse(official.get('.codex-plugin/plugin.json') ?? 'null')).toMatchObject({
      version: '2.3.4',
      skills: './skills/',
      mcpServers: './.mcp.json',
    });
  });

  it('keeps the existing marketplace bundle on both MCPs', () => {
    const direct = new Map(renderPluginBundle().map((file) => [file.path, file.content]));
    const claudeMcp = JSON.parse(direct.get('.mcp.json') ?? 'null');
    const codexMcp = JSON.parse(direct.get('.mcp.codex.json') ?? 'null');

    expect(Object.keys(claudeMcp.mcpServers).sort()).toEqual([
      'noodle-developer',
      'noodle-readiness',
    ]);
    expect(Object.keys(codexMcp.mcpServers).sort()).toEqual([
      'noodle-developer',
      'noodle-readiness',
    ]);
    expect(JSON.parse(direct.get('.claude-plugin/plugin.json') ?? 'null').version).toBe(
      AGENT_KIT_VERSION,
    );
  });

  it('stages the portable package byte-identically under the submission directory', () => {
    const marketplace = new Map(renderMarketplaceRepo().map((file) => [file.path, file.content]));

    for (const file of renderOfficialDirectoryPlugin()) {
      expect(
        marketplace.get(`submission/official-directory/${PLUGIN_NAME}/${file.path}`),
        file.path,
      ).toBe(file.content);
    }
  });
});
