// Pure renderers for the shared Noodle Developer plugin host metadata. Keeping these projections in
// one module makes the Claude Code and Codex manifests one logical release surface while allowing
// each host to receive its own install UI fields.

import {
  DEVELOPMENT_CONTENT_HASH,
  type PluginCompatibilityManifest,
} from './plugin-compatibility.js';

export interface PluginHostManifestInput {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly homepage: string;
  readonly repository: string;
  readonly author: Readonly<{ name: string; url: string }>;
  readonly keywords: readonly string[];
  readonly defaultPrompts: readonly string[];
}

export interface RenderedPluginHostManifest {
  readonly path:
    | '.claude-plugin/plugin.json'
    | '.codex-plugin/plugin.json'
    | '.cursor-plugin/plugin.json';
  readonly value: Readonly<Record<string, unknown>>;
}

export interface CopilotPluginManifest {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author: Readonly<{ name: string; url: string }>;
  readonly homepage: string;
  readonly repository: string;
  readonly license: 'Apache-2.0';
  readonly keywords: readonly string[];
  readonly skills: './skills/';
  readonly mcpServers: './.mcp.json';
}

const LICENSE = 'Apache-2.0';

/** Project one plugin identity into the current Claude Code and Codex manifest shapes. */
export function renderPluginHostManifests(
  input: PluginHostManifestInput,
): readonly RenderedPluginHostManifest[] {
  const shared = {
    name: input.name,
    version: input.version,
    description: input.description,
    author: input.author,
    homepage: input.homepage,
    repository: input.repository,
    license: LICENSE,
    keywords: input.keywords,
  };
  return [
    { path: '.claude-plugin/plugin.json', value: shared },
    {
      path: '.codex-plugin/plugin.json',
      value: {
        ...shared,
        mcpServers: './.mcp.codex.json',
        interface: {
          displayName: 'Noodle Seed',
          shortDescription: 'Build and deploy MCP servers and apps from one TypeScript file.',
          longDescription: input.description,
          developerName: 'Noodle Seed',
          category: 'Developer Tools',
          websiteURL: input.homepage,
          capabilities: ['MCP servers', 'MCP apps', 'Hosted deployment'],
          defaultPrompt: input.defaultPrompts.slice(0, 3),
        },
      },
    },
    {
      path: '.cursor-plugin/plugin.json',
      value: {
        name: input.name,
        displayName: 'Noodle Seed',
        version: input.version,
        description: input.description,
        author: { name: input.author.name },
        publisher: input.author.name,
        homepage: input.homepage,
        repository: input.repository,
        license: LICENSE,
        keywords: input.keywords,
        category: 'developer-tools',
        tags: ['mcp', 'ai-apps', 'deployment'],
        skills: './skills/',
        mcpServers: './mcp.json',
      },
    },
  ];
}

/** GitHub Copilot installs this projection directly from a repository root. */
export function renderCopilotPluginManifest(input: PluginHostManifestInput): CopilotPluginManifest {
  return {
    name: input.name,
    version: input.version,
    description: input.description,
    author: input.author,
    homepage: input.homepage,
    repository: input.repository,
    license: LICENSE,
    keywords: input.keywords,
    skills: './skills/',
    mcpServers: './.mcp.json',
  };
}

/** Claude's root `.mcp.json`; OAuth is negotiated by the host, never embedded in the bundle. */
export function renderClaudeDeveloperMcpConfig(
  compatibility: PluginCompatibilityManifest,
): Readonly<Record<string, unknown>> {
  return {
    mcpServers: {
      'noodle-developer': {
        type: 'http',
        url: compatibility.developerMcpUrl,
      },
      'noodle-readiness': localReadinessMcp('claude-code', compatibility, true),
    },
  };
}

/** Codex receives its own wrapped MCP file so the readiness launcher selects the Codex profile. */
export function renderCodexDeveloperMcpConfig(
  compatibility: PluginCompatibilityManifest,
): Readonly<Record<string, unknown>> {
  return {
    mcpServers: {
      'noodle-developer': {
        type: 'http',
        url: compatibility.developerMcpUrl,
      },
      'noodle-readiness': localReadinessMcp('codex', compatibility, false),
    },
  };
}

/** Cursor plugin MCP files use the wrapped server map consumed by the installed plugin. */
export function renderCursorDeveloperMcpConfig(
  compatibility: PluginCompatibilityManifest,
): Readonly<Record<string, unknown>> {
  return {
    mcpServers: {
      'noodle-developer': {
        url: compatibility.developerMcpUrl,
      },
      'noodle-readiness': localReadinessMcp('cursor', compatibility, false),
    },
  };
}

/** GitHub Copilot receives a root-native MCP file and a dedicated local profile. */
export function renderCopilotDeveloperMcpConfig(
  compatibility: PluginCompatibilityManifest,
): Readonly<Record<string, unknown>> {
  return {
    mcpServers: {
      'noodle-developer': {
        type: 'http',
        url: compatibility.developerMcpUrl,
      },
      'noodle-readiness': localReadinessMcp('copilot', compatibility, true),
    },
  };
}

function localReadinessMcp(
  host: 'claude-code' | 'codex' | 'copilot' | 'cursor',
  compatibility: PluginCompatibilityManifest,
  includeType: boolean,
): Readonly<Record<string, unknown>> {
  const args = [
    'plugin-mcp',
    '--plugin-host',
    host,
    '--plugin-version',
    compatibility.pluginVersion,
    '--agent-kit-version',
    compatibility.schemaVersion === 2 ? compatibility.agentKitVersion : compatibility.pluginVersion,
    '--plugin-content-hash',
    compatibility.schemaVersion === 2 ? compatibility.pluginContentHash : DEVELOPMENT_CONTENT_HASH,
    '--developer-mcp-url',
    compatibility.developerMcpUrl,
    '--developer-mcp-capability-version',
    compatibility.developerMcpCapabilityVersion,
  ];
  if (host === 'claude-code') {
    return {
      ...(includeType ? { type: 'stdio' } : {}),
      command: 'node',
      args: ['${CLAUDE_PLUGIN_ROOT}/bin/noodle-plugin.mjs', ...args],
    };
  }
  if (host === 'codex') {
    return {
      command: 'node',
      args: ['skills/noodle-seed/scripts/noodle-plugin.mjs', ...args],
      cwd: '.',
    };
  }
  if (host === 'copilot') {
    return {
      ...(includeType ? { type: 'stdio' } : {}),
      command: 'node',
      args: ['${PLUGIN_ROOT}/skills/noodle-seed/scripts/noodle-plugin.mjs', ...args],
    };
  }
  return {
    command: 'npx',
    args: ['--yes', `@noodleseed/one@${compatibility.cliVersion}`, ...args],
  };
}
