import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runApps } from '../src/commands/apps-ops.js';
import { runDeployments } from '../src/commands/deployments-ops.js';
import { runDistributions } from '../src/commands/distributions-ops.js';
import { runEnvs } from '../src/commands/envs-ops.js';
import { runGithub } from '../src/commands/github-ops.js';
import { runMembers, runOrgs } from '../src/commands/org-admin.js';
import { EXIT } from '../src/commands/output.js';
import { runServiceCommand } from '../src/commands/service-ops.js';
import { writeConfig } from '../src/config.js';
import { chdirIsolated, restoreCwd } from './helpers/isolated-cwd.js';

type Runner = (
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: string,
) => Promise<number> | number;

function lastEnvelope(): { readonly error?: { readonly code?: string } } {
  return JSON.parse(String(log.mock.lastCall?.[0])) as {
    readonly error?: { readonly code?: string };
  };
}

interface ParserCase {
  readonly path: string;
  readonly run: Runner;
  readonly accepted: readonly string[];
  readonly acceptedExit: number;
  readonly rejected: readonly string[];
  readonly missingOrg?: readonly string[];
  readonly prepareAccepted?: (home: string) => void;
}

let home: string;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-tenant-catalog-parity-'));
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

const cases: readonly ParserCase[] = [
  {
    path: 'service init',
    run: runServiceCommand,
    accepted: ['init', '--profile', 'open-core', '--compose'],
    acceptedExit: EXIT.OK,
    rejected: ['init', '--profile', 'open-core', '--replace-secrets'],
    prepareAccepted: (directory) =>
      writeFileSync(
        join(directory, 'package.json'),
        '{"name":"noodle-core","private":true,"noodleCore":{"composeInitVersion":1}}\n',
      ),
  },
  {
    path: 'service app-purge preview',
    run: runServiceCommand,
    accepted: ['app-purge', 'preview', '--output', '/tmp/noodle-app-purge-preview.json', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['app-purge', 'preview', '--output', 'relative-preview.json', '--json'],
  },
  {
    path: 'apps list',
    run: runApps,
    accepted: ['list', '--org', 'acme', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['list', '--json'],
  },
  {
    path: 'apps inspect',
    run: runApps,
    accepted: ['inspect', 'app', '--org', 'acme', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['inspect', '--org', 'acme', '--json'],
  },
  {
    path: 'apps open',
    run: runApps,
    accepted: ['open', 'app', '--org', 'acme', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['open', '--org', 'acme', '--json'],
  },
  {
    path: 'envs list',
    run: runEnvs,
    accepted: ['list', '--org', 'acme', '--app', 'app', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['list', '--json'],
  },
  {
    path: 'envs inspect',
    run: runEnvs,
    accepted: ['inspect', 'prod', '--org', 'acme', '--app', 'app', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['inspect', '--org', 'acme', '--app', 'app', '--json'],
  },
  {
    path: 'envs set-production',
    run: runEnvs,
    accepted: ['set-production', 'prod', '--org', 'acme', '--app', 'app', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['set-production', '--org', 'acme', '--app', 'app', '--json'],
  },
  {
    path: 'deployments list',
    run: runDeployments,
    accepted: ['list', '--org', 'acme', '--json'],
    acceptedExit: EXIT.OK,
    rejected: ['list', '--watch', '--json'],
  },
  {
    path: 'deployments inspect',
    run: runDeployments,
    accepted: ['inspect', 'deployment-1', '--org', 'acme', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['inspect', '--org', 'acme', '--json'],
  },
  {
    path: 'deployments package',
    run: runDeployments,
    accepted: ['package', 'deployment-1', '--org', 'acme', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['package', '--org', 'acme', '--json'],
  },
  {
    path: 'distributions publish',
    run: runDistributions,
    accepted: [
      'publish',
      'deployment-1',
      'server.ts',
      '--target',
      'openai',
      '--category',
      'Productivity',
      '--org',
      'acme',
      '--json',
    ],
    acceptedExit: EXIT.AUTH,
    rejected: ['publish', 'deployment-1', '--target', 'openai', '--org', 'acme', '--json'],
  },
  {
    path: 'distributions list',
    run: runDistributions,
    accepted: ['list', 'deployment-1', '--target', 'claude', '--org', 'acme', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['list', '--org', 'acme', '--json'],
  },
  {
    path: 'distributions inspect',
    run: runDistributions,
    accepted: ['inspect', 'distribution-1', '--org', 'acme', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['inspect', '--org', 'acme', '--json'],
  },
  {
    path: 'distributions download',
    run: runDistributions,
    accepted: ['download', 'distribution-1', '--output', 'plugin.zip', '--org', 'acme', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['download', 'distribution-1', '--org', 'acme', '--json'],
  },
  {
    path: 'distributions readiness',
    run: runDistributions,
    accepted: ['readiness', 'distribution-1', '--status', 'ready', '--org', 'acme', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['readiness', 'distribution-1', '--status', 'invalid', '--org', 'acme', '--json'],
  },
  {
    path: 'distributions review',
    run: runDistributions,
    accepted: ['review', 'distribution-1', '--status', 'approved', '--org', 'acme', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['review', 'distribution-1', '--org', 'acme', '--json'],
  },
  {
    path: 'distributions release',
    run: runDistributions,
    accepted: ['release', 'distribution-1', '--visibility', 'private', '--org', 'acme', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['release', 'distribution-1', '--visibility', 'hidden', '--org', 'acme', '--json'],
  },
  {
    path: 'distributions rollback',
    run: runDistributions,
    accepted: ['rollback', 'distribution-1', '--org', 'acme', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['rollback', '--org', 'acme', '--json'],
  },
  {
    path: 'distributions deprecate',
    run: runDistributions,
    accepted: ['deprecate', 'distribution-1', '--org', 'acme', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['deprecate', '--org', 'acme', '--json'],
  },
  {
    path: 'distributions revoke',
    run: runDistributions,
    accepted: ['revoke', 'distribution-1', '--org', 'acme', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['revoke', '--org', 'acme', '--json'],
  },
  {
    path: 'distributions grant',
    run: runDistributions,
    accepted: ['grant', 'distribution-1', '--expires-in', '900', '--org', 'acme', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['grant', 'distribution-1', '--expires-in', '10', '--org', 'acme', '--json'],
  },
  {
    path: 'orgs list',
    run: runOrgs,
    accepted: ['list', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['list', 'extra', '--json'],
  },
  {
    path: 'orgs create',
    run: runOrgs,
    accepted: ['create', 'acme', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['create', '--json'],
  },
  {
    path: 'orgs rename',
    run: runOrgs,
    accepted: ['rename', 'acme', '--name', 'Acme', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['rename', 'acme', '--json'],
  },
  {
    path: 'orgs switch',
    run: runOrgs,
    accepted: ['switch', 'acme', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['switch', '--json'],
  },
  {
    path: 'orgs current',
    run: runOrgs,
    accepted: ['current', '--json'],
    acceptedExit: EXIT.OK,
    rejected: ['current', '--json'],
    prepareAccepted: (directory) => writeConfig({ defaultOrg: 'acme' }, directory),
  },
  {
    path: 'orgs inspect',
    run: runOrgs,
    accepted: ['inspect', 'acme', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['inspect', '--json'],
  },
  {
    path: 'orgs mcp-subdomain get',
    run: runOrgs,
    accepted: ['mcp-subdomain', 'get', '--org', 'acme', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['mcp-subdomain', 'get', 'extra', '--org', 'acme', '--json'],
  },
  {
    path: 'orgs mcp-subdomain set',
    run: runOrgs,
    accepted: ['mcp-subdomain', 'set', 'new-acme', '--org', 'acme', '--yes', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['mcp-subdomain', 'set', '--org', 'acme', '--yes', '--json'],
  },
  {
    path: 'orgs openai-challenge get',
    run: runOrgs,
    accepted: ['openai-challenge', 'get', 'acme', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['openai-challenge', 'get', '--json'],
  },
  {
    path: 'orgs openai-challenge set',
    run: runOrgs,
    accepted: ['openai-challenge', 'set', 'acme', '--code', 'proof', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['openai-challenge', 'set', 'acme', '--json'],
  },
  {
    path: 'orgs openai-challenge clear',
    run: runOrgs,
    accepted: ['openai-challenge', 'clear', 'acme', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['openai-challenge', 'clear', '--json'],
  },
  {
    path: 'members list',
    run: runMembers,
    accepted: ['list', '--org', 'acme', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['list', '--json'],
  },
  {
    path: 'members add',
    run: runMembers,
    accepted: [
      'add',
      '--org',
      'acme',
      '--subject',
      'subject-1',
      '--email',
      'a@example.com',
      '--json',
    ],
    acceptedExit: EXIT.AUTH,
    rejected: ['add', '--org', 'acme', '--json'],
    missingOrg: ['add', '--subject', 'subject-1', '--email', 'a@example.com', '--json'],
  },
  {
    path: 'members remove',
    run: runMembers,
    accepted: ['remove', '--org', 'acme', '--subject', 'subject-1', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['remove', '--org', 'acme', '--json'],
    missingOrg: ['remove', '--subject', 'subject-1', '--json'],
  },
  {
    path: 'members set-role',
    run: runMembers,
    accepted: ['set-role', '--org', 'acme', '--subject', 'subject-1', '--role', 'owner', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['set-role', '--org', 'acme', '--subject', 'subject-1', '--role', 'viewer', '--json'],
    missingOrg: ['set-role', '--subject', 'subject-1', '--role', 'owner', '--json'],
  },
  {
    path: 'members invitations',
    run: runMembers,
    accepted: ['invitations', '--org', 'acme', '--all', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['invitations', '--json'],
  },
  {
    path: 'members revoke',
    run: runMembers,
    accepted: ['revoke', '--org', 'acme', '--email', 'a@example.com', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['revoke', '--org', 'acme', '--json'],
    missingOrg: ['revoke', '--email', 'a@example.com', '--json'],
  },
  {
    path: 'github connect',
    run: runGithub,
    accepted: ['connect', '--org', 'acme', '--app', 'app', '--repo', 'acme/app', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['connect', '--json'],
  },
  {
    path: 'github status',
    run: runGithub,
    accepted: ['status', '--org', 'acme', '--app', 'app', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['status', '--json'],
  },
  {
    path: 'github disconnect',
    run: runGithub,
    accepted: ['disconnect', '--org', 'acme', '--app', 'app', '--yes', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['disconnect', '--json'],
  },
  {
    path: 'github runs',
    run: runGithub,
    accepted: ['runs', '--org', 'acme', '--app', 'app', '--limit', '1', '--json'],
    acceptedExit: EXIT.AUTH,
    rejected: ['runs', '--json'],
  },
];

describe('tenant resource recursive leaf parser parity', () => {
  it.each(
    cases,
  )('$path accepts its real grammar and rejects an invalid invocation', async (entry) => {
    entry.prepareAccepted?.(home);
    expect(await entry.run(entry.accepted, {}, home), `${entry.path} accepted`).toBe(
      entry.acceptedExit,
    );

    const rejectedHome = mkdtempSync(join(tmpdir(), 'noodle-tenant-catalog-rejected-'));
    try {
      log.mockClear();
      error.mockClear();
      expect(await entry.run(entry.rejected, {}, rejectedHome), `${entry.path} rejected`).toBe(
        EXIT.USAGE,
      );
    } finally {
      rmSync(rejectedHome, { recursive: true, force: true });
    }
  });

  it.each([
    ['0'],
    ['-1'],
    ['1.5'],
    ['not-a-number'],
  ])('github runs permissively treats --limit %s as omitted', async (limit) => {
    expect(
      await runGithub(
        ['runs', '--org', 'acme', '--app', 'app', '--limit', limit, '--json'],
        {},
        home,
      ),
    ).toBe(EXIT.AUTH);
  });

  it.each(
    cases.filter((entry) => entry.path.startsWith('members ')),
  )('$path rejects a complete invocation without --org', async (entry) => {
    const missingOrg = entry.missingOrg ?? entry.rejected;
    expect(await entry.run(missingOrg, {}, home)).toBe(EXIT.USAGE);
    expect(lastEnvelope()).toMatchObject({ error: { code: 'target_required' } });
  });

  it.each([
    ['apps inspect', runApps, ['inspect', 'app', '--org', 'acme', '--archived', '--json']],
    ['apps open', runApps, ['open', 'app', '--org', 'acme', '--archived', '--json']],
    [
      'envs inspect',
      runEnvs,
      ['inspect', 'prod', '--org', 'acme', '--app', 'app', '--archived', '--json'],
    ],
    [
      'envs set-production',
      runEnvs,
      ['set-production', 'prod', '--org', 'acme', '--app', 'app', '--archived', '--json'],
    ],
    [
      'deployments inspect',
      runDeployments,
      [
        'inspect',
        'deployment-1',
        '--org',
        'acme',
        '--app',
        'app',
        '--env',
        'prod',
        '--archived',
        '--json',
      ],
    ],
  ] as const)('%s keeps ignored compatibility flags runtime-neutral', async (_path, run, args) => {
    expect(await run(args, {}, home)).toBe(EXIT.AUTH);
  });
});
