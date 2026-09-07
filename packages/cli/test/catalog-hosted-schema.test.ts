import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACCESS_MODES } from '@noodle-borg/wire-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runBilling } from '../src/commands/billing-ops.js';
import { CATALOG_ACCOUNT } from '../src/commands/catalog-data-account.js';
import { ASSISTANT_COMMAND } from '../src/commands/catalog-data-assistant.js';
import { CATALOG_HOSTED_DEPLOYMENT } from '../src/commands/catalog-data-hosted-deployment.js';
import { BILLING_COMMAND, POLICY_COMMAND } from '../src/commands/catalog-data-hosted-governance.js';
import { CATALOG_HOSTED_OBSERVABILITY } from '../src/commands/catalog-data-hosted-observability.js';
import { CATALOG_PLATFORM_AUTH } from '../src/commands/catalog-data-platform-auth.js';
import { renderCommandHelp } from '../src/commands/catalog-render.js';
import type { CommandSpec, FlagSpec, SubcommandSpec } from '../src/commands/catalog-types.js';
import { runCommands } from '../src/commands/commands-ops.js';
import { EXIT } from '../src/commands/output.js';
import { parsePlatformAuthMigrationArgs } from '../src/commands/platform-auth-migration-args.js';
import { run } from '../src/index.js';
import { chdirIsolated, restoreCwd } from './helpers/isolated-cwd.js';

const BATCH = [
  ...CATALOG_PLATFORM_AUTH,
  BILLING_COMMAND,
  ASSISTANT_COMMAND,
  ...CATALOG_HOSTED_OBSERVABILITY,
  POLICY_COMMAND,
  ...CATALOG_HOSTED_DEPLOYMENT,
];
const PLATFORM_AUTH_ACTIONS = [
  'inventory',
  'preview',
  'status',
  'start-import',
  'reconcile',
  'recover-outbox',
  'activate',
  'rollback',
  'finalize',
] as const;
const ACCOUNT_RESET_ACTIONS = ['preview', 'status', 'quarantine', 'rollback', 'finalize'] as const;

const SHA = 'a'.repeat(40);
const CHECKSUM = 'b'.repeat(64);
const FINALIZE_CHECKSUM = 'c'.repeat(64);

let home: string;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-hosted-catalog-'));
  chdirIsolated(home);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  restoreCwd();
  log.mockRestore();
  error.mockRestore();
  rmSync(home, { recursive: true, force: true });
});

function flagMap(flags: readonly FlagSpec[] | undefined): ReadonlyMap<string, FlagSpec> {
  return new Map((flags ?? []).map((flag) => [flag.name, flag]));
}

function command(name: string): CommandSpec {
  const found = BATCH.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`missing command ${name}`);
  return found;
}

type RecursiveSubcommand = SubcommandSpec & {
  readonly subcommands?: readonly RecursiveSubcommand[];
};

function nestedSubcommands(value: CommandSpec | SubcommandSpec): readonly RecursiveSubcommand[] {
  return (
    (
      value as CommandSpec & {
        readonly subcommands?: readonly RecursiveSubcommand[];
      }
    ).subcommands ?? []
  );
}

function subcommand(parent: string, ...path: readonly string[]): RecursiveSubcommand {
  let current: CommandSpec | RecursiveSubcommand = command(parent);
  for (const name of path) {
    const found = nestedSubcommands(current).find((entry) => entry.name === name);
    if (found === undefined) throw new Error(`missing subcommand ${parent} ${path.join(' ')}`);
    current = found;
  }
  return current as RecursiveSubcommand;
}

function walkSubcommands(
  value: CommandSpec | RecursiveSubcommand,
  path: readonly string[] = [],
): readonly { readonly path: readonly string[]; readonly value: RecursiveSubcommand }[] {
  return nestedSubcommands(value).flatMap((child) => [
    { path: [...path, child.name], value: child },
    ...walkSubcommands(child, [...path, child.name]),
  ]);
}

function mutationEvidence(): string[] {
  return [
    '--expected-generation',
    '4',
    '--release-sha',
    SHA,
    '--preview-checksum',
    CHECKSUM,
    '--idempotency-key',
    'private-catalog-key',
    '--reason',
    'catalog parity',
  ];
}

