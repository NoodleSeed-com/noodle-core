import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  type CatalogConnector,
  compileManifest,
  InMemoryCatalog,
  type OperationSignature,
} from '@noodle-borg/compiler';
import {
  type CredentialBroker,
  type ExecuteDeps,
  executeTool,
  InMemoryConnectorRegistry,
} from '@noodle-borg/runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpConnector } from '../src/index.js';

const signature: OperationSignature = {
  type: 'action',
  input: {
    type: 'object',
    properties: { label: { type: 'string' } },
    required: ['label'],
    additionalProperties: false,
  },
  output: { type: 'object', additionalProperties: true },
};

describe('HttpConnector binding credential presentation', () => {
  let server: Server;
  let baseUrl: string;
  let headers: IncomingMessage['headers'];

  beforeAll(async () => {
    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      headers = request.headers;
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing test port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  });

  it('uses each alias profile instead of the connector legacy auth', async () => {
    const catalog: CatalogConnector = {
      id: 'echo',
      version: '1.0.0',
      kind: 'catalog',
      credentialProfiles: {
        bearer_account: { kind: 'bearer' },
        api_account: { kind: 'apiKey', header: 'X-API-Key' },
      },
      operationCredentials: {
        create: { profiles: ['bearer_account', 'api_account'], scopes: ['write'] },
      },
      operations: { create: signature },
    };
    const compiled = compileManifest(
      {
        manifestVersion: '2',
        server: { name: 'bound_echo', version: '1.0.0', title: 'Bound Echo' },
        connectors: {
          personal: {
            id: 'echo',
            version: '1.0.0',
            binding: {
              profile: 'bearer_account',
              connection: { id: 'personal', source: { kind: 'externalExchange' } },
            },
          },
          work: {
            id: 'echo',
            version: '1.0.0',
            binding: {
              profile: 'api_account',
              connection: { id: 'work', source: { kind: 'externalExchange' } },
            },
          },
        },
        tools: ['personal', 'work'].map((alias) => ({
          name: `create_${alias}`,
          description: `Create for ${alias}.`,
          inputSchema: signature.input,
          fulfilment: { use: `${alias}.create`, args: { label: '${input.label}' } },
        })),
      },
      { catalog: new InMemoryCatalog([catalog]) },
    );
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
    const connector = new HttpConnector({
      id: 'echo',
      version: '1.0.0',
      baseUrl,
      auth: { kind: 'bearer' },
      operations: {
        create: { method: 'POST', path: '/', signature, body: (arguments_) => arguments_ },
      },
    });
    const broker: CredentialBroker = {
      async getCredential(request) {
        return { token: request.bindingId === 'personal' ? 'personal-token' : 'work-token' };
      },
    };
    const deps: ExecuteDeps = {
      connectors: new InMemoryConnectorRegistry([connector]),
      broker,
    };

    await executeTool(compiled.artifact, 'create_personal', { label: 'one' }, deps);
    expect(headers.authorization).toBe('Bearer personal-token');
    expect(headers['x-api-key']).toBeUndefined();
    await executeTool(compiled.artifact, 'create_work', { label: 'two' }, deps);
    expect(headers.authorization).toBeUndefined();
    expect(headers['x-api-key']).toBe('work-token');
  });
});
