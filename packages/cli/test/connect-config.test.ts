import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claudeAddJsonCommand,
  connectConfig,
  mcpServersConfig,
  mcpType,
} from '../src/commands/connect-config.js';
import { run } from '../src/index.js';
import { writeProjectDeployment } from '../src/project.js';

const URL_HTTPS = 'https://cloud.noodleseed.dev/o/acme/hello/mcp';
const URL_ORIGIN = 'https://cloud.noodleseed.dev';
const URL_SUBDOMAIN = 'https://acme.cloud.noodleseed.dev/hello/v2_0_6/mcp';

describe('connect-config (M5 plugin packaging)', () => {
  it('derives the MCP type from the URL scheme', () => {
    expect(mcpType('https://x/mcp')).toBe('https');
    expect(mcpType('http://localhost:9100/mcp')).toBe('http');
  });

  it('builds the documented Claude Code mcpServers block and add-json command', () => {
    const config = mcpServersConfig('hello', URL_HTTPS);
    expect(config.mcpServers.hello).toEqual({ type: 'https', url: URL_HTTPS });
    const command = claudeAddJsonCommand('hello', URL_HTTPS);
    expect(command).toContain('claude mcp add-json hello');
    expect(command).toContain(URL_HTTPS);
  });

  it('marks Claude Code verified with a config and command, Codex unverified', () => {
    const claudeCode = connectConfig('claude-code', 'hello', URL_HTTPS);
    expect(claudeCode.verified).toBe(true);
    expect(claudeCode.config?.mcpServers.hello.url).toBe(URL_HTTPS);
    expect(claudeCode.command).toContain('add-json');

    const codex = connectConfig('codex', 'hello', URL_HTTPS);
    expect(codex.verified).toBe(false);
    expect(codex.config?.mcpServers.hello.url).toBe(URL_HTTPS);
  });

  it('uses paste-URL steps for Claude.ai and ChatGPT, a command for Inspector', () => {
    for (const client of ['claude', 'chatgpt']) {
      const config = connectConfig(client, 'hello', URL_HTTPS);
      expect(config.verified).toBe(true);
      expect(config.steps?.some((s) => s.includes(URL_HTTPS))).toBe(true);
    }
    const inspector = connectConfig('inspector', 'hello', URL_HTTPS);
    expect(inspector.command).toContain('@modelcontextprotocol/inspector');
    expect(inspector.command).toContain(URL_HTTPS);
  });

  it('never embeds a bearer token or secret in any client config', () => {
    const flat = ['claude-code', 'codex', 'claude', 'chatgpt', 'inspector']
      .map((c) => JSON.stringify(connectConfig(c, 'hello', URL_HTTPS)))
      .join(' ')
      .toLowerCase();
    expect(flat).not.toContain('bearer');
    expect(flat).not.toContain('secret');
  });
});

