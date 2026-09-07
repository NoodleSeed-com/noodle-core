import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/index.js';
import { chdirIsolated, restoreCwd } from './helpers/isolated-cwd.js';

afterEach(() => {
  restoreCwd();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('hosted diagnostics commands', () => {
  it('renders hosted inspect metadata from the control-plane API', async () => {
    const home = mkdtempSync(join(tmpdir(), 'noodle-cli-home-'));
    chdirIsolated(home);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input.toString()).toBe(
        'https://svc.example/v1/orgs/acme/apps/hello/envs/prod/inspect',
      );
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token');
      return Response.json({
        ok: true,
        target: { org: 'acme', app: 'hello', env: 'prod' },
        deployment: {
          deploymentId: 'hello-12345678',
          endpointUrl: 'https://svc.example/o/acme/hello/mcp',
          active: true,
          accessMode: 'owner-only',
          ownerSubject: 'oauth-human',
          serverName: 'hello',
          createdAt: '2026-06-29T00:00:00.000Z',
        },
        health: { state: 'ready', missingSecrets: [] },
        surface: {
          tools: [{ name: 'greet' }],
          resources: [{ uri: 'docs://hello', name: 'Hello docs' }],
          prompts: [{ name: 'brief' }],
          widgets: [],
          widgetLinkedTools: [],
          appOnlyTools: [],
          compatibility: { mcpApps: 'pass', chatgpt: 'pass', claude: 'pass' },
        },
        findings: [],
      });
    }) as typeof fetch);
    try {
      expect(
        await run(
          [
            'inspect',
            '--service',
            'https://svc.example',
            '--auth-token',
            'token',
            '--org',
            'acme',
            '--app',
            'hello',
          ],
          {},
          home,
        ),
      ).toBe(0);
      const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
      // Detail card: org/app/env title, aligned rows (nothing dropped), NEXT footer.
      expect(printed.split('\n')[0]).toBe('acme/hello/prod');
      expect(printed).toMatch(/deployment\s+hello-12345678/);
      expect(printed).toMatch(/state\s+● active/);
      expect(printed).toMatch(/access\s+owner-only/);
      expect(printed).toMatch(/owner\s+oauth-human/);
      expect(printed).toMatch(/health\s+ready/);
      expect(printed).toMatch(/tools\s+greet/);
      expect(printed).toMatch(/resources\s+docs:\/\/hello/);
      expect(printed).toMatch(/prompts\s+brief/);
      expect(printed).toMatch(/widgets\s+\(none\)/);
      expect(printed).toMatch(/compat\s+mcpApps=pass chatgpt=pass claude=pass/);
      expect(printed).toContain('https://svc.example');
      expect(printed).toContain('NEXT');
      expect(printed).not.toContain('token');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('prints hosted smoke JSON with external verification commands', async () => {
    const home = mkdtempSync(join(tmpdir(), 'noodle-cli-home-'));
    chdirIsolated(home);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input.toString()).toBe(
        'https://svc.example/v1/orgs/acme/apps/hello/envs/staging/smoke',
      );
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token');
      return Response.json({
        ok: true,
        target: { org: 'acme', app: 'hello', env: 'staging' },
        checks: [{ level: 'PASS', name: 'Deployment', message: 'active deployment found' }],
        external: {
          inspector:
            'npx @modelcontextprotocol/inspector https://svc.example/o/acme/hello/staging/mcp',
          mcpjam:
            'npx @mcpjam/cli@latest server probe --url https://svc.example/o/acme/hello/staging/mcp',
        },
      });
    }) as typeof fetch);
    try {
      expect(
        await run(
          [
            'smoke',
            '--service',
            'https://svc.example',
            '--auth-token',
            'token',
            '--org',
            'acme',
            '--app',
            'hello',
            '--env',
            'staging',
            '--json',
          ],
          {},
          home,
        ),
      ).toBe(0);
      const body = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
        data: { service: string; external: { inspector: string } };
      };
      expect(body.data.service).toBe('https://svc.example');
      expect(body.data.external.inspector).toContain('@modelcontextprotocol/inspector');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
