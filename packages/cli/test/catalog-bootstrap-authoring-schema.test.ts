import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAgents } from '../src/agents.js';
import { runAuth } from '../src/commands/auth-ops.js';
import {
  parseAuthorSmokeArgs,
  runDev,
  runLocalTest,
  runSmoke,
  runValidate,
} from '../src/commands/author-loop.js';
import { CATALOG } from '../src/commands/catalog.js';
import { CATALOG_AUTH_DISCOVERY } from '../src/commands/catalog-data-auth-discovery.js';
import { CATALOG_BOOTSTRAP_AUTHORING } from '../src/commands/catalog-data-bootstrap-authoring.js';
import { CATALOG_BOOTSTRAP_PRE_AUTH } from '../src/commands/catalog-data-bootstrap-pre-auth.js';
import { CATALOG_LOCAL_AUTHORING } from '../src/commands/catalog-data-local-authoring.js';
import type { CommandSpec, FlagSpec, SubcommandSpec } from '../src/commands/catalog-types.js';
import { runConnect } from '../src/commands/connect.js';
import { parseDevtoolsArgs } from '../src/commands/devtools.js';
import { runCheck } from '../src/commands/mcp-apps.js';
import { EXIT } from '../src/commands/output.js';
import {
  runDocs,
  runExport,
  runImport,
  runInit,
  runLink,
  runSetup,
} from '../src/commands/project-setup.js';
import { isAccessMode } from '../src/commands/shared.js';
import { runUpdateCommand } from '../src/commands/update-ops.js';
import { runStart } from '../src/first-run.js';

const scratch = new Set<string>();
const HELLO = join(import.meta.dirname, 'fixtures', 'hello', 'server.ts');
const BOOTSTRAP_DISCOVERY = [
  ...CATALOG_BOOTSTRAP_PRE_AUTH,
  ...CATALOG_AUTH_DISCOVERY,
  ...CATALOG_BOOTSTRAP_AUTHORING,
];

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of scratch) rmSync(path, { recursive: true, force: true });
  scratch.clear();
});

function _nested(value: CommandSpec | SubcommandSpec): readonly SubcommandSpec[] {
  return value.subcommands ?? [];
}

function findFlag(command: string, name: string): FlagSpec | undefined {
  return BOOTSTRAP_DISCOVERY.find((entry) => entry.name === command)?.flags?.find(
    (flag) => flag.name === name,
  );
}

function command(name: string): CommandSpec {
  const result = CATALOG.find((entry) => entry.name === name);
  if (result === undefined) throw new Error(`Missing ${name} command`);
  return result;
}

function subcommand(value: CommandSpec | SubcommandSpec, name: string): SubcommandSpec {
  const result = value.subcommands?.find((entry) => entry.name === name);
  if (result === undefined) throw new Error(`Missing ${name} subcommand`);
  return result;
}

