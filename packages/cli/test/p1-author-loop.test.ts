import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToolsTable } from '../src/commands/author-loop.js';
import { run } from '../src/index.js';

const HELLO = join(import.meta.dirname, '..', '..', '..', 'examples', 'hello', 'src', 'server.ts');

let home: string;
let tmp: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-author-home-'));
  tmp = mkdtempSync(join(tmpdir(), 'noodle-author-'));
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  rmSync(home, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

function stdout(): string {
  return logSpy.mock.calls.map((call) => String(call[0])).join('\n');
}

describe('P1 local author loop', () => {
  it('runs noodle test as validate plus local MCP smoke', async () => {
    expect(await run(['test', HELLO], {}, home)).toBe(0);
    const printed = stdout();
    expect(printed).toContain('validate: pass');
    expect(printed).toContain('mcp: initialize pass');
    expect(printed).toContain('tools: greet');
  });

  it('supports JSON and optional tool call in noodle test', async () => {
    expect(
      await run(['test', HELLO, '--tool', 'greet', '--args', '{"name":"Ada"}', '--json'], {}, home),
    ).toBe(0);
    const body = JSON.parse(stdout()) as {
      ok: true;
      data: { tools: string[]; call: { structuredContent: unknown } };
    };
    expect(body.ok).toBe(true);
    expect(body.data.tools).toContain('greet');
    expect(body.data.call.structuredContent).toEqual({ message: 'Hello, Ada!' });
  });

  it('prints fix-ready agent output for validation failures', async () => {
    const broken = join(tmp, 'broken.yaml');
    writeFileSync(
      broken,
      'manifestVersion: "1"\nserver: { name: broken, version: "1.0.0" }\ntools: []\n',
    );
    expect(await run(['validate', broken, '--fix-prompt'], {}, home)).toBe(1);
    expect(logSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      'Fix this Noodle validation failure',
    );
  });

  it('renders the branded tools table for noodle tools list', async () => {
    expect(await run(['tools', 'list', HELLO], {}, home)).toBe(0);
    const printed = stdout();
    expect(printed).toContain('NAME');
    expect(printed).toContain('DESCRIPTION');
    expect(printed).toContain('greet');
    expect(printed).toContain('Greet someone by name.');
  });

  it('truncates long tool descriptions via the column cap', () => {
    const table = renderToolsTable([{ name: 'noop', description: 'x'.repeat(120) }], {
      color: 'none',
      glyph: 'unicode',
    });
    expect(table).toContain('…');
    expect(table).not.toContain('x'.repeat(120));
    expect(table).not.toContain(String.fromCharCode(27));
  });

  it('lists and calls tools through scoped local smoke commands', async () => {
    expect(await run(['tools', 'list', HELLO, '--json'], {}, home)).toBe(0);
    expect(JSON.parse(stdout()).data.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'greet',
    ]);
    logSpy.mockClear();

    expect(
      await run(
        ['tools', 'call', 'greet', HELLO, '--args', '{"name":"Grace"}', '--json'],
        {},
        home,
      ),
    ).toBe(0);
    expect(JSON.parse(stdout()).data.result.structuredContent).toEqual({
      message: 'Hello, Grace!',
    });
  });

  it('calls a tool whose only input field has .default() with {} (no missing-required error)', async () => {
    const manifest = join(tmp, 'defaults.ts');
    writeFileSync(
      manifest,
      `
import { server, tool, z } from '@noodleseed/one';

export default server('defaults', { title: 'Defaults', version: '1.0.0' }, [
  tool('greet', {
    description: 'Greet with a defaulted name.',
    input: z.object({ name: z.string().default('world') }),
    output: z.object({ ok: z.boolean() }),
    fulfil: () => ({ ok: true }),
  }),
]);
`,
    );
    // A `.default()` field is emitted as optional (io:'input'), so calling with `{}` passes input
    // validation instead of failing with `missing required field "name"` as it did before the fix.
    const code = await run(
      ['tools', 'call', 'greet', manifest, '--args', '{}', '--json'],
      {},
      home,
    );
    expect(code, stdout()).toBe(0);
    const body = JSON.parse(stdout()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(stdout()).not.toContain('missing required field');
  });

  it('reads resources and gets prompts through scoped local smoke commands', async () => {
    const manifest = join(tmp, 'server.ts');
    writeFileSync(
      manifest,
      `
import { prompt, resource, server, tool, z } from '@noodleseed/one';

export default server('rp', { title: 'RP', version: '1.0.0' }, [
  tool('noop', {
    description: 'Noop.',
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    fulfil: () => ({ ok: true }),
  }),
  resource('guide', {
    uri: 'docs://guide',
    title: 'Guide',
    mimeType: 'text/plain',
    fulfil: () => 'hello docs',
  }),
  prompt('brief', {
    description: 'Brief prompt.',
    arguments: z.object({ topic: z.string() }),
    fulfil: ({ input }) => \`Summarize \${input.topic}\`,
  }),
]);
`,
    );

    expect(await run(['resources', 'read', 'docs://guide', manifest, '--json'], {}, home)).toBe(0);
    expect(JSON.stringify(JSON.parse(stdout()).data.result)).toContain('hello docs');
    logSpy.mockClear();

    expect(
      await run(
        ['prompts', 'get', 'brief', manifest, '--args', '{"topic":"Noodle"}', '--json'],
        {},
        home,
      ),
    ).toBe(0);
    expect(JSON.stringify(JSON.parse(stdout()).data.result)).toContain('Noodle');
  });
});
