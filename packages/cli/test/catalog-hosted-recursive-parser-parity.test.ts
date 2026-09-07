import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAssistant } from '../src/commands/assistant-ops.js';
import { runBilling } from '../src/commands/billing-ops.js';
import { EXIT } from '../src/commands/output.js';
import { runPolicy } from '../src/commands/policy-ops.js';

let home: string;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-recursive-parser-parity-'));
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

function lastEnvelope(): { readonly ok: boolean; readonly error?: { readonly code?: string } } {
  return JSON.parse(String(log.mock.lastCall?.[0])) as {
    readonly ok: boolean;
    readonly error?: { readonly code?: string };
  };
}

describe('assistant recursive leaf parser parity', () => {
  const cases: readonly {
    readonly path: string;
    readonly accepted: (home: string) => readonly string[];
    readonly acceptedEnv?: NodeJS.ProcessEnv;
    readonly acceptedExit: number;
    readonly rejected: (home: string) => readonly string[];
    readonly rejectedCode: string;
  }[] = [
    {
      path: 'doctor',
      accepted: () => [
        'doctor',
        '--origin',
        'https://app.example.com',
        '--org',
        'acme',
        '--app',
        'support',
        '--json',
      ],
      acceptedEnv: {
        NOODLE_ASSISTANT_CLIENT_ID: 'client-1',
        NOODLE_ASSISTANT_CLIENT_SECRET: 'server-only-secret',
      },
      acceptedExit: EXIT.AUTH,
      rejected: () => ['doctor', '--json'],
      rejectedCode: 'assistant_doctor_config_missing',
    },
    {
      path: 'clients create',
      accepted: () => [
        'clients',
        'create',
        '--name',
        'web',
        '--org',
        'acme',
        '--app',
        'support',
        '--json',
      ],
      acceptedExit: EXIT.AUTH,
      rejected: () => ['clients', 'create', '--json'],
      rejectedCode: 'target_required',
    },
    {
      path: 'appearance show',
      accepted: () => ['appearance', 'show', '--org', 'acme', '--app', 'support', '--json'],
      acceptedExit: EXIT.AUTH,
      rejected: () => ['appearance', 'show', '--file', 'appearance.json', '--json'],
      rejectedCode: 'usage_error',
    },
    {
      path: 'appearance apply',
      accepted: (directory) => [
        'appearance',
        'apply',
        '--file',
        join(directory, 'missing.json'),
        '--org',
        'acme',
        '--app',
        'support',
        '--json',
      ],
      acceptedExit: EXIT.USAGE,
      rejected: () => ['appearance', 'apply', '--org', 'acme', '--app', 'support', '--json'],
      rejectedCode: 'usage_error',
    },
    {
      path: 'appearance reset',
      accepted: () => ['appearance', 'reset', '--org', 'acme', '--app', 'support', '--json'],
      acceptedExit: EXIT.AUTH,
      rejected: () => ['appearance', 'reset', 'unexpected', '--json'],
      rejectedCode: 'usage_error',
    },
    {
      path: 'clients list',
      accepted: () => ['clients', 'list', '--org', 'acme', '--app', 'support', '--json'],
      acceptedExit: EXIT.AUTH,
      rejected: () => ['clients', 'list', '--json'],
      rejectedCode: 'target_required',
    },
    {
      path: 'clients rotate',
      accepted: () => [
        'clients',
        'rotate',
        'client-1',
        '--org',
        'acme',
        '--app',
        'support',
        '--json',
      ],
      acceptedExit: EXIT.AUTH,
      rejected: () => ['clients', 'rotate', '--json'],
      rejectedCode: 'usage_error',
    },
    {
      path: 'clients revoke',
      accepted: () => [
        'clients',
        'revoke',
        'client-1',
        '--org',
        'acme',
        '--app',
        'support',
        '--json',
      ],
      acceptedExit: EXIT.AUTH,
      rejected: () => ['clients', 'revoke', '--json'],
      rejectedCode: 'usage_error',
    },
    {
      path: 'embed',
      accepted: (directory) => [
        'embed',
        '--framework',
        'nextjs',
        '--dir',
        directory,
        '--no-agents',
        '--json',
      ],
      acceptedExit: EXIT.OK,
      rejected: (directory) => [
        'embed',
        '--framework',
        'remix',
        '--dir',
        directory,
        '--no-agents',
        '--json',
      ],
      rejectedCode: 'unsupported_framework',
    },
  ];

  it.each(
    cases,
  )('$path accepts its real grammar and rejects an invalid invocation', async (entry) => {
    expect(
      await runAssistant(entry.accepted(home), entry.acceptedEnv ?? {}, home),
      `${entry.path} accepted`,
    ).toBe(entry.acceptedExit);
    expect(error).not.toHaveBeenCalled();

    log.mockClear();
    error.mockClear();
    expect(await runAssistant(entry.rejected(home), {}, home), `${entry.path} rejected`).toBe(
      EXIT.USAGE,
    );
    expect(lastEnvelope()).toMatchObject({
      ok: false,
      error: { code: entry.rejectedCode },
    });
    expect(error).not.toHaveBeenCalled();
  });
});

