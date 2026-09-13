import { describe, expect, it } from 'vitest';
import { AGENT_KIT_VERSION, contentHash } from '../src/index.js';
import {
  MARKETPLACE_NAME,
  PLUGIN_NAME,
  PLUGIN_SOURCE_PATH,
  renderMarketplaceCatalogs,
  renderMarketplaceRepo,
  renderPluginBundle,
} from '../src/plugin-bundle.js';

function bundleFile(path: string): string {
  const file = renderPluginBundle().find((f) => f.path === path);
  if (file === undefined) throw new Error(`missing bundle file ${path}`);
  return file.content;
}

function frontmatterAndBody(content: string): { frontmatter: string; body: string } {
  const lines = content.split('\n');
  expect(lines[0]).toBe('---');
  const close = lines.indexOf('---', 1);
  return {
    frontmatter: lines.slice(1, close).join('\n'),
    body: lines
      .slice(close + 2)
      .join('\n')
      .replace(/\n$/, ''),
  };
}

describe('authoring plugin bundle', () => {
  it('emits a lean bootstrap without project-local references or examples', () => {
    const paths = renderPluginBundle()
      .map((f) => f.path)
      .sort();
    expect(paths).toEqual(
      [
        '.claude-plugin/plugin.json',
        '.codex-plugin/plugin.json',
        '.cursor-plugin/plugin.json',
        '.mcp.codex.json',
        '.mcp.json',
        'CHANGELOG.md',
        'README.md',
        'bin/noodle-plugin.mjs',
        'noodle-plugin-compatibility.json',
        'mcp.json',
        `skills/${PLUGIN_NAME}/scripts/noodle-plugin.mjs`,
        `skills/${PLUGIN_NAME}/scripts/noodle-plugin-cursor.mjs`,
        `skills/${PLUGIN_NAME}/SKILL.md`,
      ].sort(),
    );
    // The global plugin owns only cold start. Rich references and examples are installed into the
    // project through the private plugin transport, where they can match that project's generated contract.
    expect(paths.some((p) => p.includes('/references/'))).toBe(false);
    expect(paths.some((p) => p.includes('/examples/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('commands/'))).toBe(false);
  });

  it('guides a cold-start agent toward continuous onboarding when account growth matters', () => {
    const bootstrap = bundleFile(`skills/${PLUGIN_NAME}/SKILL.md`);

    expect(frontmatterAndBody(bootstrap).frontmatter).toMatch(/signup or onboarding conversion/i);
    expect(bootstrap).toContain('## First-workflow default');
    expect(bootstrap).toMatch(/inspect the available product and repository context/i);
    expect(bootstrap).toMatch(/more signed-up or signed-in users.*valuable/i);
    expect(bootstrap).toMatch(/recommend public-to-product continuous onboarding/i);
    expect(bootstrap).toMatch(/not limited to B2B SaaS/i);
    expect(bootstrap).toMatch(/do not infer fit from the industry label alone/i);
    expect(bootstrap).toContain('embedding-mcp-assistants');
  });

  it('ships a plugin-local trust and recovery guide', () => {
    const readme = renderPluginBundle({
      version: '2.3.4',
      agentKitVersion: '8.9.0',
      cliVersion: '5.6.7',
    }).find((file) => file.path === 'README.md')?.content;

    expect(readme).toContain('# Noodle Seed plugin');
    expect(readme).toContain('Plugin version: `2.3.4`');
    expect(readme).toContain('Agent Kit: `8.9.0`');
    expect(readme).toContain('CLI: `@noodleseed/one@5.6.7`');
    expect(readme).toContain('WSL2 Ubuntu Bash');
    expect(readme).toContain('wsl --install -d Ubuntu');
    expect(readme).toContain('does not collect or send feedback without explicit approval');
    expect(readme).toContain(
      'https://github.com/NoodleSeed-com/plugins/blob/main/docs/security-and-permissions.md',
    );
    expect(readme).toContain(
      'https://github.com/NoodleSeed-com/plugins/blob/main/docs/troubleshooting.md',
    );
    expect(readme).not.toContain('../../docs/');
    const changelog = renderPluginBundle({
      version: '2.3.4',
      agentKitVersion: '8.9.0',
      cliVersion: '5.6.7',
      pluginContentHash: `sha256:${'a'.repeat(64)}`,
    }).find((file) => file.path === 'CHANGELOG.md')?.content;
    expect(changelog).toContain('## 2.3.4');
    expect(changelog).toContain('Agent Kit `8.9.0`');
    expect(changelog).toContain(`sha256:${'a'.repeat(64)}`);
  });

  it('connects both hosts to remote operations and the exact pinned local readiness MCP', () => {
    expect(JSON.parse(bundleFile('.mcp.json'))).toEqual({
      mcpServers: {
        'noodle-developer': {
          type: 'http',
          url: 'https://cloud.noodleseed.dev/developer/mcp',
        },
        'noodle-readiness': {
          type: 'stdio',
          command: 'node',
          args: [
            '${CLAUDE_PLUGIN_ROOT}/bin/noodle-plugin.mjs',
            'plugin-mcp',
            '--plugin-host',
            'claude-code',
            '--plugin-version',
            AGENT_KIT_VERSION,
            '--agent-kit-version',
            AGENT_KIT_VERSION,
            '--plugin-content-hash',
            `sha256:${'0'.repeat(64)}`,
            '--developer-mcp-url',
            'https://cloud.noodleseed.dev/developer/mcp',
            '--developer-mcp-capability-version',
            '0.0.0',
          ],
        },
      },
    });
    const codexManifest = JSON.parse(bundleFile('.codex-plugin/plugin.json'));
    expect(codexManifest.mcpServers).toBe('./.mcp.codex.json');
    const codexMcp = JSON.parse(bundleFile('.mcp.codex.json'));
    expect(codexMcp.mcpServers['noodle-developer']).toEqual({
      type: 'http',
      url: 'https://cloud.noodleseed.dev/developer/mcp',
    });
    expect(codexMcp.mcpServers['noodle-readiness']).toMatchObject({
      command: 'node',
      cwd: '.',
    });
    expect(codexMcp.mcpServers['noodle-readiness'].args[0]).toBe(
      'skills/noodle-seed/scripts/noodle-plugin.mjs',
    );
    expect(codexMcp.mcpServers['noodle-readiness'].args).toEqual(
      expect.arrayContaining(['--plugin-host', 'codex']),
    );
  });

  it('renders every JSON payload as valid JSON', () => {
    for (const file of renderPluginBundle().filter(({ path }) => path.endsWith('.json'))) {
      expect(() => JSON.parse(file.content), file.path).not.toThrow();
    }
  });

  it('binds release bundle metadata to one exact compatibility set', () => {
    const files = renderPluginBundle({
      mode: 'release',
      version: '2.3.4',
      agentKitVersion: '8.9.0',
      pluginContentHash: `sha256:${'a'.repeat(64)}`,
      cliVersion: '5.6.7',
      developerMcpUrl: 'https://cloud.noodleseed.dev/developer/mcp',
      developerMcpCapabilityVersion: '1',
    });
    expect(
      JSON.parse(
        files.find((file) => file.path === 'noodle-plugin-compatibility.json')?.content ?? 'null',
      ),
    ).toEqual({
      schemaVersion: 2,
      pluginVersion: '2.3.4',
      agentKitVersion: '8.9.0',
      pluginContentHash: `sha256:${'a'.repeat(64)}`,
      cliVersion: '5.6.7',
      developerMcpUrl: 'https://cloud.noodleseed.dev/developer/mcp',
      developerMcpCapabilityVersion: '1',
    });
    expect(JSON.parse(files.find((file) => file.path === '.mcp.json')?.content ?? 'null')).toEqual({
      mcpServers: {
        'noodle-developer': {
          type: 'http',
          url: 'https://cloud.noodleseed.dev/developer/mcp',
        },
        'noodle-readiness': {
          type: 'stdio',
          command: 'node',
          args: [
            '${CLAUDE_PLUGIN_ROOT}/bin/noodle-plugin.mjs',
            'plugin-mcp',
            '--plugin-host',
            'claude-code',
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
    expect(
      JSON.parse(files.find((file) => file.path === '.codex-plugin/plugin.json')?.content ?? 'null')
        .mcpServers,
    ).toBe('./.mcp.codex.json');
    expect(
      JSON.parse(files.find((file) => file.path === '.mcp.codex.json')?.content ?? 'null')
        .mcpServers['noodle-readiness'].args,
    ).toEqual(expect.arrayContaining(['--plugin-host', 'codex']));
  });

  it('renders a valid Claude Code plugin manifest', () => {
    const manifest = JSON.parse(bundleFile('.claude-plugin/plugin.json'));
    expect(manifest.name).toBe(PLUGIN_NAME);
    expect(manifest.version).toBe(AGENT_KIT_VERSION);
    expect(manifest.description.length).toBeGreaterThan(20);
    expect(manifest.homepage).toContain('noodleseed.dev');
    expect(manifest.license).toBe('Apache-2.0');
    expect(manifest.author?.name).toBe('Noodle Seed');
  });

  it('renders a valid Codex plugin manifest with the interface block', () => {
    const manifest = JSON.parse(bundleFile('.codex-plugin/plugin.json'));
    // Codex minimum (re-verified 2026-07-15): name + version + description.
    expect(manifest.name).toBe(PLUGIN_NAME);
    expect(manifest.version).toBe(AGENT_KIT_VERSION);
    expect(manifest.description.length).toBeGreaterThan(20);
    expect(manifest.displayName).toBeUndefined();
    expect(manifest.mcpServers).toBe('./.mcp.codex.json');
    expect(manifest.interface.displayName).toBe('Noodle Seed');
    expect(manifest.interface.developerName).toBe('Noodle Seed');
    expect(manifest.interface.websiteURL).toContain('noodleseed.dev');
    expect(Array.isArray(manifest.interface.capabilities)).toBe(true);
    expect(manifest.interface.capabilities.length).toBeGreaterThan(0);
    expect(Array.isArray(manifest.interface.defaultPrompt)).toBe(true);
    expect(manifest.interface.defaultPrompt).toHaveLength(3);
  });

  it('renders the official Cursor plugin projection and its two MCP identities', () => {
    const manifest = JSON.parse(bundleFile('.cursor-plugin/plugin.json'));
    expect(manifest).toMatchObject({
      name: PLUGIN_NAME,
      displayName: 'Noodle Seed',
      version: AGENT_KIT_VERSION,
      publisher: 'Noodle Seed',
      skills: './skills/',
      mcpServers: './mcp.json',
    });
    expect(manifest.author).toEqual({ name: 'Noodle Seed' });
    expect(manifest.author.url).toBeUndefined();

    const config = JSON.parse(bundleFile('mcp.json'));
    expect(Object.keys(config.mcpServers).sort()).toEqual(['noodle-developer', 'noodle-readiness']);
    expect(config.mcpServers['noodle-developer']).toEqual({
      url: 'https://cloud.noodleseed.dev/developer/mcp',
    });
    expect(config.mcpServers['noodle-readiness']).toMatchObject({
      command: 'npx',
      args: expect.arrayContaining([
        '@noodleseed/one@0.0.0',
        '--plugin-host',
        'cursor',
        '--plugin-version',
        AGENT_KIT_VERSION,
      ]),
    });
  });

  it('keeps bootstrap frontmatter spec-valid and self-identifies in a body metadata comment', () => {
    const router = bundleFile(`skills/${PLUGIN_NAME}/SKILL.md`);
    const { frontmatter, body } = frontmatterAndBody(router);
    expect(frontmatter.split('\n').map((line) => line.split(':', 1)[0])).toEqual([
      'name',
      'description',
    ]);
    const metadata = /^<!-- noodle-skill version:([^ ]+) hash:([a-f0-9]{16}) -->$/m.exec(body);
    expect(metadata?.[1]).toBe(AGENT_KIT_VERSION);
    const skillBody = body.replace(/^<!-- noodle-skill[^\n]+ -->\n\n/, '');
    expect(metadata?.[2]).toBe(contentHash(skillBody));
    // The description must trigger on cold intents from users who have never heard of Noodle Seed.
    const description = /description: (.+)/.exec(frontmatter)?.[1] ?? '';
    // Regression (caught by `claude plugin validate`): an unquoted YAML scalar containing ": "
    // fails to parse and Claude Code silently drops ALL frontmatter — the skill loses its name,
    // description, and auto-trigger. Keep every frontmatter value colon-free.
    for (const line of frontmatter.split('\n')) {
      expect(line.split(': ').length, line).toBe(2);
    }
    expect(description).toMatch(/MCP server/i);
    expect(description).toMatch(/MCP app/i);
    expect(description).toMatch(/AI agents/i);
    expect(description).not.toMatch(/ChatGPT|Claude|Gemini|Codex|Cursor|OpenAI/i);
    expect(skillBody).not.toMatch(/ChatGPT|Claude|Gemini|Codex|Cursor|OpenAI/i);
  });

  it('prefers readiness, falls back to inline execution, and keeps private paths out of reports', () => {
    const body = frontmatterAndBody(bundleFile(`skills/${PLUGIN_NAME}/SKILL.md`)).body;
    expect(body).toContain('noodle-readiness.setup_project');
    expect(body).toContain('noodle init');
    // Existing projects reconcile instead of overwriting unrelated files.
    expect(body).toContain('noodle setup --write');
    expect(body).toContain('supported `noodle-readiness` tools');
    expect(body).toContain('From this skill directory');
    expect(body).toContain('node scripts/noodle-plugin.mjs <args>');
    expect(body).not.toContain('resolve the installed plugin root privately');
    expect(body).not.toContain('${CLAUDE_PLUGIN_ROOT}');
    expect(body).not.toContain('bin/noodle-plugin.mjs');
    expect(body).toContain('scripts/noodle-plugin.mjs');
    expect(body).toMatch(/when `noodle-readiness` is unavailable/i);
    expect(body).toMatch(/run the packaged launcher yourself/i);
    expect(body).toMatch(/report only the corresponding public `noodle/i);
    expect(body).toMatch(/no command-execution workspace/i);
    expect(body).toMatch(/project-local route owns authoring, validation, local testing/i);
    expect(body).toMatch(/handoff is the bootstrap stop condition/i);
    expect(body).not.toMatch(/<managed-launcher>|plugin-cache/i);
    expect(body).not.toMatch(/\b(?:sh -c|sed)\b/i);
    expect(body).not.toContain('@latest');
    expect(body).not.toMatch(/npm install -g|pnpm add -g|yarn global add/);
    expect(body).toContain('WSL2 Ubuntu Bash');
    expect(body).toContain('wsl --install -d Ubuntu');
    expect(body.split('\n').length).toBeLessThan(500);
  });

  it('keeps source authoring with the coding agent and credentials out of the bundle', () => {
    const text = renderPluginBundle()
      .map(({ content }) => content)
      .join('\n');
    expect(text).toMatch(/application source remains with the coding agent/i);
    expect(text).not.toMatch(/Noodle (?:writes|authors|generates) (?:the )?(?:code|source)/i);
    expect(text).not.toMatch(/upload (?:the )?(?:source|repository|repo)/i);
    expect(text).not.toMatch(/(?:^|[\s`])\/(?:Users|home|tmp)\//m);
    expect(text).not.toMatch(/NOODLE_AUTH_TOKEN|oauthRefreshToken|\brefreshToken\b/);
    expect(text).not.toMatch(/\bnbk_[A-Za-z0-9]+\b|\bsk-[a-z0-9]{16,}\b/i);
  });

  it('defers to the project-local skill without embedding project layout', () => {
    const body = frontmatterAndBody(bundleFile(`skills/${PLUGIN_NAME}/SKILL.md`)).body;
    expect(body).toMatch(/follow it instead|instead of this one/i);
    expect(body).toMatch(/bootstrap/i);
    expect(body).not.toContain('.claude/skills/noodle-seed');
    expect(body).not.toContain('.agents/skills/noodle-seed');
    expect(body).not.toMatch(/(?:CLAUDE|AGENTS)\.md/);
    expect(body).not.toContain('/Users/');
    expect(body).not.toContain('/home/');
    expect(body).not.toContain('noodle-developer.inspect_deployment');
    expect(body).toMatch(/handoff is the bootstrap stop condition/i);
  });

  it('keeps the safety rules in the bootstrap router', () => {
    const body = frontmatterAndBody(bundleFile(`skills/${PLUGIN_NAME}/SKILL.md`)).body;
    expect(body).toMatch(/do not hand-author manifest JSON\/YAML/i);
    expect(body).toContain('secret(');
    expect(body).toMatch(/keep secrets/i);
    expect(body).toMatch(/does not authorize hosted mutation/i);
  });

  it('does not claim project-local references are bundled globally', () => {
    const router = bundleFile(`skills/${PLUGIN_NAME}/SKILL.md`);
    expect(router).not.toContain('## References');
    expect(router).not.toMatch(/references\//);
    expect(router).not.toMatch(/bundled flagship examples/i);
    expect(router).toMatch(/project-local skill owns/i);
  });

  it('supports a release version override without breaking self-identification', () => {
    const files = renderPluginBundle({ version: '9.9.9-test' });
    for (const manifestPath of [
      '.claude-plugin/plugin.json',
      '.codex-plugin/plugin.json',
      '.cursor-plugin/plugin.json',
    ]) {
      const manifest = JSON.parse(
        files.find((f) => f.path === manifestPath)?.content ?? 'null',
      ) as { version: string };
      expect(manifest.version).toBe('9.9.9-test');
    }
    const router = files.find((f) => f.path === `skills/${PLUGIN_NAME}/SKILL.md`)?.content ?? '';
    const { frontmatter, body } = frontmatterAndBody(router);
    expect(frontmatter).not.toMatch(/^version:|^hash:/m);
    const metadata = /^<!-- noodle-skill version:9\.9\.9-test hash:([a-f0-9]{16}) -->$/m.exec(body);
    expect(metadata?.[1]).toBe(contentHash(body.replace(/^<!-- noodle-skill[^\n]+ -->\n\n/, '')));
  });
});

describe('marketplace catalogs', () => {
  it('renders the Claude-format catalog with an in-repo relative source', () => {
    const catalog = renderMarketplaceCatalogs().find(
      (f) => f.path === '.claude-plugin/marketplace.json',
    );
    expect(catalog).toBeDefined();
    const parsed = JSON.parse(catalog?.content ?? 'null');
    expect(parsed.name).toBe(MARKETPLACE_NAME);
    // Anthropic reserves official-sounding names; ours must not impersonate one.
    expect(parsed.name).not.toMatch(/claude|anthropic|official/i);
    expect(parsed.owner.name).toBe('Noodle Seed');
    expect(parsed.plugins).toHaveLength(1);
    const entry = parsed.plugins[0];
    expect(entry.name).toBe(PLUGIN_NAME);
    // In-repo plugins use a relative-path string source that must start with "./".
    expect(entry.source).toBe(PLUGIN_SOURCE_PATH);
    expect(entry.source.startsWith('./')).toBe(true);
    expect(entry.version).toBe(AGENT_KIT_VERSION);
  });

  it('renders the Codex-format catalog with a local object source', () => {
    const catalog = renderMarketplaceCatalogs().find(
      (f) => f.path === '.agents/plugins/marketplace.json',
    );
    expect(catalog).toBeDefined();
    const parsed = JSON.parse(catalog?.content ?? 'null');
    expect(parsed.name).toBe(MARKETPLACE_NAME);
    expect(parsed.plugins).toHaveLength(1);
    const entry = parsed.plugins[0];
    expect(entry.name).toBe(PLUGIN_NAME);
    expect(entry.source).toEqual({ source: 'local', path: PLUGIN_SOURCE_PATH });
    expect(entry.policy).toEqual({ installation: 'AVAILABLE', authentication: 'ON_INSTALL' });
  });

  it('renders the official Cursor marketplace catalog with the shared plugin source', () => {
    const catalog = renderMarketplaceCatalogs().find(
      (file) => file.path === '.cursor-plugin/marketplace.json',
    );
    expect(catalog).toBeDefined();
    expect(JSON.parse(catalog?.content ?? 'null')).toMatchObject({
      name: MARKETPLACE_NAME,
      owner: { name: 'Noodle Seed' },
      plugins: [
        {
          name: PLUGIN_NAME,
          source: 'plugins/noodle-seed',
        },
      ],
    });
  });
});

describe('marketplace repo staging', () => {
  it('composes both catalogs plus the plugin bundle under plugins/<name>/', () => {
    const files = renderMarketplaceRepo();
    const paths = files.map((f) => f.path);
    expect(paths).toContain('.claude-plugin/marketplace.json');
    expect(paths).toContain('.agents/plugins/marketplace.json');
    expect(paths).toContain('.cursor-plugin/marketplace.json');
    for (const file of renderPluginBundle()) {
      expect(paths).toContain(`plugins/${PLUGIN_NAME}/${file.path}`);
    }
    expect(paths).toContain('submission/README.md');
    expect(paths).toContain('submission/chatgpt-app-submission.json');
    expect(paths).toContain('submission/claude-connector-submission.json');
    expect(paths).toContain('submission/cursor-plugin-submission.json');
    for (const path of [
      'docs/installation.md',
      'docs/how-it-works.md',
      'docs/security-and-permissions.md',
      'docs/troubleshooting.md',
    ]) {
      expect(paths).toContain(path);
    }
    expect(files.every((f) => f.content.trim().length > 0)).toBe(true);
  });

  it('ships a generated README with the exact install commands', () => {
    const readme = renderMarketplaceRepo().find((f) => f.path === 'README.md')?.content;
    expect(readme).toBeDefined();
    expect(readme).toContain('/plugin marketplace add NoodleSeed-com/plugins');
    expect(readme).toContain(`/plugin install ${PLUGIN_NAME}@${MARKETPLACE_NAME}`);
    expect(readme).toContain('codex plugin marketplace add NoodleSeed-com/plugins');
    expect(readme).toContain('Cursor');
    expect(readme).toMatch(/generated/i);
    expect(readme).toContain(AGENT_KIT_VERSION);
    expect(readme).toContain('docs/installation.md');
    expect(readme).toContain('Your first prompt');
  });

  it('ships task-oriented public guides for humans and coding agents', () => {
    const files = new Map(renderMarketplaceRepo().map((file) => [file.path, file.content]));
    const installation = files.get('docs/installation.md') ?? '';
    expect(installation).toContain('Claude Code');
    expect(installation).toContain('Codex');
    expect(installation).toContain('Cursor');
    expect(installation).toContain('/plugin marketplace add NoodleSeed-com/plugins');
    expect(installation).toContain('codex plugin marketplace add NoodleSeed-com/plugins');
    expect(installation).toContain('Update');
    expect(installation).toContain('Uninstall');
    expect(installation).toContain('WSL2 Ubuntu');
    expect(installation).toContain('Bash');
    expect(installation).toContain('PowerShell');
    expect(installation).toContain('Command Prompt');
    expect(installation).toContain('Git Bash');
    expect(installation).toContain('wsl --install -d Ubuntu');

    const architecture = files.get('docs/how-it-works.md') ?? '';
    for (const boundary of [
      'coding agent authors',
      'typed local operations',
      'release-pinned public CLI capabilities',
      'Build Readiness',
      'Developer MCP',
      'MCP App',
      'headless',
    ]) {
      expect(architecture).toContain(boundary);
    }

    const security = files.get('docs/security-and-permissions.md') ?? '';
    expect(security).toContain('current organization memberships and roles');
    expect(security).toContain('explicit organization');
    expect(security).toContain('OAuth');
    expect(security).toContain('never paste');
    expect(security).toContain('https://registry.npmjs.org');
    expect(security).toContain('https://cloud.noodleseed.dev/developer/mcp');
    expect(security).toContain('~/.noodle/plugin-profiles/<host>');
    expect(security).toContain('Source code is not uploaded to the Developer MCP');
    expect(security).toContain(
      'explicit approval for the exact previewed proposal and destination',
    );

    const troubleshooting = files.get('docs/troubleshooting.md') ?? '';
    expect(troubleshooting).toContain('managed CLI');
    expect(troubleshooting).toContain('plugin_cli_bootstrap_failed');
    expect(troubleshooting).toContain('preserves the original npm diagnostic');
    expect(troubleshooting).toContain('Build Readiness');
    expect(troubleshooting).toContain('Compatibility');
    expect(troubleshooting).toContain('docs.noodleseed.dev');
    expect(troubleshooting).toContain('wsl --install -d Ubuntu');
  });

  it('contains no secrets, tokens, internal hosts, or legacy branding', () => {
    const text = renderMarketplaceRepo()
      .map((f) => f.content)
      .join('\n');
    // Public provenance only: never the legacy internal host.
    expect(text).not.toContain('borg.noodleseed.com');
    expect(text).not.toMatch(/NOODLE_AUTH_TOKEN|oauthRefreshToken|\brefreshToken\b/);
    expect(text).not.toMatch(/\bnbk_[A-Za-z0-9]/);
    expect(text).not.toMatch(/\bsk-[a-z0-9]{16,}\b/i);
    expect(text).not.toMatch(/\.env\.noodle values appear|~\/\.noodle\/config\.json contents/);
    // No retired internal stacks or client leakage in public plugin surface. The submission
    // package intentionally links the current public OpenAI Apps SDK review documentation.
    expect(text).not.toMatch(/skybridge|alpic/i);
    expect(text).not.toMatch(/layla|jettly|hub71|heymate|sol-?ark|name\.com/i);
  });
});
