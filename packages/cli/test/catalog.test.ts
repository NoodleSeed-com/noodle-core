import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FEEDBACK_AREAS,
  FEEDBACK_MESSAGE_MAX,
  FEEDBACK_TITLE_MAX,
} from '@noodle-borg/wire-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATALOG, closestCommands, STANDARD_EXIT_CODES } from '../src/commands/catalog.js';
import { renderCommandHelp, renderUsageText } from '../src/commands/catalog-render.js';
import { EXIT } from '../src/commands/output.js';
import { run } from '../src/index.js';

/**
 * The CLI's declarative command catalog (`commands/catalog.ts` + `catalog-data-*.ts` +
 * `catalog-render.ts`): the single source `usage()`, per-command `--help`,
 * `noodle commands --json`, and did-you-mean suggestions all render from.
 */

const here = import.meta.dirname;
const cliSourcePath = join(here, '..', 'src', 'cli.ts');

/**
 * Extract the canonical set of top-level command names dispatched by `cli.ts`'s
 * `switch (command) { ... }`, collapsing alias groups (e.g. `--help`/`-h`/`help`) to one
 * canonical name (the plain word, or the last label if every alias in the group has dashes).
 * This is the anti-drift lock: every name here must have a catalog entry, and vice versa.
 */
function extractSwitchCaseNames(source: string): string[] {
  const names: string[] = [];
  let pending: string[] = [];
  for (const line of source.split('\n')) {
    const match = /^\s*case\s+'([^']+)':\s*$/.exec(line);
    if (match?.[1] !== undefined) {
      pending.push(match[1]);
      continue;
    }
    if (pending.length > 0) {
      const canonical = pending.find((label) => !label.startsWith('-')) ?? pending.at(-1);
      if (canonical !== undefined) names.push(canonical);
      pending = [];
    }
  }
  return names;
}

let home: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-catalog-cli-'));
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  rmSync(home, { recursive: true, force: true });
});

function stdout(): string {
  return logSpy.mock.calls.map((call) => String(call[0])).join('\n');
}
function stderr(): string {
  return errSpy.mock.calls.map((call) => String(call[0])).join('\n');
}

describe('command catalog completeness (anti-drift lock)', () => {
  it('has exactly one catalog entry per case in cli.ts dispatch switch, and vice versa', () => {
    const cliSource = readFileSync(cliSourcePath, 'utf8');
    const switchNames = new Set(extractSwitchCaseNames(cliSource));
    const catalogNames = new Set(CATALOG.map((entry) => entry.name));
    expect([...catalogNames].sort()).toEqual([...switchNames].sort());
  });

  it('gives every non-removed entry a non-empty summary', () => {
    for (const entry of CATALOG) {
      expect(entry.summary.length, `catalog entry "${entry.name}" has no summary`).toBeGreaterThan(
        0,
      );
    }
  });

  it('keeps commands --json exit codes in parity with the runtime taxonomy', () => {
    expect(Object.keys(STANDARD_EXIT_CODES).map(Number).sort()).toEqual(
      Object.values(EXIT).sort((left, right) => left - right),
    );
  });
});

describe('noodle commands', () => {
  it('prints a compact human list by default', async () => {
    expect(await run(['commands'], {}, home)).toBe(0);
    const printed = stdout();
    expect(printed).toContain('apps');
    expect(printed).toContain('deploy');
    expect(printed).toContain('--help');
  });

  it('--json emits the full machine-readable catalog envelope', async () => {
    expect(await run(['commands', '--json'], {}, home)).toBe(0);
    const body = JSON.parse(stdout()) as {
      ok: boolean;
      data: {
        commands: Array<{
          name: string;
          summary: string;
          flags?: Array<{ name: string }>;
          removed?: { use: string };
        }>;
        exitCodes: Record<string, string>;
        version: string;
      };
    };
    expect(body.ok).toBe(true);
    expect(typeof body.data.version).toBe('string');
    expect(body.data.exitCodes['0']).toBeDefined();
    expect(body.data.exitCodes['1']).toBeDefined();
    expect(body.data.exitCodes['2']).toBeDefined();
    expect(body.data.exitCodes['3']).toBeDefined();
    expect(body.data.exitCodes['4']).toBeDefined();

    const apps = body.data.commands.find((c) => c.name === 'apps');
    expect(apps).toBeDefined();
    expect(apps?.flags === undefined ? true : Array.isArray(apps.flags)).toBe(true);

    const list = body.data.commands.find((c) => c.name === 'list');
    expect(list?.removed?.use).toBe('noodle deployments list');
  });
});

