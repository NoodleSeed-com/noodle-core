import { describe, expect, it } from 'vitest';
import { renderBootstrapSkill } from '../src/plugin-bootstrap-skill.js';
import {
  createPluginCompatibility,
  renderPluginCompatibilityJson,
} from '../src/plugin-compatibility.js';
import { renderCopilotPlugin } from '../src/plugin-copilot-bundle.js';

const options = {
  mode: 'release' as const,
  version: '2.3.4',
  agentKitVersion: '8.9.0',
  pluginContentHash: `sha256:${'a'.repeat(64)}`,
  cliVersion: '5.6.7',
  developerMcpUrl: 'https://cloud.noodleseed.dev/developer/mcp',
  developerMcpCapabilityVersion: '1',
};

function filesByPath(): Map<string, string> {
  return new Map(renderCopilotPlugin(options).map((file) => [file.path, file.content]));
}

describe('GitHub Copilot plugin bundle', () => {
  it('renders exactly the approved root-native payload', () => {
    expect([...filesByPath().keys()].sort()).toEqual(
      [
        '.mcp.json',
        'README.md',
        'noodle-plugin-compatibility.json',
        'plugin.json',
        'skills/noodle-seed/SKILL.md',
        'skills/noodle-seed/scripts/noodle-plugin.mjs',
      ].sort(),
    );
  });

  it('binds the native manifest and MCP servers to one selected compatibility tuple', () => {
    const files = filesByPath();
    const manifest = JSON.parse(files.get('plugin.json') ?? 'null');
    expect(manifest).toMatchObject({
      name: 'noodle-seed',
      version: '2.3.4',
      description:
        'Build, validate, test, and deploy production MCP servers and apps from one TypeScript server.ts with Noodle Seed. Connect GitHub Copilot to local readiness tools and governed cloud operations.',
      repository: 'https://github.com/NoodleSeed-com/copilot-plugin',
      keywords: [
        'mcp',
        'mcp-server',
        'copilot',
        'typescript',
        'developer-tools',
        'deployment',
        'noodle-seed',
      ],
      skills: './skills/',
      mcpServers: './.mcp.json',
    });
    expect(manifest.description).not.toMatch(/ChatGPT|Claude|Codex|Cursor|Gemini/i);
    expect(JSON.parse(files.get('.mcp.json') ?? 'null')).toEqual({
      mcpServers: {
        'noodle-developer': {
          type: 'http',
          url: 'https://cloud.noodleseed.dev/developer/mcp',
        },
        'noodle-readiness': {
          type: 'stdio',
          command: 'node',
          args: [
            '${PLUGIN_ROOT}/skills/noodle-seed/scripts/noodle-plugin.mjs',
            'plugin-mcp',
            '--plugin-host',
            'copilot',
            '--plugin-version',
            '2.3.4',
            '--agent-kit-version',
            '8.9.0',
            '--plugin-content-hash',
            `sha256:${'a'.repeat(64)}`,
            '--developer-mcp-url',
            'https://cloud.noodleseed.dev/developer/mcp',
            '--developer-mcp-capability-version',
            '1',
          ],
        },
      },
    });
  });

  it('reuses the canonical skill and compatibility renderers without leaking another host', () => {
    const files = filesByPath();
    expect(files.get('skills/noodle-seed/SKILL.md')).toBe(renderBootstrapSkill('2.3.4'));
    expect(files.get('noodle-plugin-compatibility.json')).toBe(
      renderPluginCompatibilityJson(
        createPluginCompatibility({
          pluginVersion: '2.3.4',
          agentKitVersion: '8.9.0',
          pluginContentHash: `sha256:${'a'.repeat(64)}`,
          cliVersion: '5.6.7',
          developerMcpUrl: 'https://cloud.noodleseed.dev/developer/mcp',
          developerMcpCapabilityVersion: '1',
          mode: 'release',
        }),
      ),
    );

    for (const [path, content] of files) {
      expect(content, path).not.toContain('${CLAUDE_PLUGIN_ROOT}');
      expect(content, path).not.toMatch(/--plugin-host\s+(?!copilot\b)/);
      expect(content, path).not.toMatch(
        /NOODLE_AUTH_TOKEN|oauthRefreshToken|\brefreshToken\b|\bnbk_[A-Za-z0-9]+\b|\bsk-[a-z0-9]{16,}\b/i,
      );
      expect(content, path).not.toContain('NoodleSeed-com/noodle-borg');
    }
  });
});
