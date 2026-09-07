import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATALOG, type CommandSpec, type FlagSpec } from '../src/commands/catalog.js';
import { run } from '../src/index.js';
import { assertJsonEnvelope } from './helpers/json-envelope.js';

interface MachineFailureCase {
  readonly id: string;
  readonly argv: readonly string[];
  readonly expectedCode: 'missing_option_value' | 'duplicate_option' | 'usage';
  readonly strategy: 'missing-value' | 'duplicate-json';
  readonly flagType?: FlagSpec['type'];
}

function declaresJson(flags: readonly FlagSpec[] | undefined, usage?: string): boolean {
  return flags?.some((flag) => flag.name === 'json') === true || usage?.includes('--json') === true;
}

function valueTakingFlags(...groups: Array<readonly FlagSpec[] | undefined>): readonly FlagSpec[] {
  const byName = new Map<string, FlagSpec>();
  for (const flag of groups.flatMap((group) => group ?? [])) {
    if (flag.type !== 'boolean') byName.set(flag.name, flag);
  }
  return [...byName.values()];
}

function failureCase(
  entry: CommandSpec,
  subcommand?: NonNullable<CommandSpec['subcommands']>[number],
): MachineFailureCase {
  const path = [entry.name, ...(subcommand === undefined ? [] : [subcommand.name])];
  const valueFlag = valueTakingFlags(entry.flags, subcommand?.flags)[0];
  if (valueFlag !== undefined) {
    return {
      id: path.join(' '),
      argv: [...path, `--${valueFlag.name}`, '--json'],
      // Billing's catalog intentionally holds a flag superset for nested actions. Its action parser
      // owns this validation and preserves the established canonical `usage` error code.
      expectedCode: entry.name === 'billing' ? 'usage' : 'missing_option_value',
      strategy: 'missing-value',
      flagType: valueFlag.type,
    };
  }
  // A few machine-capable surfaces expose only boolean/positional inputs. A repeated --json is their
  // earliest deterministic, side-effect-free usage failure; keeping this fallback in the generated
  // test data makes that narrow exception visible instead of silently dropping those catalog entries.
  return {
    id: path.join(' '),
    argv: [...path, '--json', '--json'],
    expectedCode: 'duplicate_option',
    strategy: 'duplicate-json',
  };
}

function numericFailureCase(
  commandName: string,
  flagName: string,
  subcommandName?: string,
): MachineFailureCase {
  const entry = CATALOG.find((candidate) => candidate.name === commandName);
  if (entry === undefined || entry.removed !== undefined) {
    throw new Error(`missing active command ${commandName}`);
  }
  const subcommand = entry.subcommands?.find((candidate) => candidate.name === subcommandName);
  const flag = [...entry.flags, ...(subcommand?.flags ?? [])].find(
    (candidate) => candidate.name === flagName,
  );
  if (flag === undefined || (flag.type !== 'integer' && flag.type !== 'number')) {
    throw new Error(`missing numeric flag ${commandName} --${flagName}`);
  }
  const path = [commandName, ...(subcommandName === undefined ? [] : [subcommandName])];
  return {
    id: `${path.join(' ')} --${flagName}`,
    argv: [...path, `--${flagName}`, '--json'],
    expectedCode: 'missing_option_value',
    strategy: 'missing-value',
    flagType: flag.type,
  };
}

function machineFailureCases(): readonly MachineFailureCase[] {
  return CATALOG.flatMap((entry) => {
    if (entry.removed !== undefined) return [];
    const parentJson = declaresJson(entry.flags, entry.usage);
    if (entry.subcommands === undefined) return parentJson ? [failureCase(entry)] : [];
    return entry.subcommands.flatMap((subcommand) =>
      parentJson || declaresJson(subcommand.flags, subcommand.usage)
        ? [failureCase(entry, subcommand)]
        : [],
    );
  });
}

const catalogCases = [
  ...machineFailureCases(),
  numericFailureCase('alerts', 'window', 'add'),
  numericFailureCase('logs', 'interval'),
] as const;

let cwd: string;
let home: string;
let project: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let stderrWriteSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  cwd = process.cwd();
  home = mkdtempSync(join(tmpdir(), 'noodle-json-matrix-home-'));
  project = mkdtempSync(join(tmpdir(), 'noodle-json-matrix-project-'));
  process.chdir(project);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockRejectedValue(new Error('JSON failure matrix forbids network access')),
  );
});