describe('per-command --help', () => {
  it.each([
    ['deploy', '--help', '--json'],
    ['apps', 'list', '--help', '--json'],
  ])('rejects JSON help canonically for %s', async (...argv) => {
    expect(await run(argv, {}, home)).toBe(2);
    expect(stderr()).toBe('');
    expect(JSON.parse(stdout())).toMatchObject({
      ok: false,
      error: { code: 'unsupported_json_help' },
    });
  });

  it('rejects duplicate --json before help precedence', async () => {
    expect(await run(['features', '--help', '--json', '--json'], {}, home)).toBe(2);
    expect(stderr()).toBe('');
    expect(JSON.parse(stdout())).toMatchObject({
      ok: false,
      error: { code: 'duplicate_option' },
    });
  });

  it('noodle apps --help exits 0 and lists its subcommands', async () => {
    expect(await run(['apps', '--help'], {}, home)).toBe(0);
    const printed = stdout();
    expect(printed).toContain('list');
    expect(printed).toContain('inspect');
  });

  it('noodle apps (no subcommand) exits 2 with the same help body as --help', async () => {
    logSpy.mockClear();
    await run(['apps', '--help'], {}, home);
    const helpBody = stdout();

    logSpy.mockClear();
    errSpy.mockClear();
    expect(await run(['apps'], {}, home)).toBe(2);
    expect(stderr()).toBe(helpBody);
  });

  it('works uniformly for a non-resource dispatcher too (deploy --help)', async () => {
    expect(await run(['deploy', '--help'], {}, home)).toBe(0);
    expect(stdout()).toContain('server.ts');
  });

  it('documents cohort classification separately from explicit authoritative activation', async () => {
    expect(await run(['billing', '--help'], {}, home)).toBe(0);
    const printed = stdout();
    expect(printed).toContain('enforcement');
    expect(printed).toContain('cohort status');
    expect(printed).toContain('cohort seal');
    expect(printed).toContain('classification-only');
    expect(printed).toContain('activation status');
    expect(printed).toContain('activation preview');
    expect(printed).toContain('activation activate');
    expect(printed).toContain('activation rollback');
  });

  it('documents the complete feedback contract without duplicating the command name', async () => {
    expect(await run(['feedback', '--help'], {}, home)).toBe(0);
    const printed = stdout();
    expect(printed).toContain('USAGE  noodle feedback [<message>]');
    expect(printed).not.toContain('noodle feedback feedback');
    expect(printed).toContain(`1-${FEEDBACK_MESSAGE_MAX} characters`);
    expect(printed).toContain(`1-${FEEDBACK_TITLE_MAX} characters`);
    for (const area of FEEDBACK_AREAS) {
      expect(printed, `feedback help is missing area "${area}"`).toContain(area);
    }
  });

  it('renders recursive billing enforcement leaves as distinct subcommand rows', () => {
    const billing = CATALOG.find((entry) => entry.name === 'billing');
    if (billing === undefined) throw new Error('billing catalog entry is missing');
    const lines = renderCommandHelp(billing, { color: 'none', glyph: 'ascii' }).split('\n');
    const subcommandLines = lines.slice(lines.indexOf('SUBCOMMANDS') + 1);
    const statusLine = subcommandLines.find((line) => line.includes('enforcement cohort status'));
    const sealLine = subcommandLines.find((line) => line.includes('enforcement cohort seal'));
    const activationLine = subcommandLines.find((line) =>
      line.includes('enforcement activation activate'),
    );
    expect(statusLine).toMatch(/^ {2}enforcement cohort status/);
    expect(statusLine).toContain('classification-only cohort');
    expect(sealLine).toMatch(/^ {2}enforcement cohort seal/);
    expect(activationLine).toMatch(/^ {2}enforcement activation activate/);
  });
});

