import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  contentSha256,
  createPluginCompatibility,
  renderAgentKitManifest,
  renderPublishableSkills,
} from '@noodle-borg/agent-kit';
import { InMemoryControlPlaneStore, type RunningService, serveService } from '@noodle-borg/service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendServer,
  noodleProjectConfigPath,
  readConfig,
  readNoodleProjectConfig,
  readResolvedProjectConfig,
  readServers,
  run,
  writeProjectDeployment,
  writeProjectLink,
} from '../src/index.js';
import { currentCliVersion } from '../src/update.js';
import { assertJsonEnvelope } from './helpers/json-envelope.js';

describe.sequential('noodle project bootstrap', () => {
  let cwd: string;
  let home: string;
  let tmp: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    cwd = process.cwd();
    home = mkdtempSync(join(tmpdir(), 'noodle-project-home-'));
    tmp = mkdtempSync(join(tmpdir(), 'noodle-project-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    process.chdir(cwd);
    logSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(home, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  });
  function projectFile(path: string): string {
    return readFileSync(join(tmp, path), 'utf8');
  }
  function pluginEnvironment(agentKitVersion: string): NodeJS.ProcessEnv {
    const canonicalHome = realpathSync(home);
    const configHome = join(canonicalHome, 'plugin-profile');
    const compatibilityFile = join(canonicalHome, 'noodle-plugin-compatibility.json');
    writeFileSync(
      compatibilityFile,
      `${JSON.stringify(
        createPluginCompatibility({
          mode: 'release',
          pluginVersion: '1.2.3',
          agentKitVersion,
          pluginContentHash: `sha256:${'a'.repeat(64)}`,
          cliVersion: currentCliVersion(),
          developerMcpUrl: 'https://cloud.noodleseed.dev/developer/mcp',
          developerMcpCapabilityVersion: '1',
        }),
      )}\n`,
    );
    const cacheRoot = join(configHome, 'cache', 'agent-kit', agentKitVersion);
    const renderedManifest = renderAgentKitManifest();
    const files = renderPublishableSkills().map((file) => {
      const content = file.path.endsWith('/SKILL.md')
        ? file.content.replace(
            /<!-- noodle-skill version:[^ ]+ hash:/,
            `<!-- noodle-skill version:${agentKitVersion} hash:`,
          )
        : file.content;
      const fullPath = join(cacheRoot, file.path);
      mkdirSync(join(fullPath, '..'), { recursive: true });
      writeFileSync(fullPath, content);
      const manifestFile = renderedManifest.files.find((entry) => entry.path === file.path);
      if (manifestFile === undefined) throw new Error(`missing manifest entry for ${file.path}`);
      return {
        ...manifestFile,
        sha256: contentSha256(content),
        skillVersion: agentKitVersion,
      };
    });
    writeFileSync(
      join(cacheRoot, 'manifest.json'),
      JSON.stringify({ schemaVersion: 2, packageVersion: agentKitVersion, files }, null, 2),
    );
    // Binary discovery only checks path presence; keep doctor fully green without depending on the host.
    writeFileSync(join(canonicalHome, 'codex'), '');
    return {
      NOODLE_PLUGIN_HOST: 'codex',
      NOODLE_CONFIG_HOME: configHome,
      NOODLE_PLUGIN_COMPATIBILITY_FILE: compatibilityFile,
      NOODLE_UPDATE_MODE: 'off',
      PATH: canonicalHome,
    };
  }
  async function service(): Promise<RunningService> {
    const controlPlane = new InMemoryControlPlaneStore();
    await Promise.all([
      controlPlane.createOrg({ slug: 'acme' }),
      controlPlane.createOrg({ slug: 'override' }),
    ]);
    return serveService({
      port: 0,
      controlPlaneStore: controlPlane,
      deployGate: {
        authorize: () =>
          Promise.resolve({
            ok: true,
            identity: {
              subject: 'owner-sub',
              email: 'owner@noodleseed.com',
              superAdmin: true,
            },
          }),
      },
      verifyOwnerToken: (token) =>
        Promise.resolve(token === 'OWNER' ? { subject: 'owner-sub' } : null),
      authServerIssuer: 'https://as.noodle.test',
    });
  }
  it.each([
    {
      name: 'init rejects an invalid template before a trailing JSON flag',
      argv: ['init', '--no-install', '--template', 'bogus', '--json'],
      code: 'invalid_template',
    },
    {
      name: 'setup rejects invalid agents before a trailing JSON flag',
      argv: ['setup', '--agents', 'bogus', '--json'],
      code: 'invalid_agents',
    },
  ])('$name with one stdout failure envelope', async ({ argv, code }) => {
    expect(await run(argv, { NOODLE_UPDATE_MODE: 'off' }, home)).toBe(2);
    expect(logSpy).toHaveBeenCalledOnce();
    expect(errSpy).not.toHaveBeenCalled();
    const envelope = assertJsonEnvelope(JSON.parse(String(logSpy.mock.calls[0]?.[0])));
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure envelope');
    expect(envelope.error.code).toBe(code);
  });

  it('keeps the explicit hello template minimal and deployable', async () => {
    expect(
      await run(
        ['init', '--no-install', tmp, '--template', 'hello', '--name', 'hello-world'],
        {},
        home,
      ),
    ).toBe(0);
    expect(existsSync(join(tmp, 'src', 'server.ts'))).toBe(true);
    expect(existsSync(join(tmp, 'noodle.json'))).toBe(true);
    expect(existsSync(join(tmp, 'package.json'))).toBe(true);
    expect(existsSync(join(tmp, 'test', 'server.test.ts'))).toBe(true);
    expect(existsSync(join(tmp, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(tmp, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(tmp, '.agents', 'skills', 'noodle-seed', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(tmp, '.claude', 'skills', 'noodle-seed', 'SKILL.md'))).toBe(true);
    expect(projectFile('src/server.ts')).toContain(
      "import { annotations, server, tool, z } from '@noodleseed/one'",
    );
    expect(projectFile('src/server.ts')).toContain(
      "server('hello_world', { title: 'Hello World', version: '1.0.0' }",
    );
    expect(projectFile('src/server.ts')).toContain('tool(');
    expect(projectFile('src/server.ts')).toContain("'greet'");
    // The starter tool must auto-run in the embedded assistant (safe read), not confirm-gate.
    expect(projectFile('src/server.ts')).toContain('annotations.readOnly()');
    expect(projectFile('src/server.ts')).not.toContain(".tool('greet'");
    expect(projectFile('package.json')).toContain('"vitest": "4.1.8"');
    // Agent-safe scaffold scripts: a one-shot readiness check + the machine-readable command catalog.
    expect(projectFile('package.json')).toContain(
      '"agent:check": "vitest run --dir test && noodle validate --json && tsc --noEmit"',
    );
    expect(projectFile('package.json')).toContain('"agent:commands": "noodle commands --json"');
    expect(projectFile('package.json')).not.toContain('"@vitejs/plugin-react"');
    expect(projectFile('package.json')).not.toContain('"react"');
    expect(projectFile('.gitignore').split('\n')).toContain('.env');
    expect(projectFile('.gitignore')).toContain('.env.noodle');
    expect(projectFile('.gitignore')).toContain('.env.*');
    expect(projectFile('.gitignore')).toContain('node_modules');
    expect(projectFile('.gitignore')).toContain('dist');
    expect(projectFile('.gitignore')).toContain('.noodle/');
    expect(projectFile('README.md')).toContain('read-only fallback');
    expect(projectFile('README.md')).toContain('.env.noodle');
    expect(projectFile('noodle.json')).toContain('"entrypoint": "src/server.ts"');
    expect(projectFile('AGENTS.md')).toContain('BEGIN NOODLE AGENT CONTEXT');
    for (const agentFile of ['AGENTS.md', 'CLAUDE.md']) {
      expect(projectFile(agentFile)).not.toContain('@noodleseed/one/react');
    }
    for (const appPlaybook of [
      '.agents/skills/noodle-seed/references/build-an-mcp-app.md',
      '.claude/skills/noodle-seed/references/build-an-mcp-app.md',
    ]) {
      expect(projectFile(appPlaybook)).toContain('references/widgets-and-apps.md');
      expect(projectFile(appPlaybook)).not.toContain('@noodleseed/one/react');
      expect(projectFile(appPlaybook)).not.toMatch(/start with Noodle Design components/is);
    }
    const allGenerated = [
      projectFile('src/server.ts'),
      projectFile('package.json'),
      projectFile('test/server.test.ts'),
      projectFile('README.md'),
    ].join('\n');
    expect(allGenerated).not.toMatch(/NOODLE_AUTH_TOKEN|oauthRefreshToken|callerKey|nbk_/);
  });
  it('installs the verified plugin-pinned Agent Kit during fresh init', async () => {
    const agentKitVersion = '99.0.0';
    const env = pluginEnvironment(agentKitVersion);

    expect(
      await run(
        [
          'init',
          '--no-install',
          tmp,
          '--template',
          'hello',
          '--agents',
          'codex',
          '--no-docs-mcp',
          '--json',
        ],
        env,
        home,
      ),
    ).toBe(0);
    expect(projectFile('.agents/skills/noodle-seed/SKILL.md')).toContain(
      `<!-- noodle-skill version:${agentKitVersion} hash:`,
    );

    logSpy.mockClear();
    expect(
      await run(['agents', 'doctor', '--agents', 'codex', '--project', tmp, '--json'], env, home),
    ).toBe(0);
    const envelope = assertJsonEnvelope<{
      checks: Array<{ name: string; level: string }>;
      stale: boolean;
    }>(JSON.parse(logSpy.mock.calls.map((call) => String(call[0])).join('\n')));
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) throw new Error('expected a success envelope');
    expect(envelope.data.stale).toBe(false);
    expect(
      envelope.data.checks
        .filter((check) => check.name.includes('.agents/skills/noodle-seed/'))
        .every((check) => check.level === 'PASS'),
    ).toBe(true);
  });
  it('installs the verified plugin-pinned Agent Kit during project setup', async () => {
    const agentKitVersion = '99.0.0';

    expect(
      await run(
        ['setup', '--project', tmp, '--write', '--agents', 'codex', '--json'],
        pluginEnvironment(agentKitVersion),
        home,
      ),
    ).toBe(0);
    expect(projectFile('.agents/skills/noodle-seed/SKILL.md')).toContain(
      `<!-- noodle-skill version:${agentKitVersion} hash:`,
    );
  });
  it('init --no-agents skips project-local agent files', async () => {
    expect(
      await run(['init', '--no-install', tmp, '--name', 'quiet', '--no-agents'], {}, home),
    ).toBe(0);
    expect(existsSync(join(tmp, 'noodle.json'))).toBe(true);
    expect(existsSync(join(tmp, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(tmp, 'CLAUDE.md'))).toBe(false);
    // --no-agents means "no declaration": the field is omitted so a later `agents setup` still
    // defaults to all targets; only a hand-written `"agents": []` opts the project out of generation.
    expect(projectFile('noodle.json')).not.toContain('"agents"');
  });
  it('initializes an HTTP API template that validates through the real authoring loader', async () => {
    expect(
      await run(
        ['init', '--no-install', tmp, '--template', 'http-api', '--name', 'posts-api'],
        {},
        home,
      ),
    ).toBe(0);
    expect(projectFile('src/server.ts')).toContain(
      "import { annotations, connector, server, tool, variable, z } from '@noodleseed/one'",
    );
    expect(projectFile('src/server.ts')).toContain("server('posts_api', {");
    expect(projectFile('src/server.ts')).toContain('use: { posts }');
    expect(projectFile('src/server.ts')).toContain('tool(');
    expect(projectFile('src/server.ts')).toContain("'get_post'");
    expect(projectFile('src/server.ts')).not.toContain(".tool('get_post'");
    expect(projectFile('src/server.ts')).not.toContain('.use({ posts');
    expect(projectFile('package.json')).not.toContain('"@vitejs/plugin-react"');
    expect(projectFile('package.json')).not.toContain('"react"');
    process.chdir(tmp);
    expect(
      await run(
        ['link', '--org', 'acme', '--app', 'posts', '--entrypoint', 'src/server.ts'],
        {},
        home,
      ),
    ).toBe(0);
    expect(await run(['validate'], {}, home)).toBe(0);
  });
  it('defaults bare init to the comprehensive production app scaffold', async () => {
    expect(await run(['init', '--no-install', tmp, '--name', 'widget-demo'], {}, home)).toBe(0);
    expect(existsSync(join(tmp, 'src', 'server.ts'))).toBe(true);
    expect(projectFile('src/server.ts')).toContain("from '@noodleseed/one'");
    expect(projectFile('noodle.json')).toContain('"template": "saas"');
    expect(projectFile('src/server.ts')).toContain('authenticatedWebsite({');
    expect(projectFile('src/server.ts')).toContain('contextProvider: true');
    expect(projectFile('README.md')).toContain('delegatedTokenExchange');
    expect(projectFile('README.md')).toContain('authenticateAssistantRequest');
    expect(projectFile('src/server.ts')).not.toContain('federatedOidc');
    // Portable MCP tool annotations are modeled from the start.
    expect(projectFile('src/server.ts')).toContain('annotations.readOnly()');
    expect(projectFile('src/server.ts')).toContain('embeddedAssistant({');
    expect(projectFile('src/server.ts')).toContain('model: noodleManaged()');
    expect(projectFile('src/server.ts')).not.toContain('openAICompatible({');
    expect(projectFile('src/server.ts')).not.toContain('ASSISTANT_MODEL');
    expect(projectFile('src/server.ts')).toContain('branding: {');
    expect(projectFile('src/server.ts')).toContain("title: 'List workspace items'");
    expect(projectFile('src/server.ts')).not.toContain('emptyState:');
    expect(projectFile('src/server.ts')).toContain('No handoff tool');
    expect(projectFile('src/server.ts')).toContain('state: {');
    expect(projectFile('src/server.ts')).toContain("resource('workspace_guide'");
    expect(projectFile('src/server.ts')).toContain("prompt('plan_next_step'");
    expect(projectFile('src/server.ts')).toContain("tool('list_workspace_items'");
    expect(projectFile('src/server.ts')).toContain("tool('show_preferences'");
    expect(projectFile('src/server.ts')).toContain("tool('save_preferences'");
    expect(projectFile('src/server.ts')).toContain("visibility: ['app']");
    expect(projectFile('src/server.ts')).not.toContain('toolWithWidget');
    expect(projectFile('src/server.ts')).not.toContain('toolForWidget');
    expect(projectFile('src/server.ts')).toContain('view: {');
    expect(projectFile('src/server.ts')).toContain("viewTitle: 'Notification preferences'");
    expect(projectFile('src/server.ts')).toContain('viewDescription:');
    expect(projectFile('src/server.ts')).toContain("component: 'preferences-card'");
    expect(projectFile('src/server.ts')).toContain("entry: './views/preferences-card.tsx'");
    expect(projectFile('src/server.ts')).not.toContain('ui.');
    // Portable metadata includes status copy, deny-by-default CSP and a useful view description.
    // The embedded-first default does not invent a public host compatibility domain.
    expect(projectFile('src/server.ts')).toContain('invoking:');
    expect(projectFile('src/server.ts')).toContain('invoked:');
    expect(projectFile('src/server.ts')).not.toContain('your-app.example.com');
    expect(projectFile('src/server.ts')).toContain("variable('ASSISTANT_ORIGIN')");
    expect(projectFile('src/server.ts')).toContain('csp: {');
    expect(projectFile('src/server.ts')).toContain('connectDomains:');
    expect(existsSync(join(tmp, 'src/helpers.ts'))).toBe(true);
    expect(existsSync(join(tmp, 'src/views/preferences-card.tsx'))).toBe(true);
    expect(existsSync(join(tmp, 'src/views/design-system-showcase.tsx'))).toBe(false);
    expect(existsSync(join(tmp, 'vite.config.ts'))).toBe(true);
    expect(projectFile('package.json')).toContain('"@vitejs/plugin-react"');
    expect(projectFile('package.json')).toContain('"react"');
    // React type packages + a tsconfig so the .tsx view typechecks cleanly in an editor/tsc.
    expect(projectFile('package.json')).toContain('"@types/react"');
    expect(projectFile('package.json')).toContain('"@types/react-dom"');
    expect(existsSync(join(tmp, 'tsconfig.json'))).toBe(true);
    expect(projectFile('tsconfig.json')).toContain('"jsx": "react-jsx"');
    expect(projectFile('tsconfig.json')).toContain('"moduleResolution": "bundler"');
    // The widget template's readiness check also runs the widget-specific `check` gate.
    expect(projectFile('package.json')).toContain(
      '"agent:check": "vitest run --dir test && noodle validate --json && tsc --noEmit && noodle check --json"',
    );
    // Widget projects also expose an optional host-specific compatibility check.
    expect(projectFile('package.json')).toContain(
      '"agent:check:chatgpt": "vitest run --dir test && noodle validate --json && tsc --noEmit && noodle check --target chatgpt --json"',
    );
    expect(projectFile('package.json')).not.toContain('agent:check:assistant');
    expect(projectFile('package.json')).toContain('"agent:commands": "noodle commands --json"');
    const readme = projectFile('README.md');
    expect(readme).toContain('## Embedded customer application');
    expect(readme).toContain('existing application');
    expect(readme).not.toContain('ASSISTANT_MODEL');
    expect(readme).not.toContain('NOODLE_ASSISTANT_CLIENT_SECRET');
    // Helpers expose the focused starter surface plus typed hooks.
    expect(projectFile('src/helpers.ts')).toContain("from '@noodleseed/one/react'");
    expect(projectFile('src/helpers.ts')).toContain('AsyncBoundary');
    const mainView = projectFile('src/views/preferences-card.tsx');
    const generatedViews = mainView;
    expect(mainView).toContain("useToolInfo('show_preferences')");
    expect(mainView).toContain('Object.keys(toolInfo).length === 0');
    expect(mainView).toContain('toolInfo.isError');
    expect(mainView).toContain('isPreferences(toolInfo.structuredContent)');
    expect(mainView).toMatch(
      /if \(isPending\)[\s\S]*if \(toolInfo\.isError\)[\s\S]*if \(!shown\)[\s\S]*<Action/,
    );
    expect(generatedViews).toContain("useCallTool('save_preferences')");
    expect(mainView).toContain('data-llm=');
    expect(mainView).toContain("import '@noodleseed/one/react/styles.css'");
    expect(mainView).toContain('<Frame');
    expect(mainView).toContain('<AsyncBoundary');
    expect(mainView).toContain('<ActionBar');
    for (const component of [
      'Action',
      'ActionBar',
      'AsyncBoundary',
      'Feedback',
      'Field',
      'Flow',
      'Frame',
      'Region',
      'Select',
    ]) {
      expect(generatedViews, `${component} should appear in the showcase`).toContain(
        `<${component}`,
      );
    }
    // Every rendered component must be imported from the generated helper surface.
    for (const view of [mainView]) {
      const functionStart = [
        view.indexOf('export default function'),
        view.indexOf('export function'),
      ]
        .filter((index) => index >= 0)
        .sort((left, right) => left - right)[0];
      const componentImports = view.slice(0, functionStart);
      for (const match of view.matchAll(/(?<![A-Za-z0-9_])<([A-Z][A-Za-z]*)/g)) {
        expect(componentImports).toContain(match[1]);
      }
    }
    expect(projectFile('README.md')).toContain('tested integration baseline');
    expect(projectFile('README.md')).toContain('`view.component` links the tool to a React view');
    expect(projectFile('README.md')).toContain('one primary action');
    expect(projectFile('README.md')).toContain('loading, empty, error, retry, and success');
    expect(projectFile('README.md')).not.toContain('raw HTML');
    const allGenerated = [
      projectFile('src/server.ts'),
      projectFile('src/helpers.ts'),
      mainView,
      projectFile('package.json'),
      projectFile('test/server.test.ts'),
      projectFile('README.md'),
    ].join('\n');
    expect(allGenerated).not.toMatch(
      /NOODLE_AUTH_TOKEN|oauthRefreshToken|callerKey|nbk_|sk-[a-z0-9]/i,
    );
    const previousBuilderViteRoot = process.env.NOODLE_BUILDER_VITE_ROOT;
    process.env.NOODLE_BUILDER_VITE_ROOT = cwd;
    process.chdir(tmp);
    try {
      expect(
        await run(
          ['link', '--org', 'acme', '--app', 'widget-demo', '--entrypoint', 'src/server.ts'],
          {},
          home,
        ),
      ).toBe(0);
      expect(await run(['validate'], {}, home)).toBe(0);
    } finally {
      if (previousBuilderViteRoot === undefined) delete process.env.NOODLE_BUILDER_VITE_ROOT;
      else process.env.NOODLE_BUILDER_VITE_ROOT = previousBuilderViteRoot;
    }
  });
  it('refuses to initialize into a non-empty NON-Noodle directory unless --force is passed', async () => {
    writeFileSync(join(tmp, 'keep.txt'), 'existing');
    expect(await run(['init', '--no-install', tmp], {}, home)).toBe(2);
    expect(errSpy.mock.calls.join('\n')).toContain('init: target directory is not empty');
    expect(await run(['init', '--no-install', tmp, '--force'], {}, home)).toBe(0);
    expect(readFileSync(join(tmp, 'keep.txt'), 'utf8')).toBe('existing');
    expect(existsSync(join(tmp, 'src', 'server.ts'))).toBe(true);
  });
  it('does not treat legacy package names alone as an existing Noodle project', async () => {
    writeFileSync(
      join(tmp, 'package.json'),
      `${JSON.stringify({ name: 'legacy-app', dependencies: { 'noodleseed-cli': 'latest' } }, null, 2)}\n`,
    );
    expect(await run(['init', '--no-install', tmp, '--name', 'hello-world'], {}, home)).toBe(2);
    expect(existsSync(join(tmp, 'src', 'server.ts'))).toBe(false);
  });
  it('detects an @noodleseed/one package.json as an existing Noodle project (reconciles without --force)', async () => {
    writeFileSync(
      join(tmp, 'package.json'),
      `${JSON.stringify({ name: 'new-app', dependencies: { '@noodleseed/one': 'latest' } }, null, 2)}\n`,
    );
    expect(
      await run(
        ['init', '--no-install', tmp, '--template', 'hello', '--name', 'hello-world'],
        {},
        home,
      ),
    ).toBe(0);
    expect(existsSync(join(tmp, 'src', 'server.ts'))).toBe(true);
  });
  it('is idempotent: re-running init on an existing Noodle project is a no-op exit 0', async () => {
    expect(
      await run(
        ['init', '--no-install', tmp, '--template', 'hello', '--name', 'hello-world'],
        {},
        home,
      ),
    ).toBe(0);
    const firstServer = projectFile('src/server.ts');
    logSpy.mockClear();
    // Second run needs no --force even though the dir is now non-empty (it is a Noodle project).
    expect(await run(['init', '--no-install', tmp, '--name', 'hello-world'], {}, home)).toBe(0);
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('unchanged src/server.ts');
    expect(out).toContain('unchanged package.json');
    // No file was rewritten.
    expect(projectFile('src/server.ts')).toBe(firstServer);
  });
  it('preserves a user-modified scaffold file on re-run and reports it skipped', async () => {
    expect(await run(['init', '--no-install', tmp, '--name', 'hello-world'], {}, home)).toBe(0);
    writeFileSync(join(tmp, 'src', 'server.ts'), '// my edits\n');
    logSpy.mockClear();
    expect(await run(['init', '--no-install', tmp, '--name', 'hello-world'], {}, home)).toBe(0);
    expect(projectFile('src/server.ts')).toBe('// my edits\n');
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /skipped src\/server\.ts/,
    );
  });
  it('re-creates a missing scaffold file on re-run (write-missing converges)', async () => {
    expect(await run(['init', '--no-install', tmp, '--name', 'hello-world'], {}, home)).toBe(0);
    rmSync(join(tmp, 'src', 'server.ts'));
    logSpy.mockClear();
    expect(await run(['init', '--no-install', tmp, '--name', 'hello-world'], {}, home)).toBe(0);
    expect(existsSync(join(tmp, 'src', 'server.ts'))).toBe(true);
    expect(projectFile('src/server.ts')).toContain("tool('show_preferences'");
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'created src/server.ts',
    );
  });
  it('--force overwrites a modified scaffold file but leaves unrelated user files intact', async () => {
    expect(await run(['init', '--no-install', tmp, '--name', 'hello-world'], {}, home)).toBe(0);
    writeFileSync(join(tmp, 'src', 'server.ts'), '// my edits\n');
    writeFileSync(join(tmp, 'keep.txt'), 'mine');
    logSpy.mockClear();
    expect(
      await run(['init', '--no-install', tmp, '--name', 'hello-world', '--force'], {}, home),
    ).toBe(0);
    expect(projectFile('src/server.ts')).toContain("tool('show_preferences'");
    expect(projectFile('keep.txt')).toBe('mine');
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'overwritten src/server.ts',
    );
  });
  it('--dry-run reports planned actions without writing, and --json emits the uniform envelope', async () => {
    expect(
      await run(
        ['init', '--no-install', tmp, '--name', 'hello-world', '--dry-run', '--json'],
        {},
        home,
      ),
    ).toBe(0);
    expect(existsSync(join(tmp, 'src', 'server.ts'))).toBe(false);
    const envelope = assertJsonEnvelope<{
      dryRun: boolean;
      dir: string;
      files: Array<{ path: string; action: string }>;
      nextCommands: Array<{ command: string; reason: string }>;
    }>(JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string));
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) throw new Error('expected success');
    expect(envelope.data.dryRun).toBe(true);
    expect(typeof envelope.data.dir).toBe('string');
    expect(envelope.data.files.find((f) => f.path === 'src/server.ts')?.action).toBe('created');
    expect(envelope.data.files.map((f) => f.path)).toContain('package.json');
    // Structured next-step guidance so a coding agent can chain the loop without parsing prose.
    expect(Array.isArray(envelope.data.nextCommands)).toBe(true);
    expect(envelope.data.nextCommands.length).toBeGreaterThan(0);
    expect(
      envelope.data.nextCommands.every(
        (c) => typeof c.command === 'string' && typeof c.reason === 'string',
      ),
    ).toBe(true);
    expect(envelope.data.nextCommands[0]?.command).toContain(' init ');
    expect(envelope.data.nextCommands[0]?.command).not.toContain('--force');
  });
  it('files-only init --json points to the canonical resumable installer', async () => {
    expect(
      await run(['init', '--no-install', tmp, '--name', 'widget-demo', '--json'], {}, home),
    ).toBe(0);
    const envelope = assertJsonEnvelope<{
      nextCommands: Array<{ command: string; reason: string }>;
    }>(JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string));
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) throw new Error('expected success');
    expect(envelope.data.nextCommands[0]?.command).toContain(
      `@noodleseed/one@${currentCliVersion()} init`,
    );
    expect(envelope.data.nextCommands[0]?.command).not.toContain('--no-install');
  });
  it('files-only non-widget init --json uses the same recovery path', async () => {
    expect(
      await run(
        ['init', '--no-install', tmp, '--template', 'hello', '--name', 'hello-world', '--json'],
        {},
        home,
      ),
    ).toBe(0);
    const envelope = assertJsonEnvelope<{
      nextCommands: Array<{ command: string; reason: string }>;
    }>(JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string));
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) throw new Error('expected success');
    expect(envelope.data.nextCommands[0]?.command).toContain(
      `@noodleseed/one@${currentCliVersion()} init`,
    );
  });
  it('init --json failure emits { ok: false, error } and no plain text', async () => {
    // An unrelated non-empty directory is treated as someone else's work: init must fail.
    writeFileSync(join(tmp, 'keep.txt'), 'existing');
    logSpy.mockClear();
    errSpy.mockClear();
    expect(await run(['init', '--no-install', tmp, '--json'], {}, home)).toBe(2);
    const envelope = assertJsonEnvelope(JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string));
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.code).toBe('init_failed');
    expect(envelope.error.message).toContain('not empty');
    // The failure path emits JSON on stdout, never plain text on stderr.
    expect(errSpy.mock.calls.length).toBe(0);
  });
  it('links project-local metadata without writing credentials or secrets', async () => {
    expect(await run(['init', '--no-install', tmp, '--name', 'support'], {}, home)).toBe(0);
    process.chdir(tmp);
    expect(
      await run(
        [
          'link',
          '--org',
          'acme',
          '--app',
          'support',
          '--env',
          'dev',
          '--service',
          'https://svc.example',
          '--access',
          'org-members',
        ],
        {},
        home,
      ),
    ).toBe(0);
    const link = JSON.parse(projectFile('.noodle/project.json')) as Record<string, unknown>;
    expect(link).toEqual({
      entrypoint: 'src/server.ts',
      org: 'acme',
      app: 'support',
      env: 'dev',
      serviceUrl: 'https://svc.example',
      accessMode: 'org-members',
    });
    expect(JSON.stringify(link)).not.toMatch(/token|secret|caller/i);
  });
  it.each([
    { name: 'local link', saveArgs: ['--save'] },
    { name: 'shared project link', saveArgs: ['--save', 'project'] },
  ])('preserves the noodle.json entrypoint for a $name', async ({ saveArgs }) => {
    mkdirSync(join(tmp, 'apps', 'support'), { recursive: true });
    writeFileSync(join(tmp, 'apps', 'support', 'server.ts'), 'export default {};\n');
    writeFileSync(
      noodleProjectConfigPath(tmp),
      `${JSON.stringify({ entrypoint: 'apps/support/server.ts', name: 'support' })}\n`,
    );
    process.chdir(tmp);

    expect(
      await run(
        ['link', '--org', 'acme', '--app', 'support', '--env', 'dev', ...saveArgs],
        {},
        home,
      ),
    ).toBe(0);

    const savedEntrypoint =
      saveArgs.length === 1
        ? (JSON.parse(projectFile('.noodle/project.json')) as Record<string, unknown>).entrypoint
        : readNoodleProjectConfig(tmp)?.entrypoint;
    expect(savedEntrypoint).toBe('apps/support/server.ts');
  });
  it('lets an explicit link entrypoint override noodle.json', async () => {
    writeFileSync(
      noodleProjectConfigPath(tmp),
      `${JSON.stringify({ entrypoint: 'apps/support/server.ts', name: 'support' })}\n`,
    );
    process.chdir(tmp);

    expect(
      await run(
        [
          'link',
          '--org',
          'acme',
          '--app',
          'support',
          '--entrypoint',
          'custom/server.ts',
          '--save',
          'project',
        ],
        {},
        home,
      ),
    ).toBe(0);

    expect(readNoodleProjectConfig(tmp)?.entrypoint).toBe('custom/server.ts');
  });
  it('reads a narrowed org membership source list from noodle.json', () => {
    writeFileSync(
      join(tmp, 'noodle.json'),
      `${JSON.stringify({ accessMode: 'org-members', orgMembershipSources: ['explicit'] })}\n`,
    );
    expect(readNoodleProjectConfig(tmp)?.orgMembershipSources).toEqual(['explicit']);
    expect(readResolvedProjectConfig(tmp).orgMembershipSources).toEqual(['explicit']);
  });

  it('rejects an unknown or empty membership source list in noodle.json', () => {
    for (const orgMembershipSources of [['group'], [], 'explicit']) {
      writeFileSync(
        join(tmp, 'noodle.json'),
        `${JSON.stringify({ accessMode: 'org-members', orgMembershipSources })}\n`,
      );
      expect(() => readNoodleProjectConfig(tmp)).toThrow(/orgMembershipSources/i);
    }
  });

  it('rejects unknown keys and secret-like fields in noodle.json', () => {
    writeFileSync(join(tmp, 'noodle.json'), `${JSON.stringify({ entrypoint: 'server.ts' })}\n`);
    expect(readNoodleProjectConfig(tmp)?.entrypoint).toBe('server.ts');
    writeFileSync(
      join(tmp, 'noodle.json'),
      `${JSON.stringify({ entrypoint: 'server.ts', nope: true })}\n`,
    );
    expect(() => readNoodleProjectConfig(tmp)).toThrow(/unknown key/i);
    writeFileSync(join(tmp, 'noodle.json'), `${JSON.stringify({ authToken: 'tok-secret' })}\n`);
    expect(() => readNoodleProjectConfig(tmp)).toThrow(/secret/i);
  });
  it('merges project config property-by-property with local overrides taking precedence', () => {
    writeFileSync(
      noodleProjectConfigPath(tmp),
      `${JSON.stringify({
        entrypoint: 'server.ts',
        name: 'project-name',
        org: 'acme',
        app: 'from-project',
        env: 'prod',
        accessMode: 'org-members',
      })}\n`,
    );
    writeProjectLink({
      org: 'local-org',
      app: 'local-app',
      env: 'dev',
      cwd: tmp,
    });
    const resolved = readResolvedProjectConfig(tmp);
    expect(resolved).toMatchObject({
      entrypoint: 'server.ts',
      name: 'project-name',
      org: 'local-org',
      app: 'local-app',
      env: 'dev',
      accessMode: 'owner-only',
    });
    vi.stubEnv('NOODLE_APP', 'from-env');
    vi.stubEnv('NOODLE_ENV', 'stage');
    vi.stubEnv('NOODLE_ACCESS_MODE', 'customers');
    expect(readResolvedProjectConfig(tmp)).toMatchObject({
      app: 'from-env',
      env: 'stage',
      accessMode: 'customers',
    });
    vi.unstubAllEnvs();
  });
  it('link --save project writes non-secret defaults to noodle.json', async () => {
    expect(
      await run(['init', '--no-install', tmp, '--name', 'support', '--no-agents'], {}, home),
    ).toBe(0);
    process.chdir(tmp);
    expect(
      await run(
        [
          'link',
          '--org',
          'acme',
          '--app',
          'support',
          '--env',
          'dev',
          '--service',
          'https://svc.example',
          '--save',
          'project',
        ],
        {},
        home,
      ),
    ).toBe(0);
    const projectConfig = JSON.parse(projectFile('noodle.json')) as Record<string, unknown>;
    expect(projectConfig).toMatchObject({
      entrypoint: 'src/server.ts',
      org: 'acme',
      app: 'support',
      env: 'dev',
      serviceUrl: 'https://svc.example',
      accessMode: 'owner-only',
    });
    expect(JSON.stringify(projectConfig)).not.toMatch(/token|secret|caller|refresh/i);
    expect(existsSync(join(tmp, '.noodle', 'project.json'))).toBe(false);
  });
  it('connect codex --write uses the project-local agent setup planner', async () => {
    expect(
      await run(['init', '--no-install', tmp, '--name', 'connect-demo', '--no-agents'], {}, home),
    ).toBe(0);
    process.chdir(tmp);
    logSpy.mockClear();
    expect(await run(['connect', 'codex', '--write'], {}, home)).toBe(0);
    expect(existsSync(join(tmp, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(tmp, '.agents', 'skills', 'noodle-seed', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(tmp, 'CLAUDE.md'))).toBe(false);
    expect(logSpy.mock.calls.join('\n')).toContain('Connected codex');
  });
  it('setup --write creates noodle.json from an existing project without overwriting app files', async () => {
    writeFileSync(join(tmp, 'server.ts'), 'export default {};\n');
    writeProjectLink({ org: 'acme', app: 'legacy', env: 'dev', cwd: tmp });
    process.chdir(tmp);
    expect(await run(['setup', '--write'], {}, home)).toBe(0);
    expect(projectFile('server.ts')).toBe('export default {};\n');
    const projectConfig = JSON.parse(projectFile('noodle.json')) as Record<string, unknown>;
    expect(projectConfig).toMatchObject({
      entrypoint: 'server.ts',
      org: 'acme',
      app: 'legacy',
      env: 'dev',
      accessMode: 'owner-only',
    });
    expect(existsSync(join(tmp, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(tmp, 'CLAUDE.md'))).toBe(true);
  });
  it('uses the linked entrypoint for no-arg validate and dev', async () => {
    expect(
      await run(
        ['init', '--no-install', tmp, '--template', 'hello', '--name', 'hello-world'],
        {},
        home,
      ),
    ).toBe(0);
    process.chdir(tmp);
    expect(
      await run(['link', '--org', 'acme', '--app', 'hello-world', '--env', 'dev'], {}, home),
    ).toBe(0);
    expect(await run(['validate'], {}, home)).toBe(0);
    const running = run(['dev'], {}, home);
    await vi.waitFor(() => {
      expect(logSpy.mock.calls.join('\n')).toContain('/o/acme/hello-world/dev/mcp');
    });
    process.emit('SIGINT');
    expect(await running).toBe(0);
  });
  it('uses linked target metadata for no-arg test and smoke commands', async () => {
    expect(
      await run(
        ['init', '--no-install', tmp, '--template', 'hello', '--name', 'hello-world'],
        {},
        home,
      ),
    ).toBe(0);
    process.chdir(tmp);
    expect(
      await run(['link', '--org', 'acme', '--app', 'hello-world', '--env', 'prod'], {}, home),
    ).toBe(0);
    expect(await run(['test', '--json'], {}, home)).toBe(0);
    expect(JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string).data.endpoint).toContain(
      '/o/acme/hello-world/mcp',
    );
    logSpy.mockClear();
    expect(await run(['tools', 'list', '--json'], {}, home)).toBe(0);
    expect(JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string).data.endpoint).toContain(
      '/o/acme/hello-world/mcp',
    );
  });
  it('runs the zero-login magic moment: init then test + tools call with no link and no credentials', async () => {
    // The D1 magic moment: `init` then a local loopback smoke must work with zero account, zero link.
    expect(
      await run(
        ['init', '--no-install', tmp, '--template', 'hello', '--name', 'hello-world'],
        {},
        home,
      ),
    ).toBe(0);
    process.chdir(tmp);
    expect(existsSync(join(tmp, '.noodle', 'project.json'))).toBe(false);
    // `test` resolves the conventional `src/server.ts` with no link and boots the open loopback runtime.
    expect(await run(['test', '--json'], {}, home)).toBe(0);
    const testOut = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string) as {
      ok: boolean;
      data: { endpoint: string; tools: string[] };
    };
    expect(testOut.ok).toBe(true);
    expect(testOut.data.endpoint).toMatch(/\/o\/local\/[^/]+\/dev\/mcp$/);
    expect(testOut.data.tools).toContain('greet');
    logSpy.mockClear();
    // `tools call` exercises the local server end to end — still no link, still no credentials.
    expect(
      await run(['tools', 'call', 'greet', '--args', '{"name":"Ada"}', '--json'], {}, home),
    ).toBe(0);
    const callOut = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string) as {
      ok: boolean;
      data: {
        result: {
          structuredContent?: {
            message?: string;
          };
        };
      };
    };
    expect(callOut.ok).toBe(true);
    expect(callOut.data.result.structuredContent?.message).toBe('Hello, Ada!');
    // The magic moment never wrote a project link or any control-plane credential.
    expect(existsSync(join(tmp, '.noodle', 'project.json'))).toBe(false);
    expect(readConfig(home).authToken).toBeUndefined();
  });
  it('exports a portable manifest JSON locally with no link, service, or login', async () => {
    expect(
      await run(
        ['init', '--no-install', tmp, '--template', 'hello', '--name', 'hello-world'],
        {},
        home,
      ),
    ).toBe(0);
    process.chdir(tmp);
    const out = join(tmp, 'manifest.json');
    expect(await run(['export', 'manifest', '--output', out], {}, home)).toBe(0);
    expect(existsSync(out)).toBe(true);
    const manifest = JSON.parse(readFileSync(out, 'utf8')) as {
      manifestVersion?: string;
      server?: {
        name?: string;
      };
      tools?: Array<{
        name: string;
      }>;
    };
    expect(typeof manifest.manifestVersion).toBe('string');
    expect(manifest.server?.name).toBe('hello_world');
    expect((manifest.tools ?? []).map((t) => t.name)).toContain('greet');
    // No account, no link, no credentials were involved.
    expect(existsSync(join(tmp, '.noodle', 'project.json'))).toBe(false);
    expect(readConfig(home).authToken).toBeUndefined();
  });
  it('rejects an unknown export target', async () => {
    expect(await run(['export', 'everything'], {}, home)).toBe(2);
    expect(errSpy.mock.calls.join('\n')).toContain('Unknown subcommand');
  });
  it('deploys with no args from the linked project and lets explicit flags override link values', async () => {
    const open = await service();
    try {
      expect(
        await run(
          ['init', '--no-install', tmp, '--template', 'hello', '--name', 'hello-world'],
          {},
          home,
        ),
      ).toBe(0);
      process.chdir(tmp);
      expect(
        await run(
          [
            'link',
            '--org',
            'acme',
            '--app',
            'hello-world',
            '--env',
            'prod',
            '--service',
            open.url,
            '--access',
            'org-members',
          ],
          {},
          home,
        ),
      ).toBe(0);
      expect(await run(['deploy', '--version', '1'], {}, home)).toBe(0);
      expect(logSpy.mock.calls.join('\n')).toContain(`${open.url}/o/acme/hello-world/v1/mcp`);
      expect(logSpy.mock.calls.join('\n')).toContain('Access:    org-members');
      expect(logSpy.mock.calls.join('\n')).toContain(
        'Saved deployment metadata to .noodle/deployment.json.',
      );
      const deployment = JSON.parse(projectFile('.noodle/deployment.json')) as Record<
        string,
        unknown
      >;
      expect(deployment).toMatchObject({
        org: 'acme',
        app: 'hello-world',
        env: 'prod',
        serviceUrl: open.url,
        accessMode: 'org-members',
      });
      expect(String(deployment.serverVersion)).toBe('1');
      expect(String(deployment.url)).toBe(`${open.url}/o/acme/hello-world/v1/mcp`);
      expect(String(deployment.defaultUrl)).toBe(`${open.url}/o/acme/hello-world/mcp`);
      expect(String(deployment.deploymentId)).toMatch(/^hello-world-[0-9a-f]{8}$/);
      expect(typeof deployment.createdAt).toBe('string');
      expect(JSON.stringify(deployment)).not.toMatch(/token|secret|caller|nbk_/i);
      expect(statSync(join(tmp, '.noodle', 'deployment.json')).mode & 0o777).toBe(0o600);
      logSpy.mockClear();
      expect(await run(['open', '--print'], {}, home)).toBe(0);
      expect(logSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
        `${open.url}/o/acme/hello-world/mcp`,
      );
      logSpy.mockClear();
      expect(
        await run(
          [
            'deploy',
            '--org',
            'override',
            '--app',
            'other',
            '--env',
            'stage',
            '--version',
            '1',
            '--access',
            'owner-only',
          ],
          {},
          home,
        ),
      ).toBe(0);
      expect(logSpy.mock.calls.join('\n')).toContain(`${open.url}/o/override/other/stage/v1/mcp`);
      expect(logSpy.mock.calls.join('\n')).toContain('Access:    owner-only');
    } finally {
      await open.close();
    }
  });
  // #703: bare `noodle deploy` is what every example, README, and Agent Kit skill tells people to
  // run, and it is the only shape an agent or CI job can use — there is no TTY to prompt on. A
  // linked project whose app has never been deployed must complete without restating the entrypoint
  // or inventing a version.
  it('deploys a brand-new linked app with no flags and records version 1', async () => {
    const open = await service();
    try {
      expect(
        await run(
          ['init', '--no-install', tmp, '--template', 'hello', '--name', 'first'],
          {},
          home,
        ),
      ).toBe(0);
      process.chdir(tmp);
      expect(
        await run(['link', '--org', 'acme', '--app', 'first', '--service', open.url], {}, home),
      ).toBe(0);
      expect(await run(['deploy', '--no-prompt'], {}, home)).toBe(0);
      expect(logSpy.mock.calls.join('\n')).toContain(`${open.url}/o/acme/first/v1/mcp`);
      expect(String(JSON.parse(projectFile('.noodle/deployment.json')).serverVersion)).toBe('1');

      // The second deploy keeps the same version: deploying never auto-increments (ADR 0123).
      logSpy.mockClear();
      expect(await run(['deploy', '--no-prompt'], {}, home)).toBe(0);
      expect(String(JSON.parse(projectFile('.noodle/deployment.json')).serverVersion)).toBe('1');
    } finally {
      await open.close();
    }
  });
  it('supports explicit deploy memory controls for linked projects', async () => {
    const open = await service();
    try {
      expect(
        await run(
          ['init', '--no-install', tmp, '--template', 'hello', '--name', 'memory'],
          {},
          home,
        ),
      ).toBe(0);
      process.chdir(tmp);
      expect(
        await run(['link', '--org', 'acme', '--app', 'memory', '--service', open.url], {}, home),
      ).toBe(0);
      expect(await run(['deploy', '--version', '1', '--no-save'], {}, home)).toBe(0);
      expect(existsSync(join(tmp, '.noodle', 'deployment.json'))).toBe(false);
      expect(readServers(home)).toEqual([]);
      expect(await run(['deploy', '--version', '1', '--save'], {}, home)).toBe(0);
      expect(existsSync(join(tmp, '.noodle', 'deployment.json'))).toBe(true);
      expect(readServers(home)).toHaveLength(1);
      expect(readServers(home)[0]?.url).toContain('/o/acme/memory/v1/mcp');
    } finally {
      await open.close();
    }
  });
  it('explains how to recover when no entrypoint can be resolved', async () => {
    process.chdir(tmp);
    expect(await run(['validate'], {}, home)).toBe(2);
    expect(await run(['dev'], {}, home)).toBe(2);
    expect(await run(['deploy'], {}, home)).toBe(2);
    const printed = errSpy.mock.calls.join('\n');
    expect(printed).toContain('No project entrypoint found.');
    expect(printed).toContain('Cause:');
    expect(printed).toContain('Fix:');
    expect(printed).toContain('Next:');
    expect(printed).toContain('noodle init');
    expect(printed).toContain('noodle link --entrypoint <path>');
  });
  it('explains how to recover when open has no deployment memory', async () => {
    process.chdir(tmp);
    expect(await run(['open', '--print'], {}, home)).toBe(1);
    const printed = errSpy.mock.calls.join('\n');
    expect(printed).toContain('No saved deployment metadata found.');
    expect(printed).toContain('Cause:');
    expect(printed).toContain('Fix:');
    expect(printed).toContain('Next: noodle deploy');
  });
  it('keeps open fallback to legacy global deployment metadata', async () => {
    process.chdir(tmp);
    appendServer(
      {
        deploymentId: 'legacy',
        url: 'https://borg.noodleseed.com/o/demo/legacy/mcp',
        createdAt: '2026-06-09T00:00:00.000Z',
      },
      home,
    );
    expect(await run(['open', '--print'], {}, home)).toBe(0);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('https://borg.noodleseed.com/o/demo/legacy/mcp');
  });
  it('does not misrepresent a legacy service root as a project dashboard', async () => {
    process.chdir(tmp);
    appendServer(
      {
        deploymentId: 'legacy',
        url: 'https://borg.noodleseed.com/o/demo/legacy/mcp',
        createdAt: '2026-06-09T00:00:00.000Z',
      },
      home,
    );

    expect(await run(['open', '--dashboard', '--print'], {}, home)).toBe(1);
    expect(errSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      'Saved legacy deployment metadata cannot identify a project dashboard.',
    );
    expect(logSpy).not.toHaveBeenCalledWith('https://borg.noodleseed.com');
  });
  it('opens the saved Noodle Seed Cloud project dashboard', async () => {
    process.chdir(tmp);
    writeProjectDeployment({
      deploymentId: 'cloud-deployment',
      url: 'https://cloud.noodleseed.dev/o/acme/hello/v1/mcp',
      defaultUrl: 'https://cloud.noodleseed.dev/o/acme/hello/mcp',
      org: 'acme',
      app: 'hello',
      env: 'prod',
      accessMode: 'owner-only',
      serviceUrl: 'https://cloud.noodleseed.dev',
      createdAt: '2026-08-28T00:00:00.000Z',
    });

    expect(await run(['open', '--dashboard', '--print'], {}, home)).toBe(0);
    expect(logSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      'https://cloud.noodleseed.dev/projects/acme/hello',
    );
  });
  it('explains that self-hosted deployments do not have a web dashboard', async () => {
    process.chdir(tmp);
    writeProjectDeployment({
      deploymentId: 'core-deployment',
      url: 'http://127.0.0.1:8787/o/noodle-local/hello/v1/mcp',
      defaultUrl: 'http://127.0.0.1:8787/o/noodle-local/hello/mcp',
      org: 'noodle-local',
      app: 'hello',
      env: 'prod',
      accessMode: 'public',
      serviceUrl: 'http://127.0.0.1:8787',
      createdAt: '2026-08-28T00:00:00.000Z',
    });

    expect(await run(['open', '--dashboard', '--print'], {}, home)).toBe(1);
    const printed = errSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).toContain('No web dashboard is available for this deployment.');
    expect(printed).toContain(
      'Next: docker compose run --build --rm cli status --org noodle-local --app hello --env prod',
    );
    expect(logSpy).not.toHaveBeenCalledWith('http://127.0.0.1:8787');
  });
});