describe('hosted catalog security and constraints', () => {
  it('models app purge reconciliation as hosted, JSON-capable nested leaves', () => {
    const service = CATALOG_ACCOUNT.find((entry) => entry.name === 'service');
    if (service === undefined) throw new Error('missing service command');
    expect(service.local).not.toBe(true);
    const appPurge = nestedSubcommands(service).find((entry) => entry.name === 'app-purge');
    if (appPurge === undefined) throw new Error('missing service app-purge command');
    expect(nestedSubcommands(appPurge).map((entry) => entry.name)).toEqual(['preview', 'apply']);
    for (const leaf of nestedSubcommands(appPurge)) {
      expect(leaf.jsonOutput).toEqual({ mode: 'single' });
      expect(flagMap(leaf.flags).get('auth-token')?.sensitive).toBe(true);
    }
    expect(flagMap(nestedSubcommands(appPurge)[1]?.flags).get('idempotency-key')?.sensitive).toBe(
      true,
    );
  });

  it('publishes the exact private account-reset grammar and conditional preview requirements', () => {
    expect(command('platform-auth').summary).toContain('account-reset');
    const reset = subcommand('platform-auth', 'account-reset');
    expect(nestedSubcommands(reset).map((entry) => entry.name)).toEqual(ACCOUNT_RESET_ACTIONS);

    const preview = flagMap(subcommand('platform-auth', 'account-reset', 'preview').flags);
    expect(preview.get('operation')).toMatchObject({
      required: true,
      constraints: { choices: ['quarantine', 'rollback', 'finalize'] },
    });
    expect(preview.get('target-file')?.summary).toMatch(/quarantine.*required.*forbidden/i);
    expect(preview.get('operation-id')?.summary).toMatch(
      /rollback.*finalize.*required.*quarantine/i,
    );

    for (const action of ['quarantine', 'rollback', 'finalize'] as const) {
      const flags = flagMap(subcommand('platform-auth', 'account-reset', action).flags);
      expect(flags.get('yes')).toMatchObject({ required: true, type: 'boolean' });
    }
  });

  it('marks authority-bearing tokens, private evidence, and webhook credentials sensitive', () => {
    for (const entry of BATCH) {
      for (const flag of [
        ...(entry.flags ?? []),
        ...walkSubcommands(entry).flatMap((node) => node.value.flags ?? []),
      ]) {
        if (flag.name === 'auth-token') {
          expect(flag.sensitive, `${entry.name} --auth-token`).toBe(true);
        }
      }
    }

    for (const [path, names] of [
      [['accounts', 'checkout'], ['idempotency-key']],
      [['enforcement', 'cohort', 'seal'], ['idempotency-key']],
      [['enforcement', 'activation', 'preview'], ['file']],
      [
        ['enforcement', 'activation', 'activate'],
        ['file', 'preview-file', 'idempotency-key'],
      ],
      [['enforcement', 'activation', 'rollback'], ['idempotency-key']],
      [['metering', 'validation', 'prepare'], ['idempotency-key']],
      [['metering', 'validation', 'retire'], ['idempotency-key']],
      [['migration', 'preview'], ['file']],
      [
        ['migration', 'apply'],
        ['file', 'preview-file', 'plan-evidence', 'idempotency-key'],
      ],
    ] as const) {
      const flags = flagMap(subcommand('billing', ...path).flags);
      for (const name of names) {
        expect(flags.get(name)?.sensitive, `billing ${path.join(' ')} --${name}`).toBe(true);
      }
    }
    expect(flagMap(subcommand('alerts', 'add').flags).get('webhook')?.sensitive).toBe(true);

    for (const action of ['start-import', 'reconcile', 'recover-outbox', 'activate', 'rollback']) {
      const flags = flagMap(subcommand('platform-auth', 'migration', action).flags);
      for (const name of ['preview-checksum', 'idempotency-key', 'auth-token']) {
        expect(flags.get(name)?.sensitive, `platform-auth migration ${action} --${name}`).toBe(
          true,
        );
      }
    }
    expect(
      flagMap(subcommand('platform-auth', 'migration', 'preview').flags).get(
        'acceleration-approval',
      )?.sensitive,
    ).toBe(true);
    expect(
      flagMap(subcommand('platform-auth', 'migration', 'activate').flags).get(
        'acceleration-approval',
      )?.sensitive,
    ).toBe(true);
    const finalize = flagMap(subcommand('platform-auth', 'migration', 'finalize').flags);
    for (const name of [
      'preview-checksum',
      'rollback-rehearsal-checksum',
      'staging-workos-only-smoke-checksum',
      'idempotency-key',
      'auth-token',
    ]) {
      expect(finalize.get(name)?.sensitive, `platform-auth migration finalize --${name}`).toBe(
        true,
      );
    }
  });

  it('publishes the exact five billing transfer leaves and their private grammar', () => {
    const cases = [
      {
        path: ['org', 'transfer', 'candidates'],
        arguments: [],
        flags: ['account', 'query', 'cursor', 'limit', 'service', 'auth-token', 'json'],
        required: ['account'],
        sensitive: ['auth-token'],
      },
      {
        path: ['org', 'transfer', 'preview'],
        arguments: ['org-slug'],
        flags: ['account', 'out', 'service', 'auth-token', 'json'],
        required: ['account', 'out'],
        sensitive: ['out', 'auth-token'],
      },
      {
        path: ['org', 'transfer', 'apply'],
        arguments: [],
        flags: ['preview-file', 'idempotency-key', 'yes', 'service', 'auth-token', 'json'],
        required: ['preview-file', 'idempotency-key', 'yes'],
        sensitive: ['preview-file', 'idempotency-key', 'auth-token'],
      },
      {
        path: ['administration', 'transfer', 'preview'],
        arguments: [],
        flags: ['org', 'account', 'reason', 'out', 'service', 'auth-token', 'json'],
        required: ['org', 'account', 'reason', 'out'],
        sensitive: ['reason', 'out', 'auth-token'],
      },
      {
        path: ['administration', 'transfer', 'apply'],
        arguments: [],
        flags: ['preview-file', 'idempotency-key', 'yes', 'service', 'auth-token', 'json'],
        required: ['preview-file', 'idempotency-key', 'yes'],
        sensitive: ['preview-file', 'idempotency-key', 'auth-token'],
      },
    ] as const;

    for (const entry of cases) {
      const transfer = subcommand('billing', ...entry.path);
      const flags = flagMap(transfer.flags);
      expect(
        transfer.arguments.map((argument) => argument.name),
        entry.path.join(' '),
      ).toEqual(entry.arguments);
      expect([...flags.keys()], entry.path.join(' ')).toEqual(entry.flags);
      expect([...flags.values()].filter((flag) => flag.required).map((flag) => flag.name)).toEqual(
        entry.required,
      );
      expect([...flags.values()].filter((flag) => flag.sensitive).map((flag) => flag.name)).toEqual(
        entry.sensitive,
      );
      expect(transfer.jsonOutput).toEqual({ mode: 'single' });
    }

    expect(subcommand('billing', 'org', 'transfer', 'preview').arguments[0]).toMatchObject({
      required: true,
      sensitive: false,
      type: 'string',
    });
    expect(
      flagMap(subcommand('billing', 'org', 'transfer', 'candidates').flags).get('limit'),
    ).toMatchObject({
      type: 'integer',
      constraints: { default: 50, minimum: 1, maximum: 100 },
    });
    expect(subcommand('billing', 'org', 'transfer', 'candidates').summary).toMatch(
      /owned organizations.*billing transfer status.*eligibility/i,
    );
    expect(
      flagMap(subcommand('billing', 'administration', 'transfer', 'preview').flags).get('reason'),
    ).toMatchObject({ constraints: { minLength: 1, maxLength: 256 } });
  });

  it('publishes parser-enforced choices, limits, defaults, aliases, and conflicts', () => {
    const inventory = flagMap(subcommand('platform-auth', 'migration', 'inventory').flags);
    expect(inventory.get('generation')).toMatchObject({
      type: 'integer',
      constraints: { default: 0, minimum: 0 },
    });
    const preview = flagMap(subcommand('platform-auth', 'migration', 'preview').flags);
    expect(preview.get('operation')).toMatchObject({
      required: true,
      constraints: {
        choices: [
          'start_import',
          'reconcile',
          'recover_outbox',
          'activate',
          'rollback',
          'finalize',
        ],
      },
    });
    expect(preview.get('batch-size')?.constraints).toMatchObject({
      default: 100,
      minimum: 1,
      maximum: 100,
    });
    expect(preview.get('acceleration-approval')).toMatchObject({
      type: 'string',
      required: false,
      sensitive: true,
    });

    for (const action of ['reconcile', 'recover-outbox']) {
      expect(
        flagMap(subcommand('platform-auth', 'migration', action).flags).get('batch-size'),
      ).toMatchObject({
        type: 'integer',
        required: true,
        constraints: { minimum: 1, maximum: 100 },
      });
    }
    const activate = flagMap(subcommand('platform-auth', 'migration', 'activate').flags);
    expect(activate.get('percentage')).toMatchObject({
      type: 'integer',
      required: true,
      constraints: { minimum: 1, maximum: 100 },
    });
    expect(activate.get('cohort-mode')).toMatchObject({
      required: true,
      constraints: { choices: ['preserve', 'replace'] },
    });
    expect(activate.get('canary-client-id')?.repeatable).toBe(true);
    expect(activate.get('recovery-client-id')?.repeatable).toBe(true);
    expect(activate.get('acceleration-approval')).toMatchObject({
      type: 'string',
      required: false,
      sensitive: true,
    });

    const mutation = flagMap(subcommand('platform-auth', 'migration', 'start-import').flags);
    expect(mutation.get('expected-generation')).toMatchObject({
      required: true,
      constraints: { minimum: 0 },
    });
    expect(mutation.get('release-sha')).toMatchObject({
      required: true,
      constraints: { minLength: 40, maxLength: 40 },
    });
    expect(mutation.get('preview-checksum')).toMatchObject({
      required: true,
      constraints: { minLength: 64, maxLength: 64 },
    });
    expect(mutation.get('idempotency-key')).toMatchObject({
      required: true,
      constraints: { minLength: 8, maxLength: 256 },
    });
    expect(mutation.get('reason')).toMatchObject({
      required: true,
      constraints: { minLength: 1, maxLength: 256 },
    });

    const finalize = flagMap(subcommand('platform-auth', 'migration', 'finalize').flags);
    for (const name of ['rollback-rehearsal-checksum', 'staging-workos-only-smoke-checksum']) {
      expect(finalize.get(name)).toMatchObject({
        required: true,
        constraints: { minLength: 64, maxLength: 64 },
      });
    }

    const checkout = flagMap(subcommand('billing', 'accounts', 'checkout').flags);
    expect(checkout.get('plan')).toMatchObject({
      required: true,
      constraints: { choices: ['pro', 'scale'] },
    });
    expect(checkout.get('interval')).toMatchObject({
      required: true,
      constraints: { choices: ['month', 'year'] },
    });

    const activationRollback = flagMap(
      subcommand('billing', 'enforcement', 'activation', 'rollback').flags,
    );
    expect(activationRollback.get('generation')).toMatchObject({
      type: 'integer',
      required: true,
      constraints: { minimum: 1 },
    });
    for (const name of ['epoch', 'reason', 'idempotency-key']) {
      expect(activationRollback.get(name)?.required, `activation rollback --${name}`).toBe(true);
    }

    const migrationApply = flagMap(subcommand('billing', 'migration', 'apply').flags);
    expect(migrationApply.get('mode')).toMatchObject({
      required: true,
      constraints: { choices: ['shadow'] },
    });
    for (const name of ['file', 'preview-file', 'plan-evidence', 'reason', 'idempotency-key']) {
      expect(migrationApply.get(name)?.required, `migration apply --${name}`).toBe(true);
    }

    const planSet = flagMap(subcommand('policy', 'plan', 'set').flags);
    expect(planSet.get('org')?.required).toBe(true);
    expect(planSet.get('reason')?.required).toBe(true);
    expect(subcommand('policy', 'plan', 'set').arguments?.[0]?.constraints.choices).toEqual([
      'free',
      'pro',
      'scale',
      'enterprise',
    ]);

    const assistantCreate = flagMap(subcommand('assistant', 'clients', 'create').flags);
    expect(assistantCreate.get('name')?.constraints.default).toBe('web');
    expect(flagMap(subcommand('assistant', 'appearance', 'apply').flags).get('file')).toMatchObject(
      {
        required: true,
        value: '<appearance.json>',
      },
    );
    expect(subcommand('assistant', 'clients', 'rotate').arguments?.[0]).toMatchObject({
      name: 'client-id',
      required: true,
    });

    expect(preview.get('operation')?.constraints?.choices).toEqual([
      'start_import',
      'reconcile',
      'recover_outbox',
      'activate',
      'rollback',
      'finalize',
    ]);

    const logs = flagMap(command('logs').flags);
    expect(logs.get('level')?.constraints?.choices).toEqual(['debug', 'info', 'warn', 'error']);
    expect(logs.get('follow')?.aliases).toEqual(['tail']);
    expect(logs.get('interval')).toMatchObject({
      type: 'number',
      constraints: { default: 2, minimum: 0.5 },
    });
    expect(logs.get('max-polls')).toMatchObject({
      type: 'number',
    });
    expect(logs.get('max-polls')?.constraints).toBeUndefined();

    const metrics = flagMap(command('metrics').flags);
    expect(metrics.get('window')?.constraints).toEqual({
      choices: ['24h', '7d', '30d'],
      default: '7d',
    });

    const events = flagMap(command('events').flags);
    expect(events.get('status')?.constraints?.choices).toEqual(['ok', 'tool_error', 'mcp_error']);
    expect(events.get('tail')?.aliases).toEqual(['follow']);
    expect(events.get('max-polls')).toMatchObject({
      type: 'number',
      constraints: { minimum: Number.MIN_VALUE },
    });

    const alertsAdd = flagMap(subcommand('alerts', 'add').flags);
    expect(alertsAdd.get('metric')?.constraints?.choices).toEqual([
      'error_share',
      'error_count',
      'calls',
      'p95_ms',
    ]);
    expect(alertsAdd.get('threshold')).toMatchObject({
      type: 'number',
      required: true,
      constraints: { minimum: 0 },
    });
    expect(alertsAdd.get('window')?.constraints?.choices).toEqual([5, 15, 60]);
    expect(alertsAdd.get('cooldown')).toMatchObject({
      type: 'integer',
      constraints: { minimum: 1 },
    });

    expect(flagMap(command('deploy').flags).get('access')?.constraints?.choices).toEqual(
      ACCESS_MODES,
    );
    expect(flagMap(command('deploy').flags).get('owner-subject')).toMatchObject({
      type: 'string',
      value: '<subject>',
    });
    expect(flagMap(command('status').flags).get('watch')?.conflictsWith).toEqual(['json']);
    expect(flagMap(command('status').flags).get('json')?.conflictsWith).toEqual(['watch']);
    expect(flagMap(command('status').flags).get('interval')?.constraints).toEqual({
      default: 5,
      minimum: 2,
    });
  });

  it('declares one-shot JSON by default and conditional NDJSON only for follow/tail', () => {
    const jsonCommands = BATCH.filter((entry) => flagMap(entry.flags).has('json'));
    for (const entry of jsonCommands) {
      expect(entry.jsonOutput?.mode, entry.name).toBe('single');
    }
    for (const name of ['logs', 'events']) {
      expect(
        command(name).jsonOutput as
          | { readonly mode: string; readonly streamWhenAnyFlag?: readonly string[] }
          | undefined,
      ).toEqual({
        mode: 'single',
        streamWhenAnyFlag: ['follow', 'tail'],
      });
    }
    expect(command('status').jsonOutput?.mode).toBe('single');
  });
});

