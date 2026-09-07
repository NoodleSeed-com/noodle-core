import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATALOG, type FlagSpec, type SubcommandSpec } from '../src/commands/catalog.js';
import { run } from '../src/index.js';
import { chdirIsolated, restoreCwd } from './helpers/isolated-cwd.js';
import { assertJsonEnvelope } from './helpers/json-envelope.js';

const HANDLER_FAMILY_SURFACES = {
  commands: ['commands'],
  features: ['features'],
  start: ['start'],
  init: ['init'],
  setup: ['setup'],
  import_mcp: ['import mcp'],
  doctor: ['doctor'],
  agents: ['agents setup', 'agents doctor'],
  auth: [
    'auth doctor',
    'auth google prepare',
    'auth google status',
    'auth google doctor',
    'auth google revoke',
    'auth service-principals create',
    'auth service-principals list',
    'auth service-principals show',
    'auth service-principals grant',
    'auth service-principals revoke-grant',
    'auth service-principals add-jwk',
    'auth service-principals create-secret',
    'auth service-principals revoke-credential',
    'auth service-principals revoke',
  ],
  connect: [
    'connect claude-code',
    'connect codex',
    'connect gemini',
    'connect gemini-enterprise',
    'connect cursor',
    'connect vscode',
    'connect claude',
    'connect chatgpt',
    'connect inspector',
  ],
  validate: ['validate'],
  check: ['check'],
  export_distribution: ['export plugin openai', 'export plugin claude', 'export connector claude'],
  local_test: ['test'],
  local_smoke: ['tools list', 'tools call', 'resources read', 'prompts get'],
  design: ['design inspect'],
  update: ['update'],
  platform_auth: [
    'platform-auth migration inventory',
    'platform-auth migration preview',
    'platform-auth migration status',
    'platform-auth migration start-import',
    'platform-auth migration reconcile',
    'platform-auth migration recover-outbox',
    'platform-auth migration activate',
    'platform-auth migration rollback',
    'platform-auth migration finalize',
    'platform-auth account-reset preview',
    'platform-auth account-reset status',
    'platform-auth account-reset quarantine',
    'platform-auth account-reset rollback',
    'platform-auth account-reset finalize',
  ],
  billing: [
    'billing catalog status',
    'billing catalog activate',
    'billing accounts list',
    'billing accounts inspect',
    'billing accounts checkout',
    'billing accounts portal',
    'billing org inspect',
    'billing org transfer candidates',
    'billing org transfer preview',
    'billing org transfer apply',
    'billing administration transfer preview',
    'billing administration transfer apply',
    'billing enforcement cohort status',
    'billing enforcement cohort seal',
    'billing enforcement activation status',
    'billing enforcement activation preview',
    'billing enforcement activation activate',
    'billing enforcement activation rollback',
    'billing metering readiness',
    'billing metering validation prepare',
    'billing metering validation retire',
    'billing migration preview',
    'billing migration apply',
  ],
  assistant: [
    'assistant doctor',
    'assistant appearance show',
    'assistant appearance apply',
    'assistant appearance reset',
    'assistant clients create',
    'assistant clients list',
    'assistant clients rotate',
    'assistant clients revoke',
    'assistant embed',
    'assistant embeds list',
    'assistant budget set',
    'assistant sponsorship inspect',
    'assistant sponsorship grant',
    'assistant sponsorship revoke',
    'assistant usage',
  ],
  audit: ['audit status', 'audit events'],
  knowledge: ['knowledge list', 'knowledge status', 'knowledge refresh'],
  logs: ['logs'],
  analytics: ['metrics', 'events'],
  alerts: ['alerts add', 'alerts list', 'alerts remove', 'alerts test'],
  intents: ['intents status', 'intents enable', 'intents disable', 'intents list', 'intents purge'],
  policy: [
    'policy status',
    'policy list',
    'policy show',
    'policy effective',
    'policy simulate',
    'policy suspend',
    'policy resume',
    'policy deny',
    'policy quota',
    'policy rate',
    'policy usage',
    'policy apply',
    'policy delete',
    'policy plan show',
    'policy plan set',
    'policy plan suspend',
  ],
  deploy: ['deploy', 'deploy preflight'],
  deploy_status: ['status', 'rollback', 'access set'],
  diagnostics: ['inspect', 'smoke'],
  archive: ['archive', 'restore'],
  apps: ['apps list', 'apps inspect', 'apps open'],
  envs: ['envs list', 'envs inspect', 'envs set-production'],
  deployments: [
    'deployments list',
    'deployments inspect',
    'deployments package',
    'deployments lock',
    'deployments unlock',
  ],
  distributions: [
    'distributions publish',
    'distributions list',
    'distributions inspect',
    'distributions download',
    'distributions readiness',
    'distributions review',
    'distributions release',
    'distributions rollback',
    'distributions deprecate',
    'distributions revoke',
    'distributions grant',
  ],
  service_capabilities: ['service capabilities'],
  service_doctor: ['service doctor'],
  app_purge: ['service app-purge preview', 'service app-purge apply'],
  solutions: [
    'solutions installation-options',
    'solutions agreement get',
    'solutions agreement accept',
    'solutions notice get',
    'solutions notice set',
    'solutions activity list',
    'solutions activity export',
    'solutions activity preview',
    'solutions activity settings get',
    'solutions activity settings set',
    'solutions connections list',
    'solutions connections connect',
    'solutions connections disconnect',
    'solutions records migrate-schema',
    'solutions catalog',
    'solutions list',
    'solutions install',
    'solutions inspect',
    'solutions pause',
    'solutions resume',
    'solutions grants list',
    'solutions grants set',
    'solutions grants revoke',
    'solutions invitations list',
    'solutions invitations create',
    'solutions invitations revoke',
    'solutions invitations accept',
    'solutions records list',
    'solutions records create',
    'solutions records get',
    'solutions records update',
    'solutions records assign',
    'solutions records status',
    'solutions records note',
    'solutions records activity',
    'solutions records delete',
    'solutions records export',
    'solutions sources show',
    'solutions sources configure',
    'solutions sources pause',
    'solutions sources resume',
    'solutions sources refresh',
  ],
  feedback: ['feedback'],
  org_admin: [
    'orgs list',
    'orgs create',
    'orgs rename',
    'orgs switch',
    'orgs current',
    'orgs inspect',
    'orgs domains list',
    'orgs domains add',
    'orgs domains remove',
    'orgs mcp-subdomain get',
    'orgs mcp-subdomain set',
    'orgs openai-challenge get',
    'orgs openai-challenge set',
    'orgs openai-challenge clear',
    'members list',
    'members add',
    'members remove',
    'members set-role',
    'members invitations',
    'members revoke',
  ],
  github: ['github connect', 'github status', 'github disconnect', 'github runs'],
  target: ['target show', 'target set'],
  config_values: [
    'secrets set',
    'secrets list',
    'secrets delete',
    'secrets resolve',
    'variables set',
    'variables list',
    'variables delete',
    'variables resolve',
  ],
} as const;

