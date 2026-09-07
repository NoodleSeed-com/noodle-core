import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  contentSha256,
  renderAgentFiles,
  renderAgentKitManifest,
  renderPublishableSkills,
} from '@noodle-borg/agent-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  nextAgentSetupCommand,
  productSkillRecoveryNext,
} from '../src/agent-product-skill-output.js';
import {
  type AgentSetupReport,
  runAgents,
  setupAgents,
  staleAgentContextError,
} from '../src/agents.js';
import { run } from '../src/index.js';
import { bundledAgentKitVersion } from '../src/skills-update.js';
import { assertJsonEnvelope } from './helpers/json-envelope.js';

describe.sequential('noodle agents', () => {
  let cwd: string;
  let home: string;
  let project: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cwd = process.cwd();
    home = mkdtempSync(join(tmpdir(), 'noodle-agents-home-'));
    project = mkdtempSync(join(tmpdir(), 'noodle-agents-project-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(cwd);
    logSpy.mockRestore();
    errSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  async function withStderrTty(value: boolean, task: () => Promise<void>): Promise<void> {
    const stderrIsTty = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
    try {
      Object.defineProperty(process.stderr, 'isTTY', { value, configurable: true });
      await task();
    } finally {
      if (stderrIsTty) Object.defineProperty(process.stderr, 'isTTY', stderrIsTty);
      else Reflect.deleteProperty(process.stderr, 'isTTY');
    }
  }

  function logged(): string {
    return logSpy.mock.calls.map((call) => String(call[0])).join('\n');
  }

  function file(path: string): string {
    return readFileSync(join(project, path), 'utf8');
  }

  function writePluginCompatibility(agentKitVersion: string): string {
    const compatibilityFile = join(project, 'noodle-plugin-compatibility.json');
    writeFileSync(
      compatibilityFile,
      `${JSON.stringify({
        schemaVersion: 2,
        pluginVersion: '1.2.3',
        agentKitVersion,
        cliVersion: '1.2.3',
        developerMcpCapabilityVersion: '1',
        developerMcpUrl: 'https://cloud.noodleseed.dev/developer/mcp',
        pluginContentHash: `sha256:${'a'.repeat(64)}`,
      })}\n`,
    );
    return compatibilityFile;
  }

  function setInstalledCodexSkillVersion(version: string): void {
    const path = join(project, '.agents/skills/noodle-seed/SKILL.md');
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(
        /<!-- noodle-skill version:[^ ]+ hash:/,
        `<!-- noodle-skill version:${version} hash:`,
      ),
    );
  }

  function seedPinnedAgentKitCache(version: string): void {
    const cacheRoot = join(home, '.noodle', 'cache', 'agent-kit', version);
    const renderedManifest = renderAgentKitManifest();
    const files = renderPublishableSkills().map((file) => {
      const content = file.path.endsWith('/SKILL.md')
        ? file.content.replace(
            /<!-- noodle-skill version:[^ ]+ hash:/,
            `<!-- noodle-skill version:${version} hash:`,
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
        skillVersion: version,
      };
    });
    writeFileSync(
      join(cacheRoot, 'manifest.json'),
      JSON.stringify({ schemaVersion: 2, packageVersion: version, files }, null, 2),
    );
  }

  async function withInteractiveRegistry(task: () => Promise<void>): Promise<void> {
    await withStderrTty(true, async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          const isSkills = String(url).includes('agent-kit');
          return new Response(JSON.stringify({ version: isSkills ? '99.0.0' : '0.0.1' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }),
      );
      await task();
      vi.unstubAllGlobals();
    });
  }

  it('agents setup dry-runs Codex and Claude Code and writes no files', async () => {
    expect(await run(['agents', 'setup', '--project', project], {}, home)).toBe(0);

    const printed = logged();
    expect(printed).toContain('Claude Code');
    expect(printed).toContain('Codex');
    expect(printed).toContain('AGENTS.md');
    expect(printed).toContain('CLAUDE.md');
    expect(printed).toContain('noodle agents setup --write');
    expect(existsSync(join(project, '.noodle'))).toBe(false);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('agents setup respects --agents', async () => {
    expect(
      await run(['agents', 'setup', '--agents', 'codex', '--project', project], {}, home),
    ).toBe(0);

    const printed = logged();
    expect(printed).toContain('Codex');
    expect(printed).toContain('AGENTS.md');
    expect(printed).not.toContain('CLAUDE.md');
  });

  it('agents setup defaults to the noodle.json agents list when --agents is not passed', async () => {
    writeFileSync(
      join(project, 'noodle.json'),
      `${JSON.stringify({ entrypoint: 'server.ts', name: 'demo', agents: ['codex'] })}\n`,
    );
    expect(await run(['agents', 'setup', '--project', project], {}, home)).toBe(0);

    const printed = logged();
    expect(printed).toContain('Codex');
    expect(printed).not.toContain('CLAUDE.md');
  });

  it('agents setup plans nothing when noodle.json declares an empty agents list', async () => {
    writeFileSync(
      join(project, 'noodle.json'),
      `${JSON.stringify({ entrypoint: 'server.ts', name: 'demo', agents: [] })}\n`,
    );
    expect(await run(['agents', 'setup', '--write', '--project', project], {}, home)).toBe(0);

    const printed = logged();
    expect(printed).toContain('No agent targets configured');
    expect(existsSync(join(project, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(project, 'CLAUDE.md'))).toBe(false);
  });

  it('agents setup --agents all overrides an empty noodle.json agents list', async () => {
    writeFileSync(
      join(project, 'noodle.json'),
      `${JSON.stringify({ entrypoint: 'server.ts', name: 'demo', agents: [] })}\n`,
    );
    expect(await run(['agents', 'setup', '--agents', 'all', '--project', project], {}, home)).toBe(
      0,
    );

    const printed = logged();
    expect(printed).toContain('Codex');
    expect(printed).toContain('Claude Code');
  });

  it('agents context remains a compatibility alias without writing', async () => {
    expect(await run(['agents', 'context', '--project', project], {}, home)).toBe(0);

    const printed = logged();
    expect(printed).toContain('Dry run');
    expect(printed).toContain('AGENTS.md');
    expect(printed).toContain('CLAUDE.md');
    expect(existsSync(join(project, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(project, 'CLAUDE.md'))).toBe(false);
  });

  it('agents setup --write creates project-local files for Codex and Claude Code', async () => {
    process.chdir(project);
    expect(
      await run(
        ['init', '--no-install', project, '--name', 'agent-demo', '--force', '--no-agents'],
        {},
        home,
      ),
    ).toBe(0);
    expect(
      await run(['link', '--org', 'acme', '--app', 'agent-demo', '--env', 'dev'], {}, home),
    ).toBe(0);
    logSpy.mockClear();

    expect(await run(['agents', 'setup', '--write'], {}, home)).toBe(0);

    for (const target of [
      'AGENTS.md',
      'CLAUDE.md',
      '.agents/skills/noodle-seed/SKILL.md',
      '.claude/skills/noodle-seed/SKILL.md',
    ]) {
      expect(existsSync(join(project, target))).toBe(true);
      expect(file(target)).toContain('noodle validate');
      expect(file(target)).toContain('noodle test');
      expect(file(target)).toContain('noodle dev');
      expect(file(target)).toMatch(/current user request explicitly authorizes/i);
      expect(file(target)).not.toMatch(
        /NOODLE_AUTH_TOKEN|oauthRefreshToken|refreshToken|nbk_|tok-123|caller-key/,
      );
    }
    expect(file('AGENTS.md')).toContain('BEGIN NOODLE AGENT CONTEXT');
    expect(file('CLAUDE.md')).toContain('BEGIN NOODLE AGENT CONTEXT');
    expect(file('AGENTS.md')).toContain('org: acme');
    expect(file('AGENTS.md')).toContain('app: agent-demo');
    expect(file('AGENTS.md')).toContain('env: dev');
    expect(file('AGENTS.md')).not.toContain('noodle deploy');
  });

  it('agents setup --agents codex writes only Codex target files', async () => {
    expect(
      await run(
        ['agents', 'setup', '--agents', 'codex', '--project', project, '--write'],
        {},
        home,
      ),
    ).toBe(0);

    expect(existsSync(join(project, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(project, '.agents', 'skills', 'noodle-seed', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(project, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(project, '.claude', 'skills', 'noodle-seed', 'SKILL.md'))).toBe(false);
  });

  it('agents setup --write installs the full hierarchical reference tree', async () => {
    expect(
      await run(
        ['agents', 'setup', '--agents', 'codex', '--project', project, '--write'],
        {},
        home,
      ),
    ).toBe(0);

    for (const ref of [
      'sdk-surface',
      'cli-commands',
      'agent-contract',
      'compile-errors',
      'authoring-workflow',
      'widgets-and-apps',
      'test-in-hosts',
      'troubleshooting',
      'deploy-and-ops',
      'publishing',
      'examples',
    ]) {
      expect(existsSync(join(project, '.agents/skills/noodle-seed/references', `${ref}.md`))).toBe(
        true,
      );
    }
    // Generated references reflect the live surface, not stale hand-written text.
    expect(file('.agents/skills/noodle-seed/references/cli-commands.md')).toContain(
      'noodle deploy',
    );
    expect(file('.agents/skills/noodle-seed/references/sdk-surface.md')).toContain('tool');
    expect(file('.agents/skills/noodle-seed/references/compile-errors.md')).toContain(
      'unknown_operation',
    );
  });

  it('agents setup reruns update the managed block without duplicating it', async () => {
    expect(
      await run(
        ['agents', 'setup', '--agents', 'codex', '--project', project, '--write'],
        {},
        home,
      ),
    ).toBe(0);
    expect(
      await run(
        ['agents', 'setup', '--agents', 'codex', '--project', project, '--write'],
        {},
        home,
      ),
    ).toBe(0);

    const text = file('AGENTS.md');
    expect(text.match(/BEGIN NOODLE AGENT CONTEXT/g)).toHaveLength(1);
    expect(text.match(/END NOODLE AGENT CONTEXT/g)).toHaveLength(1);
  });

  it('agents setup preserves existing unmarked files while adding a managed block', async () => {
    writeFileSync(join(project, 'AGENTS.md'), '# Existing instructions\n\nKeep this.\n');

    expect(
      await run(
        ['agents', 'setup', '--agents', 'codex', '--project', project, '--write'],
        {},
        home,
      ),
    ).toBe(0);

    expect(file('AGENTS.md')).toContain('Keep this.');
    expect(file('AGENTS.md')).toContain('BEGIN NOODLE AGENT CONTEXT');
    expect(existsSync(join(project, 'AGENTS.md.bak'))).toBe(false);
  });

  it('agents setup rejects unknown targets', async () => {
    expect(
      await run(['agents', 'setup', '--agents', 'emacs', '--project', project], {}, home),
    ).toBe(2);
    const printed = errSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).toContain('--agents must be codex, claude-code, all, or none');
  });

  it('requires explicit regeneration before modified app-skill replacement', async () => {
    expect(
      await run(
        [
          'agents',
          'setup',
          '--agents',
          'codex',
          '--project',
          project,
          '--replace-modified-app-skill',
        ],
        {},
        home,
      ),
    ).toBe(2);
    expect(errSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      '--replace-modified-app-skill requires --regenerate-app-skill',
    );
  });

  it('setupAgents applies one complete remote snapshot without mixing bundled files', () => {
    const override = {
      packageVersion: '0.2.0',
      files: renderAgentFiles({ targets: ['codex'] })
        .filter((file) => file.mode === 'generated-file')
        .map((file) => ({
          path: file.path,
          target: file.target,
          skill: file.skill ?? 'noodle-seed',
          skillVersion: '0.2.0',
          content: file.path.endsWith('/SKILL.md')
            ? '---\nname: noodle-seed\n---\n\n<!-- noodle-skill version:0.2.0 hash:remotehash0000001 -->\n\n# Remote Codex Skill\n'
            : file.path.endsWith('/references/cli-commands.md')
              ? '# Remote CLI reference\n'
              : file.content,
        })),
    };
    setupAgents({
      agents: ['codex'],
      project,
      write: true,
      force: false,
      json: false,
      skillsOverride: override,
    });
    // The SKILL.md override applies to the router only.
    expect(file('.agents/skills/noodle-seed/SKILL.md')).toContain('Remote Codex Skill');
    expect(file('.agents/skills/noodle-seed/SKILL.md')).toContain('version:0.2.0');
    // The cli-commands override applies to its own file.
    expect(file('.agents/skills/noodle-seed/references/cli-commands.md')).toBe(
      '# Remote CLI reference\n',
    );
    // A reference with no override keeps its bundled content (not the SKILL.md body).
    expect(file('.agents/skills/noodle-seed/references/sdk-surface.md')).not.toContain(
      'Remote Codex Skill',
    );
    expect(file('.agents/skills/noodle-seed/references/sdk-surface.md')).toContain('SDK surface');
    // The managed block still comes from the bundled renderer.
    expect(file('AGENTS.md')).toContain('BEGIN NOODLE AGENT CONTEXT');
  });

  it('agents doctor warns when installed skills are older than the registry', async () => {
    await withInteractiveRegistry(async () => {
      // First write bundled skills so installed < registry 99.0.0.
      await run(
        ['agents', 'setup', '--agents', 'codex', '--project', project, '--write'],
        {
          NOODLE_DISABLE_UPDATE_CHECK: '1',
        },
        home,
      );
      logSpy.mockClear();
      errSpy.mockClear();
      expect(
        await run(['agents', 'doctor', '--agents', 'codex', '--project', project], {}, home),
      ).toBe(0);
      const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      // Only the SKILL.md router triggers the version-staleness warning.
      expect(printed).toContain(
        `SKILL.md: installed v${bundledAgentKitVersion()} is older than registry v99.0.0`,
      );
      // Reference files have no version frontmatter; when the router version matches the bundled kit,
      // they are hash-checked (freshly written → `current`), never falsely flagged stale.
      expect(printed).toContain(
        'PASS .agents/skills/noodle-seed/references/cli-commands.md: current',
      );
      expect(printed).not.toMatch(/references\/.*older than registry/);
    });
  });

  it('agents setup --refresh checks for an update in a non-interactive process', async () => {
    await withStderrTty(false, async () => {
      const fetchSpy = vi.fn(async () => new Response('{}', { status: 503 }));
      vi.stubGlobal('fetch', fetchSpy);

      expect(
        await runAgents(
          ['setup', '--agents', 'codex', '--project', project, '--write', '--refresh'],
          { CI: '1' },
          home,
        ),
      ).toBe(0);
      expect(fetchSpy).toHaveBeenCalled();
    });
  });

  it('agents doctor uses the plugin compatibility Agent Kit version without a TTY', async () => {
    await runAgents(['setup', '--agents', 'codex', '--project', project, '--write'], {
      NOODLE_DISABLE_UPDATE_CHECK: '1',
    });
    const compatibilityFile = writePluginCompatibility('99.0.0');
    logSpy.mockClear();

    await withStderrTty(false, async () => {
      expect(
        await runAgents(['doctor', '--agents', 'codex', '--project', project], {
          NOODLE_PLUGIN_COMPATIBILITY_FILE: compatibilityFile,
        }),
      ).toBe(0);
    });
    expect(logged()).toContain('SKILL.md: installed v');
    expect(logged()).toContain('does not match plugin-required v99.0.0');
  });

  it('agents doctor warns when matching plugin references have no verified cache baseline', async () => {
    await runAgents(
      ['setup', '--agents', 'codex', '--project', project, '--write'],
      { NOODLE_DISABLE_UPDATE_CHECK: '1' },
      home,
    );
    const pinnedVersion = '99.0.0';
    setInstalledCodexSkillVersion(pinnedVersion);
    const compatibilityFile = writePluginCompatibility(pinnedVersion);
    logSpy.mockClear();

    await withStderrTty(false, async () => {
      expect(
        await runAgents(
          ['doctor', '--agents', 'codex', '--project', project],
          { NOODLE_PLUGIN_COMPATIBILITY_FILE: compatibilityFile },
          home,
        ),
      ).toBe(0);
    });
    expect(logged()).toContain(
      `WARN .agents/skills/noodle-seed/references/sdk-surface.md: plugin-required v${pinnedVersion} cache unavailable`,
    );
  });

  it('agents doctor hash-checks references against the verified pinned cache', async () => {
    await runAgents(
      ['setup', '--agents', 'codex', '--project', project, '--write'],
      { NOODLE_DISABLE_UPDATE_CHECK: '1' },
      home,
    );
    const pinnedVersion = '99.0.0';
    setInstalledCodexSkillVersion(pinnedVersion);
    seedPinnedAgentKitCache(pinnedVersion);
    const compatibilityFile = writePluginCompatibility(pinnedVersion);
    const referencePath = join(project, '.agents/skills/noodle-seed/references/sdk-surface.md');
    writeFileSync(referencePath, `${readFileSync(referencePath, 'utf8')}\nmodified\n`);
    logSpy.mockClear();

    await withStderrTty(false, async () => {
      expect(
        await runAgents(
          ['doctor', '--agents', 'codex', '--project', project],
          { NOODLE_PLUGIN_COMPATIBILITY_FILE: compatibilityFile },
          home,
        ),
      ).toBe(0);
    });
    expect(logged()).toContain(
      'WARN .agents/skills/noodle-seed/references/sdk-surface.md: modified; run noodle agents setup --write',
    );
    expect(logged()).toContain(
      'PASS .agents/skills/noodle-seed/references/cli-commands.md: current',
    );
  });

  it('agents doctor reads the canonical body metadata comment', async () => {
    await withInteractiveRegistry(async () => {
      await run(
        ['agents', 'setup', '--agents', 'codex', '--project', project, '--write'],
        { NOODLE_DISABLE_UPDATE_CHECK: '1' },
        home,
      );
      const skillPath = join(project, '.agents/skills/noodle-seed/SKILL.md');
      writeFileSync(
        skillPath,
        '---\nname: noodle-seed\ndescription: Use when building MCP servers.\n---\n\n' +
          '<!-- noodle-skill version:0.2.0 hash:0000000000000000 -->\n\n# Skill\n',
      );
      logSpy.mockClear();
      errSpy.mockClear();

      expect(
        await run(['agents', 'doctor', '--agents', 'codex', '--project', project], {}, home),
      ).toBe(0);
      expect(logged()).toContain('SKILL.md: installed v0.2.0 is older than registry v99.0.0');
    });
  });

  it('agents doctor warns when an installed reference file was modified', async () => {
    await run(
      ['agents', 'setup', '--agents', 'codex', '--project', project, '--write'],
      {
        NOODLE_DISABLE_UPDATE_CHECK: '1',
      },
      home,
    );
    writeFileSync(
      join(project, '.agents/skills/noodle-seed/references/cli-commands.md'),
      '# locally edited reference\n',
    );
    logSpy.mockClear();
    errSpy.mockClear();

    expect(
      await run(
        ['agents', 'doctor', '--agents', 'codex', '--project', project, '--json'],
        { NOODLE_DISABLE_UPDATE_CHECK: '1' },
        home,
      ),
    ).toBe(0);

    const report = JSON.parse(logSpy.mock.calls.map((c) => String(c[0])).join('\n')) as {
      data: { checks: Array<{ name: string; level: string; message: string }> };
    };
    const check = report.data.checks.find((c) => c.name.endsWith('references/cli-commands.md'));
    expect(check).toMatchObject({
      level: 'WARN',
      message: 'modified; run noodle agents setup --write',
    });
  });

  it('agents doctor warns when managed AGENTS.md and CLAUDE.md blocks drift', async () => {
    await run(
      ['agents', 'setup', '--agents', 'all', '--project', project, '--write'],
      { NOODLE_DISABLE_UPDATE_CHECK: '1' },
      home,
    );
    for (const path of ['AGENTS.md', 'CLAUDE.md']) {
      writeFileSync(
        join(project, path),
        file(path).replace('# Noodle Seed Project Context', '# Locally edited project context'),
      );
    }
    logSpy.mockClear();

    expect(
      await run(
        ['agents', 'doctor', '--agents', 'all', '--project', project, '--json'],
        { NOODLE_DISABLE_UPDATE_CHECK: '1' },
        home,
      ),
    ).toBe(0);

    const report = JSON.parse(logged()) as {
      data: {
        stale: boolean;
        checks: Array<{ name: string; level: string; message: string }>;
      };
    };
    expect(report.data.stale).toBe(true);
    for (const path of ['AGENTS.md', 'CLAUDE.md']) {
      expect(report.data.checks.find((check) => check.name === path)).toMatchObject({
        level: 'WARN',
        message: 'modified or stale; run noodle agents setup --write',
      });
    }
  });

  it('agents setup --json wraps the setup report in a success envelope', async () => {
    expect(
      await run(['agents', 'setup', '--agents', 'codex', '--project', project, '--json'], {}, home),
    ).toBe(0);
    const envelope = assertJsonEnvelope<AgentSetupReport>(JSON.parse(logged()));
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) throw new Error('expected a success envelope');
    expect(envelope.data.dryRun).toBe(true);
    expect(envelope.data.targets).toContain('codex');
    expect(Array.isArray(envelope.data.files)).toBe(true);
    expect(logged()).not.toContain('authToken');
  });

  it('agents doctor --json returns a data-wrapped healthy envelope with exit 0', async () => {
    await run(
      ['agents', 'setup', '--agents', 'codex', '--project', project, '--write'],
      { NOODLE_DISABLE_UPDATE_CHECK: '1' },
      home,
    );
    logSpy.mockClear();
    expect(
      await run(
        ['agents', 'doctor', '--agents', 'codex', '--project', project, '--json'],
        { NOODLE_DISABLE_UPDATE_CHECK: '1' },
        home,
      ),
    ).toBe(0);
    const envelope = assertJsonEnvelope<{
      checks: Array<{ name: string; level: string }>;
      restartRequired: boolean;
    }>(JSON.parse(logged()));
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) throw new Error('expected a success envelope');
    expect(envelope.data.restartRequired).toBe(false);
    expect(
      envelope.data.checks.some((check) => check.name === 'AGENTS.md' && check.level === 'PASS'),
    ).toBe(true);
  });

  // The unhealthy branch fires only on a FAIL-level check, which the current doctor never emits
  // (all checks are PASS/WARN). Locking the failure-envelope contract at the builder keeps the
  // machine shape single-sourced and honest for when a FAIL check is added.
  it('staleAgentContextError builds the agents doctor failure envelope contract', () => {
    const error = staleAgentContextError([{ name: 'SKILL.md', level: 'FAIL', message: 'missing' }]);
    const envelope = assertJsonEnvelope(JSON.parse(JSON.stringify({ ok: false, error })));
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected a failure envelope');
    expect(envelope.error.code).toBe('agent_context_stale');
    expect(envelope.error.message).toBe('agent context is stale or missing');
    expect(envelope.error.next).toBe('noodle agents setup --write');
    expect(envelope.error.detail).toMatchObject({
      checks: [{ name: 'SKILL.md', level: 'FAIL', message: 'missing' }],
      nextCommands: [{ command: 'noodle agents setup --write' }],
    });

    const appError = staleAgentContextError([
      {
        name: 'Codex app product skill',
        level: 'FAIL',
        message: 'ownership record is malformed',
        code: 'agent_skill_invalid_state',
      },
    ]);
    expect(appError.next).toBe('noodle agents setup');
  });

  it('uses typed app-skill recovery metadata independently of issue copy', () => {
    const issue = {
      code: 'agent_skill_modified' as const,
      message: 'owned generated bytes changed',
      recovery: 'replace_modified_app_skill' as const,
    };
    const report = { ok: false, targets: [], issues: [issue] };

    expect(productSkillRecoveryNext(issue)).toContain('--replace-modified-app-skill');
    expect(nextAgentSetupCommand({ write: false, replaceModifiedAppSkill: false }, report)).toBe(
      'noodle agents setup --regenerate-app-skill --replace-modified-app-skill',
    );
  });
});
