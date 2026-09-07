import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/index.js';
import { assertJsonEnvelope } from './helpers/json-envelope.js';

// Package-local fixtures (copied from examples/), so this suite never couples to the examples showcase.
const HELLO = join(import.meta.dirname, 'fixtures', 'hello', 'server.ts');
const widgetServer = join(import.meta.dirname, 'fixtures', 'restaurant-pickup', 'src', 'server.ts');
const sensitiveWidgetServer = join(
  import.meta.dirname,
  'fixtures',
  'sensitive-widget-output',
  'server.ts',
);

let home: string;
let tmp: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-envelope-home-'));
  tmp = mkdtempSync(join(tmpdir(), 'noodle-envelope-'));
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

function lastJson(): unknown {
  return JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string);
}

function expectSingleStdoutEnvelope(): ReturnType<typeof assertJsonEnvelope> {
  expect(logSpy).toHaveBeenCalledOnce();
  expect(errorSpy).not.toHaveBeenCalled();
  return assertJsonEnvelope(lastJson());
}

async function inEmptyProject<T>(operation: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(tmp);
  try {
    return await operation();
  } finally {
    process.chdir(previous);
  }
}

function writeBrokenManifest(): string {
  const broken = join(tmp, 'broken.yaml');
  writeFileSync(
    broken,
    'manifestVersion: "1"\nserver: { name: broken, version: "1.0.0" }\ntools: []\n',
  );
  return broken;
}

/**
 * S3-A: every local author-loop `--json` command emits the uniform envelope — `{ ok: true, data }` on
 * success, `{ ok: false, error: { code, message, ... } }` on failure, with per-field issues nested under
 * `error.errors[]`.
 */