describe('non-umbrella parser-backed metadata parity', () => {
  it('covers every owned command and its direct parser contracts', () => {
    expect(BATCH.map((entry) => entry.name)).toEqual([
      'platform-auth',
      'billing',
      'assistant',
      'knowledge',
      'audit',
      'logs',
      'metrics',
      'events',
      'intents',
      'alerts',
      'policy',
      'deploy',
      'open',
      'status',
      'inspect',
      'smoke',
      'rollback',
      'archive',
      'restore',
      'access',
    ]);

    const auditEvents = flagMap(subcommand('audit', 'events').flags);
    expect(auditEvents.get('org')?.required).toBe(true);
    expect(auditEvents.get('limit')?.type).toBe('string');

    const logs = flagMap(command('logs').flags);
    expect(logs.get('follow')?.aliases).toEqual(['tail']);
    expect(logs.get('interval')?.constraints).toEqual({ default: 2, minimum: 0.5 });

    const metrics = flagMap(command('metrics').flags);
    expect(metrics.get('window')?.constraints).toEqual({
      choices: ['24h', '7d', '30d'],
      default: '7d',
    });

    const events = flagMap(command('events').flags);
    expect(events.get('tail')?.aliases).toEqual(['follow']);
    expect(events.get('max-polls')?.constraints.minimum).toBe(Number.MIN_VALUE);

    expect(flagMap(subcommand('intents', 'list').flags).get('window')?.constraints).toEqual({
      choices: ['24h', '7d', '14d'],
      default: '7d',
    });
    expect(flagMap(subcommand('intents', 'purge').flags).get('yes')?.required).toBe(true);

    const alertsList = flagMap(subcommand('alerts', 'list').flags);
    expect(alertsList.get('agent-output')?.aliases).toEqual([]);
    for (const action of ['remove', 'test']) {
      expect(subcommand('alerts', action).arguments?.[0]).toMatchObject({
        name: 'id',
        required: true,
      });
    }

    expect(command('deploy').arguments?.[0]).toMatchObject({
      name: 'server.ts',
      required: false,
    });
    expect(flagMap(command('deploy').flags).get('access')?.constraints.choices).toEqual(
      ACCESS_MODES,
    );

    expect(command('open').arguments).toEqual([]);
    expect([...flagMap(command('open').flags).keys()]).toEqual(['print', 'dashboard']);

    const status = flagMap(command('status').flags);
    expect(status.get('watch')?.conflictsWith).toEqual(['json']);
    expect(status.get('json')?.conflictsWith).toEqual(['watch']);
    expect(status.get('interval')?.constraints).toEqual({ default: 5, minimum: 2 });

    for (const name of ['inspect', 'smoke']) {
      expect(command(name).arguments, name).toEqual([]);
    }
    expect(command('rollback').arguments?.[0]).toMatchObject({
      name: 'deployment-id',
      required: true,
    });
    for (const name of ['archive', 'restore']) {
      expect(command(name).arguments?.[0]).toMatchObject({ name: 'app', required: false });
      expect(flagMap(command(name).flags).has('app'), `${name} accepts --app`).toBe(true);
    }
    expect(subcommand('access', 'set').arguments?.[0]?.constraints.choices).toEqual(ACCESS_MODES);
    expect(flagMap(subcommand('access', 'set').flags).has('version')).toBe(true);
    expect(flagMap(subcommand('access', 'set').flags).get('owner-subject')).toMatchObject({
      type: 'string',
      value: '<subject>',
    });
  });

  it('drives every non-umbrella command through accepted and rejected parser paths', async () => {
    const cases: readonly {
      readonly name: string;
      readonly accepted: readonly string[];
      readonly acceptedExit: number;
      readonly rejected: readonly string[];
      readonly rejectedExit?: number;
      readonly rejectedCode?: string;
    }[] = [
      {
        name: 'assistant',
        accepted: [
          'assistant',
          'clients',
          'rotate',
          'client-1',
          '--org',
          'acme',
          '--app',
          'support',
        ],
        acceptedExit: EXIT.AUTH,
        rejected: ['assistant', 'clients', 'rotate'],
        rejectedCode: 'usage_error',
      },
      {
        name: 'knowledge',
        accepted: [
          'knowledge',
          'list',
          '--org',
          'acme',
          '--app',
          'site',
          '--env',
          'prod',
          '--service',
          'http://127.0.0.1:1',
          '--auth-token',
          't',
        ],
        acceptedExit: EXIT.UNREACHABLE,
        rejected: ['knowledge', 'sync'],
        rejectedCode: 'usage',
      },
      {
        name: 'audit',
        accepted: ['audit', 'events', '--org', 'acme', '--service', 'http://127.0.0.1:1'],
        acceptedExit: EXIT.UNREACHABLE,
        rejected: ['audit', 'events'],
        rejectedCode: 'target_required',
      },
      {
        name: 'logs',
        accepted: ['logs', '--org', 'acme', '--app', 'support'],
        acceptedExit: EXIT.AUTH,
        rejected: ['logs'],
        rejectedCode: 'target_required',
      },
      {
        name: 'metrics',
        accepted: ['metrics', '--org', 'acme', '--app', 'support', '--window', '7d'],
        acceptedExit: EXIT.AUTH,
        rejected: ['metrics', '--window', 'year'],
        rejectedCode: 'invalid_window',
      },
      {
        name: 'events',
        accepted: ['events', '--org', 'acme', '--app', 'support', '--max-polls', '1'],
        acceptedExit: EXIT.AUTH,
        rejected: ['events', '--tail', '--max-polls', '0'],
        rejectedCode: 'invalid_max_polls',
      },
      {
        name: 'intents',
        accepted: ['intents', 'status', '--org', 'acme', '--app', 'support'],
        acceptedExit: EXIT.AUTH,
        rejected: ['intents', 'list', '--window', 'year'],
        rejectedCode: 'invalid_window',
      },
      {
        name: 'alerts',
        accepted: [
          'alerts',
          'add',
          '--org',
          'acme',
          '--app',
          'support',
          '--metric',
          'calls',
          '--threshold',
          '1',
          '--window',
          '5',
          '--webhook',
          'https://example.com/hook',
        ],
        acceptedExit: EXIT.AUTH,
        rejected: ['alerts', 'add', '--metric', 'unknown'],
        rejectedCode: 'invalid_metric',
      },
      {
        name: 'policy',
        accepted: ['policy', 'status'],
        acceptedExit: EXIT.FAILURE,
        rejected: ['policy', 'status', '--partition', 'tenant'],
        rejectedCode: 'invalid_arguments',
      },
      {
        name: 'deploy',
        accepted: ['deploy', '--access', 'public'],
        acceptedExit: EXIT.USAGE,
        rejected: ['deploy', '--access', 'unknown'],
        rejectedCode: 'invalid_access',
      },
      {
        name: 'open',
        accepted: ['open', '--print'],
        acceptedExit: EXIT.FAILURE,
        rejected: [],
        rejectedExit: EXIT.FAILURE,
      },
      {
        name: 'status',
        accepted: ['status', '--org', 'acme', '--app', 'support'],
        acceptedExit: EXIT.AUTH,
        rejected: ['status', '--watch'],
        rejectedCode: 'watch_json_conflict',
      },
      {
        name: 'inspect',
        accepted: ['inspect', '--org', 'acme', '--app', 'support'],
        acceptedExit: EXIT.AUTH,
        rejected: ['inspect'],
        rejectedCode: 'target_required',
      },
      {
        name: 'smoke',
        accepted: ['smoke', '--org', 'acme', '--app', 'support'],
        acceptedExit: EXIT.AUTH,
        rejected: ['smoke'],
        rejectedCode: 'target_required',
      },
      {
        name: 'rollback',
        accepted: ['rollback', 'deployment-1', '--org', 'acme', '--app', 'support'],
        acceptedExit: EXIT.AUTH,
        rejected: ['rollback'],
        rejectedCode: 'usage_error',
      },
      {
        name: 'archive',
        accepted: ['archive', 'support', '--org', 'acme', '--yes'],
        acceptedExit: EXIT.AUTH,
        rejected: ['archive', 'support', '--org', 'acme', '--env', 'prod'],
        rejectedCode: 'usage_error',
      },
      {
        name: 'restore',
        accepted: ['restore', 'support', '--org', 'acme'],
        acceptedExit: EXIT.AUTH,
        rejected: ['restore', 'support', '--org', 'acme', '--env', 'prod'],
        rejectedCode: 'usage_error',
      },
      {
        name: 'access',
        accepted: ['access', 'set', 'public', '--org', 'acme', '--app', 'support'],
        acceptedExit: EXIT.AUTH,
        rejected: ['access', 'set', 'unknown'],
        rejectedCode: 'usage_error',
      },
    ];

    expect(cases.map((entry) => entry.name)).toEqual(
      BATCH.map((entry) => entry.name).filter(
        (name) => name !== 'platform-auth' && name !== 'billing',
      ),
    );
    for (const entry of cases) {
      log.mockClear();
      error.mockClear();
      const accepted = entry.name === 'open' ? entry.accepted : [...entry.accepted, '--json'];
      expect(await run(accepted, { CI: 'true' }, home), `${entry.name} accepted`).toBe(
        entry.acceptedExit,
      );

      log.mockClear();
      error.mockClear();
      const rejected = entry.name === 'open' ? entry.rejected : [...entry.rejected, '--json'];
      expect(await run(rejected, { CI: 'true' }, home), `${entry.name} rejected`).toBe(
        entry.rejectedExit ?? EXIT.USAGE,
      );
      if (entry.rejectedCode !== undefined) {
        expect(
          JSON.parse(String(log.mock.lastCall?.[0])),
          `${entry.name} rejected envelope`,
        ).toMatchObject({
          ok: false,
          error: { code: entry.rejectedCode },
        });
      }
    }
  });

  it('preserves parser compatibility for logs max-polls and ignored open arguments', async () => {
    expect(
      await run(
        ['logs', '--org', 'acme', '--app', 'support', '--follow', '--max-polls', '0', '--json'],
        { CI: 'true' },
        home,
      ),
    ).toBe(EXIT.AUTH);

    log.mockClear();
    error.mockClear();
    expect(await run(['open', '--bogus'], { CI: 'true' }, home)).toBe(EXIT.FAILURE);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('No saved deployment metadata'));
  });
});