afterEach(() => {
  process.chdir(cwd);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function expectOnlyFailureEnvelope(expectedCode: string): void {
  expect(logSpy).toHaveBeenCalledOnce();
  expect(errorSpy).not.toHaveBeenCalled();
  expect(warnSpy).not.toHaveBeenCalled();
  expect(stderrWriteSpy).not.toHaveBeenCalled();
  const envelope = assertJsonEnvelope(JSON.parse(String(logSpy.mock.calls[0]?.[0])));
  expect(envelope.ok).toBe(false);
  if (envelope.ok) throw new Error('expected failure envelope');
  expect(envelope.error.code).toBe(expectedCode);
}

describe('catalog-complete JSON failure envelope matrix', () => {
  it('derives one unique deterministic failure case for every active JSON-capable catalog surface', () => {
    expect(catalogCases.length).toBeGreaterThan(0);
    expect(new Set(catalogCases.map((entry) => entry.id)).size).toBe(catalogCases.length);
    expect(catalogCases.some((entry) => entry.strategy === 'missing-value')).toBe(true);
    expect(catalogCases.some((entry) => entry.strategy === 'duplicate-json')).toBe(true);
    expect(catalogCases.some((entry) => entry.flagType === 'string')).toBe(true);
    expect(catalogCases.some((entry) => entry.flagType === 'integer')).toBe(true);
    expect(catalogCases.some((entry) => entry.flagType === 'number')).toBe(true);
    expect(catalogCases.find((entry) => entry.id === 'commands')?.strategy).toBe('duplicate-json');
  });

  it.each(catalogCases)('$id: $strategy emits one canonical failure', async (entry) => {
    expect(await run(entry.argv, { NOODLE_UPDATE_MODE: 'off' }, home)).toBe(2);
    expectOnlyFailureEnvelope(entry.expectedCode);
  });
});

describe('audited command-owned JSON failure paths', () => {
  it.each([
    {
      id: 'init invalid template before JSON flag',
      argv: ['init', '--template', 'bogus', '--json'],
      code: 'invalid_template',
    },
    {
      id: 'init invalid agents before JSON flag',
      argv: ['init', '--agents', 'bogus', '--json'],
      code: 'invalid_agents',
    },
    {
      id: 'setup invalid agents before JSON flag',
      argv: ['setup', '--agents', 'bogus', '--json'],
      code: 'invalid_agents',
    },
    {
      id: 'agents setup invalid agents before JSON flag',
      argv: ['agents', 'setup', '--agents', 'bogus', '--json'],
      code: 'invalid_agents',
    },
    {
      id: 'auth google invalid nested action',
      argv: ['auth', 'google', 'bogus', '--json'],
      code: 'usage_error',
    },
    {
      id: 'auth google prepare missing required flags',
      argv: ['auth', 'google', 'prepare', '--json'],
      code: 'missing_google_setup',
    },
    {
      id: 'auth service principals missing organization',
      argv: ['auth', 'service-principals', 'list', '--json'],
      code: 'usage_error',
    },
    {
      id: 'policy parser failure before JSON flag',
      argv: ['policy', 'status', '--bogus', '--json'],
      code: 'invalid_arguments',
    },
    {
      id: 'policy plan invalid nested action',
      argv: ['policy', 'plan', 'bogus', '--json'],
      code: 'invalid_arguments',
    },
    {
      id: 'deploy removed secrets option before JSON flag',
      argv: ['deploy', '--secrets', 'old.json', '--json'],
      code: 'deprecated_option',
    },
    {
      id: 'deploy invalid access before JSON flag',
      argv: ['deploy', '--access', 'bogus', '--json'],
      code: 'invalid_access',
    },
    {
      id: 'secret reveal rejects machine mode canonically',
      argv: [
        'secrets',
        'reveal',
        'TOKEN',
        '--runtime',
        'cloud',
        '--org',
        'acme',
        '--app',
        'app',
        '--env',
        'prod',
        '--json',
      ],
      code: 'unsupported_json_mode',
    },
    {
      id: 'secret set missing name after target resolution',
      argv: [
        'secrets',
        'set',
        '--runtime',
        'local',
        '--org',
        'acme',
        '--app',
        'app',
        '--env',
        'prod',
        '--json',
      ],
      code: 'invalid_arguments',
    },
  ])('$id emits one canonical failure', async ({ argv, code }) => {
    expect(await run(argv, { NOODLE_UPDATE_MODE: 'off' }, home)).toBe(2);
    expectOnlyFailureEnvelope(code);
  });

  it('routes plugin bootstrap failures through the requested JSON envelope', async () => {
    expect(
      await run(
        ['commands', '--json'],
        { NOODLE_PLUGIN_HOST: 'codex', NOODLE_UPDATE_MODE: 'off' },
        home,
      ),
    ).toBe(2);
    expectOnlyFailureEnvelope('plugin_mode_invalid');
  });
});