type HandlerFamily = keyof typeof HANDLER_FAMILY_SURFACES;

const HANDLER_FAMILY_BY_SURFACE = new Map<string, HandlerFamily>(
  Object.entries(HANDLER_FAMILY_SURFACES).flatMap(([family, surfaces]) =>
    surfaces.map((surface) => [surface, family as HandlerFamily]),
  ),
);

function declaresJson(flags: readonly FlagSpec[] | undefined, usage?: string): boolean {
  return flags?.some((flag) => flag.name === 'json') === true || usage?.includes('--json') === true;
}

function activeJsonSubcommandSurfaces(
  parent: string,
  subcommands: readonly SubcommandSpec[],
  inheritedJson: boolean,
): readonly string[] {
  return subcommands.flatMap((subcommand) => {
    const path = `${parent} ${subcommand.name}`;
    const json = inheritedJson || declaresJson(subcommand.flags, subcommand.usage);
    if (subcommand.subcommands !== undefined && subcommand.subcommands.length > 0) {
      return activeJsonSubcommandSurfaces(path, subcommand.subcommands, json);
    }
    return json ? [path] : [];
  });
}

function activeJsonSurfaces(): readonly string[] {
  return CATALOG.flatMap((entry) => {
    if (entry.removed !== undefined) return [];
    const parentJson = declaresJson(entry.flags, entry.usage);
    if (entry.subcommands === undefined) return parentJson ? [entry.name] : [];
    // An entrypoint-bearing parent (deploy) remains executable alongside its named subcommands.
    return [
      ...(parentJson && entry.arguments.length > 0 ? [entry.name] : []),
      ...activeJsonSubcommandSurfaces(entry.name, entry.subcommands, parentJson),
    ];
  });
}

