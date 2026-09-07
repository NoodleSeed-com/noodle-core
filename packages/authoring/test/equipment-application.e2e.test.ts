import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileManifest, InMemoryCatalog } from '../../compiler/src/index.js';
import { compileConnectors } from '../../connector-defs/src/index.js';
import {
  executeTool,
  InMemoryConnectorRegistry,
  StaticServiceBroker,
} from '../../runtime/src/index.js';
import { equipmentApplication } from './fixtures/equipment-application.js';

let customerApi: Server;
let customerApiUrl = '';
let quantity = 3;

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk as Buffer));
    request.on('error', reject);
    request.on('end', () => {
      try {
        resolve(
          chunks.length === 0 ? {} : (JSON.parse(Buffer.concat(chunks).toString()) as object),
        );
      } catch (error) {
        reject(error);
      }
    });
  });
}

function send(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

beforeAll(async () => {
  customerApi = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/stock:scan') {
      send(response, {
        records: [
          {
            id: 'stock-eq-1',
            version: `quantity-${quantity}`,
            record: { code: 'EQ-1', label: 'Projector', quantity },
          },
        ],
        deletedIds: [],
        checkpoint: `quantity-${quantity}`,
        complete: true,
      });
      return;
    }
    if (pathname === '/stock/EQ-1:adjust') {
      void readJson(request).then((body) => {
        quantity += Number(body.delta);
        send(response, { code: 'EQ-1', quantity });
      });
      return;
    }
    if (pathname === '/equipment/EQ-1:inspect') {
      send(response, { code: 'EQ-1', state: 'online' });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => customerApi.listen(0, '127.0.0.1', resolve));
  const { port } = customerApi.address() as AddressInfo;
  customerApiUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    customerApi.close((error) => (error ? reject(error) : resolve())),
  );
});

async function compiledEquipmentApplication() {
  const app = equipmentApplication(customerApiUrl);
  const catalog = app.toConnectorCatalog();
  if (catalog === undefined) throw new Error('expected equipment connector catalog');
  const connectors = compileConnectors(JSON.stringify(catalog));
  if (!connectors.ok) throw new Error(JSON.stringify(connectors.errors));
  const compiled = compileManifest(await app.toManifest(), {
    catalog: new InMemoryCatalog(connectors.catalog),
  });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
  return { app, artifact: compiled.artifact, connectors: connectors.connectors };
}

describe('synthetic equipment developer application', () => {
  it('authors native and external collections without introducing application-specific primitives', async () => {
    const { artifact } = await compiledEquipmentApplication();

    expect(artifact.server.managedCollections).toMatchObject([
      { name: 'assets', source: { authority: 'native' } },
      {
        name: 'stock',
        source: {
          authority: 'external',
          connectorAlias: 'inventory',
          scan: { operation: 'scan_stock', credentialBinding: { profile: 'customer' } },
        },
      },
    ]);
    expect(artifact.tools.map((candidate) => candidate.name)).toEqual([
      'adjust_stock',
      'inspect_equipment',
    ]);
    expect(
      artifact.server.managedCollections?.some(
        (collection) =>
          collection.source.authority === 'external' &&
          collection.source.connectorAlias === 'diagnostics',
      ),
    ).toBe(false);
  });

  it('keeps an ordinary source action separate and observes later source-only changes', async () => {
    quantity = 3;
    const { artifact, connectors } = await compiledEquipmentApplication();
    const dependencies = {
      connectors: new InMemoryConnectorRegistry(connectors),
      broker: new StaticServiceBroker({ token: 'tenant-customer-token' }),
    };

    await expect(
      executeTool(artifact, 'adjust_stock', { code: 'EQ-1', delta: 2 }, dependencies),
    ).resolves.toEqual({ ok: true, output: { code: 'EQ-1', quantity: 5 } });

    const stockSource = artifact.server.managedCollections?.find(
      (collection) => collection.name === 'stock',
    )?.source;
    if (stockSource?.authority !== 'external') throw new Error('expected external stock source');
    const sourceArtifact = {
      ...artifact,
      tools: [
        {
          name: 'test_scan_stock',
          description: 'Test the separate inbound source read.',
          inputSchema: {
            type: 'object' as const,
            properties: {},
            additionalProperties: false,
          },
          fulfilment: {
            kind: 'operation' as const,
            operationRef: stockSource.scan,
            args: {
              mode: { kind: 'literal' as const, value: 'snapshot' },
              limit: { kind: 'literal' as const, value: 100 },
            },
          },
        },
      ],
    };
    await expect(executeTool(sourceArtifact, 'test_scan_stock', {}, dependencies)).resolves.toEqual(
      {
        ok: true,
        output: {
          records: [
            {
              id: 'stock-eq-1',
              version: 'quantity-5',
              record: { code: 'EQ-1', label: 'Projector', quantity: 5 },
            },
          ],
          deletedIds: [],
          checkpoint: 'quantity-5',
          complete: true,
        },
      },
    );

    quantity = 8;
    await expect(
      executeTool(sourceArtifact, 'test_scan_stock', {}, dependencies),
    ).resolves.toMatchObject({
      ok: true,
      output: {
        records: [{ version: 'quantity-8', record: { code: 'EQ-1', quantity: 8 } }],
        checkpoint: 'quantity-8',
      },
    });
  });

  it('executes a live connector tool that has no collection', async () => {
    const { artifact, connectors } = await compiledEquipmentApplication();
    await expect(
      executeTool(
        artifact,
        'inspect_equipment',
        { code: 'EQ-1' },
        {
          connectors: new InMemoryConnectorRegistry(connectors),
          broker: new StaticServiceBroker({ token: '' }),
        },
      ),
    ).resolves.toEqual({ ok: true, output: { code: 'EQ-1', state: 'online' } });
  });
});
