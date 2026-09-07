import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { snapshotFromTools } from '@noodle-borg/openapi-import';
import { afterEach, describe, expect, it } from 'vitest';
import { importMcpProject } from '../src/mcp-import.js';
import { importOpenApiProject } from '../src/openapi-import.js';

const require = createRequire(import.meta.url);
const execute = promisify(execFile);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('generated import consumer contract', () => {
  it.each([
    'openapi',
    'mcp',
  ])('%s compiles and runs its actual generated test without credentials', async (kind) => {
    // Resolves the built public SDK from the workspace. Packed-byte qualification is separate.
    const root = mkdtempSync(join(tmpdir(), 'noodle-import-consumer-'));
    roots.push(root);
    symlinkSync(
      resolve(import.meta.dirname, '../../../node_modules'),
      join(root, 'node_modules'),
      'dir',
    );
    const output = join(root, 'customer');
    if (kind === 'openapi') {
      const spec = join(root, 'openapi.json');
      writeFileSync(
        spec,
        JSON.stringify({
          openapi: '3.1.0',
          servers: [{ url: 'https://unreachable.example.invalid' }],
          security: [{ Token: [] }],
          components: { securitySchemes: { Token: { type: 'http', scheme: 'bearer' } } },
          paths: {
            '/tickets': {
              post: {
                operationId: 'createTicket',
                parameters: [
                  { name: 'limit', in: 'query', schema: { type: 'integer', format: 'int32' } },
                ],
                requestBody: {
                  required: true,
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: { title: { type: 'string' }, count: { type: 'integer' } },
                        required: ['title'],
                        additionalProperties: false,
                      },
                    },
                  },
                },
                responses: {},
              },
            },
            '/tickets/{id}': {
              get: {
                operationId: 'getTicket',
                parameters: [
                  { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
                ],
                responses: {
                  '200': {
                    description: 'ticket',
                    content: {
                      'application/json': {
                        schema: {
                          type: 'object',
                          properties: { id: { type: 'string' } },
                          required: ['id'],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      );
      importOpenApiProject({ specPath: spec, output, name: 'tickets' });
    } else {
      await importMcpProject(
        { endpoint: 'https://unreachable.example.invalid/mcp', output, name: 'tickets' },
        {
          probe: async (options) =>
            snapshotFromTools({
              ...options,
              tools: [
                {
                  name: 'get_ticket',
                  inputSchema: {
                    type: 'object',
                    properties: { id: { type: 'string' } },
                    required: ['id'],
                  },
                  outputSchema: {
                    type: 'object',
                    properties: { title: { type: 'string' } },
                    required: ['title'],
                  },
                },
              ],
            }),
        },
      );
    }
    const manifest = readFileSync(join(output, 'package.json'), 'utf8');
    const options = {
      cwd: output,
      timeout: 45_000,
      maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, NOODLE_UPDATE_CHECK: 'off', CI: 'true' },
    };
    await execute(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit'], options);
    const args = [
      join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs'),
      'run',
      '--config',
      'vitest.config.ts',
    ];
    const result = await execute(process.execPath, args, options);
    expect(result.stdout).toContain('1 passed');
    expect(readFileSync(join(output, 'package.json'), 'utf8')).toBe(manifest);

    // Prove the generated test validates customer source, not a hidden hello starter or fixture copy.
    writeFileSync(join(output, 'src/server.ts'), 'export default this is not TypeScript;');
    await expect(execute(process.execPath, args, options)).rejects.toMatchObject({ code: 1 });
  }, 90_000);
});
