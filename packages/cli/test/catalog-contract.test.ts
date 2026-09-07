import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../../../scripts/gen-docs-reference.mjs';
import {
  CATALOG,
  type CommandSpec,
  type FlagSpec,
  type SubcommandSpec,
} from '../src/commands/catalog.js';
import { renderCommandHelp } from '../src/commands/catalog-render.js';

interface CatalogNode {
  readonly name: string;
  readonly summary: string;
  readonly arguments?: CommandSpec['arguments'];
  readonly flags?: readonly FlagSpec[];
  readonly jsonOutput?: CommandSpec['jsonOutput'];
  readonly subcommands?: readonly SubcommandSpec[];
}

interface ActiveNode {
  readonly path: string;
  readonly value: CatalogNode;
}

function activeNodes(): readonly ActiveNode[] {
  const nodes: ActiveNode[] = [];
  const visit = (value: CatalogNode, path: readonly string[]): void => {
    nodes.push({ path: path.join(' '), value });
    for (const child of value.subcommands ?? []) {
      visit(child, [...path, child.name]);
    }
  };
  for (const command of CATALOG) {
    if (command.removed === undefined) visit(command, [command.name]);
  }
  return nodes;
}

function flagNames(flags: readonly FlagSpec[]): ReadonlySet<string> {
  return new Set(flags.flatMap((flag) => [flag.name, ...flag.aliases]));
}

const docsDirectory = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'apps',
  'docs',
  'content',
  '_generated',
  'cli',
);

describe('catalog-wide typed discovery contract', () => {
  it('requires structured arguments and flags on every active recursive node', () => {
    const nodes = activeNodes();
    expect(CATALOG).toHaveLength(63);
    expect(nodes).toHaveLength(288);
    expect(
      nodes
        .map(({ path }) => path)
        .filter((path) => path.startsWith('platform-auth account-reset')),
    ).toEqual([
      'platform-auth account-reset',
      'platform-auth account-reset preview',
      'platform-auth account-reset status',
      'platform-auth account-reset quarantine',
      'platform-auth account-reset rollback',
      'platform-auth account-reset finalize',
    ]);

    for (const { path, value } of nodes) {
      expect(value, `${path} must declare arguments`).toHaveProperty('arguments');
      expect(value.arguments, `${path}.arguments`).toEqual(expect.any(Array));
      expect(value, `${path} must declare flags`).toHaveProperty('flags');
      expect(value.flags, `${path}.flags`).toEqual(expect.any(Array));
      expect(value, `${path} retains legacy positional metadata`).not.toHaveProperty('positional');
    }
  });

  it('keeps removed commands minimal and free of active-command metadata', () => {
    const removed = CATALOG.filter((command) => command.removed !== undefined);
    expect(removed.map((command) => command.name)).toEqual(['list', 'keys']);
    for (const command of removed) {
      expect(Object.keys(command).sort(), command.name).toEqual([
        'name',
        'removed',
        'section',
        'summary',
      ]);
    }
  });

  it('requires complete flag and argument fields without manufactured constraints', () => {
    for (const { path, value } of activeNodes()) {
      for (const argument of value.arguments ?? []) {
        expect(Object.keys(argument).sort(), `${path} <${argument.name}>`).toEqual([
          'constraints',
          'name',
          'required',
          'sensitive',
          'summary',
          'type',
          'variadic',
        ]);
        expect(
          argument.summary.trim().length,
          `${path} <${argument.name}> summary`,
        ).toBeGreaterThan(0);
      }
      for (const flag of value.flags ?? []) {
        expect(flag, `${path} --${flag.name}`).toMatchObject({
          name: expect.any(String),
          type: expect.stringMatching(/^(string|boolean|integer|number)$/),
          summary: expect.any(String),
          required: expect.any(Boolean),
          repeatable: expect.any(Boolean),
          sensitive: expect.any(Boolean),
          aliases: expect.any(Array),
          conflictsWith: expect.any(Array),
        });
        expect(flag.summary.trim().length, `${path} --${flag.name} summary`).toBeGreaterThan(0);
        expect(flag.summary, `${path} --${flag.name} generic summary`).not.toMatch(
          /^Set --[^.]+\.$/,
        );
        if (flag.type === 'boolean') {
          expect(flag.value, `${path} --${flag.name} boolean value token`).toBeUndefined();
        } else {
          expect(flag.value, `${path} --${flag.name} value token`).toEqual(expect.any(String));
        }
      }
    }
  });

  it('keeps defaults, choices, and limits structural whenever summaries mention them', () => {
    const structuralFact =
      /\b(default(?:s|ed)? to|choices?:|one of|minimum \d|maximum \d|at least \d|at most \d|up to \d)\b/i;
    for (const { path, value } of activeNodes()) {
      for (const flag of value.flags ?? []) {
        if (structuralFact.test(flag.summary)) {
          expect(flag.constraints, `${path} --${flag.name} leaves a fact in prose only`).toEqual(
            expect.any(Object),
          );
        }
      }
    }
  });

  it('declares JSON framing exactly where --json is accepted and validates stream references', () => {
    for (const { path, value } of activeNodes()) {
      const flags = value.flags ?? [];
      const json = flags.some((flag) => flag.name === 'json');
      expect(value.jsonOutput !== undefined, `${path} JSON framing parity`).toBe(json);
      if (value.jsonOutput === undefined) continue;
      expect(value.jsonOutput.mode, `${path} JSON mode`).toMatch(/^(single|stream)$/);
      const names = flagNames(flags);
      for (const reference of value.jsonOutput.streamWhenAnyFlag ?? []) {
        expect(names.has(reference), `${path} stream reference --${reference}`).toBe(true);
      }
    }
  });

  it('keeps aliases and conflicts canonical, local, reciprocal, and collision-free', () => {
    const publicAliases: Array<[string, string, readonly string[]]> = [];
    for (const { path, value } of activeNodes()) {
      const flags = value.flags ?? [];
      const names = flagNames(flags);
      expect(names.size, `${path} has duplicate canonical flags or aliases`).toBe(
        flags.reduce((count, flag) => count + 1 + flag.aliases.length, 0),
      );
      for (const flag of flags) {
        if (flag.aliases.length > 0) publicAliases.push([path, flag.name, flag.aliases]);
        for (const alias of flag.aliases) {
          expect(alias, `${path} --${flag.name} alias`).not.toMatch(/^-|^$/);
        }
        for (const conflict of flag.conflictsWith) {
          expect(names.has(conflict), `${path} --${flag.name} conflict --${conflict}`).toBe(true);
          const peer = flags.find(
            (candidate) => candidate.name === conflict || candidate.aliases.includes(conflict),
          );
          expect(
            peer?.conflictsWith.some(
              (candidate) => candidate === flag.name || flag.aliases.includes(candidate),
            ),
            `${path} --${flag.name}/--${conflict} reciprocal conflict`,
          ).toBe(true);
        }
      }
    }
    expect(publicAliases).toEqual([
      ['logs', 'follow', ['tail']],
      ['events', 'tail', ['follow']],
    ]);
  });
});

