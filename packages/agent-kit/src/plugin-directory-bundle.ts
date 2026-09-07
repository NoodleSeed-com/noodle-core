// One portable official-directory projection. Claude consumes the plugin root; OpenAI consumes the
// same noodle-seed skill directory. Both receive the same release-pinned skill and launcher bytes,
// while the directory manifests declare only the remote Developer MCP.
import {
  PLUGIN_NAME,
  type PluginBundleFile,
  type PluginRenderOptions,
  renderPluginBundle,
} from './plugin-bundle.js';

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function requiredFile(files: ReadonlyMap<string, string>, path: string): string {
  const content = files.get(path);
  if (content === undefined) throw new Error(`direct plugin bundle is missing ${path}`);
  return content;
}

function renderOpenAiPluginManifest(files: ReadonlyMap<string, string>): string {
  const manifest = JSON.parse(requiredFile(files, '.codex-plugin/plugin.json')) as Record<
    string,
    unknown
  >;
  return json({
    ...manifest,
    skills: './skills/',
    mcpServers: './.mcp.json',
  });
}

function officialDirectoryReadme(): string {
  return [
    '# Noodle Seed official-directory plugin',
    '',
    'This portable directory is the single submission source for Claude and OpenAI plugin directories.',
    'It declares one remote MCP, `noodle-developer`, and ships the shared adaptive `noodle-seed` skill.',
    'Claude and OpenAI receive their native plugin manifests from this same generated root.',
    'When a host does not expose the local `noodle-readiness` MCP, the skill privately invokes the',
    'release-pinned packaged launcher and continues to report only public `noodle ...` commands.',
    '',
    'The direct coding-agent marketplace plugin remains a separate projection of the same source and',
    'continues to declare both `noodle-developer` and `noodle-readiness`.',
    '',
  ].join('\n');
}

function renderOpenAiSkillManifest(developerMcpUrl: string): string {
  return [
    'interface:',
    '  display_name: "Noodle Seed"',
    '  short_description: "Build and deploy MCP servers and apps"',
    '  default_prompt: "Use $noodle-seed to build, validate, test, and prepare a Noodle Seed MCP server or app from this workspace. Ask before any hosted mutation."',
    'dependencies:',
    '  tools:',
    '    - type: "mcp"',
    '      value: "noodle-developer"',
    '      description: "Inspect and operate existing Noodle Seed hosted apps and deployments"',
    '      transport: "streamable_http"',
    `      url: "${developerMcpUrl}"`,
    'policy:',
    '  allow_implicit_invocation: true',
    '',
  ].join('\n');
}

/** Render the one-MCP package submitted to both Claude and OpenAI official directories. */
export function renderOfficialDirectoryPlugin(
  options: PluginRenderOptions = {},
): readonly PluginBundleFile[] {
  const direct = new Map(renderPluginBundle(options).map((file) => [file.path, file.content]));
  const directMcp = JSON.parse(requiredFile(direct, '.mcp.json')) as {
    mcpServers?: Record<string, unknown>;
  };
  const developerMcp = directMcp.mcpServers?.['noodle-developer'];
  if (developerMcp === undefined) {
    throw new Error('direct plugin bundle is missing noodle-developer MCP');
  }
  const developerMcpUrl = (developerMcp as { url?: unknown }).url;
  if (typeof developerMcpUrl !== 'string' || developerMcpUrl.length === 0) {
    throw new Error('direct plugin bundle has an invalid noodle-developer MCP URL');
  }

  return [
    {
      path: '.claude-plugin/plugin.json',
      content: requiredFile(direct, '.claude-plugin/plugin.json'),
    },
    {
      path: '.codex-plugin/plugin.json',
      content: renderOpenAiPluginManifest(direct),
    },
    {
      path: '.mcp.json',
      content: json({ mcpServers: { 'noodle-developer': developerMcp } }),
    },
    { path: 'README.md', content: officialDirectoryReadme() },
    { path: 'bin/noodle-plugin.mjs', content: requiredFile(direct, 'bin/noodle-plugin.mjs') },
    {
      path: 'noodle-plugin-compatibility.json',
      content: requiredFile(direct, 'noodle-plugin-compatibility.json'),
    },
    {
      path: `skills/${PLUGIN_NAME}/SKILL.md`,
      content: requiredFile(direct, `skills/${PLUGIN_NAME}/SKILL.md`),
    },
    {
      path: `skills/${PLUGIN_NAME}/agents/openai.yaml`,
      content: renderOpenAiSkillManifest(developerMcpUrl),
    },
    {
      path: `skills/${PLUGIN_NAME}/scripts/noodle-plugin.mjs`,
      content: requiredFile(direct, `skills/${PLUGIN_NAME}/scripts/noodle-plugin.mjs`),
    },
  ];
}
