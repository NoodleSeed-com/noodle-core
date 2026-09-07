import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLocalTest, runSmoke } from '../src/commands/author-loop.js';
import { EXIT } from '../src/commands/output.js';
import { dev } from '../src/dev.js';

let root: string;
let entry: string;
let output: ReturnType<typeof vi.spyOn>;
let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noodle-smoke-outcome-'));
  entry = join(root, 'server.ts');
  writeFileSync(
    entry,
    `
import { server, tool, z } from '@noodleseed/one';
export default server('outcomes', { title: 'Outcomes', version: '1.0.0' }, [
  tool('read', {
    title: 'Read', description: 'Read the supplied value.',
    input: z.object({ value: z.string() }),
    output: z.object({ value: z.string() }),
    fulfil: ({ input }) => ({ value: input.value }),
  }),
  tool('bad_output', {
    title: 'Bad output', description: 'Prove output validation rejects a string.',
    input: z.object({ value: z.string() }),
    output: z.object({ value: z.number() }),
    fulfil: ({ input }) => ({ value: input.value }),
  }),
]);`,
  );
  output = vi.spyOn(console, 'log').mockImplementation(() => {});
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  output.mockRestore();
  errors.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

const stdout = () => output.mock.calls.map(([line]) => String(line)).join('\n');

describe('local smoke completion evidence', () => {
  it('reports missing local variables and secrets from an actual authored connector in one response', async () => {
    writeFileSync(
      entry,
      `
import { connector, server, tool, variable, secret, z } from '@noodleseed/one';
const backend = connector('backend').version('1.0.0').http({
  baseUrl: 'https://readiness.invalid', allowedOrigins: ['https://readiness.invalid'],
  auth: { kind: 'bearer', secret: secret('FIXTURE_READINESS_TOKEN') },
  operations: { read: { type: 'read', method: 'GET', path: '/',
    headers: { 'X-Region': variable('FIXTURE_READINESS_REGION') },
    input: z.object({}), output: z.object({ ok: z.boolean() }), response: { ok: '\${response.ok}' },
  } },
});
export default server('backend', { title: 'Backend', version: '1.0.0', use: { backend } }, [
  tool('read', { title: 'Read', description: 'Read from the test backend.',
    input: z.object({}), output: z.object({ ok: z.boolean() }),
    fulfil: ({ connectors }) => ({ ok: connectors.backend.read({}).ok }),
  }),
]);`,
    );
    expect(await runSmoke('tools', ['list', entry, '--json'], root)).toBe(EXIT.MCP);
    expect(JSON.parse(stdout())).toMatchObject({
      ok: false,
      error: {
        code: 'connector_secret_unresolved',
        detail: { secrets: ['FIXTURE_READINESS_TOKEN'], variables: ['FIXTURE_READINESS_REGION'] },
      },
    });
    expect(stdout()).toContain('noodle secrets set FIXTURE_READINESS_TOKEN --runtime local');
    expect(stdout()).toContain('noodle variables set FIXTURE_READINESS_REGION --runtime local');
    expect(errors).not.toHaveBeenCalled();
  });

  it('reports a real connector failure without retrying the tool or exposing its response', async () => {
    let calls = 0;
    const backend = createServer((_request, response) => {
      calls += 1;
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end('{"error":"synthetic-private-backend-response"}');
    }).listen(0, '127.0.0.1');
    await once(backend, 'listening');
    try {
      const address = backend.address();
      if (!address || typeof address === 'string') throw new Error('Expected test backend port');
      const origin = `http://127.0.0.1:${address.port}`;
      writeFileSync(
        entry,
        `
import { connector, server, tool, z } from '@noodleseed/one';
const backend = connector('backend').version('1.0.0').http({
  baseUrl: '${origin}', allowedOrigins: ['${origin}'],
  operations: { read: { type: 'read', method: 'GET', path: '/',
    input: z.object({}), output: z.object({ ok: z.boolean() }), response: { ok: '\${response.ok}' },
  } },
});
export default server('backend', { title: 'Backend', version: '1.0.0', use: { backend } }, [
  tool('read', { title: 'Read', description: 'Read from the test backend.',
    input: z.object({}), output: z.object({ ok: z.boolean() }),
    fulfil: ({ connectors }) => ({ ok: connectors.backend.read({}).ok }),
  }),
]);`,
      );
      const probe = await dev({
        manifestPath: entry,
        projectRoot: root,
        watch: false,
        interactive: false,
        log: () => {},
      });
      try {
        expect(probe.boot.ok, JSON.stringify(probe.boot)).toBe(true);
      } finally {
        await probe.close();
      }
      expect(await runSmoke('tools', ['call', 'read', entry, '--json'], root)).toBe(EXIT.MCP);
      expect(calls, stdout()).toBe(1);
      expect(JSON.parse(stdout())).toMatchObject({
        ok: false,
        error: { detail: { reason: 'tool_error' } },
      });
      expect(stdout()).not.toContain('synthetic-private-backend-response');
    } finally {
      await new Promise<void>((resolve, reject) =>
        backend.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  for (const json of [true, false]) {
    for (const tool of ['missing', 'bad_output', 'read']) {
      it(`fails noodle test for ${tool} in ${json ? 'JSON' : 'human'} output`, async () => {
        const args = tool === 'bad_output' ? '{"value":"synthetic-private-value"}' : '{}';
        const code = await runLocalTest(
          [entry, '--tool', tool, '--args', args, ...(json ? ['--json'] : [])],
          root,
        );
        expect(code, stdout()).toBe(EXIT.MCP);
        if (json) expect(JSON.parse(stdout()).ok).toBe(false);
        expect(stdout()).not.toContain('synthetic-private-value');
      });
    }

    it(`fails scoped tool smoke on a tool error in ${json ? 'JSON' : 'human'} output`, async () => {
      const code = await runSmoke(
        'tools',
        [
          'call',
          'bad_output',
          entry,
          '--args',
          '{"value":"synthetic-private-value"}',
          ...(json ? ['--json'] : []),
        ],
        root,
      );
      expect(code, stdout()).toBe(EXIT.MCP);
      if (json) expect(JSON.parse(stdout()).ok).toBe(false);
      expect(stdout()).not.toContain('synthetic-private-value');
    });

    it(`reports pending confirmation as incomplete without exposing continuation in ${json ? 'JSON' : 'human'} output`, async () => {
      const guided = join(import.meta.dirname, 'fixtures/modern-guided/server.ts');
      const code = await runSmoke(
        'tools',
        [
          'call',
          'complete_task',
          guided,
          '--args',
          '{"task":"review_pr","title":"Review"}',
          ...(json ? ['--json'] : []),
        ],
        root,
      );
      expect(code, stdout()).toBe(EXIT.MCP);
      if (json)
        expect(JSON.parse(stdout())).toMatchObject({
          ok: false,
          error: { next: 'noodle devtools', detail: { reason: 'input_required' } },
        });
      expect(stdout()).not.toContain('requestState');
    });
  }

  it('retains successful mapped results for an explicitly requested safe read', async () => {
    expect(
      await runLocalTest(
        [entry, '--tool', 'read', '--args', '{"value":"public test value"}', '--json'],
        root,
      ),
    ).toBe(0);
    expect(JSON.parse(stdout())).toMatchObject({
      ok: true,
      data: { call: { structuredContent: { value: 'public test value' } } },
    });
  });
});