/**
 * Bare handler probes intentionally preserve each surface's established exit code. Usage is the
 * common case (2); this table makes every non-usage result explicit, including successful local
 * read-only commands and the standard auth/service/update failure classes.
 */
const EXPECTED_EXIT_OVERRIDES = new Map<string, number>([
  ...[
    'commands',
    'features',
    'init',
    'setup',
    'agents setup',
    'agents doctor',
    'connect claude-code',
    'connect codex',
    'connect gemini',
    'connect cursor',
    'connect vscode',
    'connect claude',
    'connect chatgpt',
    'connect inspector',
    'assistant embed',
    'deployments list',
    'service doctor',
    'target show',
    'target set',
    'secrets list',
    'secrets resolve',
    'variables list',
    'variables resolve',
  ].map((surface) => [surface, 0] as const),
  ...[
    'doctor',
    'policy status',
    'policy list',
    'policy show',
    'policy effective',
    'policy simulate',
    'policy suspend',
    'policy resume',
    'policy deny',
    'policy quota',
    'policy rate',
    'policy usage',
    'policy apply',
    'policy delete',
  ].map((surface) => [surface, 1] as const),
  ...[
    'platform-auth migration inventory',
    'platform-auth migration status',
    'billing accounts list',
    'billing enforcement cohort status',
    'billing catalog status',
    'billing enforcement activation status',
    'billing metering readiness',
    'billing migration preview',
  ].map((surface) => [surface, 3] as const),
  ['orgs list', 3],
  ...['audit status', 'service capabilities'].map((surface) => [surface, 4] as const),
  ['solutions catalog', 4],
  ['solutions installation-options', 3],
  ...[
    'solutions list',
    'solutions install',
    'solutions inspect',
    'solutions pause',
    'solutions resume',
    'solutions grants list',
    'solutions grants set',
    'solutions grants revoke',
    'solutions invitations list',
    'solutions invitations create',
    'solutions invitations revoke',
    'solutions invitations accept',
    'solutions records list',
    'solutions records create',
    'solutions records get',
    'solutions records update',
    'solutions records assign',
    'solutions records status',
    'solutions records note',
    'solutions records activity',
    'solutions records delete',
    'solutions records export',
    'solutions records migrate-schema',
    'solutions sources show',
    'solutions sources configure',
    'solutions sources pause',
    'solutions sources resume',
    'solutions sources refresh',
  ].map((surface) => [surface, 3] as const),
  ['update', 14],
]);

const HANDLER_CASES = [...HANDLER_FAMILY_BY_SURFACE].map(([surface, family]) => ({
  surface,
  family,
  // Exercise init's real handler without giving this output-only audit registry authority.
  argv: [...surface.split(' '), ...(surface === 'init' ? ['--no-install'] : []), '--json'],
  expectedExit: EXPECTED_EXIT_OVERRIDES.get(surface) ?? 2,
}));

