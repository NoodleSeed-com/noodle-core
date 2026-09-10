import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { compileManifest, InMemoryCatalog } from '../../compiler/src/index.js';
import { compileConnectors } from '../../connector-defs/src/index.js';
import {
  executeTool,
  InMemoryConnectorRegistry,
  MapServiceBroker,
} from '../../runtime/src/index.js';
import { bind, connection, connector, externalExchange, server, tool, z } from '../src/index.js';

it('carries a Portal-bound account through sandboxed compute to real HTTP with exact broker scopes', async () => {
  let received: string | undefined;
  let calls = 0;
  const provider = createServer((req, res) => {
    calls += 1;
    received = req.headers.authorization;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ value: 'owned-record' }));
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  try {
    const api = bind(
      connector('external_api')
        .version('1.0.0')
        .http({
          baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}`,
          credentialProfiles: { user: { kind: 'bearer' } },
          operations: {
            read: {
              type: 'read',
              path: '/',
              input: z.object({}),
              output: z.object({ value: z.string() }),
              credentials: { profiles: ['user'], scopes: ['records.read'] },
            },
          },
        }),
      { profile: 'user', connection: connection('operator_account', externalExchange()) },
    );
    const application = connector('application')
      .version('1.0.0')
      .compute('read', {
        input: z.object({}),
        output: z.object({ value: z.string() }),
        calls: { read: 'external_api.read' },
        run: (_input, host) => host.callOperation('read', {}),
      });
    const app = server(
      'application_sample',
      { title: 'Application sample', version: '1.0.0', use: { application, selected: api } },
      [
        tool('read', {
          description: 'Read the connected account.',
          input: z.object({}),
          output: z.object({ value: z.string() }),
          fulfil: ({ connectors }) => {
            const output = connectors.application.read({});
            return { value: output.value };
          },
        }),
      ],
    );
    const definitions = compileConnectors(JSON.stringify(app.toConnectorCatalog()));
    if (!definitions.ok) throw new Error(JSON.stringify(definitions.errors));
    const compiled = compileManifest(await app.toManifest(), {
      catalog: new InMemoryCatalog(definitions.catalog),
    });
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
    const fulfilment = compiled.artifact.tools[0]?.fulfilment;
    if (fulfilment?.kind !== 'flow') throw new Error('Expected authored flow');
    const outer = fulfilment.steps.find((step) => step.kind === 'operation');
    if (outer?.kind !== 'operation' || !outer.operationRef.resolved)
      throw new Error('Missing operation');
    const nested = outer.operationRef.calls?.[0];
    if (!nested?.credentialBinding) throw new Error('Missing nested account authority');
    const binding = {
      connectorId: nested.connectorId,
      connectorVersion: nested.connectorVersion,
      operation: nested.operation,
      ...nested.credentialBinding,
    };
    expect(binding).toMatchObject({
      bindingId: 'selected',
      connectionId: 'operator_account',
      requiredScopes: ['records.read'],
    });
    const deps = {
      connectors: new InMemoryConnectorRegistry(definitions.connectors),
      broker: new MapServiceBroker(
        new Map([[MapServiceBroker.bindingKey(binding), { token: 'correct-account-token' }]]),
      ),
    };
    await expect(executeTool(compiled.artifact, 'read', {}, deps)).resolves.toEqual({
      ok: true,
      output: { value: 'owned-record' },
    });
    expect(received).toBe('Bearer correct-account-token');
    expect(calls).toBe(1);
    const missing = await executeTool(
      compiled.artifact,
      'read',
      {},
      {
        ...deps,
        broker: new MapServiceBroker(new Map(), { token: 'ambient-fallback-must-not-be-used' }),
      },
    );
    expect(missing.ok).toBe(false);
    expect(calls).toBe(1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      provider.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
