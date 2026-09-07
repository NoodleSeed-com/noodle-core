import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { parseBuildReadinessSnapshot } from '../src/plugin-mode/build-readiness-contract.js';
import { bootstrapPluginMcpInvocation } from '../src/plugin-mode/plugin-mcp-bootstrap.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'noodle-plugin-security-'));
  roots.push(root);
  return realpath(root);
}

const BOOTSTRAP = [
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
] as const;

describe('developer plugin cross-boundary security', () => {
  it('rejects command injection before creating plugin-owned profile state', async () => {
    const home = await temporaryHome();
    await expect(
      bootstrapPluginMcpInvocation([...BOOTSTRAP, '--shell', 'rm -rf /'], {
        env: {},
        home,
        cliVersion: '5.6.7',
      }),
    ).rejects.toThrow(/plugin MCP bootstrap/i);
    await expect(access(join(home, '.noodle'))).rejects.toThrow();
  });

  it('rejects credential-bearing compatibility URLs before creating profile state', async () => {
    const home = await temporaryHome();
    const injected = BOOTSTRAP.map((value) =>
      value === 'https://cloud.noodleseed.dev/developer/mcp'
        ? 'https://user:password@cloud.noodleseed.dev/developer/mcp'
        : value,
    );
    await expect(
      bootstrapPluginMcpInvocation(injected, { env: {}, home, cliVersion: '5.6.7' }),
    ).rejects.toThrow(/HTTPS|credential/i);
    await expect(access(join(home, '.noodle'))).rejects.toThrow();
  });

  it('rejects secret-shaped findings and non-relative evidence paths', () => {
    const base = {
      schemaVersion: 1,
      workspaceHandle: 'a'.repeat(22),
      workspaceDigest: `sha256:${'a'.repeat(64)}`,
      updatedAt: '2026-07-18T00:00:00.000Z',
      runs: [],
    };
    expect(() =>
      parseBuildReadinessSnapshot({
        ...base,
        findings: [{ code: 'unsafe', severity: 'error', message: 'Authorization: Bearer secret' }],
      }),
    ).toThrow(/secret|sensitive/i);
    expect(() =>
      parseBuildReadinessSnapshot({
        ...base,
        findings: [
          {
            code: 'unsafe',
            severity: 'error',
            message: 'Invalid source',
            relativePath: '/etc/passwd',
          },
        ],
      }),
    ).toThrow(/project-relative/i);
  });
});