describe('typed bootstrap and authoring command catalog schema', () => {
  it('documents local mixed/customer access and rejects unsupported flags before boot', async () => {
    expect(command('dev').flags?.find((flag) => flag.name === 'access')).toMatchObject({
      constraints: { choices: ['mixed', 'customers'] },
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runDev(['--access', 'owner-only'], {})).toBe(2);
    expect(await runDev(['--access'], {})).toBe(2);
    expect(error.mock.calls.flat().join(' ')).toContain('mixed or customers');
  });

  it('keeps the bootstrap raw-data sources below the handwritten size threshold', () => {
    for (const file of [
      'catalog-data-bootstrap-authoring.ts',
      'catalog-data-auth-discovery.ts',
      'catalog-data-local-authoring.ts',
    ]) {
      const source = readFileSync(`packages/cli-catalog/src/${file}`, 'utf8');
      expect(source.split('\n').length).toBeLessThanOrEqual(500);
    }
  });

  it('keeps the split bootstrap and local-authoring commands in their curated aggregate order', () => {
    const expected = [...BOOTSTRAP_DISCOVERY, ...CATALOG_LOCAL_AUTHORING].map(
      (command) => command.name,
    );
    const actual = CATALOG.filter((command) => expected.includes(command.name)).map(
      (command) => command.name,
    );
    expect(actual).toEqual(expected);
  });

  it('marks credential-bearing inputs sensitive and exposes parser-backed choices', () => {
    expect(findFlag('doctor', 'auth-token')?.sensitive).toBe(true);
    expect(findFlag('start', 'template')?.constraints).toEqual({
      choices: ['saas', 'hello', 'http-api', 'widget'],
      default: 'saas',
    });
    expect(findFlag('start', 'access')?.constraints).toEqual({
      choices: ['owner-only', 'org-members', 'authenticated', 'customers'],
      default: 'owner-only',
    });
    expect(findFlag('init', 'template')?.constraints).toEqual({
      choices: ['saas', 'hello', 'http-api', 'widget'],
      default: 'saas',
    });
    expect(findFlag('link', 'save')?.constraints?.choices).toEqual(['local', 'project']);
  });

  it('advertises agents setup as the sole public setup surface while keeping its complete grammar', () => {
    const agents = command('agents');
    expect(agents.subcommands?.map((entry) => entry.name)).toEqual(['setup', 'doctor']);
    expect(subcommand(agents, 'setup').flags?.map((flag) => flag.name)).toEqual(
      expect.arrayContaining([
        'agents',
        'project',
        'write',
        'force',
        'refresh',
        'regenerate-app-skill',
        'replace-modified-app-skill',
        'json',
      ]),
    );
    expect(
      subcommand(agents, 'setup').flags?.find((flag) => flag.name === 'replace-modified-app-skill')
        ?.summary,
    ).toMatch(/requires --regenerate-app-skill/i);
  });

  it('publishes the complete service-principal lifecycle with sensitive auth and explicit safety flags', () => {
    const auth = command('auth');
    const servicePrincipals = subcommand(auth, 'service-principals');
    expect(servicePrincipals.subcommands?.map((entry) => entry.name)).toEqual([
      'create',
      'list',
      'show',
      'grant',
      'revoke-grant',
      'add-jwk',
      'create-secret',
      'revoke-credential',
      'revoke',
    ]);
    expect(subcommand(servicePrincipals, 'grant').flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'scope', repeatable: true }),
        expect.objectContaining({ name: 'org', required: true }),
        expect.objectContaining({ name: 'auth-token', sensitive: true }),
      ]),
    );
    expect(subcommand(servicePrincipals, 'add-jwk').flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'file', required: true }),
        expect.objectContaining({ name: 'label', required: true }),
      ]),
    );
    expect(subcommand(servicePrincipals, 'revoke').flags).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'yes', type: 'boolean' })]),
    );
  });

  it('keeps catalog parity tests independent from shipped showcases', () => {
    const source = readFileSync(
      'packages/cli/test/catalog-bootstrap-authoring-schema.test.ts',
      'utf8',
    );
    expect(source).not.toMatch(new RegExp(['ex', 'amples'].join('')));
    expect(source).toContain("'fixtures', 'hello', 'server.ts'");
  });

  it('models auth google actions as constrained JSON-capable leaves', () => {
    const google = subcommand(command('auth'), 'google');
    expect(google.arguments).toEqual([]);
    expect(google.subcommands?.map((entry) => entry.name)).toEqual([
      'prepare',
      'status',
      'doctor',
      'revoke',
    ]);
    const prepare = subcommand(google, 'prepare');
    expect(prepare.flags?.find((flag) => flag.name === 'project-number')).toMatchObject({
      required: true,
      constraints: { minLength: 6, maxLength: 32 },
    });
    expect(prepare.flags?.find((flag) => flag.name === 'pool')).toMatchObject({
      required: true,
      constraints: { minLength: 4, maxLength: 32 },
    });
    expect(prepare.jsonOutput).toEqual({ mode: 'single' });
    for (const action of google.subcommands ?? [])
      expect(action.jsonOutput).toEqual({ mode: 'single' });
  });

  it('makes generic remote MCP OAuth readiness the default auth doctor contract', () => {
    const doctor = subcommand(command('auth'), 'doctor');
    expect(doctor.flags?.map((flag) => flag.name)).not.toContain('target');
    expect(doctor.flags?.find((flag) => flag.name === 'version')).toMatchObject({
      type: 'string',
      value: '<version>',
      required: false,
    });
    expect(doctor.summary).toContain('remote MCP OAuth readiness');
  });

  it('keeps inherited JSON support and parser defaults explicit at scoped leaves', () => {
    expect(findFlag('setup', 'project')).toBeDefined();
    expect(subcommand(command('agents'), 'doctor').flags?.map((flag) => flag.name)).toEqual(
      expect.arrayContaining(['agents', 'project', 'json']),
    );
    expect(
      subcommand(command('docs'), 'export').flags?.find((flag) => flag.name === 'format'),
    ).toMatchObject({
      required: true,
      constraints: { choices: ['llms'] },
    });
    expect(
      subcommand(command('import'), 'openapi').flags?.find((flag) => flag.name === 'output'),
    ).toMatchObject({
      constraints: { default: 'noodle-openapi-app' },
    });
    expect(subcommand(command('tools'), 'call').jsonOutput).toEqual({ mode: 'single' });

    const plugin = subcommand(command('export'), 'plugin');
    expect(plugin.arguments).toEqual([]);
    expect(plugin.flags).toEqual([]);
    const openai = subcommand(plugin, 'openai');
    expect(openai.arguments).toEqual([
      expect.objectContaining({ name: 'server.ts', required: false }),
    ]);
    expect(openai.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'state', required: true }),
        expect.objectContaining({ name: 'mcp-url', required: true }),
        expect.objectContaining({ name: 'category', required: true }),
        expect.objectContaining({ name: 'registered-app-id', required: false }),
        expect.objectContaining({ name: 'output', required: true }),
        expect.objectContaining({ name: 'json', type: 'boolean' }),
      ]),
    );
    expect(openai.flags.some((flag) => flag.name === 'endpoint')).toBe(false);

    const claudePlugin = subcommand(plugin, 'claude');
    expect(claudePlugin.arguments).toEqual([
      expect.objectContaining({ name: 'server.ts', required: false }),
    ]);
    expect(claudePlugin.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'mcp-url', required: true }),
        expect.objectContaining({ name: 'output', required: true }),
        expect.objectContaining({ name: 'json', type: 'boolean' }),
      ]),
    );

    const connector = subcommand(command('export'), 'connector');
    const claudeConnector = subcommand(connector, 'claude');
    expect(claudeConnector.arguments).toEqual([
      expect.objectContaining({ name: 'server.ts', required: false }),
    ]);
    expect(claudeConnector.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'auth', required: true }),
        expect.objectContaining({ name: 'category', required: true, repeatable: true }),
        expect.objectContaining({ name: 'output', required: true }),
      ]),
    );
  });

  it('models every local smoke entrypoint in actual parser order', () => {
    expect(subcommand(command('tools'), 'list').arguments).toEqual([
      expect.objectContaining({ name: 'server.ts', required: false }),
    ]);
    expect(subcommand(command('tools'), 'call').arguments).toEqual([
      expect.objectContaining({ name: 'name', required: true }),
      expect.objectContaining({ name: 'server.ts', required: false }),
    ]);
    expect(subcommand(command('resources'), 'read').arguments).toEqual([
      expect.objectContaining({ name: 'uri', required: true }),
      expect.objectContaining({ name: 'server.ts', required: false }),
    ]);
    expect(subcommand(command('prompts'), 'get').arguments).toEqual([
      expect.objectContaining({ name: 'name', required: true }),
      expect.objectContaining({ name: 'server.ts', required: false }),
    ]);
  });

  it('renders typed nested arguments, flags, required facts, and defaults into CLI MDX', () => {
    const read = (name: string) =>
      readFileSync(`apps/docs/content/_generated/cli/${name}.mdx`, 'utf8');
    expect(read('tools')).toContain('`list [<server.ts>]`');
    expect(read('tools')).toContain('`call <name> [<server.ts>]`');
    expect(read('resources')).toContain('`read <uri> [<server.ts>]`');
    expect(read('prompts')).toContain('`get <name> [<server.ts>]`');
    expect(read('auth')).toContain('`google prepare`');
    expect(read('auth')).toContain('`--project-number <number>`');
    expect(read('docs')).toContain('`--format llms` — Documentation export format. (required)');
    expect(read('link')).toContain(
      '`--save local|project` — Configuration scope for the saved link. (default local)',
    );
    expect(read('agents')).not.toContain('context');
    expect(read('start')).toContain(
      '`--access owner-only|org-members|authenticated|customers` — Hosted MCP access policy. (default owner-only)',
    );
    expect(read('init')).toContain(
      '`--template saas|hello|http-api|widget` — Project template. (default saas)',
    );
    expect(read('export')).toContain('`plugin openai [<server.ts>]`');
    expect(read('export')).toContain(
      '`--state local|submission` — Local marketplace testing or public submission projection. (required)',
    );
  });

  it('keeps nested action grammars and material choice constraints aligned with runtime parsers', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const directory = mkdtempSync(join(tmpdir(), 'noodle-bootstrap-catalog-'));
    scratch.add(directory);

    expect(await runInit([directory, '--template', 'hello', '--dry-run', '--json'])).toBe(EXIT.OK);
    expect(await runInit(['--template', 'invalid', '--json'])).toBe(EXIT.USAGE);
    expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'invalid_template' },
    });

    log.mockClear();
    expect(await runConnect(['codex', '--json'])).toBe(EXIT.OK);
    expect(await runConnect(['unknown-client', '--json'])).toBe(EXIT.USAGE);
    expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'usage_error' },
    });

    log.mockClear();
    expect(
      await runAuth(
        [
          'google',
          'prepare',
          '--project-number',
          '123456',
          '--pool',
          'pool-id',
          '--provider',
          'provider-id',
          '--org',
          'acme',
          '--app',
          'catalog',
          '--env',
          'dev',
          '--json',
        ],
        {},
        directory,
      ),
    ).not.toBe(EXIT.USAGE);
    expect(
      await runAuth(
        [
          'google',
          'prepare',
          '--project-number',
          'x',
          '--pool',
          'pool-id',
          '--provider',
          'provider-id',
          '--json',
        ],
        {},
        directory,
      ),
    ).toBe(EXIT.USAGE);
    expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'invalid_google_setup' },
    });
    expect(error).not.toHaveBeenCalled();
  });

  it.each([
    'public',
    'mixed',
  ])('rejects start --access %s at the owning deploy validator', async (access) => {
    const directory = mkdtempSync(join(tmpdir(), 'noodle-start-access-'));
    const home = mkdtempSync(join(tmpdir(), 'noodle-start-access-home-'));
    scratch.add(directory);
    scratch.add(home);
    const cwd = process.cwd();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.chdir(directory);
    try {
      expect(
        await runStart(
          [
            '--json',
            '--deploy',
            '--name',
            `invalid-${access}`,
            '--org',
            'acme',
            '--service',
            'https://service.example.test',
            '--auth-token',
            'test-token',
            '--access',
            access,
          ],
          {},
          home,
        ),
      ).toBe(1);
    } finally {
      process.chdir(cwd);
    }
    expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
      ok: false,
      error: { message: `invalid --access value "${access}".` },
    });
  });

  it('accepts and rejects the remaining scoped command grammar through owning parsers and local runners', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const directory = mkdtempSync(join(tmpdir(), 'noodle-scoped-catalog-'));
    scratch.add(directory);
    const spec = join(directory, 'openapi.json');
    const imported = join(directory, 'imported');
    const docsOutput = join(directory, 'llms.txt');
    const manifestOutput = join(directory, 'manifest.json');
    const resourcePromptServer = join(directory, 'resource-prompt.ts');
    writeFileSync(
      spec,
      JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Parity', version: '1.0.0' },
        servers: [{ url: 'https://api.example.test' }],
        paths: { '/ping': { get: { responses: { 200: { description: 'ok' } } } } },
      }),
    );
    writeFileSync(
      resourcePromptServer,
      `
import { prompt, resource, server, tool, z } from '@noodleseed/one';
export default server('parity', { title: 'Parity', version: '1.0.0' }, [
  tool('noop', { description: 'Noop.', input: z.object({}), output: z.object({ ok: z.boolean() }), fulfil: () => ({ ok: true }) }),
  resource('guide', { uri: 'docs://guide', title: 'Guide', mimeType: 'text/plain', fulfil: () => 'guide' }),
  prompt('brief', { description: 'Brief.', arguments: z.object({ topic: z.string() }), fulfil: ({ input }) => \`Brief \${input.topic}\` }),
]);
`,
    );

    expect(isAccessMode('owner-only')).toBe(true);
    expect(isAccessMode('not-a-mode')).toBe(false);
    expect(parseDevtoolsArgs(['server.ts', '--theme', 'dark', '--device', 'mobile'])).toMatchObject(
      {
        theme: 'dark',
        device: 'mobile',
      },
    );
    expect(
      parseDevtoolsArgs(['server.ts', '--theme', 'invalid', '--device', 'invalid']),
    ).toMatchObject({
      theme: 'both',
      device: 'both',
    });
    expect(
      parseAuthorSmokeArgs([HELLO, '--target', 'chatgpt', '--min-severity', 'warn']),
    ).toMatchObject({
      path: HELLO,
      target: 'chatgpt',
      minSeverity: 'warn',
    });

    expect(await runSetup(['--project', directory, '--agents', 'codex'], {}, directory)).toBe(0);
    expect(await runSetup(['--agents', 'invalid', '--json'], {}, directory)).toBe(EXIT.USAGE);

    const cwd = process.cwd();
    process.chdir(directory);
    try {
      expect(runLink(['--org', 'acme', '--app', 'parity', '--access', 'owner-only'])).toBe(0);
      expect(runLink(['--org', 'acme', '--app', 'parity', '--access', 'invalid'])).toBe(EXIT.USAGE);
    } finally {
      process.chdir(cwd);
    }

    expect(runDocs(['export', '--format', 'llms', '--output', docsOutput])).toBe(0);
    expect(existsSync(docsOutput)).toBe(true);
    expect(runDocs(['export', '--format', 'invalid'])).toBe(EXIT.USAGE);

    expect(
      await runAgents(['setup', '--agents', 'codex', '--project', directory], {}, directory),
    ).toBe(0);
    expect(await runAgents(['unsupported', '--json'], {}, directory)).toBe(EXIT.USAGE);

    expect(
      await runImport([
        'openapi',
        spec,
        '--output',
        imported,
        '--name',
        'parity',
        '--base-url',
        'https://api.example.test',
      ]),
    ).toBe(0);
    expect(await runImport(['unsupported', spec])).toBe(EXIT.USAGE);

    expect(await runExport(['manifest', HELLO, '--output', manifestOutput])).toBe(0);
    expect(existsSync(manifestOutput)).toBe(true);
    expect(await runExport(['unsupported'])).toBe(EXIT.USAGE);

    expect(await runValidate([HELLO])).toBe(0);
    expect(await runValidate([join(directory, 'missing.ts')])).toBe(1);
    expect(await runCheck([HELLO, '--target', 'generic'])).toBe(0);
    expect(await runCheck([HELLO, '--target', 'invalid', '--json'])).toBe(EXIT.USAGE);

    expect(await runLocalTest([HELLO])).toBe(0);
    expect(await runLocalTest([join(directory, 'missing.ts')])).toBe(1);
    expect(await runSmoke('tools', ['list', HELLO])).toBe(0);
    expect(await runSmoke('tools', ['call', 'noop', resourcePromptServer])).toBe(0);
    expect(await runSmoke('tools', ['list', join(directory, 'missing.ts')])).toBe(EXIT.MCP);
    expect(await runSmoke('tools', ['call', 'noop', join(directory, 'missing.ts')])).toBe(EXIT.MCP);
    expect(await runSmoke('tools', ['unsupported', HELLO])).toBe(EXIT.USAGE);
    expect(await runSmoke('resources', ['read', 'docs://guide', resourcePromptServer])).toBe(0);
    expect(
      await runSmoke('resources', ['read', 'docs://guide', join(directory, 'missing.ts')]),
    ).toBe(EXIT.MCP);
    expect(await runSmoke('resources', ['unsupported', resourcePromptServer])).toBe(EXIT.USAGE);
    expect(
      await runSmoke('prompts', [
        'get',
        'brief',
        resourcePromptServer,
        '--args',
        '{"topic":"Noodle"}',
      ]),
    ).toBe(0);
    expect(
      await runSmoke('prompts', [
        'get',
        'brief',
        join(directory, 'missing.ts'),
        '--args',
        '{"topic":"Noodle"}',
      ]),
    ).toBe(EXIT.MCP);
    expect(await runSmoke('prompts', ['unsupported', resourcePromptServer])).toBe(EXIT.USAGE);

    const runningDev = runDev([HELLO], {}, directory);
    await vi.waitFor(() => {
      expect(log.mock.calls.flat().join('\n')).toContain('noodle dev --tunnel');
    });
    process.emit('SIGINT');
    expect(await runningDev).toBe(0);
    expect(await runDev(['--secrets', HELLO], {}, directory)).toBe(EXIT.USAGE);

    const updateDeps = {
      interactive: false,
      inspectImpl: () => ({
        expectedBinDir: '/tmp',
        binPath: '/tmp/noodle',
        status: { kind: 'none' },
      }),
      fetchImpl: (async () => new Response(JSON.stringify({ version: '0.0.1' }))) as typeof fetch,
      log: vi.fn(),
      logError: vi.fn(),
    };
    expect(await runUpdateCommand(['--check'], updateDeps)).toBe(0);
    expect(
      await runUpdateCommand(['--check'], {
        ...updateDeps,
        fetchImpl: (async () => {
          throw new Error('offline');
        }) as typeof fetch,
      }),
    ).toBe(14);
  });
});
