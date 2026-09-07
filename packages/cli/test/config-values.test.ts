import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATALOG_CONFIG } from '../src/commands/catalog-data-config.js';
import {
  configInputValue,
  renderConfigValuesTable,
  runConfigValues,
  secretInputOptions,
} from '../src/commands/config-values.js';
import { run, writeConfig } from '../src/index.js';
import { assertJsonEnvelope } from './helpers/json-envelope.js';

/**
 * `noodle secrets list` / `noodle variables list` branded-table output (founder-approved design,
 * 2026-07-06): NAME / SCOPE chip / UPDATED / BY, with `--json` byte-identical to the pre-table
 * shape (values masked for secrets, `updatedByEmail` never leaking into the legacy envelope).
 */

let cwd: string;
let dir: string;
let home: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let stderrWriteSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'noodle-config-values-'));
  process.chdir(dir);
  home = mkdtempSync(join(tmpdir(), 'noodle-config-values-home-'));
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  stderrWriteSpy.mockRestore();
  vi.unstubAllGlobals();
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function stdout(): string {
  return logSpy.mock.calls.map((call) => String(call[0])).join('\n');
}

function rawStderr(): string {
  return stderrWriteSpy.mock.calls.map((call) => String(call[0])).join('');
}

async function seedLocalEnvSecret(): Promise<void> {
  expect(
    await run(
      ['target', 'set', '--runtime', 'local', '--org', 'acme', '--app', 'support', '--env', 'prod'],
      {},
      home,
    ),
  ).toBe(0);
  mkdirSync(join(dir, '.noodle'), { recursive: true });
  writeFileSync(
    join(dir, '.noodle', 'project.json'),
    `${JSON.stringify(
      {
        entrypoint: 'src/server.ts',
        org: 'acme',
        app: 'support',
        env: 'prod',
        serviceUrl: 'https://borg.noodleseed.com',
        accessMode: 'customers',
      },
      null,
      2,
    )}\n`,
  );
  expect(
    await run(['secrets', 'set', 'TOKEN', '--scope', 'env', '--value', 'shh-token'], {}, home),
  ).toBe(0);
  logSpy.mockClear();
}

// #701: a command naming a complete hosted target but omitting `--runtime` fell through to the
// implicit `local` default, wrote `.env.noodle`, and printed success. The agent read that as hosted
// configuration and moved on; the deployment stayed unconfigured and the secret was never stored
// where anything would read it. A fully-qualified target must never resolve implicitly.
describe.each(['secrets', 'variables'] as const)('noodle %s set target resolution', (kind) => {
  const hostedTarget = ['--scope', 'env', '--org', 'acme', '--app', 'driveiq', '--env', 'prod'];

  it('refuses a complete hosted target with no --runtime, and writes nothing', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(
      await run([kind, 'set', 'ASSISTANT_MODEL', ...hostedTarget, '--value', 'sonnet'], {}, home),
    ).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(join(dir, '.env.noodle'))).toBe(false);
    const printed = errSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).toContain('--runtime cloud');
    expect(printed).toContain('--runtime local');
  });

  it('reports the ambiguity as a machine-readable failure under --json', async () => {
    expect(
      await run(
        [kind, 'set', 'ASSISTANT_MODEL', ...hostedTarget, '--value', 'sonnet', '--json'],
        {},
        home,
      ),
    ).toBe(2);
    expect(JSON.parse(stdout()).error.code).toBe('runtime_required');
    expect(rawStderr()).toBe('');
  });

  it('accepts the same target once the runtime is explicit', async () => {
    expect(
      await run(
        [
          kind,
          'set',
          'ASSISTANT_MODEL',
          ...hostedTarget,
          '--value',
          'sonnet',
          '--runtime',
          'local',
        ],
        {},
        home,
      ),
    ).toBe(0);
    expect(readFileSync(join(dir, '.env.noodle'), 'utf8')).toContain(
      'org/acme/app/driveiq/env/prod',
    );
  });

  it('leaves an unqualified local command alone', async () => {
    expect(
      await run(
        [
          'target',
          'set',
          '--runtime',
          'local',
          '--org',
          'acme',
          '--app',
          'support',
          '--env',
          'prod',
        ],
        {},
        home,
      ),
    ).toBe(0);
    expect(await run([kind, 'set', 'REGION', '--scope', 'env', '--value', 'us'], {}, home)).toBe(0);
    expect(readFileSync(join(dir, '.env.noodle'), 'utf8')).toContain('REGION=us');
  });
});

