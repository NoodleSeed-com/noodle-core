import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findCommand } from '../src/commands/catalog.js';
import { run, writeConfig } from '../src/index.js';
import { parseDeployRequestJson } from './deploy-request-test-helpers.js';
import { chdirIsolated, restoreCwd } from './helpers/isolated-cwd.js';

const HELLO = join(import.meta.dirname, 'fixtures', 'hello', 'server.ts');
const target = { org: 'acme', app: 'support', env: 'prod' };
let home: string;
let cwd: string;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-preflight-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'noodle-preflight-project-'));
  chdirIsolated(cwd);
  writeConfig({ serviceUrl: 'https://service.example.test', authToken: 'private-token' }, home);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  restoreCwd();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function args(extra: string[] = []): string[] {
  return [
    'deploy',
    'preflight',
    HELLO,
    '--org',
    'acme',
    '--app',
    'support',
    '--env',
    'prod',
    '--version',
    '1',
    ...extra,
  ];
}
function report() {
  return JSON.parse(log.mock.calls.map((call) => String(call[0])).join('\n'));
}
function ready() {
  return {
    ok: true,
    ready: true,
    target: { ...target, appState: 'will-create', environmentState: 'will-create' },
    config: { ready: true, missingSecrets: [], missingVariables: [] },
    errors: [],
  };
}
function serve(body: unknown) {
  const calls: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
    if (String(input).endsWith('/deploy/preflight')) return Response.json(body);
    throw new Error('preflight attempted an unexpected operation');
  });
  vi.stubGlobal('fetch', fetchImpl);
  return { calls, fetchImpl };
}

