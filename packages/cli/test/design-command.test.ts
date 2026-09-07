import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CATALOG } from '../src/commands/catalog.js';
import { parseDesignArgs, runDesign } from '../src/commands/design.js';
import { EXIT } from '../src/commands/output.js';
import type { DesignSessionV1 } from '../src/devtools-design-contract.js';
import { createDesignStore } from '../src/devtools-design-store.js';

const roots: string[] = [];

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'noodle-design-command-'));
  roots.push(root);
  writeFileSync(join(root, 'noodle.json'), '{}');
  return root;
}

function draft(): DesignSessionV1 {
  return {
    version: 1,
    id: 'draft-session',
    status: 'draft',
    project: { entrypoint: 'src/server.ts', toolName: 'open_ordering' },
    viewport: {
      width: 1280,
      height: 800,
      device: 'desktop',
      theme: 'dark',
    },
    createdAt: '2026-07-29T10:00:00.000Z',
    updatedAt: '2026-07-29T10:01:00.000Z',
    annotations: [
      {
        id: 'annotation-1',
        intent: 'Increase the visual hierarchy.',
        target: {
          tagName: 'h2',
          accessibleName: 'Ready for checkout',
          visibleText: 'Ready for checkout',
          classNames: ['checkout-title'],
          authorHints: {},
          ancestry: [],
          siblingIndex: 0,
          siblingCount: 1,
          rect: { x: 12, y: 24, width: 300, height: 32 },
          computedStyles: { 'font-size': '24px' },
          resolution: {
            confidence: 85,
            evidence: ['accessible name'],
            status: 'resolved',
          },
        },
        changes: [{ property: 'font-size', from: '24px', to: '28px' }],
        acceptanceCriteria: ['The heading remains on one line at desktop width.'],
        preserve: ['Keep the heading text.'],
      },
    ],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('parseDesignArgs', () => {
  it('accepts only inspect with the explicit latest selector', () => {
    expect(parseDesignArgs(['inspect', '--latest'])).toEqual({
      latest: true,
      json: false,
    });
    expect(parseDesignArgs(['inspect', '--latest', '--json'])).toEqual({
      latest: true,
      json: true,
    });
  });

  it('rejects missing, unknown, and duplicate input', () => {
    expect(() => parseDesignArgs([])).toThrow();
    expect(() => parseDesignArgs(['inspect'])).toThrow();
    expect(() => parseDesignArgs(['show', '--latest'])).toThrow();
    expect(() => parseDesignArgs(['inspect', '--latest', '--latest'])).toThrow();
    expect(() => parseDesignArgs(['inspect', '--latest', '--json', '--json'])).toThrow();
    expect(() => parseDesignArgs(['inspect', '--latest', '--wat'])).toThrow();
  });
});

describe('runDesign', () => {
  it('finds the nearest project from a nested directory and prints one JSON envelope', () => {
    const root = project();
    const nested = join(root, 'src', 'widgets');
    mkdirSync(nested, { recursive: true });
    const ready = createDesignStore(root).finalize(draft());
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(runDesign(['inspect', '--latest', '--json'], nested)).toBe(EXIT.OK);

    const output = log.mock.calls.map(([line]) => String(line)).join('\n');
    expect(JSON.parse(output)).toEqual({
      ok: true,
      data: expect.objectContaining({
        version: 1,
        session: expect.objectContaining({
          id: ready.id,
          status: 'ready',
        }),
        unresolvedAnnotations: 0,
        acceptanceChecklist: expect.any(Array),
        markdown: expect.stringContaining('# Noodle Design brief'),
      }),
    });
    expect(output).not.toContain(root);
  });

  it('prints only the deterministic Markdown in human mode', () => {
    const root = project();
    createDesignStore(root).finalize(draft());
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(runDesign(['inspect', '--latest'], root)).toBe(EXIT.OK);

    const output = log.mock.calls.map(([line]) => String(line)).join('\n');
    expect(output).toContain('# Noodle Design brief');
    expect(output).not.toContain(root);
    expect(output).not.toContain('draft-session');
  });

  it('returns stable JSON failures for a missing project, brief, and corrupt state', () => {
    const outside = mkdtempSync(join(tmpdir(), 'noodle-design-outside-'));
    roots.push(outside);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(runDesign(['inspect', '--latest', '--json'], outside)).toBe(EXIT.USAGE);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      ok: false,
      error: {
        code: 'design_project_missing',
        message: 'Run this command from a Noodle project.',
        fix: 'Change into a project containing noodle.json and retry.',
        next: 'noodle design inspect --latest --json',
      },
    });

    const root = project();
    expect(runDesign(['inspect', '--latest', '--json'], root)).toBe(EXIT.FAILURE);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      ok: false,
      error: {
        code: 'design_brief_missing',
        message: 'No ready Noodle Design brief exists in this project.',
        fix: 'Open `noodle devtools`, annotate the widget in Design, then choose Send to agent.',
        next: 'noodle devtools',
      },
    });

    mkdirSync(join(root, '.noodle', 'design'), { recursive: true });
    writeFileSync(join(root, '.noodle', 'design', 'latest.json'), '{broken');
    expect(runDesign(['inspect', '--latest', '--json'], root)).toBe(EXIT.FAILURE);
    const corruptOutput = String(log.mock.calls.at(-1)?.[0]);
    expect(JSON.parse(corruptOutput)).toEqual({
      ok: false,
      error: {
        code: 'design_brief_invalid',
        message: 'The latest Noodle Design brief is unreadable.',
        fix: 'Return to Design in `noodle devtools` and choose Send to agent again.',
        next: 'noodle devtools',
      },
    });
    expect(corruptOutput).not.toContain(root);
  });

  it('returns a usage failure instead of accepting loose flags', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(runDesign(['inspect', '--json'], project())).toBe(EXIT.USAGE);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      ok: false,
      error: {
        code: 'design_usage',
        message: 'Use `noodle design inspect --latest [--json]`.',
        fix: 'Pass the required `--latest` selector and no other flags.',
        next: 'noodle design inspect --latest --json',
      },
    });
  });
});

describe('design command catalog', () => {
  it('advertises one local JSON-capable inspect command', () => {
    const design = CATALOG.find((entry) => entry.name === 'design');
    expect(design).toMatchObject({
      name: 'design',
      section: 'build',
      helpRank: 8,
      local: true,
    });
    expect(design?.subcommands).toEqual([
      expect.objectContaining({
        name: 'inspect',
        arguments: [],
        jsonOutput: { mode: 'single' },
        flags: expect.arrayContaining([
          expect.objectContaining({ name: 'latest', type: 'boolean', required: true }),
          expect.objectContaining({ name: 'json', type: 'boolean', required: false }),
        ]),
      }),
    ]);
  });
});