describe('noodle secrets set output modes', () => {
  const targetFlags = [
    '--scope',
    'env',
    '--org',
    'acme',
    '--app',
    'support',
    '--env',
    'prod',
  ] as const;

  it('writes one local JSON envelope with empty raw stderr for --value', async () => {
    expect(
      await run(
        [
          'secrets',
          'set',
          'TOKEN',
          '--runtime',
          'local',
          ...targetFlags,
          '--value',
          'local-secret',
          '--json',
        ],
        {},
        home,
      ),
    ).toBe(0);

    expect(rawStderr()).toBe('');
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(assertJsonEnvelope(JSON.parse(stdout()))).toEqual({
      ok: true,
      data: {
        runtime: 'local',
        scope: { level: 'env', org: 'acme', app: 'support', env: 'prod' },
        name: 'TOKEN',
      },
    });
  });

  it('writes one hosted JSON envelope with empty raw stderr for --value', async () => {
    writeConfig({ serviceUrl: 'https://svc.example', authToken: 'cloud-token' }, home);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true })),
    );

    expect(
      await run(
        [
          'secrets',
          'set',
          'TOKEN',
          '--runtime',
          'cloud',
          ...targetFlags,
          '--value',
          'hosted-secret',
          '--json',
        ],
        {},
        home,
      ),
    ).toBe(0);

    expect(rawStderr()).toBe('');
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(assertJsonEnvelope(JSON.parse(stdout()))).toEqual({
      ok: true,
      data: {
        runtime: 'cloud',
        service: 'https://svc.example',
        scope: { level: 'env', org: 'acme', app: 'support', env: 'prod' },
        name: 'TOKEN',
      },
    });
  });

  it('retains the shell-history warning for human --value writes', async () => {
    expect(
      await run(
        [
          'secrets',
          'set',
          'TOKEN',
          '--runtime',
          'local',
          ...targetFlags,
          '--value',
          'human-secret',
        ],
        {},
        home,
      ),
    ).toBe(0);

    expect(rawStderr()).toContain(
      'warning: passing a secret with --value exposes it in shell history',
    );
    expect(stdout()).toContain('set TOKEN');
  });

  it.each([
    ['direct value', ['--value', 'first-line\nsecond-line'], {}],
    [
      'environment value',
      ['--from-env', 'MULTILINE_SECRET'],
      { MULTILINE_SECRET: 'first\rsecond' },
    ],
  ] as const)('rejects a multiline local %s without creating .env.noodle', async (_label, source, env) => {
    expect(
      await run(
        ['secrets', 'set', 'TOKEN', '--runtime', 'local', ...targetFlags, ...source],
        env,
        home,
      ),
    ).toBe(1);
    expect(existsSync(join(dir, '.env.noodle'))).toBe(false);
    expect(errSpy.mock.calls.flat().join('\n')).toContain(
      'local managed values must be a single line',
    );
  });

  it('rejects the reported documentation-style secret file before creating .env.noodle', async () => {
    const path = join(dir, 'documentation-style-secret.txt');
    writeFileSync(path, 'heading\nCONFIDENTIAL_CONTINUATION_MARKER\n');

    expect(
      await run(
        ['secrets', 'set', 'TOKEN', '--runtime', 'local', ...targetFlags, '--from-file', path],
        {},
        home,
      ),
    ).toBe(1);
    expect(existsSync(join(dir, '.env.noodle'))).toBe(false);
    const rendered = [stdout(), errSpy.mock.calls.flat().join('\n'), rawStderr()].join('\n');
    expect(rendered).toContain('local managed values must be a single line');
    expect(rendered).not.toContain('CONFIDENTIAL_CONTINUATION_MARKER');
  });

  it('preserves a hosted multiline string because cloud storage is not line-oriented', async () => {
    writeConfig({ serviceUrl: 'https://svc.example', authToken: 'cloud-token' }, home);
    const fetchSpy = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchSpy);
    const value = '-----BEGIN TEST DATA-----\nline-two\n-----END TEST DATA-----';

    expect(
      await run(
        [
          'secrets',
          'set',
          'TOKEN',
          '--runtime',
          'cloud',
          ...targetFlags,
          '--from-env',
          'MULTILINE_SECRET',
          '--json',
        ],
        { MULTILINE_SECRET: value },
        home,
      ),
    ).toBe(0);
    const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({ value });
  });
});

