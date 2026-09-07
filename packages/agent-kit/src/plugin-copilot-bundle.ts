// The GitHub Copilot projection is deliberately root-native: its public repository contains only
// release-generated plugin bytes, while Agent Kit remains the pure canonical renderer.
import pkg from '../package.json' with { type: 'json' };
import { PLUGIN_NAME, renderBootstrapSkill } from './plugin-bootstrap-skill.js';
import type { PluginBundleFile, PluginRenderOptions } from './plugin-bundle.js';
import {
  createPluginCompatibility,
  renderPluginCompatibilityJson,
} from './plugin-compatibility.js';
import { renderPluginLauncher } from './plugin-launcher.js';
import {
  renderCopilotDeveloperMcpConfig,
  renderCopilotPluginManifest,
} from './plugin-manifests.js';

const HOMEPAGE = 'https://noodleseed.dev';
const AGENT_KIT_VERSION: string = pkg.version;
const AUTHOR = { name: 'Noodle Seed', url: HOMEPAGE } as const;
const DESCRIPTION =
  'Build, validate, test, and deploy production MCP servers and apps from one TypeScript server.ts ' +
  'with Noodle Seed. Connect GitHub Copilot to local readiness tools and governed cloud operations.';

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function copilotReadme(compatibility: ReturnType<typeof createPluginCompatibility>): string {
  if (compatibility.schemaVersion !== 2) {
    throw new Error('Copilot plugin README requires current compatibility provenance');
  }
  return [
    '# Noodle Seed GitHub Copilot plugin',
    '',
    'This generated plugin guides GitHub Copilot through the Noodle Seed TypeScript-first workflow: author',
    'one `server.ts`, validate and test locally, then deploy to a governed hosted MCP endpoint. Copilot',
    'writes and edits the application source; Noodle Seed supplies guidance, validation, deployment, and',
    'Cloud operations.',
    '',
    '## Install and update',
    '',
    '`copilot plugin install NoodleSeed-com/copilot-plugin`',
    '',
    'Use the GitHub Copilot plugin update flow to receive a later released version.',
    '',
    '## First verification',
    '',
    'In a coding workspace, ask Copilot to create a Noodle Seed MCP app. It should use the',
    '`noodle-readiness` MCP when available, or privately run the packaged launcher and report only the',
    'corresponding public `noodle ...` outcome.',
    '',
    '## Compatibility and profile',
    '',
    `- Plugin version: \`${compatibility.pluginVersion}\``,
    `- Agent Kit: \`${compatibility.agentKitVersion}\``,
    `- CLI: \`@noodleseed/one@${compatibility.cliVersion}\``,
    `- MCP capability: \`${compatibility.developerMcpCapabilityVersion}\``,
    '',
    'The local launcher uses a Copilot-specific Noodle profile. GitHub Copilot manages OAuth for the',
    'remote developer MCP; credentials remain outside this generated repository.',
    '',
    '## Supported systems',
    '',
    'Use macOS or Linux. Native Windows is unsupported for the local launcher; use WSL2 Ubuntu Bash',
    '(`wsl --install -d Ubuntu`) before installing the plugin.',
    '',
    '## Support',
    '',
    '- [Noodle Seed documentation](https://docs.noodleseed.dev)',
    '- [Support](https://noodleseed.com/support)',
    '- [Privacy](https://noodleseed.com/privacy)',
    '- [Terms](https://noodleseed.com/terms)',
    '',
  ].join('\n');
}

/** Render the pure six-file GitHub Copilot payload; release trust files are added by its owner. */
export function renderCopilotPlugin(options: PluginRenderOptions): readonly PluginBundleFile[] {
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
  return [
    {
      path: 'plugin.json',
      content: json(
        renderCopilotPluginManifest({
          name: PLUGIN_NAME,
          version,
          description: DESCRIPTION,
          author: AUTHOR,
          homepage: HOMEPAGE,
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
          defaultPrompts: [],
        }),
      ),
    },
    { path: '.mcp.json', content: json(renderCopilotDeveloperMcpConfig(compatibility)) },
    { path: 'README.md', content: copilotReadme(compatibility) },
    {
      path: `skills/${PLUGIN_NAME}/scripts/noodle-plugin.mjs`,
      content: renderPluginLauncher({ host: 'copilot', cliVersion: compatibility.cliVersion }),
    },
    {
      path: 'noodle-plugin-compatibility.json',
      content: renderPluginCompatibilityJson(compatibility),
    },
    { path: `skills/${PLUGIN_NAME}/SKILL.md`, content: renderBootstrapSkill(version) },
  ];
}
