import { compileManifest, InMemoryCatalog } from '@noodle-borg/compiler';
import { compileConnectors } from '@noodle-borg/connector-defs';
import { describe, expect, it } from 'vitest';
import { connector, customerAuth, customerEndpoint, server, tool, z } from '../src/index.js';

describe('customer endpoint cross-compilation', () => {
  it('compiles authoring through the connector catalog without emitting a customer URL', async () => {
    const endpoint = customerEndpoint('customer_api', {
      allowedHttpsHostSuffixes: ['noodleseed.dev'],
    });
    const api = connector('customer_records')
      .version('1.0.0')
      .http({
        baseUrl: endpoint,
        operations: {
          list_records: {
            type: 'read',
            method: 'GET',
            path: '/records',
            input: z.object({}),
            output: z.object({ records: z.array(z.unknown()).max(100) }),
          },
        },
      });
    const app = server(
      'customer_records',
      {
        title: 'Customer records',
        version: '1.0.0',
        use: { api },
        auth: customerAuth.oidc({
          issuer: 'https://id.noodleseed.dev',
          audience: 'https://org.cloud.noodleseed.dev/app/mcp',
          routing: {
            endpoints: {
              customer_api: { claim: 'tenant.api_base_url' },
            },
          },
        }),
      },
      [
        tool('list_records', {
          description: 'List customer records.',
          input: z.object({}),
          output: z.object({ records: z.array(z.unknown()).max(100) }),
          fulfil({ connectors }) {
            const result = connectors.api.listRecords();
            return { records: result.records };
          },
        }),
      ],
    );

    const compiledConnectors = compileConnectors(JSON.stringify(app.toConnectorCatalog()));
    expect(compiledConnectors.ok).toBe(true);
    if (!compiledConnectors.ok) return;
    const compiled = compileManifest(await app.toManifest(), {
      catalog: new InMemoryCatalog(compiledConnectors.catalog),
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.artifact.customerEndpoints).toEqual({
      customer_api: { allowedHttpsHostSuffixes: ['noodleseed.dev'] },
    });
    const fulfilment = compiled.artifact.tools[0]?.fulfilment;
    expect(fulfilment?.kind).toBe('flow');
    if (fulfilment?.kind !== 'flow') return;
    expect(fulfilment.steps[0]).toMatchObject({
      kind: 'operation',
      operationRef: {
        resolved: true,
        customerEndpoint: 'customer_api',
      },
    });
    expect(JSON.stringify(compiled.artifact)).not.toContain('tenant-a.api.noodleseed.dev');
  });
});