describe('umbrella parser parity', () => {
  it('represents and accepts every platform-auth migration action grammar', () => {
    const migration = subcommand('platform-auth', 'migration');
    expect(nestedSubcommands(migration).map((entry) => entry.name)).toEqual(PLATFORM_AUTH_ACTIONS);
    expect(migration.arguments).toEqual([]);

    const finalizationEvidence = [
      '--rollback-rehearsal-checksum',
      CHECKSUM,
      '--staging-workos-only-smoke-checksum',
      FINALIZE_CHECKSUM,
    ];
    const cases: readonly (readonly string[])[] = [
      ['migration', 'inventory', '--generation', '0'],
      ['migration', 'status'],
      ['migration', 'preview', '--operation', 'start_import'],
      ['migration', 'preview', '--operation', 'reconcile'],
      ['migration', 'preview', '--operation', 'recover_outbox', '--batch-size', '100'],
      [
        'migration',
        'preview',
        '--operation',
        'activate',
        '--percentage',
        '1',
        '--cohort-mode',
        'preserve',
        '--acceleration-approval',
        'approval.json',
      ],
      ['migration', 'preview', '--operation', 'rollback'],
      ['migration', 'preview', '--operation', 'finalize', ...finalizationEvidence],
      ['migration', 'start-import', ...mutationEvidence(), '--yes'],
      ['migration', 'reconcile', '--batch-size', '1', ...mutationEvidence(), '--yes'],
      ['migration', 'recover-outbox', '--batch-size', '100', ...mutationEvidence(), '--yes'],
      [
        'migration',
        'activate',
        '--percentage',
        '50',
        '--cohort-mode',
        'preserve',
        '--acceleration-approval',
        'approval.json',
        ...mutationEvidence(),
        '--yes',
      ],
      ['migration', 'rollback', ...mutationEvidence(), '--yes'],
      ['migration', 'finalize', ...mutationEvidence(), ...finalizationEvidence, '--yes'],
    ];
    for (const args of cases) {
      expect(parsePlatformAuthMigrationArgs(args), args.join(' ')).toMatchObject({ ok: true });
    }
  });

  it('keeps platform-auth bounds and conditional flag applicability in parser parity', () => {
    for (const args of [
      ['migration', 'inventory', '--generation', '-1'],
      ['migration', 'reconcile', '--batch-size', '0', ...mutationEvidence(), '--yes'],
      ['migration', 'reconcile', '--batch-size', '101', ...mutationEvidence(), '--yes'],
      [
        'migration',
        'activate',
        '--percentage',
        '101',
        '--cohort-mode',
        'preserve',
        ...mutationEvidence(),
        '--yes',
      ],
      [
        'migration',
        'activate',
        '--percentage',
        '10',
        '--cohort-mode',
        'preserve',
        '--canary-client-id',
        'client-a',
        ...mutationEvidence(),
        '--yes',
      ],
      ['migration', 'preview', '--operation', 'rollback', '--batch-size', '1'],
      [
        'migration',
        'preview',
        '--operation',
        'rollback',
        '--acceleration-approval',
        'approval.json',
      ],
      [
        'migration',
        'rollback',
        '--acceleration-approval',
        'approval.json',
        ...mutationEvidence(),
        '--yes',
      ],
    ]) {
      expect(parsePlatformAuthMigrationArgs(args), args.join(' ')).toMatchObject({ ok: false });
    }
  });

  it('represents and accepts every billing action path before authentication or mutation', async () => {
    const paths = walkSubcommands(command('billing'))
      .filter((node) => nestedSubcommands(node.value).length === 0)
      .map((node) => node.path.join(' '));
    expect(paths).toEqual([
      'catalog status',
      'catalog activate',
      'accounts list',
      'accounts inspect',
      'accounts checkout',
      'accounts portal',
      'org inspect',
      'org transfer candidates',
      'org transfer preview',
      'org transfer apply',
      'administration transfer preview',
      'administration transfer apply',
      'enforcement cohort status',
      'enforcement cohort seal',
      'enforcement activation status',
      'enforcement activation preview',
      'enforcement activation activate',
      'enforcement activation rollback',
      'metering readiness',
      'metering validation prepare',
      'metering validation retire',
      'migration preview',
      'migration apply',
    ]);

    const acceptedBeforeAuth: readonly (readonly string[])[] = [
      ['catalog', 'status'],
      ['catalog', 'activate', '--proof', 'release-proof.json'],
      ['accounts', 'list'],
      ['accounts', 'inspect', 'billing-account'],
      ['accounts', 'checkout', 'billing-account', '--plan', 'pro', '--interval', 'month'],
      ['accounts', 'portal', 'billing-account'],
      ['org', 'inspect', 'acme'],
      ['enforcement', 'cohort', 'status'],
      [
        'enforcement',
        'cohort',
        'seal',
        '--reason',
        'catalog parity',
        '--idempotency-key',
        'private-catalog-key',
        '--yes',
      ],
      ['enforcement', 'activation', 'status'],
      ['enforcement', 'activation', 'preview', '--file', 'approval.json'],
      [
        'enforcement',
        'activation',
        'activate',
        '--file',
        'approval.json',
        '--preview-file',
        'ready-preview.json',
        '--reason',
        'catalog parity',
        '--idempotency-key',
        'private-catalog-key',
        '--yes',
      ],
      [
        'enforcement',
        'activation',
        'rollback',
        '--epoch',
        'epoch-1',
        '--generation',
        '1',
        '--reason',
        'catalog parity',
        '--idempotency-key',
        'private-catalog-key',
        '--yes',
      ],
      ['metering', 'readiness'],
      [
        'metering',
        'validation',
        'prepare',
        '--reason',
        'catalog parity',
        '--idempotency-key',
        'private-catalog-key',
        '--yes',
      ],
      [
        'metering',
        'validation',
        'retire',
        '--epoch',
        'epoch-1',
        '--reason',
        'catalog parity',
        '--idempotency-key',
        'private-catalog-key',
        '--yes',
      ],
      ['migration', 'preview'],
    ];
    for (const args of acceptedBeforeAuth) {
      log.mockClear();
      error.mockClear();
      expect(await runBilling([...args, '--json'], {}, home), args.join(' ')).toBe(EXIT.AUTH);
      expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
        ok: false,
        error: { code: 'auth_required' },
      });
      expect(error).not.toHaveBeenCalled();
    }

    expect(
      await runBilling(
        [
          'migration',
          'apply',
          '--file',
          'mapping.json',
          '--preview-file',
          'ready-preview.json',
          '--plan-evidence',
          'plan-evidence.json',
          '--mode',
          'shadow',
          '--reason',
          'catalog parity',
          '--idempotency-key',
          'private-catalog-key',
          '--json',
        ],
        {},
        home,
      ),
    ).toBe(EXIT.USAGE);
    expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'confirmation_required' },
    });
  });

  it('represents assistant clients and policy plan compound actions as recursive leaves', () => {
    const assistantPaths = walkSubcommands(command('assistant'))
      .filter((node) => nestedSubcommands(node.value).length === 0)
      .map((node) => node.path.join(' '));
    expect(assistantPaths).toEqual([
      'doctor',
      'appearance show',
      'appearance apply',
      'appearance reset',
      'clients create',
      'clients list',
      'clients rotate',
      'clients revoke',
      'embeds list',
      'budget set',
      'sponsorship inspect',
      'sponsorship grant',
      'sponsorship revoke',
      'usage',
      'embed',
    ]);

    const policyPaths = walkSubcommands(command('policy'))
      .filter((node) => nestedSubcommands(node.value).length === 0)
      .map((node) => node.path.join(' '));
    expect(policyPaths).toEqual([
      'status',
      'list',
      'effective',
      'simulate',
      'suspend',
      'resume',
      'usage',
      'apply',
      'show',
      'deny',
      'quota',
      'rate',
      'delete',
      'plan show',
      'plan set',
      'plan suspend',
    ]);
  });
});