describe('noodle secrets list (local)', () => {
  const explicitTarget = [
    '--runtime',
    'local',
    '--scope',
    'env',
    '--org',
    'acme',
    '--app',
    'support',
    '--env',
    'prod',
  ] as const;

  it('uses the linked project target before the saved CLI target', async () => {
    mkdirSync(join(dir, '.noodle'));
    writeFileSync(
      join(dir, '.noodle', 'project.json'),
      JSON.stringify({
        entrypoint: 'src/server.ts',
        org: 'linked-org',
        app: 'linked-app',
        env: 'dev',
        serviceUrl: 'https://cloud.noodleseed.dev',
        accessMode: 'customers',
      }),
    );
    writeConfig(
      {
        defaultRuntime: 'cloud',
        defaultOrg: 'saved-org',
        defaultApp: 'saved-app',
        defaultEnv: 'prod',
      },
      home,
    );

    expect(
      await run(
        ['secrets', 'set', 'TOKEN', '--runtime', 'local', '--value', 'shh-token', '--json'],
        {},
        home,
      ),
    ).toBe(0);
    expect(JSON.parse(stdout())).toEqual({
      ok: true,
      data: {
        runtime: 'local',
        scope: { level: 'env', org: 'linked-org', app: 'linked-app', env: 'dev' },
        name: 'TOKEN',
      },
    });
  });

  it('uses the unlinked project target instead of hosted global defaults for local variables', async () => {
    writeFileSync(join(dir, 'noodle.json'), JSON.stringify({ name: 'customer-auth-demo' }));
    writeConfig(
      {
        defaultRuntime: 'cloud',
        defaultOrg: 'hosted-org',
        defaultApp: 'other-app',
        defaultEnv: 'prod',
      },
      home,
    );
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(
      await run(
        [
          'variables',
          'set',
          'ASSISTANT_MODEL',
          '--runtime',
          'local',
          '--value',
          'local-model',
          '--json',
        ],
        {},
        home,
      ),
    ).toBe(0);

    expect(JSON.parse(stdout())).toMatchObject({
      ok: true,
      data: {
        runtime: 'local',
        scope: { level: 'env', org: 'local', app: 'customer-auth-demo', env: 'dev' },
        name: 'ASSISTANT_MODEL',
      },
    });
    expect(readFileSync(join(dir, '.env.noodle'), 'utf8')).toContain(
      'var org/local/app/customer-auth-demo/env/dev ASSISTANT_MODEL=local-model',
    );
    expect(readFileSync(join(dir, '.env.noodle'), 'utf8')).not.toMatch(
      /hosted-org|other-app|prod/u,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves and writes local config at the containing project root from src', async () => {
    const src = join(dir, 'src');
    mkdirSync(src);
    mkdirSync(join(dir, '.noodle'));
    writeFileSync(
      join(dir, '.noodle', 'project.json'),
      JSON.stringify({
        entrypoint: 'src/server.ts',
        org: 'linked-org',
        app: 'linked-app',
        env: 'dev',
        serviceUrl: 'https://cloud.noodleseed.dev',
        accessMode: 'customers',
      }),
    );

    process.chdir(src);
    try {
      expect(
        await run(
          ['secrets', 'set', 'TOKEN', '--runtime', 'local', '--value', 'root-value', '--json'],
          {},
          home,
        ),
      ).toBe(0);
    } finally {
      process.chdir(dir);
    }

    expect(JSON.parse(stdout())).toEqual({
      ok: true,
      data: {
        runtime: 'local',
        scope: { level: 'env', org: 'linked-org', app: 'linked-app', env: 'dev' },
        name: 'TOKEN',
      },
    });
    expect(readFileSync(join(dir, '.env.noodle'), 'utf8')).toContain(
      'secret org/linked-org/app/linked-app/env/dev TOKEN=root-value',
    );
    expect(existsSync(join(src, '.env.noodle'))).toBe(false);
  });

  it('uses the linked app and environment when resolving from an org scope', async () => {
    mkdirSync(join(dir, '.noodle'));
    writeFileSync(
      join(dir, '.noodle', 'project.json'),
      JSON.stringify({
        entrypoint: 'src/server.ts',
        org: 'linked-org',
        app: 'linked-app',
        env: 'dev',
        serviceUrl: 'https://cloud.noodleseed.dev',
        accessMode: 'customers',
      }),
    );
    writeConfig(
      {
        defaultRuntime: 'local',
        defaultOrg: 'saved-org',
        defaultApp: 'saved-app',
        defaultEnv: 'prod',
      },
      home,
    );
    expect(
      await run(
        ['secrets', 'set', 'TOKEN', '--runtime', 'local', '--value', 'linked-value', '--json'],
        {},
        home,
      ),
    ).toBe(0);
    logSpy.mockClear();

    expect(
      await run(
        [
          'secrets',
          'resolve',
          'TOKEN',
          '--runtime',
          'local',
          '--scope',
          'org',
          '--org',
          'linked-org',
          '--json',
        ],
        {},
        home,
      ),
    ).toBe(0);
    expect(JSON.parse(stdout())).toMatchObject({
      ok: true,
      data: { values: { TOKEN: '********' } },
    });
  });

  it('prints a friendly empty line at an unset scope (not a silent no-op)', async () => {
    expect(
      await run(
        [
          'target',
          'set',
          '--runtime',
          'local',
          '--org',
          'acme',
          '--app',
          'support',
          '--env',
          'prod',
        ],
        {},
        home,
      ),
    ).toBe(0);
    logSpy.mockClear();
    expect(await run(['secrets', 'list', '--scope', 'env'], {}, home)).toBe(0);
    expect(stdout()).toContain('No secrets set at this scope.');
  });

  it('renders the branded table with the scope chip and never prints the value', async () => {
    await seedLocalEnvSecret();
    expect(await run(['secrets', 'list', '--scope', 'env'], {}, home)).toBe(0);
    const out = stdout();
    expect(out).toContain('runtime: local'); // target block stays above the table
    for (const header of ['NAME', 'SCOPE', 'UPDATED']) expect(out).toContain(header);
    expect(out).toContain('TOKEN');
    expect(out).toContain('env');
    expect(out).not.toContain('BY'); // local records carry no updater
    expect(out).not.toContain('shh-token');
  });

  it('keeps the local --json list shape byte-identical', async () => {
    await seedLocalEnvSecret();
    expect(await run(['secrets', 'list', '--scope', 'env', '--json'], {}, home)).toBe(0);
    expect(JSON.parse(stdout())).toEqual({
      ok: true,
      data: {
        runtime: 'local',
        scope: { level: 'env', org: 'acme', app: 'support', env: 'prod' },
        // Local secret records surface name-only through the pre-table JSON shape (no value key).
        values: [{ name: 'TOKEN' }],
      },
    });
  });

  it.each([
    ['human output', []],
    ['agent output', ['--agent-output']],
  ] as const)('redacts malformed managed-file contents from %s', async (_label, outputFlags) => {
    const disclosureMarker = 'CONFIDENTIAL_CONTINUATION_MARKER';
    writeFileSync(
      join(dir, '.env.noodle'),
      `secret org/acme/app/support/env/prod TOKEN=first-line\n${disclosureMarker}\n`,
      { mode: 0o600 },
    );

    expect(await run(['secrets', 'list', ...explicitTarget, ...outputFlags], {}, home)).toBe(1);
    const rendered = [stdout(), errSpy.mock.calls.flat().join('\n'), rawStderr()].join('\n');
    expect(rendered).toContain('invalid .env.noodle syntax at line 2');
    expect(rendered).not.toContain(disclosureMarker);
  });

  it('redacts malformed managed-file contents from JSON errors', async () => {
    const disclosureMarker = 'CONFIDENTIAL_CONTINUATION_MARKER';
    writeFileSync(
      join(dir, '.env.noodle'),
      `secret org/acme/app/support/env/prod TOKEN=first-line\n${disclosureMarker}\n`,
      { mode: 0o600 },
    );

    expect(await run(['secrets', 'list', ...explicitTarget, '--json'], {}, home)).toBe(1);
    const rendered = stdout();
    expect(JSON.parse(rendered).error).toMatchObject({
      message: expect.stringContaining('invalid .env.noodle syntax at line 2'),
      cause: expect.stringContaining('invalid .env.noodle syntax at line 2'),
    });
    expect(rendered).not.toContain(disclosureMarker);
    expect(rawStderr()).toBe('');
  });
});

describe('noodle variables list (cloud)', () => {
  const updatedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const cloudFlags = [
    '--runtime',
    'cloud',
    '--scope',
    'env',
    '--org',
    'acme',
    '--app',
    'support',
    '--env',
    'prod',
  ];

  function stubCloudList(): void {
    writeConfig({ serviceUrl: 'https://svc.example', authToken: 'cloud-token' }, home);
    vi.stubGlobal('fetch', (async () =>
      Response.json({
        ok: true,
        values: [{ name: 'REGION', value: 'us', updatedAt, updatedByEmail: 'ops@acme.com' }],
      })) as typeof fetch);
  }

  it('renders UPDATED relative time and the BY column when the service reports an updater', async () => {
    stubCloudList();
    expect(await run(['variables', 'list', ...cloudFlags], {}, home)).toBe(0);
    const out = stdout();
    for (const header of ['NAME', 'SCOPE', 'UPDATED', 'BY']) expect(out).toContain(header);
    expect(out).toContain('REGION');
    expect(out).toContain('2h ago');
    expect(out).toContain('ops@acme.com');
  });

  it('keeps the hosted --json list shape byte-identical (updatedByEmail stays out)', async () => {
    stubCloudList();
    expect(await run(['variables', 'list', ...cloudFlags, '--json'], {}, home)).toBe(0);
    expect(JSON.parse(stdout())).toEqual({
      ok: true,
      data: {
        runtime: 'cloud',
        service: 'https://svc.example',
        scope: { level: 'env', org: 'acme', app: 'support', env: 'prod' },
        values: [{ name: 'REGION', value: 'us', updatedAt }],
      },
    });
  });
});

describe('configInputValue secret ergonomics', () => {
  it('warns (but still returns the value) when a secret is passed via --value', async () => {
    const warnings: string[] = [];
    const value = await configInputValue(
      { value: 'sekret' },
      {},
      { isSecret: true, warn: (m) => warnings.push(m) },
    );
    expect(value).toBe('sekret');
    expect(warnings.some((w) => w.includes('--value') && w.includes('shell history'))).toBe(true);
  });

  it('does not warn for a non-secret variable passed via --value', async () => {
    const warnings: string[] = [];
    const value = await configInputValue(
      { value: 'plain' },
      {},
      { isSecret: false, warn: (m) => warnings.push(m) },
    );
    expect(value).toBe('plain');
    expect(warnings).toHaveLength(0);
  });

  it('reads from the interactive prompt when no source flag is given', async () => {
    const value = await configInputValue({}, {}, { promptValue: async () => 'typed-secret' });
    expect(value).toBe('typed-secret');
  });

  it('still requires exactly one source when headless (no prompt available)', async () => {
    await expect(configInputValue({}, {})).rejects.toThrow('exactly one value source is required');
  });

  it('resolves --from-env without prompting or warning', async () => {
    const warnings: string[] = [];
    const value = await configInputValue(
      { fromEnv: 'MY_SECRET' },
      { MY_SECRET: 'from-env-value' },
      { isSecret: true, warn: (m) => warnings.push(m) },
    );
    expect(value).toBe('from-env-value');
    expect(warnings).toHaveLength(0);
  });

  it('rejects a directory passed to --from-file with a stable error', async () => {
    await expect(configInputValue({ fromFile: dir }, {})).rejects.toThrow(
      '--from-file must reference a regular file',
    );
  });

  it('accepts a regular scalar file and removes one trailing newline', async () => {
    const path = join(dir, 'secret.txt');
    writeFileSync(path, 'scalar-value\n');

    await expect(configInputValue({ fromFile: path }, {})).resolves.toBe('scalar-value');
  });
});

describe('secretInputOptions', () => {
  it('marks secrets and omits a prompt when non-interactive (headless-safe)', () => {
    // vitest stdin/stdout are not TTYs, so isInteractive() is false → no interactive prompt is offered.
    const opts = secretInputOptions('secret', 'API_TOKEN');
    expect(opts.isSecret).toBe(true);
    expect(opts.promptValue).toBeUndefined();
  });

  it('marks variables as non-secret', () => {
    expect(secretInputOptions('variable', 'BASE_URL').isSecret).toBe(false);
  });
});

describe('renderConfigValuesTable', () => {
  it('chips the env scope amber and dims UPDATED/BY under truecolor', () => {
    const colored = renderConfigValuesTable(
      [
        {
          name: 'TOKEN',
          scope: 'env',
          updatedAt: new Date().toISOString(),
          updatedBy: 'ops@acme.com',
        },
      ],
      { color: 'truecolor', glyph: 'unicode' },
    );
    expect(colored).toContain('38;2;245;158;11'); // env chip → amber
    expect(colored).toContain('38;2;115;115;115'); // updated/by → dim
  });

  it('omits the BY column when no row carries an updater', () => {
    const plain = renderConfigValuesTable([{ name: 'A', scope: 'org' }], {
      color: 'none',
      glyph: 'unicode',
    });
    expect(plain).toContain('NAME');
    expect(plain).toContain('org');
    expect(plain).not.toContain('BY');
    expect(plain).not.toContain(String.fromCharCode(27));
  });
});

describe('noodle secrets reveal', () => {
  const revealArgs = [
    'reveal',
    'TOP_SECRET',
    '--runtime',
    'cloud',
    '--org',
    'acme space',
    '--app',
    'support/app',
    '--env',
    'prod west',
  ];
  const safeUrl =
    'https://console.example.test/console/apps/acme%20space/support%2Fapp?env=prod%20west&tab=configuration&kind=secrets';

  function configuredCloud(): void {
    writeConfig(
      {
        defaultRuntime: 'cloud',
        serviceUrl: 'https://svc.example.test',
        authToken: 'control-plane-token',
      },
      home,
    );
  }

  function discoveryFetch(): ReturnType<typeof vi.fn> {
    return vi.fn(async (input: RequestInfo | URL) => {
      expect(input.toString()).toBe('https://svc.example.test/v1/auth');
      return Response.json({
        ok: true,
        service: 'https://svc.example.test',
        authType: 'open-dev',
        consoleUrl: 'https://console.example.test/console/',
      });
    });
  }

  it('advertises reveal as the canonical secret handoff subcommand', () => {
    const secrets = CATALOG_CONFIG.find((command) => command.name === 'secrets');
    expect(secrets?.summary).toContain('set/list/delete/reveal/resolve');
    expect(secrets?.subcommands?.find((command) => command.name === 'reveal')).toMatchObject({
      arguments: [expect.objectContaining({ name: 'name', required: true })],
    });
  });

  it('opens the encoded Console Configuration URL without sending or printing the secret name', async () => {
    configuredCloud();
    const fetchImpl = discoveryFetch();
    vi.stubGlobal('fetch', fetchImpl);
    const openBrowser = vi.fn(async () => {});

    expect(
      await runConfigValues('secret', revealArgs, {}, home, {
        interactive: () => true,
        openBrowser,
      }),
    ).toBe(0);

    expect(openBrowser).toHaveBeenCalledWith(safeUrl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls.flat().join('\n')).not.toContain('TOP_SECRET');
    expect(stdout()).toBe(safeUrl);
    expect(stdout()).not.toContain('TOP_SECRET');
    expect(errSpy.mock.calls.flat().join('\n')).not.toContain('TOP_SECRET');
  });

  it.each([
    {
      name: 'local runtime',
      args: ['reveal', 'TOP_SECRET', '--runtime', 'local', '--org', 'acme', '--app', 'support'],
      options: { interactive: () => true },
    },
    {
      name: 'noninteractive stdin',
      args: [...revealArgs],
      options: { interactive: () => false },
    },
    {
      name: 'JSON output',
      args: [...revealArgs, '--json'],
      options: { interactive: () => true },
    },
    {
      name: 'agent output',
      args: [...revealArgs, '--agent-output'],
      options: { interactive: () => true },
    },
    {
      name: 'agent recovery output',
      args: [...revealArgs, '--fix-prompt'],
      options: { interactive: () => true },
    },
    {
      name: 'a non-environment scope',
      args: ['reveal', 'TOP_SECRET', '--runtime', 'cloud', '--scope', 'org', '--org', 'acme'],
      options: { interactive: () => true },
    },
  ])('refuses $name without a request, browser launch, or secret name output', async ({
    args,
    options,
  }) => {
    configuredCloud();
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const openBrowser = vi.fn(async () => {});

    expect(await runConfigValues('secret', args, {}, home, { ...options, openBrowser })).toBe(2);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
    expect(`${stdout()}\n${errSpy.mock.calls.flat().join('\n')}`).not.toContain('TOP_SECRET');
  });

  it('rejects an invalid name without a request, browser launch, or secret name output', async () => {
    configuredCloud();
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const openBrowser = vi.fn(async () => {});
    const secretName = 'TOP SECRET';

    expect(
      await runConfigValues(
        'secret',
        ['reveal', secretName, '--runtime', 'cloud', '--org', 'acme', '--app', 'support'],
        {},
        home,
        { interactive: () => true, openBrowser },
      ),
    ).toBe(2);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
    expect(`${stdout()}\n${errSpy.mock.calls.flat().join('\n')}`).not.toContain(secretName);
  });

  it('leaves the same safe URL as the only stdout recovery value when browser launch fails', async () => {
    configuredCloud();
    vi.stubGlobal('fetch', discoveryFetch());

    expect(
      await runConfigValues('secret', revealArgs, {}, home, {
        interactive: () => true,
        openBrowser: async () => {
          throw new Error('browser unavailable');
        },
      }),
    ).toBe(0);

    expect(stdout()).toBe(safeUrl);
    expect(errSpy.mock.calls.flat().join('\n')).not.toContain('TOP_SECRET');
  });
});