describe('uniform --json envelope (S3-A)', () => {
  it('validate --json success returns { ok: true, data }', async () => {
    expect(await run(['validate', HELLO, '--json'], {}, home)).toBe(0);
    const envelope = assertJsonEnvelope(lastJson());
    expect(envelope.ok).toBe(true);
    expect(envelope).not.toHaveProperty('error');
  });

  it('validate --json failure nests enriched errors under error.errors[]', async () => {
    expect(await run(['validate', writeBrokenManifest(), '--json'], {}, home)).toBe(1);
    const envelope = assertJsonEnvelope(lastJson());
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.code).toBe('validation_failed');
    expect(envelope.error.message).toContain('validation error');
    expect(Array.isArray(envelope.error.errors)).toBe(true);
    expect((envelope.error.errors ?? []).every((e) => typeof e.code === 'string')).toBe(true);
    // The old top-level `errors`/`stage` keys are gone; issues live under error.errors.
    expect(envelope).not.toHaveProperty('errors');
    expect(envelope).not.toHaveProperty('stage');
  });

  it('test --json success returns { ok: true, data: { endpoint, tools } }', async () => {
    expect(await run(['test', HELLO, '--json'], {}, home)).toBe(0);
    const envelope = assertJsonEnvelope<{ endpoint: string; tools: string[] }>(lastJson());
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) throw new Error('expected success');
    expect(envelope.data.endpoint).toContain('/mcp');
    expect(envelope.data.tools).toContain('greet');
  }, 15_000);

  it('test --json failure returns the validation_failed envelope', async () => {
    expect(await run(['test', writeBrokenManifest(), '--json'], {}, home)).toBe(1);
    const envelope = assertJsonEnvelope(lastJson());
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.code).toBe('validation_failed');
    expect((envelope.error.errors ?? []).length).toBeGreaterThan(0);
  });

  it('tools/resources/prompts --json success returns { ok: true, data: { result } }', async () => {
    const manifest = join(tmp, 'server.ts');
    writeFileSync(
      manifest,
      `
import { prompt, resource, server, tool, z } from '@noodleseed/one';

export default server('rp', { title: 'RP', version: '1.0.0' }, [
  tool('noop', {
    description: 'A no-op tool.',
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    fulfil: () => ({ ok: true }),
  }),
  resource('guide', {
    uri: 'docs://guide',
    title: 'Guide',
    mimeType: 'text/plain',
    fulfil: () => 'hello docs',
  }),
  prompt('brief', {
    description: 'A brief prompt.',
    arguments: z.object({ topic: z.string() }),
    fulfil: ({ input }) => \`Summarize \${input.topic}\`,
  }),
]);
`,
    );

    expect(await run(['tools', 'list', manifest, '--json'], {}, home)).toBe(0);
    const toolsEnvelope = assertJsonEnvelope<{ tools: Array<{ name: string }> }>(lastJson());
    if (!toolsEnvelope.ok) throw new Error('expected success');
    expect(toolsEnvelope.data.tools.map((tool) => tool.name)).toContain('noop');
    logSpy.mockClear();

    expect(await run(['resources', 'read', 'docs://guide', manifest, '--json'], {}, home)).toBe(0);
    const resEnvelope = assertJsonEnvelope<{ result: unknown }>(lastJson());
    if (!resEnvelope.ok) throw new Error('expected success');
    expect(JSON.stringify(resEnvelope.data.result)).toContain('hello docs');
    logSpy.mockClear();

    expect(
      await run(
        ['prompts', 'get', 'brief', manifest, '--args', '{"topic":"Noodle"}', '--json'],
        {},
        home,
      ),
    ).toBe(0);
    const promptEnvelope = assertJsonEnvelope<{ result: unknown }>(lastJson());
    if (!promptEnvelope.ok) throw new Error('expected success');
    expect(JSON.stringify(promptEnvelope.data.result)).toContain('Noodle');
  }, 20_000);

  it('smoke --json surfaces an mcp_error envelope with the raw detail', async () => {
    expect(await run(['tools', 'call', 'does_not_exist', HELLO, '--json'], {}, home)).toBe(5);
    const envelope = assertJsonEnvelope(lastJson());
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.code).toBe('mcp_error');
    expect(typeof envelope.error.message).toBe('string');
    expect(envelope.error.detail).toBeDefined();
  }, 15_000);

  it('check --json success returns { ok: true, data: { target, findings } }', async () => {
    expect(await run(['check', widgetServer, '--json'], {}, home)).toBe(0);
    const envelope = assertJsonEnvelope<{ target: string; findings: Array<{ code: string }> }>(
      lastJson(),
    );
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) throw new Error('expected success');
    expect(envelope.data.target).toBe('generic');
    expect(
      envelope.data.findings.some((finding) => finding.code === 'progressive_enhancement'),
    ).toBe(true);
  }, 15_000);

  it('check --json check-failure nests findings under error.errors[]', async () => {
    expect(await run(['check', sensitiveWidgetServer, '--json'], {}, home)).toBe(1);
    const envelope = assertJsonEnvelope(lastJson());
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.code).toBe('check_failed');
    expect(
      (envelope.error.errors ?? []).some((finding) => finding.code === 'widget_privacy_boundary'),
    ).toBe(true);
    expect(envelope).not.toHaveProperty('findings');
    expect(JSON.stringify(envelope)).not.toContain('secret-token-value');
  }, 15_000);

  it('check --json invalid_target returns the failure envelope', async () => {
    expect(await run(['check', '--target', 'unknown', '--json'], {}, home)).toBe(2);
    const envelope = assertJsonEnvelope(lastJson());
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.code).toBe('invalid_target');
    expect(envelope.error.fix).toContain('--target');
  });

  it.each([
    {
      name: 'validate missing entrypoint',
      argv: ['validate', '--json'],
      exitCode: 2,
      errorCode: 'project_entrypoint_required',
      emptyProject: true,
    },
    {
      name: 'test missing entrypoint',
      argv: ['test', '--json'],
      exitCode: 2,
      errorCode: 'project_entrypoint_required',
      emptyProject: true,
    },
    {
      name: 'tools missing entrypoint',
      argv: ['tools', 'list', '--json'],
      exitCode: 2,
      errorCode: 'project_entrypoint_required',
      emptyProject: true,
    },
    {
      name: 'check missing entrypoint',
      argv: ['check', '--json'],
      exitCode: 2,
      errorCode: 'project_entrypoint_required',
      emptyProject: true,
    },
    {
      name: 'features invalid host before JSON flag',
      argv: ['features', '--host', 'invalid', '--json'],
      exitCode: 2,
      errorCode: 'invalid_host',
      emptyProject: false,
    },
    {
      name: 'service invalid capability before JSON flag',
      argv: ['service', 'capabilities', '--capability', 'invalid', '--json'],
      exitCode: 2,
      errorCode: 'invalid_capability',
      emptyProject: false,
    },
  ])('emits exactly one stdout envelope for $name', async ({
    argv,
    exitCode,
    errorCode,
    emptyProject,
  }) => {
    const invoke = () => run(argv, {}, home);
    expect(await (emptyProject ? inEmptyProject(invoke) : invoke())).toBe(exitCode);
    const envelope = expectSingleStdoutEnvelope();
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected failure');
    expect(envelope.error.code).toBe(errorCode);
  });

  it('normalizes representative hosted-read, authentication, usage, unknown, and service failures', async () => {
    expect(
      await run(
        ['apps', 'list', '--org', 'acme', '--service', 'https://service.invalid', '--json'],
        {},
        home,
      ),
    ).toBe(3);
    let envelope = expectSingleStdoutEnvelope();
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected auth failure');
    expect(envelope.error.code).toBe('auth_required');

    logSpy.mockClear();
    errorSpy.mockClear();
    expect(await run(['apps', '--json'], {}, home)).toBe(2);
    envelope = expectSingleStdoutEnvelope();
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected usage failure');
    expect(envelope.error.code).toBe('missing_subcommand');

    logSpy.mockClear();
    errorSpy.mockClear();
    expect(await run(['definitely-not-a-command', '--json'], {}, home)).toBe(2);
    envelope = expectSingleStdoutEnvelope();
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('expected unknown-command failure');
    expect(envelope.error.code).toBe('unknown_command');

    logSpy.mockClear();
    errorSpy.mockClear();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ error: 'service down' }, { status: 503 }));
    try {
      expect(
        await run(
          [
            'apps',
            'list',
            '--org',
            'acme',
            '--service',
            'https://service.invalid',
            '--auth-token',
            'test-token',
            '--json',
          ],
          {},
          home,
        ),
      ).toBe(1);
      envelope = expectSingleStdoutEnvelope();
      expect(envelope.ok).toBe(false);
      if (envelope.ok) throw new Error('expected service failure');
      expect(envelope.error).toMatchObject({
        code: 'service_error',
        retryable: true,
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('wraps representative hosted read and mutation successes under data', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input.toString());
      if (url.pathname === '/v1/orgs/acme/apps') {
        return Response.json({ ok: true, data: { apps: [], truncated: false } });
      }
      if (url.pathname === '/v1/orgs' && init?.method === 'POST') {
        return Response.json({ ok: true, org: { slug: 'acme' } });
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 });
    });
    try {
      expect(
        await run(
          [
            'apps',
            'list',
            '--org',
            'acme',
            '--service',
            'https://service.invalid',
            '--auth-token',
            'test-token',
            '--json',
          ],
          {},
          home,
        ),
      ).toBe(0);
      let envelope = expectSingleStdoutEnvelope();
      expect(envelope.ok).toBe(true);
      if (!envelope.ok) throw new Error('expected hosted-read success');
      expect(envelope.data).toEqual({ apps: [], truncated: false });

      logSpy.mockClear();
      errorSpy.mockClear();
      expect(
        await run(
          [
            'orgs',
            'create',
            'acme',
            '--service',
            'https://service.invalid',
            '--auth-token',
            'test-token',
            '--json',
          ],
          {},
          home,
        ),
      ).toBe(0);
      envelope = expectSingleStdoutEnvelope();
      expect(envelope.ok).toBe(true);
      if (!envelope.ok) throw new Error('expected hosted-mutation success');
      expect(envelope.data).toEqual({
        service: 'https://service.invalid',
        org: { slug: 'acme' },
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