/**
 * Catalog entries with nested grammars dispatch to more than one output implementation. These
 * probes reach each nested handler through a deterministic, side-effect-free missing-input/auth
 * branch; fetch is blocked by the suite harness as a final safety boundary.
 */
const NESTED_HANDLER_CASES = [
  {
    implementation: 'solutions_activity_export',
    argv: ['solutions', 'activity', 'export', 'installation', '--org', 'organization', '--json'],
    exit: 3,
  },
  {
    implementation: 'solutions_activity_preview',
    argv: ['solutions', 'activity', 'preview', 'installation', '--org', 'organization', '--json'],
    exit: 3,
  },
  { implementation: 'auth_google_prepare', argv: ['auth', 'google', 'prepare', '--json'], exit: 2 },
  { implementation: 'auth_google_status', argv: ['auth', 'google', 'status', '--json'], exit: 2 },
  { implementation: 'auth_google_doctor', argv: ['auth', 'google', 'doctor', '--json'], exit: 2 },
  { implementation: 'auth_google_revoke', argv: ['auth', 'google', 'revoke', '--json'], exit: 2 },
  {
    implementation: 'billing_accounts_list',
    argv: ['billing', 'accounts', 'list', '--json'],
    exit: 3,
  },
  {
    implementation: 'billing_accounts_inspect',
    argv: ['billing', 'accounts', 'inspect', '--json'],
    exit: 2,
  },
  {
    implementation: 'billing_accounts_checkout',
    argv: ['billing', 'accounts', 'checkout', '--json'],
    exit: 2,
  },
  {
    implementation: 'billing_accounts_portal',
    argv: ['billing', 'accounts', 'portal', '--json'],
    exit: 2,
  },
  { implementation: 'billing_org_inspect', argv: ['billing', 'org', 'inspect', '--json'], exit: 2 },
  {
    implementation: 'billing_cohort_status',
    argv: ['billing', 'enforcement', 'cohort', 'status', '--json'],
    exit: 3,
  },
  {
    implementation: 'billing_cohort_seal',
    argv: ['billing', 'enforcement', 'cohort', 'seal', '--json'],
    exit: 2,
  },
  {
    implementation: 'billing_activation_status',
    argv: ['billing', 'enforcement', 'activation', 'status', '--json'],
    exit: 3,
  },
  {
    implementation: 'billing_activation_preview',
    argv: ['billing', 'enforcement', 'activation', 'preview', '--json'],
    exit: 2,
  },
  {
    implementation: 'billing_activation_activate',
    argv: ['billing', 'enforcement', 'activation', 'activate', '--json'],
    exit: 2,
  },
  {
    implementation: 'billing_activation_rollback',
    argv: ['billing', 'enforcement', 'activation', 'rollback', '--json'],
    exit: 2,
  },
  {
    implementation: 'billing_metering_readiness',
    argv: ['billing', 'metering', 'readiness', '--json'],
    exit: 3,
  },
  {
    implementation: 'billing_metering_validation_prepare',
    argv: ['billing', 'metering', 'validation', 'prepare', '--json'],
    exit: 2,
  },
  {
    implementation: 'billing_metering_validation_retire',
    argv: ['billing', 'metering', 'validation', 'retire', '--json'],
    exit: 2,
  },
  {
    implementation: 'billing_migration_preview',
    argv: ['billing', 'migration', 'preview', '--json'],
    exit: 3,
  },
  {
    implementation: 'billing_migration_apply',
    argv: ['billing', 'migration', 'apply', '--json'],
    exit: 2,
  },
  {
    implementation: 'billing_org_transfer_candidates',
    argv: ['billing', 'org', 'transfer', 'candidates', '--json'],
    exit: 2,
  },
  {
    implementation: 'billing_org_transfer_preview',
    argv: ['billing', 'org', 'transfer', 'preview', '--json'],
    exit: 2,
  },
  {
    implementation: 'billing_org_transfer_apply',
    argv: ['billing', 'org', 'transfer', 'apply', '--json'],
    exit: 2,
  },
  {
    implementation: 'billing_administration_transfer_preview',
    argv: ['billing', 'administration', 'transfer', 'preview', '--json'],
    exit: 2,
  },
  {
    implementation: 'billing_administration_transfer_apply',
    argv: ['billing', 'administration', 'transfer', 'apply', '--json'],
    exit: 2,
  },
  {
    implementation: 'assistant_clients_create',
    argv: ['assistant', 'clients', 'create', '--json'],
    exit: 2,
  },
  {
    implementation: 'assistant_clients_list',
    argv: ['assistant', 'clients', 'list', '--json'],
    exit: 2,
  },
  {
    implementation: 'assistant_clients_rotate',
    argv: ['assistant', 'clients', 'rotate', '--json'],
    exit: 2,
  },
  {
    implementation: 'assistant_clients_revoke',
    argv: ['assistant', 'clients', 'revoke', '--json'],
    exit: 2,
  },
  {
    implementation: 'service_asset_doctor',
    argv: ['service', 'doctor', '--assets', '--json'],
    exit: 1,
  },
  {
    implementation: 'platform_auth_inventory',
    argv: ['platform-auth', 'migration', 'inventory', '--json'],
    exit: 3,
  },
  {
    implementation: 'platform_auth_status',
    argv: ['platform-auth', 'migration', 'status', '--json'],
    exit: 3,
  },
  {
    implementation: 'platform_auth_preview',
    argv: ['platform-auth', 'migration', 'preview', '--json'],
    exit: 2,
  },
  ...['start-import', 'reconcile', 'recover-outbox', 'activate', 'rollback', 'finalize'].map(
    (action) => ({
      implementation: `platform_auth_${action.replace('-', '_')}`,
      argv: ['platform-auth', 'migration', action, '--json'],
      exit: 2,
    }),
  ),
] as const;