describe('hosted typed-field rendering and public discovery', () => {
  it('derives hosted help from structured arguments and constraints', () => {
    const billing = command('billing');
    const platformAuth = command('platform-auth');
    expect(billing.usage).toBeUndefined();
    expect(platformAuth.usage).toBeUndefined();

    const billingHelp = renderCommandHelp(billing, { color: 'none', glyph: 'ascii' });
    expect(billingHelp).toContain('accounts list');
    expect(billingHelp).toContain('accounts checkout <account-id>');
    expect(billingHelp).toContain('--plan pro|scale');
    expect(billingHelp).toContain('--generation <n>');
    expect(billingHelp).toContain('minimum 1');
    expect(billingHelp).toContain('org transfer preview <org-slug>');
    expect(billingHelp).toContain('administration transfer preview');

    const platformHelp = renderCommandHelp(platformAuth, { color: 'none', glyph: 'ascii' });
    expect(platformHelp).toContain('migration inventory');
    expect(platformHelp).toContain('migration activate');
    expect(platformHelp).toContain('--batch-size <1-100>');
    expect(platformHelp).toContain('range 1-100');
    expect(platformHelp).toContain('8-256 characters');

    const assistantHelp = renderCommandHelp(command('assistant'), {
      color: 'none',
      glyph: 'ascii',
    });
    expect(assistantHelp).toContain('clients rotate <client-id>');

    const policyHelp = renderCommandHelp(command('policy'), { color: 'none', glyph: 'ascii' });
    expect(policyHelp).toContain('plan set free|pro|scale|enterprise');
  });

  it('renders the deploy entrypoint as optional because runtime resolves linked defaults', () => {
    const deploy = command('deploy');
    expect(deploy.arguments?.[0]).toMatchObject({ name: 'server.ts', required: false });
    expect(renderCommandHelp(deploy, { color: 'none', glyph: 'ascii' })).toContain(
      'noodle deploy [<server.ts>]',
    );
  });

  it('snapshots the actual serialized public JSON entries for this batch', () => {
    expect(runCommands(['--json'])).toBe(EXIT.OK);
    const envelope = JSON.parse(String(log.mock.lastCall?.[0])) as {
      data: { commands: Array<{ name: string }>; version: string };
    };
    const names = new Set(BATCH.map((entry) => entry.name));
    envelope.data.commands = envelope.data.commands.filter((entry) => names.has(entry.name));
    envelope.data.version = '<version>';
    expect(JSON.parse(JSON.stringify(envelope))).toMatchSnapshot();
  });
});
