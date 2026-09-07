// The globally-installable Noodle Seed authoring plugin for Claude Code and Codex. It fixes the
// cold-start gap: a developer installs the plugin into their coding agent once, and from the first
// prompt in any directory the agent knows to reach for exact, typed plugin operations backed by the
// compatible CLI, scaffold with `noodle init`, and then defer to the project-local `noodle-seed` skill
// that init
// installs. One shared plugin directory serves all hosts. The global bundle stays intentionally
// lean: manifests, MCP projections, private transport launchers, and one cold-start router. Rich
// references and examples are generated into each project, where they can match that project's SDK
// and CLI contract.
import { AGENT_KIT_VERSION } from './index.js';
import { PLUGIN_NAME, renderBootstrapSkill } from './plugin-bootstrap-skill.js';
import {
  createPluginCompatibility,
  renderPluginCompatibilityJson,
} from './plugin-compatibility.js';
import { renderOfficialDirectoryPlugin } from './plugin-directory-bundle.js';
import { renderPluginLauncher } from './plugin-launcher.js';
import {
  renderClaudeDeveloperMcpConfig,
  renderCodexDeveloperMcpConfig,
  renderCursorDeveloperMcpConfig,
  renderPluginHostManifests,
} from './plugin-manifests.js';
import { renderPluginMarketplaceDocs } from './plugin-marketplace-docs.js';
import { PLUGIN_WINDOWS_SUPPORT } from './plugin-platform-support.js';
import {
  renderChatGptSubmission,
  renderClaudeSubmission,
  renderCursorSubmission,
  renderSubmissionReadme,
} from './plugin-submission.js';

export { PLUGIN_NAME } from './plugin-bootstrap-skill.js';
/** The public marketplace identifier (`/plugin install noodle-seed@noodleseed`). */
export const MARKETPLACE_NAME = 'noodleseed';
/** Where the plugin lives inside the marketplace repo (relative sources must start with "./"). */
export const PLUGIN_SOURCE_PATH = './plugins/noodle-seed';

const HOMEPAGE = 'https://noodleseed.dev';
const AUTHOR = { name: 'Noodle Seed', url: HOMEPAGE } as const;
const OWNER = { name: 'Noodle Seed' } as const;

const PLUGIN_DESCRIPTION =
  'Build production MCP servers and apps with Noodle Seed: author one TypeScript server.ts with ' +
  'the noodle CLI, validate and test locally, then deploy to a governed hosted MCP endpoint that ' +
  'works in ChatGPT, Claude, Codex, Cursor, Gemini, and every MCP client.';

/**
 * The skill frontmatter description. It must auto-trigger on cold intents ("build an MCP app",
 * "make a ChatGPT app", "ship an MCP app for Claude Code") from developers who have never heard of
 * Noodle Seed — this is the whole point of the global plugin.
 */
/** Starter prompts surfaced by the Codex install UI (mirrors the website starter intents). */
const DEFAULT_PROMPTS: readonly string[] = [
  'Create a ChatGPT app for my support workflow',
  'Create a Claude connector for my SaaS',
  'Create an MCP app with a small UI',
];

export interface PluginBundleFile {
  readonly path: string;
  readonly content: string;
}