let home: string;
let project: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
let stderrWriteSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-handler-audit-home-'));
  project = mkdtempSync(join(tmpdir(), 'noodle-handler-audit-project-'));
  chdirIsolated(project);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockRejectedValue(new Error('handler audit forbids real network access')),
  );
});

afterEach(() => {
  restoreCwd();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function stdoutLines(): readonly string[] {
  return [
    ...logSpy.mock.calls.map((call) => String(call[0])),
    ...stdoutWriteSpy.mock.calls.flatMap((call) =>
      String(call[0])
        .split('\n')
        .filter((line) => line.length > 0),
    ),
  ];
}

describe('handler-reaching JSON output audit', () => {
  it('maps every active JSON catalog surface to exactly one implementation family', () => {
    expect([...HANDLER_FAMILY_BY_SURFACE.keys()].sort()).toEqual([...activeJsonSurfaces()].sort());
    expect(new Set(HANDLER_CASES.map((entry) => entry.family))).toEqual(
      new Set(Object.keys(HANDLER_FAMILY_SURFACES)),
    );
  });

  it.each(HANDLER_CASES)('$surface reaches $family with machine-safe output', async (entry) => {
    const exitCode = await run(entry.argv, { NOODLE_UPDATE_MODE: 'off' }, home);

    expect(exitCode).toBe(entry.expectedExit);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(stderrWriteSpy).not.toHaveBeenCalled();
    const lines = stdoutLines();
    expect(lines).toHaveLength(1);
    for (const line of lines) assertJsonEnvelope(JSON.parse(line));
  });

  it.each(
    NESTED_HANDLER_CASES,
  )('$implementation reaches its nested output implementation', async (entry) => {
    const exitCode = await run(entry.argv, { NOODLE_UPDATE_MODE: 'off' }, home);

    expect(exitCode).toBe(entry.exit);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(stderrWriteSpy).not.toHaveBeenCalled();
    const lines = stdoutLines();
    expect(lines).toHaveLength(1);
    for (const line of lines) assertJsonEnvelope(JSON.parse(line));
  });
});
