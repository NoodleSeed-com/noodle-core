import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPluginCompatibility } from '@noodle-borg/agent-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/cli.js';
import { readConfig, writeConfig } from '../src/config.js';
import { browserLogin, resolveControlPlaneToken } from '../src/control-plane.js';
import {
  assertPluginCompatibility,
  readPluginCompatibility,
} from '../src/plugin-mode/compatibility.js';
import { resolvePluginMode, splitPluginPathComponents } from '../src/plugin-mode/profile.js';
import { currentCliVersion } from '../src/update.js';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'noodle-plugin-mode-')));
  roots.push(root);
  return root;
}

function writeCompatibility(root: string, cliVersion = currentCliVersion()): string {
  const path = join(root, 'noodle-plugin-compatibility.json');
  writeFileSync(
    path,
    `${JSON.stringify(
      createPluginCompatibility({
        mode: 'release',
        pluginVersion: '1.2.3',
        agentKitVersion: '4.5.6',
        pluginContentHash: `sha256:${'a'.repeat(64)}`,
        cliVersion,
        developerMcpUrl: 'https://cloud.noodleseed.dev/developer/mcp',
        developerMcpCapabilityVersion: '1',
      }),
    )}\n`,
  );
  return path;
}

function pluginEnv(root: string): NodeJS.ProcessEnv {
  return {
    NOODLE_PLUGIN_HOST: 'codex',
    NOODLE_CONFIG_HOME: join(root, 'profile'),
    NOODLE_PLUGIN_COMPATIBILITY_FILE: writeCompatibility(root),
    NOODLE_UPDATE_MODE: 'off',
  };
}

