import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runConfigValues } from '../src/commands/config-values.js';
import { EXIT } from '../src/commands/output.js';
import { runTarget } from '../src/commands/session.js';
import { run } from '../src/index.js';
import { chdirIsolated, restoreCwd } from './helpers/isolated-cwd.js';

type Runner = (args: readonly string[], home: string) => Promise<number> | number;

interface ParserCase {
  readonly path: string;
  readonly run: Runner;
  readonly accepted: readonly string[];
  readonly acceptedExit: number;
  readonly rejected: readonly string[];
  readonly rejectedExit: number;
}

const scopeFlags = [
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
const revealFlags = [
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
] as const;

let home: string;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-config-catalog-parity-'));
  chdirIsolated(home);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  restoreCwd();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

const target: Runner = (args, location) => run(['target', ...args], {}, location);
const secret: Runner = (args, location) => runConfigValues('secret', args, {}, location);
const variable: Runner = (args, location) => runConfigValues('variable', args, {}, location);

const cases: readonly ParserCase[] = [
  {
    path: 'target show',
    run: target,
    accepted: ['show', '--json'],
    acceptedExit: EXIT.OK,
    rejected: ['show', '--json', '--json'],
    rejectedExit: EXIT.USAGE,
  },
  {
    path: 'target set',
    run: target,
    accepted: [
      'set',
      '--runtime',
      'local',
      '--org',
      'acme',
      '--app',
      'support',
      '--env',
      'prod',
      '--json',
    ],
    acceptedExit: EXIT.OK,
    rejected: ['set', '--json', '--json'],
    rejectedExit: EXIT.USAGE,
  },
  {
    path: 'secrets set',
    run: secret,
    accepted: ['set', 'TOKEN', ...scopeFlags, '--value', 'secret-value', '--json'],
    acceptedExit: EXIT.OK,
    rejected: ['set', ...scopeFlags, '--value', 'secret-value', '--json'],
    rejectedExit: EXIT.USAGE,
  },
  {
    path: 'secrets list',
    run: secret,
    accepted: ['list', ...scopeFlags, '--json'],
    acceptedExit: EXIT.OK,
    rejected: ['list', '--runtime', 'cloud', '--scope', 'env', '--json'],
    rejectedExit: EXIT.USAGE,
  },
  {
    path: 'secrets delete',
    run: secret,
    accepted: ['delete', 'TOKEN', ...scopeFlags, '--json'],
    acceptedExit: EXIT.OK,
    rejected: ['delete', ...scopeFlags, '--json'],
    rejectedExit: EXIT.USAGE,
  },
  {
    path: 'secrets resolve',
    run: secret,
    accepted: ['resolve', ...scopeFlags, '--json'],
    acceptedExit: EXIT.OK,
    rejected: ['resolve', '--runtime', 'cloud', '--scope', 'app', '--org', 'acme', '--json'],
    rejectedExit: EXIT.USAGE,
  },
  {
    path: 'secrets reveal',
    run: async (args, location) =>
      runConfigValues('secret', args, {}, location, { interactive: () => true }),
    accepted: ['reveal', 'TOKEN', ...revealFlags],
    acceptedExit: EXIT.FAILURE,
    rejected: ['reveal', 'TOKEN', '--runtime', 'cloud', '--scope', 'org', '--org', 'acme'],
    rejectedExit: EXIT.USAGE,
  },
  {
    path: 'variables set',
    run: variable,
    accepted: ['set', 'REGION', ...scopeFlags, '--value', 'us', '--json'],
    acceptedExit: EXIT.OK,
    rejected: ['set', ...scopeFlags, '--value', 'us', '--json'],
    rejectedExit: EXIT.USAGE,
  },
  {
    path: 'variables list',
    run: variable,
    accepted: ['list', ...scopeFlags, '--json'],
    acceptedExit: EXIT.OK,
    rejected: ['list', '--runtime', 'cloud', '--scope', 'org', '--json'],
    rejectedExit: EXIT.USAGE,
  },
  {
    path: 'variables delete',
    run: variable,
    accepted: ['delete', 'REGION', ...scopeFlags, '--json'],
    acceptedExit: EXIT.OK,
    rejected: ['delete', ...scopeFlags, '--json'],
    rejectedExit: EXIT.USAGE,
  },
  {
    path: 'variables resolve',
    run: variable,
    accepted: ['resolve', 'REGION', ...scopeFlags, '--json'],
    acceptedExit: EXIT.OK,
    rejected: ['resolve', '--runtime', 'cloud', '--scope', 'app', '--org', 'acme', '--json'],
    rejectedExit: EXIT.USAGE,
  },
];

describe('target and managed-config parser parity', () => {
  it.each(
    cases,
  )('$path accepts its runtime grammar and rejects its invalid form', async (entry) => {
    expect(await entry.run(entry.rejected, home), `${entry.path} rejected`).toBe(
      entry.rejectedExit,
    );
    log.mockClear();
    error.mockClear();
    expect(await entry.run(entry.accepted, home), `${entry.path} accepted`).toBe(
      entry.acceptedExit,
    );
  });

  it.each([
    'local',
    'cloud',
    'other',
  ] as const)('target set accepts the %s runtime choice', async (runtime) => {
    expect(await runTarget(['set', '--runtime', runtime, '--json'], home)).toBe(EXIT.OK);
  });

  it.each([
    ['org', ['--scope', 'org', '--org', 'acme']],
    ['app', ['--scope', 'app', '--org', 'acme', '--app', 'support']],
    ['env', ['--scope', 'env', '--org', 'acme', '--app', 'support', '--env', 'prod']],
    ['default env', ['--org', 'acme', '--app', 'support', '--env', 'prod']],
  ] as const)('managed config accepts the %s scope', async (_scope, flags) => {
    for (const kind of ['secret', 'variable'] as const) {
      expect(
        await runConfigValues(kind, ['list', '--runtime', 'local', ...flags, '--json'], {}, home),
      ).toBe(EXIT.OK);
    }
  });

  it.each([
    'local',
    'cloud',
    'other',
  ] as const)('managed config accepts the %s runtime choice before its established target/auth outcome', async (runtime) => {
    for (const kind of ['secret', 'variable'] as const) {
      const exit = await runConfigValues(
        kind,
        ['list', '--runtime', runtime, ...scopeFlags.slice(2), '--json'],
        {},
        home,
      );
      if (runtime === 'local') expect(exit).toBe(EXIT.OK);
      else expect(exit).not.toBe(EXIT.USAGE);
    }
  });

  it.each([
    ['value', ['--value', 'direct-value'], {}],
    ['environment', ['--from-env', 'CONFIG_VALUE'], { CONFIG_VALUE: 'environment-value' }],
    ['file', ['--from-file', 'config-value.txt'], {}],
    ['stdin', ['--from-stdin'], {}],
  ] as const)('sets each %s source for secrets and variables', async (source, sourceFlags, env) => {
    if (source === 'file') writeFileSync(join(home, 'config-value.txt'), 'file-value\n');
    if (source === 'stdin') {
      vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
        yield Buffer.from('stdin-value\n');
      });
    }
    for (const kind of ['secret', 'variable'] as const) {
      expect(
        await runConfigValues(
          kind,
          ['set', `${kind}_${source}`.toUpperCase(), ...scopeFlags, ...sourceFlags, '--json'],
          env,
          home,
        ),
      ).toBe(EXIT.OK);
    }
  });

  const sourcePairs = [
    ['value and from-env', ['--value', 'direct-value', '--from-env', 'CONFIG_VALUE']],
    ['value and from-file', ['--value', 'direct-value', '--from-file', 'config-value.txt']],
    ['value and from-stdin', ['--value', 'direct-value', '--from-stdin']],
    ['from-env and from-file', ['--from-env', 'CONFIG_VALUE', '--from-file', 'config-value.txt']],
    ['from-env and from-stdin', ['--from-env', 'CONFIG_VALUE', '--from-stdin']],
    ['from-file and from-stdin', ['--from-file', 'config-value.txt', '--from-stdin']],
  ] as const;

  it.each(sourcePairs)('secrets set rejects exactly %s', async (_pair, sourceFlags) => {
    expect(await secret(['set', 'TOKEN', ...scopeFlags, ...sourceFlags, '--json'], home)).toBe(
      EXIT.FAILURE,
    );
  });

  it.each(sourcePairs)('variables set rejects exactly %s', async (_pair, sourceFlags) => {
    expect(await variable(['set', 'REGION', ...scopeFlags, ...sourceFlags, '--json'], home)).toBe(
      EXIT.FAILURE,
    );
  });

  it.each([
    ['org', ['--scope', 'org', '--org', 'acme']],
    ['app', ['--scope', 'app', '--org', 'acme', '--app', 'support']],
  ] as const)('secret reveal rejects the %s scope on its own action path', async (_scope, scope) => {
    expect(
      await runConfigValues(
        'secret',
        ['reveal', 'TOKEN', '--runtime', 'cloud', ...scope],
        {},
        home,
        {
          interactive: () => true,
        },
      ),
    ).toBe(EXIT.USAGE);
  });
});