describe('catalog projections', () => {
  it('loads the raw generator shards in the exact runtime catalog order', async () => {
    expect(JSON.parse(JSON.stringify(await loadCatalog()))).toEqual(
      JSON.parse(JSON.stringify(CATALOG)),
    );
  });

  it('renders every typed flag summary in human help and generated MDX', () => {
    for (const command of CATALOG) {
      if (command.removed !== undefined) continue;
      const help = renderCommandHelp(command, { color: 'none', glyph: 'ascii' });
      const mdx = readFileSync(join(docsDirectory, `${command.name}.mdx`), 'utf8');
      for (const flag of command.flags ?? []) {
        expect(help, `${command.name} help omits --${flag.name} summary`).toContain(flag.summary);
        expect(mdx, `${command.name} MDX omits --${flag.name} summary`).toContain(flag.summary);
      }
      for (const { value, path } of activeNodes().filter((node) =>
        node.path.startsWith(`${command.name} `),
      )) {
        for (const flag of value.flags ?? []) {
          expect(help, `${path} help omits --${flag.name} summary`).toContain(flag.summary);
          expect(mdx, `${path} MDX omits --${flag.name} summary`).toContain(flag.summary);
        }
      }
    }
  });

  it('explains the deployments signed-out local-cache fallback on both help surfaces', () => {
    const deployments = CATALOG.find((command) => command.name === 'deployments');
    if (deployments === undefined) throw new Error('deployments command is missing');
    const help = renderCommandHelp(deployments, { color: 'none', glyph: 'ascii' });
    const mdx = readFileSync(join(docsDirectory, 'deployments.mdx'), 'utf8');
    for (const output of [help, mdx]) {
      expect(output).toContain('signed out');
      expect(output).toContain('local deployment cache');
    }
  });

  it('de-duplicates only identical inherited flags from generated MDX', () => {
    const occurrences = (text: string, token: string): number =>
      text
        .split('\n')
        .map((line) => line.trimStart())
        .filter((line) => line.startsWith(`- \`${token}`)).length;
    const tools = readFileSync(join(docsDirectory, 'tools.mdx'), 'utf8');
    expect(occurrences(tools, '--json')).toBe(1);
    expect(occurrences(tools, '--connectors')).toBe(1);
    expect(occurrences(tools, '--args')).toBe(1);

    const github = readFileSync(join(docsDirectory, 'github.mdx'), 'utf8');
    expect(occurrences(github, '--json')).toBe(2);
    expect(occurrences(github, '--limit')).toBe(1);
    expect(github).toContain('conflicts: --watch');
  });
});