describe('plugin mode profile', () => {
  it('is disabled only when the complete launcher tuple is absent', () => {
    expect(resolvePluginMode({})).toBeUndefined();
    expect(() => resolvePluginMode({ NOODLE_PLUGIN_HOST: 'codex' })).toThrow(/all three/i);
  });

  it('accepts a complete valid tuple and rejects unknown hosts and relative roots', () => {
    const root = tempRoot();
    const env = pluginEnv(root);
    expect(resolvePluginMode(env)).toEqual({
      host: 'codex',
      configHome: join(root, 'profile'),
      compatibilityFile: join(root, 'noodle-plugin-compatibility.json'),
    });
    expect(
      resolvePluginMode({
        ...env,
        NOODLE_PLUGIN_HOST: 'copilot',
        NOODLE_CONFIG_HOME: join(root, '.noodle', 'plugin-profiles', 'copilot'),
        NOODLE_PLUGIN_COMPATIBILITY_FILE: join(
          root,
          '.noodle',
          'plugin-profiles',
          'copilot',
          'plugin-mcp-compatibility.json',
        ),
      }),
    ).toEqual({
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
    expect(() => resolvePluginMode({ ...env, NOODLE_PLUGIN_HOST: 'chatgpt' })).toThrow(
      /unknown plugin host/i,
    );
    expect(() => resolvePluginMode({ ...env, NOODLE_CONFIG_HOME: 'relative/profile' })).toThrow(
      /absolute/i,
    );
  });

  it('rejects an existing symlink anywhere in the profile path', () => {
    const root = tempRoot();
    const real = join(root, 'real');
    const linked = join(root, 'linked');
    mkdirSync(real);
    symlinkSync(real, linked);
    expect(() =>
      resolvePluginMode({ ...pluginEnv(root), NOODLE_CONFIG_HOME: join(linked, 'codex') }),
    ).toThrow(/symbolic link/i);
  });

  it('splits Windows profile components using the platform separator', () => {
    expect(splitPluginPathComponents('C:\\Users\\dev\\.noodle', 'C:\\', '\\')).toEqual([
      'Users',
      'dev',
      '.noodle',
    ]);
  });
});

describe('plugin compatibility', () => {
  it('reads a strict manifest and rejects malformed JSON', () => {
    const root = tempRoot();
    const path = writeCompatibility(root);
    expect(readPluginCompatibility(path)).toMatchObject({ cliVersion: currentCliVersion() });
    writeFileSync(path, '{ malformed');
    expect(() => readPluginCompatibility(path)).toThrow(/read plugin compatibility/i);
  });

  it('fails exact CLI and MCP capability mismatches', () => {
    const root = tempRoot();
    const manifest = readPluginCompatibility(writeCompatibility(root));
    expect(() =>
      assertPluginCompatibility({
        manifest,
        cliVersion: '99.0.0',
        developerMcpCapabilityVersion: '1',
      }),
    ).toThrow(/pins CLI/);
    expect(() =>
      assertPluginCompatibility({
        manifest,
        cliVersion: currentCliVersion(),
        developerMcpCapabilityVersion: '2',
      }),
    ).toThrow(/requires Developer MCP capability/);
  });
});

describe('plugin CLI isolation', () => {
  it('rejects manual service and bearer-token overrides without touching either profile', async () => {
    const root = tempRoot();
    const normalHome = join(root, 'normal-home');
    mkdirSync(normalHome);
    writeConfig(
      { serviceUrl: 'https://ordinary.example', authToken: 'ordinary-token' },
      normalHome,
    );
    const code = await run(
      ['login', '--service', 'https://cloud.noodleseed.dev', '--auth-token', 'plugin-token'],
      pluginEnv(root),
      normalHome,
    );

    expect(code).toBe(2);
    expect(readConfig(normalHome)).toEqual({
      serviceUrl: 'https://ordinary.example',
      authToken: 'ordinary-token',
    });
    const mode = resolvePluginMode(pluginEnv(root));
    expect(mode).toBeDefined();
    if (mode === undefined) throw new Error('expected plugin mode');
    expect(readConfig({ configHome: mode.configHome })).toEqual({});
  });

  it('ignores ambient normal-CLI bearer and service overrides in plugin mode', async () => {
    const root = tempRoot();
    const env = {
      ...pluginEnv(root),
      NOODLE_AUTH_TOKEN: 'ambient-normal-token',
      NOODLE_SERVICE_URL: 'https://credential-thief.example',
    };
    const mode = resolvePluginMode(env);
    expect(mode).toBeDefined();
    if (mode === undefined) throw new Error('expected plugin mode');
    writeConfig(
      { serviceUrl: 'https://cloud.noodleseed.dev', authToken: 'plugin-profile-token' },
      { configHome: mode.configHome },
    );
    let authorization: string | null = null;
    let requestedUrl: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requestedUrl = input.toString();
        authorization = new Headers(init?.headers).get('authorization');
        return Response.json({
          ok: true,
          identity: { subject: 'user-1', email: 'dev@example.com', superAdmin: false },
          orgs: [{ slug: 'acme' }],
        });
      }),
    );

    expect(await run(['whoami', '--json'], env, join(root, 'normal-home'))).toBe(0);
    expect(authorization).toBe('Bearer plugin-profile-token');
    expect(requestedUrl).toBe('https://cloud.noodleseed.dev/v1/whoami');
  });

  it('rejects an internally supplied project service before resolving a plugin token', async () => {
    const root = tempRoot();
    const env = pluginEnv(root);
    const mode = resolvePluginMode(env);
    expect(mode).toBeDefined();
    if (mode === undefined) throw new Error('expected plugin mode');
    writeConfig(
      { serviceUrl: 'https://cloud.noodleseed.dev', authToken: 'plugin-profile-token' },
      { configHome: mode.configHome },
    );

    await expect(
      resolveControlPlaneToken({
        serviceFlag: 'https://credential-thief.example',
        env,
        home: { configHome: mode.configHome },
      }),
    ).rejects.toThrow(/pinned to https:\/\/cloud\.noodleseed\.dev/i);
  });

  it('revokes the exact plugin grant before clearing the isolated profile', async () => {
    const root = tempRoot();
    const env = pluginEnv(root);
    const mode = resolvePluginMode(env);
    expect(mode).toBeDefined();
    if (mode === undefined) throw new Error('expected plugin mode');
    writeConfig(
      {
        serviceUrl: 'https://cloud.noodleseed.dev',
        authToken: 'plugin-access-token',
        oauthClientId: 'plugin-client',
      },
      { configHome: mode.configHome },
    );
    let request: { url: string; init?: RequestInit } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        request = { url: input.toString(), ...(init === undefined ? {} : { init }) };
        return Response.json({});
      }),
    );

    expect(await run(['logout'], env, join(root, 'normal-home'))).toBe(0);
    expect(request?.url).toBe('https://cloud.noodleseed.dev/revoke');
    expect(request?.init?.method).toBe('POST');
    expect(new URLSearchParams(request?.init?.body?.toString())).toEqual(
      new URLSearchParams({
        client_id: 'plugin-client',
        token: 'plugin-access-token',
        token_type_hint: 'access_token',
      }),
    );
    expect(readConfig({ configHome: mode.configHome })).toEqual({
      serviceUrl: 'https://cloud.noodleseed.dev',
    });
  });
});

