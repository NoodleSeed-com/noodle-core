import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { compileManifest, InMemoryCatalog } from '../../compiler/src/index.js';
import { compileConnectors } from '../../connector-defs/src/index.js';
import {
  executeTool,
  InMemoryConnectorRegistry,
  MapServiceBroker,
} from '../../runtime/src/index.js';
import { connector, secret, server, tool, variable, z } from '../src/index.js';

function application(baseUrl: string, response: Record<string, unknown> = { status: 'conflict' }) {
  const api = connector('resource_api')
    .version('1.0.0')
    .http({
      baseUrl,
      operations: {
        update: {
          type: 'action',
          method: 'PATCH',
          path: '/resources/${args.id}',
          input: z.object({ id: z.string(), version: z.string() }),
          headers: { 'If-Match': '${args.version}' },
          output: z.object({ status: z.enum(['ok', 'conflict']) }),
          response: { status: 'ok' },
          evidence: { outcome: 'completed' },
          responses: { '412': { response, evidence: { outcome: 'rejected' } } },
        },
      },
    });
  return server('resource_app', { title: 'Resource App', version: '1.0.0', use: { api } }, [
    tool('update_resource', {
      description: 'Update a resource when its version still matches.',
      input: z.object({ id: z.string(), version: z.string() }),
      output: z.object({ status: z.enum(['ok', 'conflict']) }),
      fulfil: ({ input, connectors }) => {
        const result = connectors.api.update({ id: input.id, version: input.version });
        return { status: result.status };
      },
    }),
  ]);
}

describe('HTTP response outcome authoring', () => {
  it('emits ordinary typed connector data with explicit expected response mappings', () => {
    const app = application('https://example.com');
    const catalog = app.toConnectorCatalog();
    expect(catalog?.connectors[0]?.operations.update).toMatchObject({
      path: '/resources/{id}',
      responses: { '412': { response: { status: 'conflict' }, evidence: { outcome: 'rejected' } } },
    });
    expect(compileConnectors(JSON.stringify(catalog)).ok).toBe(true);
  });

  it('rejects secret references in response mappings during authoring', () => {
    expect(() =>
      application('https://example.com', { status: secret('PRIVATE_TOKEN') }).toConnectorCatalog(),
    ).toThrow();
  });

  it('normalizes variables so forbidden response roots are rejected during compilation', () => {
    const catalog = application('https://example.com', {
      status: variable('INTERNAL_VALUE'),
    }).toConnectorCatalog();
    expect(compileConnectors(JSON.stringify(catalog)).ok).toBe(false);
  });

  it.each([
    false,
    true,
  ])('validates mapped outcomes through the complete runtime (invalid output: %s)', async (invalid) => {
    let calls = 0;
    let ifMatch: string | string[] | undefined;
    const provider = createServer((req, res) => {
      calls += 1;
      ifMatch = req.headers['if-match'];
      res.writeHead(412, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'private provider diagnostic' } }));
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    try {
      const baseUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
      const app = application(baseUrl, { status: invalid ? 7 : 'conflict' });
      const catalog = compileConnectors(JSON.stringify(app.toConnectorCatalog()));
      if (!catalog.ok) throw new Error(JSON.stringify(catalog.errors));
      const compiled = compileManifest(await app.toManifest(), {
        catalog: new InMemoryCatalog(catalog.catalog),
      });
      if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
      const deps = {
        connectors: new InMemoryConnectorRegistry(catalog.connectors),
        broker: new MapServiceBroker(
          new Map([[MapServiceBroker.key('resource_api'), { token: '' }]]),
        ),
      };
      const result = await executeTool(
        compiled.artifact,
        'update_resource',
        { id: 'one', version: 'v1' },
        deps,
      );
      if (invalid) {
        expect(result.ok).toBe(false);
        expect(JSON.stringify(result)).not.toContain('private provider diagnostic');
      } else {
        expect(result).toEqual({ ok: true, output: { status: 'conflict' } });
      }
      expect(ifMatch).toBe('v1');
      expect(calls).toBe(1);
      await executeTool(compiled.artifact, 'update_resource', { id: 'one', version: 2 }, deps);
      expect(calls).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        provider.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