describe('billing organization transfer recursive leaf parser parity', () => {
  const cases: readonly {
    readonly path: string;
    readonly accepted: (home: string) => readonly string[];
    readonly acceptedExit: number;
    readonly rejected: (home: string) => readonly string[];
  }[] = [
    {
      path: 'org transfer candidates',
      accepted: () => [
        'org',
        'transfer',
        'candidates',
        '--account',
        'ba_00000000-0000-0000-0000-000000000001',
        '--query',
        'alice',
        '--cursor',
        'page-2',
        '--limit',
        '25',
        '--service',
        'https://svc.example',
      ],
      acceptedExit: EXIT.AUTH,
      rejected: () => ['org', 'transfer', 'candidates', 'unexpected'],
    },
    {
      path: 'org transfer preview',
      accepted: (directory) => [
        'org',
        'transfer',
        'preview',
        'acme',
        '--account',
        'ba_00000000-0000-0000-0000-000000000001',
        '--out',
        join(directory, 'customer-preview.json'),
      ],
      acceptedExit: EXIT.AUTH,
      rejected: () => ['org', 'transfer', 'preview', '--org', 'acme'],
    },
    {
      path: 'org transfer apply',
      accepted: (directory) => [
        'org',
        'transfer',
        'apply',
        '--preview-file',
        join(directory, 'missing-customer-preview.json'),
        '--idempotency-key',
        'private-catalog-key',
        '--yes',
      ],
      acceptedExit: EXIT.FAILURE,
      rejected: () => ['org', 'transfer', 'apply', '--reason', 'not-applicable'],
    },
    {
      path: 'administration transfer preview',
      accepted: (directory) => [
        'administration',
        'transfer',
        'preview',
        '--org',
        'acme',
        '--account',
        'ba_00000000-0000-0000-0000-000000000001',
        '--reason',
        'support case 1234',
        '--out',
        join(directory, 'admin-preview.json'),
      ],
      acceptedExit: EXIT.AUTH,
      rejected: () => ['administration', 'transfer', 'preview', 'acme'],
    },
    {
      path: 'administration transfer apply',
      accepted: (directory) => [
        'administration',
        'transfer',
        'apply',
        '--preview-file',
        join(directory, 'missing-admin-preview.json'),
        '--idempotency-key',
        'private-catalog-key',
        '--yes',
      ],
      acceptedExit: EXIT.FAILURE,
      rejected: () => ['administration', 'transfer', 'apply', '--org', 'acme'],
    },
  ];

  it.each(
    cases,
  )('$path accepts only its leaf grammar and emits one JSON envelope', async (entry) => {
    expect(await runBilling([...entry.accepted(home), '--json'], {}, home)).toBe(
      entry.acceptedExit,
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect(lastEnvelope()).toMatchObject({ ok: false });
    expect(error).not.toHaveBeenCalled();

    log.mockClear();
    expect(await runBilling([...entry.rejected(home), '--json'], {}, home)).toBe(EXIT.USAGE);
    expect(log).toHaveBeenCalledTimes(1);
    expect(lastEnvelope()).toMatchObject({ ok: false, error: { code: 'usage_error' } });
    expect(error).not.toHaveBeenCalled();
  });

  it.each([
    [
      'admin preview org',
      ['administration', 'transfer', 'preview', '--account', 'x', '--reason', 'r', '--out', 'x'],
    ],
    [
      'admin preview account',
      ['administration', 'transfer', 'preview', '--org', 'acme', '--reason', 'r', '--out', 'x'],
    ],
    [
      'admin preview reason',
      ['administration', 'transfer', 'preview', '--org', 'acme', '--account', 'x', '--out', 'x'],
    ],
    [
      'admin preview out',
      ['administration', 'transfer', 'preview', '--org', 'acme', '--account', 'x', '--reason', 'r'],
    ],
    [
      'admin apply file',
      ['administration', 'transfer', 'apply', '--idempotency-key', 'private-key', '--yes'],
    ],
    ['admin apply key', ['administration', 'transfer', 'apply', '--preview-file', 'x', '--yes']],
    [
      'admin apply confirmation',
      [
        'administration',
        'transfer',
        'apply',
        '--preview-file',
        'x',
        '--idempotency-key',
        'private-key',
      ],
    ],
  ] as const)('requires the explicit %s input', async (_label, argv) => {
    expect(await runBilling([...argv, '--json'], {}, home)).toBe(EXIT.USAGE);
    expect(log).toHaveBeenCalledTimes(1);
    expect(lastEnvelope()).toMatchObject({ ok: false, error: { code: 'usage_error' } });
    expect(error).not.toHaveBeenCalled();
  });
});

describe('policy recursive leaf parser parity', () => {
  const cases: readonly {
    readonly path: string;
    readonly accepted: readonly string[];
    readonly rejected: readonly string[];
  }[] = [
    { path: 'status', accepted: ['status'], rejected: ['status', '--unknown'] },
    { path: 'list', accepted: ['list', '--org', 'acme'], rejected: ['list', '--unknown'] },
    {
      path: 'effective',
      accepted: ['effective', '--org', 'acme'],
      rejected: ['effective', '--unknown'],
    },
    {
      path: 'simulate',
      accepted: ['simulate', '--org', 'acme'],
      rejected: ['simulate', '--unknown'],
    },
    {
      path: 'suspend',
      accepted: ['suspend', '--org', 'acme', '--reason', 'maintenance'],
      rejected: ['suspend', '--unknown'],
    },
    {
      path: 'resume',
      accepted: ['resume', '--org', 'acme', '--reason', 'restored'],
      rejected: ['resume', '--unknown'],
    },
    {
      path: 'usage',
      accepted: ['usage', '--org', 'acme'],
      rejected: ['usage', '--unknown'],
    },
    {
      path: 'apply',
      accepted: ['apply', '--org', 'acme', '--file', 'policy.json'],
      rejected: ['apply', '--unknown'],
    },
    {
      path: 'show',
      accepted: ['show', 'policy-1', '--org', 'acme'],
      rejected: ['show', 'policy-1', '--unknown'],
    },
    {
      path: 'deny',
      accepted: ['deny', 'execute', '--org', 'acme'],
      rejected: ['deny', 'execute', '--unknown'],
    },
    {
      path: 'quota',
      accepted: ['quota', 'execute', '--org', 'acme', '--limit', '10', '--window', '1m'],
      rejected: ['quota', 'execute', '--unknown'],
    },
    {
      path: 'rate',
      accepted: [
        'rate',
        'execute',
        '--org',
        'acme',
        '--limit',
        '10',
        '--window',
        '1m',
        '--burst',
        '20',
        '--partition',
        'subject',
      ],
      rejected: ['rate', 'execute', '--partition', 'tenant'],
    },
    {
      path: 'delete',
      accepted: ['delete', 'policy-1', '--org', 'acme'],
      rejected: ['delete', 'policy-1', '--unknown'],
    },
    {
      path: 'plan show',
      accepted: ['plan', 'show', '--org', 'acme'],
      rejected: ['plan', 'show'],
    },
    {
      path: 'plan set',
      accepted: ['plan', 'set', 'pro', '--org', 'acme', '--reason', 'contract'],
      rejected: ['plan', 'set', 'pro', '--org', 'acme'],
    },
    {
      path: 'plan suspend',
      accepted: ['plan', 'suspend', '--org', 'acme', '--reason', 'contract ended'],
      rejected: ['plan', 'suspend', '--org', 'acme'],
    },
  ];

  it.each(
    cases,
  )('$path accepts its real grammar and rejects an invalid invocation', async (entry) => {
    expect(await runPolicy([...entry.accepted, '--json'], {}, home), `${entry.path} accepted`).toBe(
      EXIT.FAILURE,
    );
    expect(lastEnvelope()).toMatchObject({
      ok: false,
      error: { code: 'auth_required' },
    });
    expect(error).not.toHaveBeenCalled();

    log.mockClear();
    error.mockClear();
    expect(await runPolicy([...entry.rejected, '--json'], {}, home), `${entry.path} rejected`).toBe(
      EXIT.USAGE,
    );
    expect(lastEnvelope()).toMatchObject({
      ok: false,
      error: { code: 'invalid_arguments' },
    });
    expect(error).not.toHaveBeenCalled();
  });
});