describe('plugin OAuth resource', () => {
  it('authorizes and exchanges the code for the dedicated developer CLI resource', async () => {
    const root = tempRoot();
    const location = { configHome: join(root, 'profile') } as const;
    let openedUrl: URL | undefined;
    let tokenBody: URLSearchParams | undefined;
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input.toString());
      if (url.pathname === '/v1/auth') {
        return Response.json({
          ok: true,
          service: 'https://svc.example',
          googleClientId: null,
          allowedEmailDomain: '@example.com',
          authType: 'noodle-oauth-pkce',
          authorizationServerIssuer: 'https://svc.example',
          controlPlaneResource: 'https://svc.example',
        });
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return Response.json({
          issuer: 'https://svc.example',
          authorization_endpoint: 'https://svc.example/authorize',
          token_endpoint: 'https://svc.example/token',
          registration_endpoint: 'https://svc.example/register',
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
        });
      }
      if (url.pathname === '/register') {
        return Response.json({ client_id: 'plugin-cli-client' }, { status: 201 });
      }
      if (url.pathname === '/token') {
        tokenBody = new URLSearchParams(init?.body?.toString());
        return Response.json({
          access_token: 'header.payload.signature',
          refresh_token: 'plugin-refresh',
          expires_in: 3600,
          token_type: 'bearer',
        });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    };

    await browserLogin({
      serviceUrl: 'https://svc.example',
      home: location,
      resource: 'https://svc.example/developer/cli',
      fetchImpl,
      openBrowser: (url) => {
        openedUrl = new URL(url);
        const callback = new URL(openedUrl.searchParams.get('redirect_uri') ?? '');
        callback.searchParams.set('code', 'auth-code');
        callback.searchParams.set('state', openedUrl.searchParams.get('state') ?? '');
        setTimeout(() => void fetch(callback), 0);
      },
    });

    expect(openedUrl?.searchParams.get('resource')).toBe('https://svc.example/developer/cli');
    expect(tokenBody?.get('resource')).toBe('https://svc.example/developer/cli');
    expect(readConfig(location)).toMatchObject({
      oauthClientId: 'plugin-cli-client',
      oauthRefreshToken: 'plugin-refresh',
      oauthResource: 'https://svc.example/developer/cli',
    });
  });

  it('retains the dedicated resource when refreshing the plugin token', async () => {
    const root = tempRoot();
    const location = { configHome: join(root, 'profile') } as const;
    writeConfig(
      {
        serviceUrl: 'https://svc.example',
        authToken: 'expired',
        authTokenExpiresAt: '2000-01-01T00:00:00.000Z',
        oauthIssuer: 'https://svc.example',
        oauthClientId: 'plugin-cli-client',
        oauthRefreshToken: 'plugin-refresh',
        oauthResource: 'https://svc.example/developer/cli',
      },
      location,
    );
    let tokenBody: URLSearchParams | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      tokenBody = new URLSearchParams(init?.body?.toString());
      return Response.json({
        access_token: 'renewed',
        refresh_token: 'rotated',
        expires_in: 3600,
      });
    }) as typeof fetch;

    await resolveControlPlaneToken({ env: {}, home: location, fetchImpl });

    expect(tokenBody?.get('resource')).toBe('https://svc.example/developer/cli');
    expect(readConfig(location)).toMatchObject({
      authToken: 'renewed',
      oauthRefreshToken: 'rotated',
      oauthResource: 'https://svc.example/developer/cli',
    });
  });
});
