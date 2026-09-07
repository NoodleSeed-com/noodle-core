import type { ScaffoldModel } from './project-scaffold-model.js';

/** Exercise the actual authored source through the local CLI; never mutate customer config or call live APIs. */
export function scaffoldBehaviorTest(model: ScaffoldModel): string {
  return `import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
${model.httpFixture ? "import { createServer } from 'node:http';\n" : ''}import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// TEST SEAM: update the representative read and expectations when your business contract changes.
// This proves local synthetic behavior, not customer identity, hosted integration or production readiness.
const project = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'noodle-behavior-'));
const tool = ${JSON.stringify(model.tool)};
const variables: readonly string[] = ${JSON.stringify(model.variables)};
${
  model.httpFixture
    ? `let requests = 0;
const backend = createServer((request, response) => {
  requests++;
  if (request.method !== 'GET' || request.url !== '/posts/1') {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(${JSON.stringify(model.expected)}));
});
`
    : ''
}
beforeAll(async () => {
  // Copy only authored source, never .env, saved accounts, project links, credentials or generated skills.
  cpSync(join(project, 'src'), join(scratch, 'src'), { recursive: true });
  cpSync(join(project, 'package.json'), join(scratch, 'package.json'));
  symlinkSync(join(project, 'node_modules'), join(scratch, 'node_modules'), 'dir');
  mkdirSync(join(scratch, 'home'));
  writeFileSync(join(scratch, 'noodle.json'), JSON.stringify({ entrypoint: 'src/server.ts', name: 'fixture' }));
  writeFileSync(join(scratch, 'runner.mjs'), "import { run } from '@noodleseed/one'; process.exitCode = await run(JSON.parse(process.argv[2]), {}, process.argv[3]);");
${
  model.httpFixture
    ? `  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const address = backend.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not listen');
  const origin = 'http://127.0.0.1:' + address.port;
`
    : "  const origin = 'http://localhost:3000';\n"
}  writeFileSync(join(scratch, '.env'), variables.map((name) => name + '=' + origin).join('\\n'));
});
afterAll(async () => {
${model.httpFixture ? '  await new Promise<void>((resolve) => backend.close(() => resolve()));\n' : ''}  rmSync(scratch, { recursive: true, force: true });
});

function command(args: string[]): Promise<{ exit: number; body: unknown }> {
  // Execute the installed public CLI in native Node, independent of the test runner's module transforms.
  return new Promise((resolve, reject) => execFile(process.execPath, [
    join(scratch, 'runner.mjs'),
    JSON.stringify([...args, '--json']),
    join(scratch, 'home'),
  ], {
    cwd: scratch, timeout: 25_000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, NOODLE_UPDATE_CHECK: 'off' },
  }, (error, stdout) => {
    if (error && typeof error.code !== 'number') { reject(new Error('Local CLI process could not complete.')); return; }
    const exit = typeof error?.code === 'number' ? error.code : 0;
    try { resolve({ exit, body: JSON.parse(stdout) }); }
    catch { reject(new Error('Local CLI did not return a JSON envelope.')); }
  }));
}

describe.sequential('local application behavior', () => {
  it('compiles the authored source and view', async () => {
    const result = await command(['validate']);
    expect(result.exit, JSON.stringify(result.body)).toBe(0);
  }, 30_000);
  it('registers the representative capability', async () => {
    const result = await command(['tools', 'list']);
    expect(result.exit, JSON.stringify(result.body)).toBe(0);
    expect(result.body).toMatchObject({ ok: true, data: { result: { tools: expect.arrayContaining([expect.objectContaining({ name: tool })]) } } });
  }, 30_000);
  it('returns the expected useful result', async () => {
    const result = await command(['tools', 'call', tool, '--args', JSON.stringify(${JSON.stringify(model.input)})]);
    expect(result.exit, JSON.stringify(result.body)).toBe(0);
    expect(result.body).toMatchObject({ ok: true, data: { result: { structuredContent: ${JSON.stringify(model.expected)} } } });
${model.httpFixture ? '    expect(requests).toBe(1);\n' : ''}  }, 30_000);
  it('rejects invalid input without claiming completion', async () => {
    const result = await command(['tools', 'call', tool, '--args', JSON.stringify(${JSON.stringify(model.invalidInput)})]);
    expect(result.exit).not.toBe(0);
    expect(result.body).toMatchObject({ ok: false });
${model.httpFixture ? '    expect(requests).toBe(1);\n' : ''}  }, 30_000);
});
`;
}
