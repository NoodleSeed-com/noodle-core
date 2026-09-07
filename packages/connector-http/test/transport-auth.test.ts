import { createServer, type IncomingMessage } from 'node:http';
import { compileManifest, InMemoryCatalog, type OperationSignature } from '@noodle-borg/compiler';
import { executeTool, InMemoryConnectorRegistry } from '@noodle-borg/runtime';
import { describe, expect, it } from 'vitest';
import { HttpConnector } from '../src/index.js';

const signature: OperationSignature = {
  type: 'read',
  input: { type: 'object', properties: {}, additionalProperties: false },
  output: { type: 'object', properties: {}, additionalProperties: false },
};
function artifact() {
  const result = compileManifest(
    {
      manifestVersion: '2',
      server: { name: 'adapter', version: '1.0.0', title: 'Adapter' },
      connectors: {
        application: {
          id: 'application',
          version: '1.0.0',
          binding: {
            profile: 'account',
            connection: { id: 'business_account', source: { kind: 'externalExchange' } },
          },
        },
      },
      tools: [
        {
          name: 'read',
          description: 'Read authorized account data.',
          inputSchema: signature.input,
          fulfilment: { use: 'application.read', args: {} },
        },
      ],
    },
    {
      catalog: new InMemoryCatalog([
        {
          id: 'application',
          version: '1.0.0',
          kind: 'custom',
          credentialProfiles: { account: { kind: 'bearer' } },
          operationCredentials: { read: { profiles: ['account'] } },
          operations: { read: signature },
        },
      ]),
    },
  );
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.artifact;
}

describe('broker-scoped independent transport credentials', () => {
  it('keeps the selected business credential separate from lazy deployment transport auth', async () => {
    let received: IncomingMessage['headers'] = {};
    const server = createServer((request, response) => {
      received = request.headers;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing server address');
    const requests: { bindingId?: string; tenantId?: string; deploymentId?: string }[] = [];
    try {
      const connector = new HttpConnector({
        id: 'application',
        version: '1.0.0',
        baseUrl: `http://127.0.0.1:${address.port}`,
        transportAuth: { kind: 'apiKey', header: 'X-Adapter-Key' },
        operations: { read: { path: '/', signature } },
      });
      const result = await executeTool(
        artifact(),
        'read',
        {},
        {
          tenantId: 'business-one',
          deploymentId: 'deployment-one',
          connectors: new InMemoryConnectorRegistry([connector]),
          broker: {
            async getCredential(request) {
              requests.push(request);
              return {
                token: request.bindingId === undefined ? 'deployment-key' : 'business-google-token',
              };
            },
          },
        },
      );
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      expect(received.authorization).toBe('Bearer business-google-token');
      expect(received['x-adapter-key']).toBe('deployment-key');
      expect(requests).toEqual([
        expect.objectContaining({
          bindingId: 'application',
          connectionId: 'business_account',
          tenantId: 'business-one',
          deploymentId: 'deployment-one',
        }),
        expect.objectContaining({ tenantId: 'business-one', deploymentId: 'deployment-one' }),
      ]);
      expect(requests[1]).not.toHaveProperty('bindingId');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('never acquires a transport credential when egress is refused', async () => {
    let acquired = 0;
    const connector = new HttpConnector({
      id: 'application',
      version: '1.0.0',
      baseUrl: 'https://application.example',
      allowedOrigins: ['https://permitted.example'],
      transportAuth: { kind: 'apiKey', header: 'X-Adapter-Key' },
      operations: { read: { path: '/', signature } },
    });
    await expect(
      connector.invoke({
        operation: 'read',
        args: {},
        credential: { token: 'business-token' },
        credentialPresentation: { kind: 'bearer' },
        acquireTransportCredential: async () => {
          acquired += 1;
          return { token: 'deployment-key' };
        },
      }),
    ).rejects.toThrow();
    expect(acquired).toBe(0);
  });

  it('never acquires the transport secret after private DNS resolution is refused', async () => {
    let acquired = 0;
    const connector = new HttpConnector({
      id: 'application',
      version: '1.0.0',
      baseUrl: 'https://private.example',
      transportAuth: { kind: 'apiKey', header: 'X-Adapter-Key' },
      lookup: (_hostname, _options, callback) =>
        callback(null, [{ address: '127.0.0.1', family: 4 }]),
      operations: { read: { path: '/', signature } },
    });
    await expect(
      connector.invoke({
        operation: 'read',
        args: {},
        credential: { token: 'business-token' },
        credentialPresentation: { kind: 'bearer' },
        acquireTransportCredential: async () => {
          acquired += 1;
          return { token: 'deployment-key' };
        },
      }),
    ).rejects.toThrow();
    expect(acquired).toBe(0);
  });

  it('never acquires either credential after policy denial', async () => {
    let acquired = 0;
    const connector = new HttpConnector({
      id: 'application',
      version: '1.0.0',
      baseUrl: 'https://application.example',
      transportAuth: { kind: 'apiKey', header: 'X-Adapter-Key' },
      operations: { read: { path: '/', signature } },
    });
    const result = await executeTool(
      artifact(),
      'read',
      {},
      {
        connectors: new InMemoryConnectorRegistry([connector]),
        broker: {
          async getCredential() {
            acquired += 1;
            return { token: 'unused' };
          },
        },
        policy: {
          async before() {
            return { allow: false, reason: 'denied' };
          },
          async after() {},
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(acquired).toBe(0);
  });

  it('rejects a case-insensitive collision before acquiring the transport secret', async () => {
    let acquired = 0;
    const connector = new HttpConnector({
      id: 'application',
      version: '1.0.0',
      baseUrl: 'http://127.0.0.1:1',
      transportAuth: { kind: 'apiKey', header: 'X-Adapter-Key' },
      operations: { read: { path: '/', signature } },
    });
    await expect(
      connector.invoke({
        operation: 'read',
        args: {},
        credential: { token: 'business-token' },
        credentialPresentation: { kind: 'apiKey', header: 'x-adapter-key' },
        acquireTransportCredential: async () => {
          acquired += 1;
          return { token: 'deployment-key' };
        },
      }),
    ).rejects.toThrow();
    expect(acquired).toBe(0);
  });
});
