import { describe, expect, it, vi } from 'vitest';
import * as coreCatalogData from '../src/commands/catalog-data-core.js';
import { renderCommandHelp } from '../src/commands/catalog-render.js';
import { runCommands } from '../src/commands/commands-ops.js';
import { runFeatures } from '../src/commands/features.js';
import { EXIT } from '../src/commands/output.js';

const { CATALOG_CORE } = coreCatalogData;

describe('typed core command catalog schema', () => {
  it('declares structured positional arguments for every core command', () => {
    for (const command of CATALOG_CORE) {
      expect(command, `${command.name} must declare arguments`).toHaveProperty('arguments');
      expect(Array.isArray(command.arguments), `${command.name}.arguments must be an array`).toBe(
        true,
      );
      for (const argument of command.arguments ?? []) {
        expect(argument).toMatchObject({
          name: expect.any(String),
          type: expect.stringMatching(/^(string|boolean|integer|number)$/),
          summary: expect.any(String),
          required: expect.any(Boolean),
          variadic: expect.any(Boolean),
          sensitive: expect.any(Boolean),
          constraints: expect.any(Object),
        });
      }
    }
  });

  it('declares complete typed metadata and JSON modes for every core flag', () => {
    for (const command of CATALOG_CORE) {
      for (const flag of command.flags ?? []) {
        expect(flag).toMatchObject({
          name: expect.any(String),
          type: expect.stringMatching(/^(string|boolean|integer|number)$/),
          summary: expect.any(String),
          required: expect.any(Boolean),
          repeatable: expect.any(Boolean),
          sensitive: expect.any(Boolean),
          aliases: expect.any(Array),
          conflictsWith: expect.any(Array),
        });
        if (flag.type === 'boolean') {
          expect(
            flag.value,
            `${command.name} --${flag.name} boolean flags have no value token`,
          ).toBeUndefined();
        } else {
          expect(flag.value, `${command.name} --${flag.name} must declare a value token`).toEqual(
            expect.any(String),
          );
        }
      }
      if ((command.flags ?? []).some((flag) => flag.name === 'json')) {
        expect(
          command.jsonOutput?.mode,
          `${command.name} advertises --json without jsonOutput.mode`,
        ).toMatch(/^(single|stream)$/);
      }
    }
  });

  it('shares one host choice set with runtime acceptance and rejection', () => {
    expect(Object.keys(coreCatalogData)).toContain('FEATURE_HOST_CHOICES');
    const exportedChoices = Reflect.get(coreCatalogData, 'FEATURE_HOST_CHOICES');
    const features = CATALOG_CORE.find((command) => command.name === 'features');
    const host = features?.flags?.find((flag) => flag.name === 'host');
    expect(host?.constraints?.choices).toBe(exportedChoices);
    if (features === undefined) throw new Error('features catalog entry is missing');
    expect(renderCommandHelp(features, { color: 'none', glyph: 'ascii' })).toContain(
      '--host claude|chatgpt|embedded',
    );

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const choice of host?.constraints?.choices ?? []) {
        expect(runFeatures(['--host', String(choice), '--json']), String(choice)).toBe(EXIT.OK);
        expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({ ok: true });
      }
      expect(runFeatures(['--host', 'invalid-host', '--json'])).toBe(EXIT.USAGE);
      expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({
        ok: false,
        error: { code: 'invalid_host' },
      });
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});

describe('core catalog discovery snapshot', () => {
  it('snapshots the public commands --json representation', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(runCommands(['--json'])).toBe(EXIT.OK);
      const envelope = JSON.parse(String(log.mock.lastCall?.[0])) as {
        data: {
          commands: Array<{ name: string }>;
          version: string;
        };
      };
      envelope.data.commands = envelope.data.commands.filter((command) =>
        CATALOG_CORE.some((core) => core.name === command.name),
      );
      envelope.data.version = '<version>';
      const publicWireShape = JSON.parse(JSON.stringify(envelope)) as unknown;
      expect(publicWireShape).toMatchSnapshot();
    } finally {
      log.mockRestore();
    }
  });
});
