import { mkdtemp, readFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { bootstrapPluginMcpInvocation } from '../src/plugin-mode/plugin-mcp-bootstrap.js';
import { resolvePluginMode } from '../src/plugin-mode/profile.js';

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'noodle-plugin-mcp-bootstrap-'));
  roots.push(root);
  return realpath(root);
}

describe('pinned plugin MCP bootstrap', () => {
  it('derives an isolated profile and owner-only compatibility file from bounded arguments', async () => {
    const root = await home();
    const result = await bootstrapPluginMcpInvocation(
      [
        'plugin-mcp',
        '--plugin-host',
        'cursor',
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
      { env: {}, home: root, cliVersion: '5.6.7' },
    );
    expect(result?.argv).toEqual(['plugin-mcp']);
    expect(resolvePluginMode(result?.env ?? {})).toEqual({
      host: 'cursor',
      configHome: join(root, '.noodle', 'plugin-profiles', 'cursor'),
      compatibilityFile: join(
        root,
        '.noodle',
        'plugin-profiles',
        'cursor',
        'plugin-mcp-compatibility.json',
      ),
    });
    const compatibility = JSON.parse(
      await readFile(result?.env.NOODLE_PLUGIN_COMPATIBILITY_FILE ?? '', 'utf8'),
    );
    expect(compatibility).toMatchObject({
      pluginVersion: '2.3.4',
      agentKitVersion: '8.9.0',
      pluginContentHash: `sha256:${'a'.repeat(64)}`,
      cliVersion: '5.6.7',
      developerMcpCapabilityVersion: '1',
    });
    expect((await stat(result?.env.NOODLE_CONFIG_HOME ?? '')).mode & 0o077).toBe(0);
    expect((await stat(result?.env.NOODLE_PLUGIN_COMPATIBILITY_FILE ?? '')).mode & 0o077).toBe(0);
  });

  it('isolates a Copilot bootstrap in the dedicated Copilot profile', async () => {
    const root = await home();
    const result = await bootstrapPluginMcpInvocation(
      [
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
      { env: {}, home: root, cliVersion: '5.6.7' },
    );

    expect(resolvePluginMode(result?.env ?? {})).toEqual({
      host: 'copilot',
      configHome: join(root, '.noodle', 'plugin-profiles', 'copilot'),
      compatibilityFile: join(
        root,
        '.noodle',
        'plugin-profiles',
        'copilot',
        'plugin-mcp-compatibility.json',
      ),
    });
  });

  it('does nothing for other commands or an already managed plugin invocation', async () => {
    const root = await home();
    await expect(
      bootstrapPluginMcpInvocation(['validate'], { env: {}, home: root, cliVersion: '1.0.0' }),
    ).resolves.toBeUndefined();
    await expect(
      bootstrapPluginMcpInvocation(['plugin-mcp'], {
        env: {
          NOODLE_PLUGIN_HOST: 'codex',
          NOODLE_CONFIG_HOME: join(root, 'profile'),
          NOODLE_PLUGIN_COMPATIBILITY_FILE: join(root, 'compatibility.json'),
        },
        home: root,
        cliVersion: '1.0.0',
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects missing, duplicate, unknown, or unbounded bootstrap values', async () => {
    const root = await home();
    const base = [
      'plugin-mcp',
      '--plugin-host',
      'codex',
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
    ];
    for (const argv of [
      base.slice(0, -2),
      [...base, '--plugin-host', 'cursor'],
      [...base, '--shell', 'rm -rf /'],
      base.map((value) => (value === 'codex' ? 'chatgpt' : value)),
      base.map((value) =>
        value === 'https://cloud.noodleseed.dev/developer/mcp' ? 'file:///tmp/mcp' : value,
      ),
    ]) {
      await expect(
        bootstrapPluginMcpInvocation(argv, { env: {}, home: root, cliVersion: '5.6.7' }),
      ).rejects.toThrow(/plugin MCP bootstrap/i);
    }
  });
});
