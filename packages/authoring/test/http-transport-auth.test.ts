import { describe, expect, it } from 'vitest';
import { compileManifest, InMemoryCatalog } from '../../compiler/src/index.js';
import { compileConnectors } from '../../connector-defs/src/index.js';
import {
  bind,
  connection,
  connector,
  externalExchange,
  secret,
  server,
  tool,
  variable,
  z,
} from '../src/index.js';

describe('application gateway transport authentication authoring', () => {
  it('compiles a deployment secret independently from a connected account without exposing either value', async () => {
    const gateway = connector('mail_gateway')
      .version('1.0.0')
      .http({
        baseUrl: variable('MAIL_GATEWAY_URL'),
        allowedOrigins: ['https://gateway.example.com'],
        transportAuth: {
          kind: 'apiKey',
          header: 'X-Gateway-Key',
          secret: secret('MAIL_GATEWAY_KEY'),
        },
        credentialProfiles: { account: { kind: 'bearer' } },
        operations: {
          inspect: {
            type: 'read',
            method: 'POST',
            path: '/inspect',
            credentials: { profiles: ['account'] },
            input: z.object({}),
            output: z.object({ available: z.boolean() }),
          },
        },
      });
    const app = server(
      'gateway_example',
      {
        title: 'Application Gateway Example',
        version: '1.0.0',
        use: {
          mail: bind(gateway, {
            profile: 'account',
            connection: connection('work_mail', externalExchange()),
          }),
        },
      },
      [
        tool('inspect_mail', {
          description:
            'Inspect availability through the separately authenticated application gateway.',
          input: z.object({}),
          output: z.object({ available: z.boolean() }),
          fulfil: ({ connectors }) => ({ available: connectors.mail.inspect({}).available }),
        }),
      ],
    );
    const compiledConnectors = compileConnectors(JSON.stringify(app.toConnectorCatalog()));
    expect(compiledConnectors.ok).toBe(true);
    if (!compiledConnectors.ok) throw new Error(JSON.stringify(compiledConnectors.errors));
    expect(compiledConnectors.secretBindings).toEqual([
      { connectorId: 'mail_gateway', connectorVersion: '1.0.0', secretRef: 'MAIL_GATEWAY_KEY' },
    ]);
    const manifest = await app.toManifest();
    const compiled = compileManifest(manifest, {
      catalog: new InMemoryCatalog(compiledConnectors.catalog),
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
    expect(JSON.stringify(manifest)).not.toContain('MAIL_GATEWAY_KEY');
    expect(JSON.stringify(compiled.artifact)).not.toContain('MAIL_GATEWAY_KEY');
    expect(JSON.stringify(compiled.artifact)).toContain('work_mail');
  });
});
