import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPluginCompatibility } from '@noodle-borg/agent-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/cli.js';
import { writeConfig } from '../src/config.js';
import {
  type PluginServiceCompatibilityFailure,
  pluginServiceCompatibilityFailure,
} from '../src/plugin-mode/service-compatibility.js';
import { currentCliVersion } from '../src/update.js';
import { chdirIsolated, restoreCwd } from './helpers/isolated-cwd.js';

const roots: string[] = [];

beforeEach(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'noodle-plugin-service-cwd-')));
  roots.push(root);
  chdirIsolated(root);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  restoreCwd();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(
  input: {
    readonly cliVersion?: string;
    readonly capabilityVersion?: string;
    readonly serviceOrigin?: string;
  } = {},
): {
  readonly root: string;
  readonly profile: string;
  readonly env: NodeJS.ProcessEnv;
  readonly mode: {
    readonly host: 'codex';
    readonly configHome: string;
    readonly compatibilityFile: string;
  };
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'noodle-plugin-service-')));
  roots.push(root);
  const profile = join(root, 'profile');
  const compatibilityFile = join(root, 'noodle-plugin-compatibility.json');
  const serviceOrigin = input.serviceOrigin ?? 'https://svc.example';
  writeFileSync(
    compatibilityFile,
    JSON.stringify(
      createPluginCompatibility({
        mode: 'release',
        pluginVersion: '1.2.3',
        agentKitVersion: '4.5.6',
        pluginContentHash: `sha256:${'a'.repeat(64)}`,
        cliVersion: input.cliVersion ?? currentCliVersion(),
        developerMcpUrl: `${serviceOrigin}/developer/mcp`,
        developerMcpCapabilityVersion: input.capabilityVersion ?? '2',
      }),
    ),
  );
  const mode = { host: 'codex' as const, configHome: profile, compatibilityFile };
  return {
    root,
    profile,
    mode,
    env: {
      NOODLE_PLUGIN_HOST: mode.host,
      NOODLE_CONFIG_HOME: profile,
      NOODLE_PLUGIN_COMPATIBILITY_FILE: compatibilityFile,
      NOODLE_UPDATE_MODE: 'off',
    },
  };
}

describe('plugin service compatibility', () => {
  it('accepts the exact CLI, service origin, and Developer MCP capability tuple', async () => {
    const { mode } = fixture();
    const failure = await pluginServiceCompatibilityFailure({
      pluginMode: mode,
      serviceUrl: 'https://svc.example',
      fetchImpl: vi.fn(async () =>
        Response.json({ developerPlugin: { mcpCapabilityVersion: '2' } }),
      ) as typeof fetch,
    });
    expect(failure).toBeUndefined();
  });

  it('fails a CLI mismatch before making a service request', async () => {
    const { mode } = fixture({ cliVersion: '99.0.0' });
    const fetchImpl = vi.fn<typeof fetch>();
    expect(
      await pluginServiceCompatibilityFailure({
        pluginMode: mode,
        serviceUrl: 'https://svc.example',
        fetchImpl,
      }),
    ).toMatchObject<PluginServiceCompatibilityFailure>({
      code: 'plugin_cli_incompatible',
      exitCode: 1,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails a server capability or origin mismatch with corrective action', async () => {
    const { mode } = fixture({ capabilityVersion: '1' });
    expect(
      await pluginServiceCompatibilityFailure({
        pluginMode: mode,
        serviceUrl: 'https://svc.example',
        fetchImpl: vi.fn(async () =>
          Response.json({ developerPlugin: { mcpCapabilityVersion: '2' } }),
        ) as typeof fetch,
      }),
    ).toMatchObject({
      code: 'plugin_server_incompatible',
      next: expect.stringMatching(/plugin/i),
    });

    const other = fixture({ serviceOrigin: 'https://other.example' });
    const fetchImpl = vi.fn<typeof fetch>();
    expect(
      await pluginServiceCompatibilityFailure({
        pluginMode: other.mode,
        serviceUrl: 'https://svc.example',
        fetchImpl,
      }),
    ).toMatchObject({ code: 'plugin_server_incompatible' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('blocks a deploy before reading or uploading app bytes when the cloud capability mismatches', async () => {
    const { env, profile, root } = fixture({ capabilityVersion: '1' });
    writeConfig(
      { serviceUrl: 'https://svc.example', authToken: 'plugin-token', defaultOrg: 'acme' },
      { configHome: profile },
    );
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        requests.push(input.toString());
        return Response.json({ developerPlugin: { mcpCapabilityVersion: '2' } });
      }),
    );
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const code = await run(
      [
        'deploy',
        join(root, 'does-not-need-to-exist.ts'),
        '--org',
        'acme',
        '--app',
        'demo',
        '--version',
        '1',
        '--json',
      ],
      env,
      join(root, 'normal-home'),
    );

    expect(code).toBe(1);
    expect(requests).toEqual(['https://svc.example/v1/service/info']);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'plugin_server_incompatible' },
    });
    expect(error).not.toHaveBeenCalled();
  });

  it('returns a structured CLI mismatch before any deploy service request', async () => {
    const { env, profile, root } = fixture({ cliVersion: '99.0.0' });
    writeConfig(
      { serviceUrl: 'https://svc.example', authToken: 'plugin-token', defaultOrg: 'acme' },
      { configHome: profile },
    );
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchImpl);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(
      await run(
        [
          'deploy',
          join(root, 'unread.ts'),
          '--org',
          'acme',
          '--app',
          'demo',
          '--version',
          '1',
          '--json',
        ],
        env,
        join(root, 'normal-home'),
      ),
    ).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'plugin_cli_incompatible' },
    });
    expect(error).not.toHaveBeenCalled();
  });

  it('blocks rollback before its mutation request when the cloud capability mismatches', async () => {
    const { env, profile, root } = fixture({ capabilityVersion: '1' });
    writeConfig(
      { serviceUrl: 'https://svc.example', authToken: 'plugin-token' },
      { configHome: profile },
    );
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        requests.push(input.toString());
        return Response.json({ developerPlugin: { mcpCapabilityVersion: '2' } });
      }),
    );
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(
      await run(
        ['rollback', 'dep_previous', '--org', 'acme', '--app', 'demo', '--env', 'prod', '--json'],
        env,
        join(root, 'normal-home'),
      ),
    ).toBe(1);
    expect(requests).toEqual(['https://svc.example/v1/service/info']);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'plugin_server_incompatible' },
    });
    expect(error).not.toHaveBeenCalled();
  });

  it('does nothing for a normal non-plugin invocation', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(
      await pluginServiceCompatibilityFailure({
        serviceUrl: 'https://svc.example',
        fetchImpl,
      }),
    ).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
