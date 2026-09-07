import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileManifest, InMemoryCatalog } from '../../compiler/src/index.js';
import { compileConnectors } from '../../connector-defs/src/index.js';
import {
  type ExecuteDeps,
  executeTool,
  InMemoryConnectorRegistry,
  MapServiceBroker,
} from '../../runtime/src/index.js';
import { connector, server, tool, z } from '../src/index.js';

const CONFIGURED_RESPONSE_LIMIT_BYTES = 6 * 1024 * 1024;
const OBSERVED_ROUND_TRIP_BYTES = 4_960_533;
const EMPTY_RESPONSE_BYTES = Buffer.byteLength(JSON.stringify({ marker: 'ok', padding: '' }));
const SYNTHETIC_RESPONSE_PADDING_BYTES = OBSERVED_ROUND_TRIP_BYTES - EMPTY_RESPONSE_BYTES;

let syntheticServer: Server;
let baseUrl = '';

beforeAll(async () => {
  syntheticServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        marker: 'ok',
        padding: 'x'.repeat(SYNTHETIC_RESPONSE_PADDING_BYTES),
      }),
    );
  });
  await new Promise<void>((resolve) => syntheticServer.listen(0, '127.0.0.1', resolve));
  const address = syntheticServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    syntheticServer.close((error) => (error ? reject(error) : resolve())),
  );
});

async function executeAuthoredTool(app: unknown): Promise<unknown> {
  const authored = app as {
    toConnectorCatalog(): unknown;
    toManifest(): Promise<unknown>;
  };
  const catalog = authored.toConnectorCatalog();
  if (!catalog) throw new Error('expected a connector catalog');
  const compiledConnectors = compileConnectors(JSON.stringify(catalog));
  if (!compiledConnectors.ok) {
    throw new Error(`connector compile failed: ${JSON.stringify(compiledConnectors.errors)}`);
  }
  const compiledManifest = compileManifest(await authored.toManifest(), {
    catalog: new InMemoryCatalog(compiledConnectors.catalog),
  });
  if (!compiledManifest.ok) {
    throw new Error(`manifest compile failed: ${JSON.stringify(compiledManifest.errors)}`);
  }
  const dependencies: ExecuteDeps = {
    connectors: new InMemoryConnectorRegistry(compiledConnectors.connectors),
    broker: new MapServiceBroker(new Map()),
  };
  return executeTool(compiledManifest.artifact, 'fetch_large_response', {}, dependencies);
}

describe('authored HTTP response-size limits', () => {
  it('maps the observed 4,960,533-byte response with an explicit 6 MiB grant', async () => {
    const largeApi = connector('large_api')
      .version('1.0.0')
      .http({
        baseUrl,
        allowedOrigins: [baseUrl],
        operations: {
          fetch: {
            type: 'read',
            method: 'GET',
            path: '/large',
            limits: { maxResponseBytes: CONFIGURED_RESPONSE_LIMIT_BYTES },
            response: { marker: '${response.marker}' },
            output: z.object({ marker: z.string() }),
          },
        },
      });
    const app = server(
      'large_response_test',
      { title: 'Large response test', version: '1.0.0', use: { large_api: largeApi } },
      [
        tool('fetch_large_response', {
          description: 'Fetch and reduce a synthetic large response.',
          input: z.object({}),
          output: z.object({ marker: z.string() }),
          fulfil: ({ connectors }) => ({ marker: connectors.large_api.fetch({}).marker }),
        }),
      ],
    );

    expect(largeApi.httpDef?.operations.fetch.limits).toEqual({
      maxResponseBytes: CONFIGURED_RESPONSE_LIMIT_BYTES,
    });
    await expect(executeAuthoredTool(app)).resolves.toEqual({
      ok: true,
      output: { marker: 'ok' },
    });
  });
});