describe('did-you-mean for unknown commands', () => {
  it('suggests the closest command and exits 2', async () => {
    expect(await run(['deply'], {}, home)).toBe(2);
    expect(stderr()).toContain('Unknown command "deply"');
    expect(stderr()).toContain('deploy');
  });

  it('--json shape carries the unknown_command code and suggestions on stdout', async () => {
    expect(await run(['deply', '--json'], {}, home)).toBe(2);
    // `--json` failures go to stdout (where agent loops parse), not stderr.
    expect(stderr()).toBe('');
    const body = JSON.parse(stdout()) as {
      ok: boolean;
      error: { code: string; suggestions: string[] };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('unknown_command');
    expect(body.error.suggestions).toContain('deploy');
  });

  it('never suggests a removed verb', () => {
    expect(closestCommands('lst')).not.toContain('list');
  });

  it('bare `noodle --json` (a flag, no verb) points at the canonical `noodle commands --json` on stdout', async () => {
    expect(await run(['--json'], {}, home)).toBe(2);
    expect(stderr()).toBe('');
    const body = JSON.parse(stdout()) as {
      ok: boolean;
      error: { code: string; message: string; next: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('no_command');
    expect(body.error.next).toBe('noodle commands --json');
  });

  it('unknown subcommand of a dispatcher also gets a did-you-mean and exit 2', async () => {
    expect(await run(['apps', 'lsit'], {}, home)).toBe(2);
    expect(stderr()).toContain('list');
  });
});

describe('usage()', () => {
  const ESC = String.fromCharCode(27);
  const plain = (): string => renderUsageText({ color: 'none', glyph: 'ascii' });

  it('gives every catalog entry one of the six help sections', () => {
    const sections = new Set(['start', 'build', 'operate', 'github', 'resources', 'account']);
    for (const entry of CATALOG) {
      expect(sections.has(entry.section), `"${entry.name}" has invalid section`).toBe(true);
    }
  });

  it('renders every non-removed catalog name and the branded title', () => {
    const text = plain();
    for (const entry of CATALOG) {
      if (entry.removed !== undefined) continue;
      expect(text, `usage() is missing "${entry.name}"`).toContain(entry.name);
    }
    expect(text).toContain('noodle v');
    expect(text).toContain('author, deploy, and operate MCP apps');
    expect(text).toContain('usage: noodle <command>');
  });

  it('renders the six section headers in the approved order', () => {
    const text = plain();
    const headers = [
      'START HERE',
      'BUILD & TEST LOCALLY',
      'DEPLOY & OPERATE',
      'GITHUB - DEPLOY ON PUSH',
      'YOUR RESOURCES',
      'ACCOUNT & CONFIG',
    ];
    let last = -1;
    for (const header of headers) {
      const at = text.indexOf(header);
      expect(at, `usage() is missing section header "${header}"`).toBeGreaterThan(last);
      last = at;
    }
  });

  it('never renders a removed verb', () => {
    const text = plain();
    expect(text).not.toContain('(removed');
    expect(text).not.toContain('keys');
    // `list` only ever appears inside other summaries — never as its own command row.
    expect(text).not.toMatch(/^[|+] list\b/m);
  });

  it('caps each section at 5 command rows and collapses the rest into one +N more row', () => {
    const text = plain();
    // build: 11 commands -> validate..resources ranked into rows, the rest collapsed.
    expect(text).toContain('validate [<server.ts>]');
    expect(text).toContain('+6 more');
    const buildCollapse = text.split('\n').find((line) => line.includes('+6 more'));
    for (const verb of ['prompts', 'devtools', 'import', 'design', 'export', 'docs']) {
      expect(buildCollapse, `+6 more row is missing "${verb}"`).toContain(verb);
    }
    // A collapsed verb never gets its own row.
    expect(text).not.toMatch(/^[|+]\s*prompts\b/m);
    // operate has 19 commands including intents; account & config has 18.
    expect(text.match(/\+14 more/g)).toHaveLength(1);
    expect(text.match(/\+13 more/g)).toHaveLength(1);
  });

  it('renders the single-line footer', () => {
    const text = plain();
    expect(text).toContain('noodle <command> --help');
    expect(text).toContain('noodle commands --json');
    expect(text).toContain('docs.noodleseed.dev');
  });

  it('emits no ANSI escapes under color none, for both glyph modes', () => {
    expect(plain()).not.toContain(ESC);
    expect(renderUsageText({ color: 'none', glyph: 'unicode' })).not.toContain(ESC);
  });

  it('degrades the noodle-bowl brand mark to plain under ascii glyphs', () => {
    expect(renderUsageText({ color: 'truecolor', glyph: 'unicode' })).toContain('🍜');
    expect(renderUsageText({ color: 'truecolor', glyph: 'ascii' })).not.toContain('🍜');
    expect(renderUsageText({ color: 'truecolor', glyph: 'unicode' })).toContain(ESC);
  });

  it('is what `noodle --help` prints', async () => {
    expect(await run(['--help'], {}, home)).toBe(0);
    expect(stdout()).toBe(renderUsageText());
  });
});

describe('orgs catalog entry (switch/current/inspect/mcp-subdomain/openai-challenge)', () => {
  it('lists operational organization subcommands alongside list/create/rename', () => {
    const orgs = CATALOG.find((entry) => entry.name === 'orgs');
    expect(orgs).toBeDefined();
    const names = (orgs?.subcommands ?? []).map((sub) => sub.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'list',
        'create',
        'rename',
        'switch',
        'current',
        'inspect',
        'mcp-subdomain',
        'openai-challenge',
      ]),
    );
  });

  it('noodle orgs --help documents the new subcommands', async () => {
    expect(await run(['orgs', '--help'], {}, home)).toBe(0);
    const printed = stdout();
    expect(printed).toContain('switch');
    expect(printed).toContain('current');
    expect(printed).toContain('inspect');
    expect(printed).toContain('mcp-subdomain');
    expect(printed).toContain('openai-challenge');
  });
});

describe('doctor catalog entry', () => {
  it('documents a --json flag', () => {
    const doctor = CATALOG.find((entry) => entry.name === 'doctor');
    expect(doctor).toBeDefined();
    expect((doctor?.flags ?? []).some((flag) => flag.name === 'json')).toBe(true);
  });
});

/**
 * S4: exactly one canonical agent flag is advertised per use case. `--fix-prompt` and
 * `--agent-output` remain aliases in the parsers (both still work), but each command's discovery
 * surface (catalog data + `commands --json`) names only its canonical primary and never the other
 * spelling — so an agent sees one way to do the thing, not two.
 */
describe('canonical agent flag advertising (one flag per use case)', () => {
  const flagsBlob = (name: string): string =>
    JSON.stringify(CATALOG.find((entry) => entry.name === name)?.flags ?? []);

  it('validate advertises --fix-prompt and never names --agent-output', () => {
    const validate = CATALOG.find((entry) => entry.name === 'validate');
    expect((validate?.flags ?? []).some((flag) => flag.name === 'fix-prompt')).toBe(true);
    expect(flagsBlob('validate')).not.toContain('agent-output');
  });

  it('check advertises --fix-prompt and never names --agent-output', () => {
    const check = CATALOG.find((entry) => entry.name === 'check');
    expect((check?.flags ?? []).some((flag) => flag.name === 'fix-prompt')).toBe(true);
    expect(flagsBlob('check')).not.toContain('agent-output');
  });

  it('metrics advertises --agent-output and never names --fix-prompt', () => {
    const metrics = CATALOG.find((entry) => entry.name === 'metrics');
    expect((metrics?.flags ?? []).some((flag) => flag.name === 'agent-output')).toBe(true);
    expect(flagsBlob('metrics')).not.toContain('fix-prompt');
  });

  it('doctor advertises --agent-output and never names --fix-prompt', () => {
    const doctor = CATALOG.find((entry) => entry.name === 'doctor');
    expect((doctor?.flags ?? []).some((flag) => flag.name === 'agent-output')).toBe(true);
    expect(flagsBlob('doctor')).not.toContain('fix-prompt');
  });

  it('commands --json exposes the same one-flag-per-use-case surface', async () => {
    expect(await run(['commands', '--json'], {}, home)).toBe(0);
    const body = JSON.parse(stdout()) as {
      data: {
        commands: Array<{ name: string; flags?: Array<{ name: string; summary?: string }> }>;
      };
    };
    const validate = body.data.commands.find((c) => c.name === 'validate');
    expect((validate?.flags ?? []).some((flag) => flag.name === 'fix-prompt')).toBe(true);
    expect(JSON.stringify(validate?.flags ?? [])).not.toContain('agent-output');

    const metrics = body.data.commands.find((c) => c.name === 'metrics');
    expect((metrics?.flags ?? []).some((flag) => flag.name === 'agent-output')).toBe(true);
    expect(JSON.stringify(metrics?.flags ?? [])).not.toContain('fix-prompt');
  });
});

describe('feedback machine discovery', () => {
  it('exposes the complete area enum and length limits through commands --json', async () => {
    expect(await run(['commands', '--json'], {}, home)).toBe(0);
    const body = JSON.parse(stdout()) as {
      data: {
        commands: Array<{
          name: string;
          usage?: string;
          arguments?: Array<{ name: string; required: boolean }>;
          flags?: Array<{
            name: string;
            value?: string;
            constraints?: { minLength?: number; maxLength?: number; choices?: readonly string[] };
          }>;
        }>;
      };
    };
    const feedback = body.data.commands.find((command) => command.name === 'feedback');
    expect(feedback?.usage).toBeUndefined();
    expect(feedback?.arguments).toEqual([
      expect.objectContaining({ name: 'message', required: false }),
    ]);
    const flags = new Map((feedback?.flags ?? []).map((flag) => [flag.name, flag]));
    expect(flags.get('message')?.constraints).toMatchObject({
      minLength: 1,
      maxLength: FEEDBACK_MESSAGE_MAX,
    });
    expect(flags.get('title')?.constraints).toMatchObject({
      minLength: 1,
      maxLength: FEEDBACK_TITLE_MAX,
    });
    expect(flags.get('area')?.constraints?.choices).toEqual(FEEDBACK_AREAS);
    expect(flags.get('dry-run')).toMatchObject({ name: 'dry-run' });
  });
});

describe('renderCommandHelp', () => {
  const ESC = String.fromCharCode(27);
  const helpFor = (name: string): string => {
    const entry = CATALOG.find((candidate) => candidate.name === name);
    expect(entry, `no catalog entry for "${name}"`).toBeDefined();
    if (entry === undefined) throw new Error('unreachable');
    return renderCommandHelp(entry, { color: 'none', glyph: 'ascii' });
  };

  it('shows removal guidance for a removed verb', () => {
    const help = helpFor('list');
    expect(help).toContain('Removed');
    expect(help).toContain('noodle deployments list');
  });

  it('renders title, USAGE line, and one boxed flag table', () => {
    const help = helpFor('deploy');
    expect(help).toContain(
      'noodle deploy - Preflight required config, deploy your server, and verify its governed MCP URL is ready.',
    );
    expect(help).toContain('USAGE  noodle deploy [<server.ts>]');
    expect(help).toContain('FLAG');
    expect(help).toContain('--org <slug>');
    // one boxed table: exactly one top border in the block
    expect(help.split('\n').filter((line) => line.startsWith('+-')).length).toBe(3);
  });

  it('renders a NEXT line from the spec next field', () => {
    const deploy = helpFor('deploy');
    expect(deploy).toContain('NEXT');
    expect(deploy).toContain('noodle login then noodle deploy');
    expect(deploy).toContain('noodle github connect');
    expect(helpFor('status')).toContain('NEXT');
    expect(helpFor('logs')).toContain('NEXT');
    // no next field -> no NEXT line
    expect(helpFor('whoami')).not.toContain('NEXT');
  });

  it('still lists subcommands for a dispatcher', () => {
    const help = helpFor('apps');
    expect(help).toContain('SUBCOMMANDS');
    expect(help).toContain('list');
    expect(help).toContain('inspect');
  });

  it('renders a subcommand-level flag (e.g. tools call --args) under its subcommand', () => {
    const tools = helpFor('tools');
    expect(tools).toContain('call');
    expect(tools).toContain('--args <json>');
    expect(tools).toContain('Tool input as a JSON object.');

    const prompts = helpFor('prompts');
    expect(prompts).toContain('get');
    expect(prompts).toContain('--args <json>');
    expect(prompts).toContain('Prompt arguments as a JSON object.');
  });

  it('renders identical common flags once while preserving leaf flags and overrides', () => {
    const occurrences = (text: string, token: string): number =>
      text
        .split('\n')
        .map((line) => line.replace(/^[\s|]+/, ''))
        .filter((line) => line.startsWith(`${token} `) || line === token).length;

    const tools = helpFor('tools');
    expect(occurrences(tools, '--json')).toBe(1);
    expect(occurrences(tools, '--connectors')).toBe(1);
    expect(occurrences(tools, '--args')).toBe(1);

    const github = helpFor('github');
    expect(occurrences(github, '--json')).toBe(2);
    expect(occurrences(github, '--limit')).toBe(1);
    expect(github).toContain('conflicts: --watch');
  });

  it('keeps the additional exit codes and local notes', () => {
    const update = helpFor('update');
    expect(update).toContain('EXIT CODES');
    expect(update).toContain('10');
    expect(update).toContain('Runs locally');
  });

  it('emits no ANSI escapes under color none', () => {
    expect(helpFor('deploy')).not.toContain(ESC);
    expect(helpFor('apps')).not.toContain(ESC);
  });

  it('degrades the brand mark under ascii glyphs but keeps it for unicode', () => {
    const entry = CATALOG.find((candidate) => candidate.name === 'deploy');
    if (entry === undefined) throw new Error('unreachable');
    expect(renderCommandHelp(entry, { color: 'truecolor', glyph: 'unicode' })).toContain('🍜');
    expect(renderCommandHelp(entry, { color: 'truecolor', glyph: 'ascii' })).not.toContain('🍜');
  });
});