describe('read-only deploy preflight command', () => {
  it('compiles the selected entrypoint and checks readiness without any deploy or project writes', async () => {
    const before = readFileSync(join(home, '.noodle', 'config.json'), 'utf8');
    const { calls, fetchImpl } = serve(ready());
    expect(await run(args(['--json']), { NOODLE_UPDATE_MODE: 'off' }, home)).toBe(0);
    expect(calls).toEqual([
      'POST https://service.example.test/v1/orgs/acme/apps/support/envs/prod/deploy/preflight',
    ]);
    expect(parseDeployRequestJson(fetchImpl.mock.calls[0]?.[1])).toMatchObject({
      serverVersion: '1',
      accessMode: 'owner-only',
    });
    expect(report()).toMatchObject({ ok: true, data: { ready: true, target, published: false } });
    expect(JSON.stringify(report())).not.toContain('private-token');
    expect(existsSync(join(cwd, '.noodle'))).toBe(false);
    expect(readFileSync(join(home, '.noodle', 'config.json'), 'utf8')).toBe(before);
  });

  it('returns every config and validation finding together, never importing dotenv or saving a retry', async () => {
    writeFileSync(
      join(cwd, '.env'),
      'API_TOKEN=do-not-disclose\nAPI_ORIGIN=https://private.example\n',
    );
    const errors = [
      { code: 'missing_secret', path: 'connectors.api.auth', message: 'Missing API_TOKEN' },
      { code: 'missing_variable', path: 'connectors.api.baseUrl', message: 'Missing API_ORIGIN' },
      {
        code: 'server_auth_required',
        path: 'server.auth',
        message: 'Customer authentication is required',
      },
    ];
    const { calls } = serve({
      ...ready(),
      ready: false,
      config: { ready: false, missingSecrets: ['API_TOKEN'], missingVariables: ['API_ORIGIN'] },
      errors,
    });
    expect(await run(args(['--json']), {}, home)).toBe(1);
    expect(report()).toMatchObject({
      ok: false,
      error: {
        code: 'deploy_preflight_failed',
        errors,
        detail: {
          target,
          missingSecrets: ['API_TOKEN'],
          missingVariables: ['API_ORIGIN'],
          actions: expect.arrayContaining([
            expect.stringContaining('noodle secrets set API_TOKEN'),
            expect.stringContaining('noodle variables set API_ORIGIN'),
          ]),
        },
      },
    });
    expect(calls).toHaveLength(1);
    expect(existsSync(join(cwd, '.noodle'))).toBe(false);
    expect(JSON.stringify(report())).not.toContain('do-not-disclose');
  });

  it('renders every finding for humans and distinguishes readiness from publication', async () => {
    serve({
      ...ready(),
      ready: false,
      errors: [
        { code: 'first', path: 'one', message: 'First problem' },
        { code: 'second', path: 'two', message: 'Second problem' },
      ],
    });
    expect(await run(args(), {}, home)).toBe(1);
    const output = error.mock.calls.flat().join('\n');
    expect(output).toContain('First problem');
    expect(output).toContain('Second problem');
    expect(output).toContain('No deployment');
  });

  it.each([
    { ...ready(), target: { ...ready().target, org: 'another-tenant' } },
    { ...ready(), ownerSubject: 'another-owner' },
  ])('rejects a response that does not bind the requested identity and target', async (body) => {
    const { calls } = serve(body);
    expect(await run(args(['--owner-subject', 'requested-owner', '--json']), {}, home)).toBe(1);
    expect(report().ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(existsSync(join(cwd, '.noodle'))).toBe(false);
  });

  it.each([
    ['--save'],
    ['--no-save'],
    ['--unknown'],
    ['--version'],
    ['extra.ts'],
  ])('rejects unsupported or malformed arguments before any request: %j', async (extra) => {
    const { calls } = serve(ready());
    expect(await run(args([...extra, '--json']), {}, home)).toBe(2);
    expect(report().ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('discovers the command and its read-only flags through the canonical catalog', () => {
    const command = findCommand('deploy');
    const preflight = command?.subcommands?.find((item) => item.name === 'preflight');
    expect(preflight?.jsonOutput).toEqual({ mode: 'single' });
    expect(preflight?.flags.map((flag) => flag.name)).toEqual(
      expect.arrayContaining(['json', 'org', 'app', 'env', 'version', 'access', 'owner-subject']),
    );
    expect(preflight?.flags.some((flag) => flag.name === 'save' || flag.name === 'no-save')).toBe(
      false,
    );
    expect(preflight?.flags.find((flag) => flag.name === 'version')?.summary).toContain(
      'without publishing',
    );
  });

  it('resolves the signed-in organization without rewriting saved identity or target', async () => {
    const before = readFileSync(join(home, '.noodle', 'config.json'), 'utf8');
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith('/v1/whoami'))
          return Response.json({
            ok: true,
            identity: { subject: 'owner', email: 'owner@example.test', superAdmin: false },
            orgs: [{ slug: 'acme' }],
          });
        if (url.endsWith('/deploy/preflight')) return Response.json(ready());
        throw new Error('unexpected request');
      }),
    );
    const command = args(['--json']);
    command.splice(command.indexOf('--org'), 2);
    expect(await run(command, { NOODLE_UPDATE_MODE: 'off' }, home)).toBe(0);
    expect(calls).toHaveLength(2);
    expect(report()).toMatchObject({ ok: true, data: { target, published: false } });
    expect(readFileSync(join(home, '.noodle', 'config.json'), 'utf8')).toBe(before);
  });

  it.each([
    401, 403, 503,
  ])('reports HTTP %i without publication or a retry checkpoint', async (status) => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ code: 'preflight_denied', error: 'Check unavailable' }, { status }),
    );
    vi.stubGlobal('fetch', fetchImpl);
    expect(await run(args(['--json']), {}, home)).toBe(status === 503 ? 1 : 3);
    expect(report()).toMatchObject({
      ok: false,
      error: { code: 'preflight_denied', detail: { target, status } },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(existsSync(join(cwd, '.noodle'))).toBe(false);
  });

  it('does not treat an inconsistent ready response as evidence', async () => {
    serve({
      ...ready(),
      config: { ready: false, missingSecrets: ['API_TOKEN'], missingVariables: [] },
    });
    expect(await run(args(['--json']), {}, home)).toBe(1);
    expect(report()).toMatchObject({
      ok: false,
      error: { message: 'deploy preflight returned inconsistent readiness' },
    });
    expect(existsSync(join(cwd, '.noodle'))).toBe(false);
  });
});