describe('noodle connect --endpoint', () => {
  let home: string;
  let cwd: string;
  let project: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;

  beforeEach(() => {
    cwd = process.cwd();
    home = mkdtempSync(join(tmpdir(), 'noodle-connect-'));
    project = mkdtempSync(join(tmpdir(), 'noodle-connect-project-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(cwd);
    fetchSpy?.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('emits the Claude Code registration config as JSON for a deployed endpoint', async () => {
    const code = await run(
      ['connect', 'claude-code', '--endpoint', URL_HTTPS, '--name', 'hello', '--json'],
      {},
      home,
    );
    expect(code).toBe(0);
    const body = JSON.parse(logSpy.mock.calls.map((c) => String(c[0])).join('\n')) as {
      ok: boolean;
      data: {
        client: string;
        config: { mcpServers: Record<string, { url: string }> };
        command: string;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.client).toBe('claude-code');
    expect(body.data.config.mcpServers.hello.url).toBe(URL_HTTPS);
    expect(body.data.command).toContain('claude mcp add-json hello');
  });

  it('registers a Gemini Enterprise OAuth client and emits setup fields as JSON', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof URL ? input.href : String(input);
      calls.push({ url, ...(init !== undefined ? { init } : {}) });
      if (
        url === 'https://cloud.noodleseed.dev/.well-known/oauth-protected-resource/o/acme/hello/mcp'
      ) {
        return Response.json({
          resource: URL_HTTPS,
          authorization_servers: ['https://cloud.noodleseed.dev'],
        });
      }
      if (url === 'https://cloud.noodleseed.dev/.well-known/oauth-authorization-server') {
        return Response.json({
          authorization_endpoint: 'https://cloud.noodleseed.dev/authorize',
          token_endpoint: 'https://cloud.noodleseed.dev/token',
          registration_endpoint: 'https://cloud.noodleseed.dev/register',
        });
      }
      if (url === 'https://cloud.noodleseed.dev/register') {
        return Response.json(
          {
            client_id: 'gemini-client-id',
            client_secret: 'gemini-client-secret',
            client_secret_expires_at: 1785523159,
            default_resource: URL_HTTPS,
          },
          { status: 201 },
        );
      }
      return Response.json({ error: 'unexpected url' }, { status: 500 });
    });

    const code = await run(
      [
        'connect',
        'gemini-enterprise',
        '--endpoint',
        URL_HTTPS,
        '--name',
        'SharePoint Test',
        '--json',
      ],
      { NOODLE_DISABLE_UPDATE_CHECK: '1' },
      home,
    );

    expect(code).toBe(0);
    const body = JSON.parse(logSpy.mock.calls.map((c) => String(c[0])).join('\n')) as {
      ok: boolean;
      data: {
        client: string;
        mcpServerUrl: string;
        authorizationUrl: string;
        tokenUrl: string;
        clientId: string;
        clientSecret: string;
        scopes: string;
        pkce: boolean;
        authorizationUrlParameters: string;
        description: string;
        instructions: string;
      };
    };
    expect(body).toMatchObject({
      ok: true,
      data: {
        client: 'gemini-enterprise',
        mcpServerUrl: URL_HTTPS,
        authorizationUrl: 'https://cloud.noodleseed.dev/authorize',
        tokenUrl: 'https://cloud.noodleseed.dev/token',
        clientId: 'gemini-client-id',
        clientSecret: 'gemini-client-secret',
        scopes: '',
        pkce: true,
        authorizationUrlParameters: '',
      },
    });
    expect(body.data.description).toContain('Noodle MCP server');
    expect(body.data.instructions).toContain('Discover available MCP tools');

    const register = calls.find((call) => call.url === 'https://cloud.noodleseed.dev/register');
    expect(register?.init?.method).toBe('POST');
    const registrationBody = JSON.parse(String(register?.init?.body)) as {
      client_name: string;
      redirect_uris: string[];
      token_endpoint_auth_method: string;
      grant_types: string[];
      response_types: string[];
    };
    expect(registrationBody).toEqual({
      client_name: `Gemini Enterprise MCP SharePoint Test ${URL_HTTPS}`,
      application_type: 'web',
      redirect_uris: [
        'https://vertexaisearch.cloud.google.com/oauth-redirect',
        'https://vertexaisearch.cloud.google.com/static/oauth/oauth.html',
      ],
      token_endpoint_auth_method: 'client_secret_post',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });

  it('uses the standard protected-resource metadata URL for origin-only Gemini Enterprise endpoints', async () => {
    const calls: string[] = [];
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = input instanceof URL ? input.href : String(input);
      calls.push(url);
      if (url === `${URL_ORIGIN}/.well-known/oauth-protected-resource`) {
        return Response.json({
          resource: URL_ORIGIN,
          authorization_servers: [URL_ORIGIN],
        });
      }
      if (url === `${URL_ORIGIN}/.well-known/oauth-authorization-server`) {
        return Response.json({
          authorization_endpoint: `${URL_ORIGIN}/authorize`,
          token_endpoint: `${URL_ORIGIN}/token`,
          registration_endpoint: `${URL_ORIGIN}/register`,
        });
      }
      if (url === `${URL_ORIGIN}/register`) {
        return Response.json({
          client_id: 'gemini-client-id',
          client_secret: 'gemini-client-secret',
          default_resource: URL_ORIGIN,
        });
      }
      return Response.json({ error: 'unexpected url' }, { status: 500 });
    });

    const code = await run(
      ['connect', 'gemini-enterprise', '--endpoint', URL_ORIGIN, '--json'],
      { NOODLE_DISABLE_UPDATE_CHECK: '1' },
      home,
    );

    expect(code).toBe(0);
    expect(calls).toContain(`${URL_ORIGIN}/.well-known/oauth-protected-resource`);
    expect(calls).not.toContain(`${URL_ORIGIN}/.well-known/oauth-protected-resource/`);
  });

  it('uses the endpoint path when deriving Gemini Enterprise metadata for org-subdomain endpoints', async () => {
    const calls: string[] = [];
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = input instanceof URL ? input.href : String(input);
      calls.push(url);
      if (
        url ===
        'https://acme.cloud.noodleseed.dev/.well-known/oauth-protected-resource/hello/v2_0_6/mcp'
      ) {
        return Response.json({
          resource: URL_SUBDOMAIN,
          authorization_servers: ['https://cloud.noodleseed.dev'],
        });
      }
      if (url === 'https://cloud.noodleseed.dev/.well-known/oauth-authorization-server') {
        return Response.json({
          authorization_endpoint: 'https://cloud.noodleseed.dev/authorize',
          token_endpoint: 'https://cloud.noodleseed.dev/token',
          registration_endpoint: 'https://cloud.noodleseed.dev/register',
        });
      }
      if (url === 'https://cloud.noodleseed.dev/register') {
        return Response.json({
          client_id: 'gemini-client-id',
          client_secret: 'gemini-client-secret',
          default_resource: URL_SUBDOMAIN,
        });
      }
      return Response.json({ error: 'unexpected url' }, { status: 500 });
    });

    const code = await run(
      ['connect', 'gemini-enterprise', '--endpoint', URL_SUBDOMAIN, '--json'],
      { NOODLE_DISABLE_UPDATE_CHECK: '1' },
      home,
    );

    expect(code).toBe(0);
    expect(calls).toContain(
      'https://acme.cloud.noodleseed.dev/.well-known/oauth-protected-resource/hello/v2_0_6/mcp',
    );
  });

  it('emits standalone Gemini Enterprise authorization URL parameters without a leading ampersand', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = input instanceof URL ? input.href : String(input);
      if (
        url === 'https://cloud.noodleseed.dev/.well-known/oauth-protected-resource/o/acme/hello/mcp'
      ) {
        return Response.json({
          resource: URL_HTTPS,
          authorization_servers: ['https://cloud.noodleseed.dev'],
        });
      }
      if (url === 'https://cloud.noodleseed.dev/.well-known/oauth-authorization-server') {
        return Response.json({
          authorization_endpoint: 'https://cloud.noodleseed.dev/authorize',
          token_endpoint: 'https://cloud.noodleseed.dev/token',
          registration_endpoint: 'https://cloud.noodleseed.dev/register',
        });
      }
      if (url === 'https://cloud.noodleseed.dev/register') {
        return Response.json({
          client_id: 'gemini-client-id',
          client_secret: 'gemini-client-secret',
        });
      }
      return Response.json({ error: 'unexpected url' }, { status: 500 });
    });

    const code = await run(
      ['connect', 'gemini-enterprise', '--endpoint', URL_HTTPS, '--json'],
      { NOODLE_DISABLE_UPDATE_CHECK: '1' },
      home,
    );

    expect(code).toBe(0);
    const body = JSON.parse(logSpy.mock.calls.map((c) => String(c[0])).join('\n')) as {
      data: { authorizationUrlParameters: string };
    };
    expect(body.data.authorizationUrlParameters).toBe(`resource=${encodeURIComponent(URL_HTTPS)}`);
  });

  it('uses saved deployment metadata for Gemini Enterprise when --endpoint is omitted', async () => {
    process.chdir(project);
    writeProjectDeployment({
      deploymentId: 'hello-123',
      url: URL_HTTPS,
      org: 'acme',
      app: 'hello',
      env: 'prod',
      accessMode: 'customers',
      serviceUrl: 'https://cloud.noodleseed.dev',
      createdAt: '2026-07-02T00:00:00.000Z',
    });
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = input instanceof URL ? input.href : String(input);
      if (url.endsWith('/.well-known/oauth-protected-resource/o/acme/hello/mcp')) {
        return Response.json({
          resource: URL_HTTPS,
          authorization_servers: ['https://cloud.noodleseed.dev'],
        });
      }
      if (url.endsWith('/.well-known/oauth-authorization-server')) {
        return Response.json({
          authorization_endpoint: 'https://cloud.noodleseed.dev/authorize',
          token_endpoint: 'https://cloud.noodleseed.dev/token',
          registration_endpoint: 'https://cloud.noodleseed.dev/register',
        });
      }
      return Response.json({
        client_id: 'saved-client-id',
        client_secret: 'saved-client-secret',
        default_resource: URL_HTTPS,
      });
    });

    const code = await run(
      ['connect', 'gemini-enterprise', '--json'],
      { NOODLE_DISABLE_UPDATE_CHECK: '1' },
      home,
    );

    expect(code).toBe(0);
    const body = JSON.parse(logSpy.mock.calls.map((c) => String(c[0])).join('\n')) as {
      data: { mcpServerUrl: string; clientId: string };
    };
    expect(body.data.mcpServerUrl).toBe(URL_HTTPS);
    expect(body.data.clientId).toBe('saved-client-id');
  });
});
