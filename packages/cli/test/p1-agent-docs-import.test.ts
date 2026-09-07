import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/index.js';

let home: string;
let project: string;
let cwd: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  cwd = process.cwd();
  home = mkdtempSync(join(tmpdir(), 'noodle-agent-p1-home-'));
  project = mkdtempSync(join(tmpdir(), 'noodle-agent-p1-project-'));
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.chdir(cwd);
  logSpy.mockRestore();
  errSpy.mockRestore();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function stdout(): string {
  return logSpy.mock.calls.map((call) => String(call[0])).join('\n');
}

describe('P1 agent docs and import CLI', () => {
  it('runs agents doctor and reports project-local context state as JSON', async () => {
    expect(
      await run(
        ['agents', 'setup', '--agents', 'codex', '--project', project, '--write'],
        {},
        home,
      ),
    ).toBe(0);
    logSpy.mockClear();

    expect(
      await run(
        ['agents', 'doctor', '--agents', 'codex', '--project', project, '--json'],
        {},
        home,
      ),
    ).toBe(0);
    const body = JSON.parse(stdout()) as {
      ok: true;
      data: { checks: Array<{ name: string; level: string }>; restartRequired: boolean };
    };
    expect(body.ok).toBe(true);
    expect(
      body.data.checks.some((check) => check.name === 'AGENTS.md' && check.level === 'PASS'),
    ).toBe(true);
    expect(stdout()).not.toContain('authToken');
  });

  it('exports curated docs in llms format to stdout and a file', async () => {
    expect(await run(['docs', 'export', '--format', 'llms'], {}, home)).toBe(0);
    expect(stdout()).toContain('# Noodle Seed Platform LLM Context');
    expect(stdout()).toContain('noodle validate');
    expect(stdout()).toContain('tool');
    expect(stdout()).toContain('noodle devtools');
    logSpy.mockClear();

    const output = join(project, 'llms.txt');
    expect(await run(['docs', 'export', '--format', 'llms', '--output', output], {}, home)).toBe(0);
    expect(readFileSync(output, 'utf8')).toContain('# Noodle Seed Platform LLM Context');
  });

  it('prints client setup flows and writes project-local agent files', async () => {
    expect(await run(['connect', 'codex'], {}, home)).toBe(0);
    expect(stdout()).toContain('noodle agents setup --write --agents codex');
    logSpy.mockClear();

    expect(await run(['connect', 'codex', '--json'], {}, home)).toBe(0);
    expect(JSON.parse(stdout()).data.client).toBe('codex');
    process.chdir(project);
    expect(await run(['connect', 'codex', '--write'], {}, home)).toBe(0);
    expect(existsSync(join(project, 'AGENTS.md'))).toBe(true);
  });

  it('imports an OpenAPI document into a local connector-backed project', async () => {
    const spec = join(project, 'openapi.yaml');
    const output = join(project, 'generated');
    writeFileSync(
      spec,
      `
openapi: 3.1.0
info: { title: Demo API, version: 1.0.0 }
servers:
  - url: https://api.example.com
paths:
  /tickets/{id}:
    get:
      operationId: getTicket
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
        - { name: verbose, in: query, schema: { type: string } }
      responses:
        "200":
          description: ok
`,
    );

    expect(
      await run(['import', 'openapi', spec, '--output', output, '--name', 'demo-api'], {}, home),
    ).toBe(0);
    expect(existsSync(join(output, 'src/server.ts'))).toBe(true);
    const server = readFileSync(join(output, 'src/server.ts'), 'utf8');
    expect(server).toContain(
      "import { annotations, connector, server, tool, z } from '@noodleseed/one'",
    );
    expect(server).toContain('server("demo_api", {');
    expect(server).toContain('title: "Demo Api"');
    expect(server).toContain('use: { api }');
    const oldTitleForm = 'server' + "('demo_api', 'Demo Api'";
    expect(server).not.toContain(oldTitleForm);
    const oldChainedUseForm = '])' + '.use' + '({ api })';
    expect(server).not.toContain(oldChainedUseForm);
    expect(server).toContain('tool(');
    expect(server).toContain('connector("demo_api")');
    expect(server).toContain('get_ticket');
    expect(server).toContain('baseUrl: "https://api.example.com"');
    expect(readFileSync(join(output, '.gitignore'), 'utf8')).toContain('.env.noodle');
  });
});
