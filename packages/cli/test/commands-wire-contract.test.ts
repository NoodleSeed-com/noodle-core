import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandSpec, SubcommandSpec } from '../src/commands/catalog.js';
import { EXIT } from '../src/commands/output.js';
import { run } from '../src/index.js';
import { assertJsonEnvelope } from './helpers/json-envelope.js';

interface CommandsPayload {
  readonly commands: readonly CommandSpec[];
  readonly exitCodes: Readonly<Record<string, string>>;
  version: string;
}

function leafPaths(commands: readonly CommandSpec[]): readonly string[] {
  const paths: string[] = [];
  const visit = (subcommands: readonly SubcommandSpec[], prefix: readonly string[]): void => {
    for (const subcommand of subcommands) {
      const path = [...prefix, subcommand.name];
      if ((subcommand.subcommands?.length ?? 0) > 0) {
        visit(subcommand.subcommands ?? [], path);
      } else {
        paths.push(path.join(' '));
      }
    }
  };
  for (const command of commands) {
    if (command.removed !== undefined) continue;
    if ((command.subcommands?.length ?? 0) > 0) {
      if (command.arguments.length > 0) paths.push(command.name);
      visit(command.subcommands ?? [], [command.name]);
    } else {
      paths.push(command.name);
    }
  }
  return paths;
}

let home: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-commands-wire-'));
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  rmSync(home, { recursive: true, force: true });
});

describe('commands --json public wire contract', () => {
  it('writes one complete JsonEnvelope to stdout and snapshots every recursive leaf', async () => {
    expect(await run(['commands', '--json'], {}, home)).toBe(EXIT.OK);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);

    const serialized = String(logSpy.mock.calls[0]?.[0]);
    expect(serialized.split('\n')).toHaveLength(1);
    const envelope = assertJsonEnvelope<CommandsPayload>(JSON.parse(serialized));
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) throw new Error('commands --json returned a failure envelope');

    expect(envelope.data.commands).toHaveLength(63);
    const paths = leafPaths(envelope.data.commands);
    expect(paths).toHaveLength(228);
    expect(paths).toContain('deploy');
    expect(paths).toContain('deploy preflight');
    expect(paths).toContain('service app-purge preview');
    expect(paths).toContain('service app-purge apply');
    expect(paths).toContain('assistant appearance show');
    expect(paths).toContain('assistant appearance apply');
    expect(paths).toContain('assistant appearance reset');
    expect(paths).toContain('import mcp');
    expect(paths).toContain('assistant usage');
    expect(paths).toContain('assistant sponsorship inspect');
    expect(paths).toContain('assistant sponsorship grant');
    expect(paths).toContain('assistant sponsorship revoke');
    expect(paths).toContain('intents status');
    expect(paths).toContain('intents enable');
    expect(paths).toContain('intents disable');
    expect(paths).toContain('intents list');
    expect(paths).toContain('intents purge');
    expect(paths).toContain('export plugin openai');
    expect(paths).toContain('export plugin claude');
    expect(paths).toContain('export connector claude');
    expect(paths).toContain('design inspect');
    expect(paths).toContain('deployments lock');
    expect(paths).toContain('deployments package');
    expect(paths).toContain('deployments unlock');
    expect(paths).toContain('distributions publish');
    expect(paths).toContain('distributions download');
    expect(paths).toContain('distributions revoke');
    expect(paths).toContain('distributions grant');
    expect(paths).toContain('auth google prepare');
    expect(paths).toContain('auth service-principals create-secret');
    expect(paths).toContain('orgs mcp-subdomain get');
    expect(paths).toContain('orgs mcp-subdomain set');
    expect(paths).toContain('orgs openai-challenge clear');
    expect(paths).toContain('solutions catalog');
    expect(paths).toContain('solutions records export');
    expect(paths.filter((path) => path.startsWith('platform-auth account-reset'))).toEqual([
      'platform-auth account-reset preview',
      'platform-auth account-reset status',
      'platform-auth account-reset quarantine',
      'platform-auth account-reset rollback',
      'platform-auth account-reset finalize',
    ]);
    expect(envelope.data.exitCodes).toEqual({
      0: 'success',
      1: 'domain/runtime failure (the request ran but did not succeed)',
      2: 'usage error, missing target, or headless missing-answer',
      3: 'authentication/authorization failure (HTTP 401/403)',
      4: 'service unreachable (network error)',
      5: 'MCP/tool-call smoke failure',
    });

    envelope.data.version = '<version>';
    expect(JSON.parse(JSON.stringify(envelope))).toMatchSnapshot();
  });
});