export interface PluginRenderOptions {
  /**
   * Release version stamped into plugin manifests and the router body metadata. Defaults to the
   * in-repo AGENT_KIT_VERSION (development metadata); the marketplace render script passes the
   * published @noodleseed/agent-kit version so pushed content always matches a real release.
   */
  readonly version?: string;
  /** Agent Kit package that rendered this plugin. Independent from the plugin's own version. */
  readonly agentKitVersion?: string;
  /** Normalized plugin-content fingerprint used to decide the plugin's independent SemVer. */
  readonly pluginContentHash?: string;
  /** Release mode requires the complete compatibility set; development mode uses inert defaults. */
  readonly mode?: 'development' | 'release';
  readonly cliVersion?: string;
  readonly developerMcpUrl?: string;
  readonly developerMcpCapabilityVersion?: string;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function pluginReadme(compatibility: ReturnType<typeof createPluginCompatibility>): string {
  if (compatibility.schemaVersion !== 2) {
    throw new Error('plugin README requires current compatibility provenance');
  }
  return [
    '# Noodle Seed plugin',
    '',
    'This is the installable Noodle Seed bootstrap for Claude Code, Codex, and Cursor. It connects',
    'the host to Noodle Seed MCP services and invokes one exact CLI package behind typed local',
    'plugin functions. Project-specific guidance is generated into each project by `noodle init`.',
    '',
    '## Installed compatibility',
    '',
    `- Plugin version: \`${compatibility.pluginVersion}\``,
    `- Agent Kit: \`${compatibility.agentKitVersion}\``,
    `- CLI: \`@noodleseed/one@${compatibility.cliVersion}\``,
    `- MCP capability: \`${compatibility.developerMcpCapabilityVersion}\``,
    '',
    'These values are generated and released as one verified compatibility set. Do not edit them',
    'inside an installed plugin.',
    '',
    '## Supported platforms',
    '',
    `Run the plugin on macOS or from ${PLUGIN_WINDOWS_SUPPORT.supportedShell} with Linux Node.js and npm.`,
    `Native ${PLUGIN_WINDOWS_SUPPORT.unsupportedShells} are unsupported; from PowerShell, run \`${PLUGIN_WINDOWS_SUPPORT.installCommand}\`,`,
    'then install and run the coding-agent host inside Ubuntu.',
    '',
    '## Trust boundary',
    '',
    '- The private plugin bootstrap may download the exact CLI package from the npm registry on first use.',
    '- The plugin connects only to the declared Noodle Seed MCP endpoints and does not forward host',
    '  bearer tokens to business backends.',
    '- The plugin does not collect or send feedback without explicit approval for the disclosed',
    '  command and payload.',
    '- Secrets stay in Noodle Seed managed secret storage; they must not be placed in prompts, source,',
    '  generated files, or logs.',
    '',
    'Read [security and permissions](https://github.com/NoodleSeed-com/plugins/blob/main/docs/security-and-permissions.md) before enabling access.',
    '',
    '## Recovery',
    '',
    'If the private plugin bootstrap cannot resolve its pinned CLI, preserve the npm diagnostic, verify npm',
    'registry access, then update or reinstall the plugin. See the',
    '[troubleshooting guide](https://github.com/NoodleSeed-com/plugins/blob/main/docs/troubleshooting.md) for the canonical checks.',
    '',
  ].join('\n');
}

function pluginChangelog(compatibility: ReturnType<typeof createPluginCompatibility>): string {
  if (compatibility.schemaVersion !== 2) {
    throw new Error('plugin changelog requires current compatibility provenance');
  }
  return [
    '# Plugin changelog',
    '',
    `## ${compatibility.pluginVersion}`,
    '',
    `- Generated by Agent Kit \`${compatibility.agentKitVersion}\``,
    `- Uses CLI \`@noodleseed/one@${compatibility.cliVersion}\``,
    `- MCP capability \`${compatibility.developerMcpCapabilityVersion}\``,
    `- Content fingerprint \`${compatibility.pluginContentHash}\``,
    '',
    'The generated marketplace root changelog and System Release history are the authoritative',
    'cross-version record for this plugin.',
    '',
  ].join('\n');
}

/** The shared plugin directory: host manifests, MCP projections, launchers, and one bootstrap router. */
export function renderPluginBundle(options: PluginRenderOptions = {}): readonly PluginBundleFile[] {
  const version = options.version ?? AGENT_KIT_VERSION;
  const compatibility = createPluginCompatibility({
    pluginVersion: version,
    ...(options.agentKitVersion === undefined ? {} : { agentKitVersion: options.agentKitVersion }),
    ...(options.pluginContentHash === undefined
      ? {}
      : { pluginContentHash: options.pluginContentHash }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.cliVersion === undefined ? {} : { cliVersion: options.cliVersion }),
    ...(options.developerMcpUrl === undefined ? {} : { developerMcpUrl: options.developerMcpUrl }),
    ...(options.developerMcpCapabilityVersion === undefined
      ? {}
      : { developerMcpCapabilityVersion: options.developerMcpCapabilityVersion }),
  });
  const hostManifests = renderPluginHostManifests({
    name: PLUGIN_NAME,
    version,
    description: PLUGIN_DESCRIPTION,
    author: AUTHOR,
    homepage: HOMEPAGE,
    repository: 'https://github.com/NoodleSeed-com/plugins',
    keywords: ['mcp', 'mcp-server', 'chatgpt-apps', 'claude', 'codex', 'noodleseed'],
    defaultPrompts: DEFAULT_PROMPTS,
  });
  return [
    ...hostManifests.map(({ path, value }) => ({ path, content: json(value) })),
    { path: 'CHANGELOG.md', content: pluginChangelog(compatibility) },
    { path: 'README.md', content: pluginReadme(compatibility) },
    {
      path: '.mcp.json',
      content: json(renderClaudeDeveloperMcpConfig(compatibility)),
    },
    {
      path: '.mcp.codex.json',
      content: json(renderCodexDeveloperMcpConfig(compatibility)),
    },
    {
      path: 'mcp.json',
      content: json(renderCursorDeveloperMcpConfig(compatibility)),
    },
    {
      path: 'noodle-plugin-compatibility.json',
      content: renderPluginCompatibilityJson(compatibility),
    },
    {
      path: 'bin/noodle-plugin.mjs',
      content: renderPluginLauncher({ host: 'claude-code', cliVersion: compatibility.cliVersion }),
    },
    { path: `skills/${PLUGIN_NAME}/SKILL.md`, content: renderBootstrapSkill(version) },
    {
      path: `skills/${PLUGIN_NAME}/scripts/noodle-plugin.mjs`,
      content: renderPluginLauncher({ host: 'codex', cliVersion: compatibility.cliVersion }),
    },
    {
      path: `skills/${PLUGIN_NAME}/scripts/noodle-plugin-cursor.mjs`,
      content: renderPluginLauncher({ host: 'cursor', cliVersion: compatibility.cliVersion }),
    },
  ];
}

/**
 * Both marketplace catalogs, rendered from one entry: the Claude format (relative-string source;
 * Codex also reads it for legacy compat) and the native Codex format (object source + policy).
 */
export function renderMarketplaceCatalogs(
  options: PluginRenderOptions = {},
): readonly PluginBundleFile[] {
  const version = options.version ?? AGENT_KIT_VERSION;
  const entryMetadata = {
    name: PLUGIN_NAME,
    description: PLUGIN_DESCRIPTION,
    version,
    author: OWNER,
    homepage: HOMEPAGE,
    license: 'Apache-2.0',
    category: 'developer-tools',
  };
  return [
    {
      path: '.claude-plugin/marketplace.json',
      content: json({
        name: MARKETPLACE_NAME,
        owner: OWNER,
        description: 'Official Noodle Seed plugins for coding agents.',
        plugins: [{ ...entryMetadata, source: PLUGIN_SOURCE_PATH }],
      }),
    },
    {
      path: '.agents/plugins/marketplace.json',
      content: json({
        name: MARKETPLACE_NAME,
        interface: { displayName: 'Noodle Seed' },
        plugins: [
          {
            ...entryMetadata,
            source: { source: 'local', path: PLUGIN_SOURCE_PATH },
            policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
            category: 'Developer Tools',
          },
        ],
      }),
    },
    {
      path: '.cursor-plugin/marketplace.json',
      content: json({
        name: MARKETPLACE_NAME,
        owner: OWNER,
        metadata: { description: 'Official Noodle Seed plugins for coding agents.' },
        plugins: [
          {
            name: PLUGIN_NAME,
            source: 'plugins/noodle-seed',
            description: PLUGIN_DESCRIPTION,
          },
        ],
      }),
    },
  ];
}

function marketplaceReadme(version: string): string {
  return [
    '# Noodle Seed plugins',
    '',
    'The official [Noodle Seed](https://noodleseed.dev) plugin marketplace for AI coding agents.',
    `Install the \`${PLUGIN_NAME}\` plugin once and your coding agent knows how to build, validate,`,
    'and deploy production MCP servers and apps with the `noodle` CLI from the very first prompt.',
    '',
    '## Install',
    '',
    '**Claude Code**',
    '',
    '```text',
    '/plugin marketplace add NoodleSeed-com/plugins',
    `/plugin install ${PLUGIN_NAME}@${MARKETPLACE_NAME}`,
    '```',
    '',
    '**Codex**',
    '',
    '```text',
    'codex plugin marketplace add NoodleSeed-com/plugins',
    `codex plugin add ${PLUGIN_NAME}@${MARKETPLACE_NAME}`,
    '```',
    '',
    '**Cursor**',
    '',
    'Add `NoodleSeed-com/plugins` as a custom or team marketplace in Cursor, then install',
    `\`${PLUGIN_NAME}\`. Directory listing is tracked separately from direct repository distribution.`,
    '',
    'Full setup, updates, and removal: [docs/installation.md](docs/installation.md).',
    '',
    '## Your first prompt',
    '',
    '> Build an MCP app for this project with Noodle Seed. Validate it locally and show me the deployment plan before deploying.',
    '',
    '## What you get',
    '',
    `- The lean \`${PLUGIN_NAME}\` bootstrap skill plus pinned launchers and MCP connections.`,
    '- After `noodle init`, the plugin defers to the self-updating project-local skill, which carries',
    '  the compatible command guidance, references, examples, and project defaults.',
    '',
    '## Guides',
    '',
    '- [Installation](docs/installation.md)',
    '- [How it works](docs/how-it-works.md)',
    '- [Security and permissions](docs/security-and-permissions.md)',
    '- [Troubleshooting](docs/troubleshooting.md)',
    '',
    '## About this repository',
    '',
    `This repository is **generated** from \`@noodleseed/agent-kit@${version}\` by the Noodle Seed`,
    'release process. Do not edit it by hand — changes land through <https://noodleseed.dev>',
    'releases. Docs: <https://docs.noodleseed.dev>.',
    '',
  ].join('\n');
}

/** The full public marketplace repo layout: catalogs + README + the plugin under plugins/<name>/. */
export function renderMarketplaceRepo(
  options: PluginRenderOptions = {},
): readonly PluginBundleFile[] {
  const version = options.version ?? AGENT_KIT_VERSION;
  const agentKitVersion = options.agentKitVersion ?? AGENT_KIT_VERSION;
  return [
    ...renderMarketplaceCatalogs(options),
    { path: 'README.md', content: marketplaceReadme(agentKitVersion) },
    ...renderPluginMarketplaceDocs({
      version,
      pluginName: PLUGIN_NAME,
      marketplaceName: MARKETPLACE_NAME,
    }),
    { path: 'submission/README.md', content: renderSubmissionReadme() },
    {
      path: 'submission/chatgpt-app-submission.json',
      content: json(renderChatGptSubmission()),
    },
    {
      path: 'submission/claude-connector-submission.json',
      content: json(renderClaudeSubmission()),
    },
    {
      path: 'submission/cursor-plugin-submission.json',
      content: json(renderCursorSubmission()),
    },
    ...renderOfficialDirectoryPlugin(options).map((file) => ({
      path: `submission/official-directory/${PLUGIN_NAME}/${file.path}`,
      content: file.content,
    })),
    ...renderPluginBundle(options).map((file) => ({
      path: `plugins/${PLUGIN_NAME}/${file.path}`,
      content: file.content,
    })),
  ];
}
