import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compile, InMemoryCatalog } from '@noodle-borg/compiler';
import { compileConnectors } from '@noodle-borg/connector-defs';
import { MAX_OPENAPI_SOURCE_BYTES } from '@noodle-borg/openapi-import';
import {
  executePreparedTool,
  executeTool,
  InMemoryConnectorRegistry,
  prepareToolForConfirmation,
} from '@noodle-borg/runtime';
import { describe, expect, it } from 'vitest';
import { readDeployInput } from '../src/deploy.js';
import { importOpenApiProject } from '../src/openapi-import.js';

describe('generated OpenAPI request execution', () => {
  it('rejects oversized or unsupported requests before creating a customer project', () => {
    const root = mkdtempSync(join(tmpdir(), 'noodle-import-reject-'));
    try {
      const specPath = join(root, 'api.json');
      const output = join(root, 'customer');
      const sources = [
        ' '.repeat(MAX_OPENAPI_SOURCE_BYTES + 1),
        JSON.stringify({
          openapi: '3.1.0',
          servers: [{ url: 'https://api.example.com' }],
          paths: {
            '/tickets': {
              post: {
                requestBody: {
                  content: {
                    'application/json': {
                      schema: {
                        $ref: 'https://private.invalid/schema?token=synthetic-secret-marker',
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      ];
      for (const source of sources) {
        writeFileSync(specPath, source);
        expect(() => importOpenApiProject({ specPath, output, name: 'tickets' })).toThrow(
          /import openapi:/,
        );
        try {
          importOpenApiProject({ specPath, output, name: 'tickets' });
        } catch (error) {
          expect(String(error)).not.toContain('synthetic-secret-marker');
        }
        expect(existsSync(output)).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each([
    true,
    false,
  ])('preserves typed request bytes with required=%s and never writes during preparation', async (required) => {
    const requests: Array<{
      method: string | undefined;
      url: string | undefined;
      body: string;
      contentType: string | undefined;
    }> = [];
    const backend = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      requests.push({
        method: request.method,
        url: request.url,
        body,
        contentType: request.headers['content-type'],
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ accepted: true }));
    });
    await new Promise<void>((done) => backend.listen(0, '127.0.0.1', done));
    const address = backend.address();
    if (address === null || typeof address === 'string')
      throw new Error('missing local fixture port');
    const root = mkdtempSync(join(tmpdir(), 'noodle-import-request-'));
    try {
      symlinkSync(
        resolve(import.meta.dirname, '../../../node_modules'),
        join(root, 'node_modules'),
        'dir',
      );
      const specPath = join(root, 'api.json');
      const output = join(root, 'customer');
      writeFileSync(
        specPath,
        JSON.stringify({
          openapi: '3.1.0',
          servers: [{ url: `http://127.0.0.1:${address.port}/v1` }],
          paths: {
            '/tickets/{ticket-id}': {
              parameters: [
                { name: 'ticket-id', in: 'path', required: true, schema: { type: 'string' } },
              ],
              post: {
                operationId: 'updateTicket',
                parameters: [{ name: 'includeNotes', in: 'query', schema: { type: 'boolean' } }],
                requestBody: {
                  required,
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['title', 'labels'],
                        properties: {
                          title: { type: 'string' },
                          labels: { type: 'array', items: { type: 'string' } },
                          estimate: { type: 'integer' },
                          enabled: { type: ['boolean', 'null'] },
                        },
                      },
                    },
                  },
                },
                responses: {
                  '200': {
                    content: {
                      'application/json': {
                        schema: {
                          type: 'object',
                          properties: { accepted: { type: 'boolean' } },
                          required: ['accepted'],
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
      importOpenApiProject({ specPath, output, name: 'tickets' });
      expect(readFileSync(join(output, 'src/server.ts'), 'utf8')).toContain(
        "request: '${args.body}'",
      );
      const input = await readDeployInput(join(output, 'src/server.ts'));
      const connectors = compileConnectors(input.connectors ?? '');
      expect(connectors.ok, JSON.stringify(connectors)).toBe(true);
      if (!connectors.ok) return;
      const compiled = compile(input.manifest, {
        catalog: new InMemoryCatalog(connectors.catalog),
      });
      expect(compiled.ok, JSON.stringify(compiled)).toBe(true);
      if (!compiled.ok) return;
      const tool = compiled.artifact.tools.find((entry) => entry.name === 'update_ticket');
      expect(tool?.inputSchema).toEqual({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        ...connectors.catalog[0]?.operations.update_ticket?.input,
      });
      expect(JSON.parse(input.manifest).tools[0].annotations.confirm).toBe(true);
      const deps = {
        connectors: new InMemoryConnectorRegistry(connectors.connectors),
        broker: { getCredential: async () => ({ token: 'unused-synthetic' }) },
      };
      const body = {
        title: 'Keep the nested JSON',
        labels: ['one', 'two'],
        estimate: 3,
        enabled: null,
      };
      const args = { ticket_id: 'ticket / 4', includeNotes: true, body };
      for (const invalidBody of [
        {},
        { ...body, estimate: 3.5 },
        { ...body, labels: 'one' },
        { ...body, extra: 'not allowed' },
      ]) {
        expect(
          await executeTool(
            compiled.artifact,
            'update_ticket',
            { ...args, body: invalidBody },
            deps,
          ),
        ).toMatchObject({ ok: false });
      }
      if (required)
        expect(
          await executeTool(compiled.artifact, 'update_ticket', { ticket_id: '4' }, deps),
        ).toMatchObject({ ok: false });
      const prepared = await prepareToolForConfirmation(
        compiled.artifact,
        'update_ticket',
        args,
        deps,
      );
      expect(prepared.status).toBe('confirmation_required');
      expect(requests).toEqual([]);
      if (prepared.status !== 'confirmation_required') return;
      expect(
        await executePreparedTool(compiled.artifact, prepared.continuation, deps),
      ).toMatchObject({ status: 'completed', output: { value: { accepted: true } } });
      expect(requests).toEqual([
        {
          method: 'POST',
          url: '/v1/tickets/ticket%20%2F%204?includeNotes=true',
          body: JSON.stringify(body),
          contentType: 'application/json',
        },
      ]);
      if (!required) {
        const omitted = await prepareToolForConfirmation(
          compiled.artifact,
          'update_ticket',
          { ticket_id: '4' },
          deps,
        );
        expect(omitted.status).toBe('confirmation_required');
        if (omitted.status !== 'confirmation_required') return;
        expect(
          await executePreparedTool(compiled.artifact, omitted.continuation, deps),
        ).toMatchObject({ status: 'completed' });
        expect(requests[1]?.body).toBe('');
        expect(requests[1]?.url).toBe('/v1/tickets/4');
      }
    } finally {
      backend.closeAllConnections();
      await new Promise<void>((done, reject) =>
        backend.close((error) => (error ? reject(error) : done())),
      );
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
