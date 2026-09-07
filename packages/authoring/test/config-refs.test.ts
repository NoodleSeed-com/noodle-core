import { describe, expect, it } from 'vitest';
import { compileConnectors } from '../../connector-defs/src/index.js';
import {
  connector,
  embeddedAssistant,
  openAICompatible,
  publicWebsite,
  secret,
  server,
  tool,
  variable,
  z,
} from '../src/index.js';

describe('managed config authoring refs', () => {
  it('serializes variable refs in tool outputs and connector args', async () => {
    const upstream = connector('upstream')
      .version('1.0.0')
      .operation('lookup', {
        type: 'read',
        input: z.object({ region: z.string() }),
        output: z.object({ ok: z.boolean().optional() }),
      });
    const app = server(
      'config_demo',
      { title: 'Config Demo', version: '1.0.0', use: { upstream } },
      [
        tool('lookup', {
          description: 'Use a managed variable.',
          input: z.object({}),
          output: z.object({ region: z.string() }),
          fulfil({ connectors }) {
            connectors.upstream.lookup({ region: variable('REGION') });
            return { region: variable('REGION') };
          },
        }),
      ],
    );

    const manifest = await app.toManifest();

    expect(manifest.tools[0]?.fulfilment.steps?.[0]).toMatchObject({
      args: { region: '${env.REGION}' },
    });
    expect(manifest.tools[0]?.fulfilment.output).toEqual({ region: '${env.REGION}' });
  });

  it('serializes secret refs only in connector auth slots', () => {
    const api = connector('api')
      .version('1.0.0')
      .http({
        baseUrl: 'https://api.example.com',
        allowedOrigins: ['https://api.example.com'],
        auth: { kind: 'bearer', secret: secret('API_TOKEN') },
        operations: {
          ping: {
            type: 'read',
            method: 'GET',
            path: '/ping',
            output: z.object({ ok: z.boolean().optional() }),
            response: { ok: true },
          },
        },
      });

    const compiled = compileConnectors(
      JSON.stringify(
        server('s', { title: 'S', version: '1.0.0', use: { api } }).toConnectorCatalog(),
      ),
    );

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.secretBindings).toEqual([
      { connectorId: 'api', connectorVersion: '1.0.0', secretRef: 'API_TOKEN' },
    ]);
  });

  it('serializes one managed exact origin across connector, handoff, and assistant boundaries', async () => {
    const storeOrigin = variable('SHOPIFY_STORE_ORIGIN');
    const storefront = connector('shopify')
      .version('1.0.0')
      .http({
        baseUrl: storeOrigin,
        allowedOrigins: [storeOrigin],
        operations: {
          ping: {
            type: 'read',
            method: 'GET',
            path: '/products.json',
            output: z.object({}),
          },
        },
      });
    const browse = tool('browse', {
      description: 'Browse the configured storefront.',
      input: z.object({}),
      output: z.object({ storeOrigin: z.string() }),
      fulfil: () => ({ storeOrigin }),
    });
    const app = server(
      'managed_storefront',
      {
        title: 'Managed storefront',
        version: '1.0.0',
        use: { storefront },
        handoff: { allowedDomains: [storeOrigin] },
        assistant: embeddedAssistant({
          model: openAICompatible({
            baseUrl: variable('ASSISTANT_MODEL_BASE_URL'),
            model: variable('ASSISTANT_MODEL'),
            apiKey: secret('ASSISTANT_MODEL_API_KEY'),
          }),
          access: publicWebsite({ origins: [storeOrigin], capabilities: [browse] }),
        }),
      },
      [browse],
    );

    const manifest = await app.toManifest();
    const catalog = app.toConnectorCatalog();

    expect(catalog?.connectors[0]?.http).toMatchObject({
      baseUrl: '${env.SHOPIFY_STORE_ORIGIN}',
      allowedOrigins: ['${env.SHOPIFY_STORE_ORIGIN}'],
    });
    expect(manifest.handoff?.allowedDomains).toEqual(['${env.SHOPIFY_STORE_ORIGIN}']);
    expect(manifest.server.assistant?.allowedOrigins).toEqual(['${env.SHOPIFY_STORE_ORIGIN}']);
    expect(manifest.server.assistant?.surfaces[0]?.origins).toEqual([
      '${env.SHOPIFY_STORE_ORIGIN}',
    ]);
  });

  it('rejects secret refs in non-credential authoring contexts', async () => {
    const app = server('bad_secret', { title: 'Bad Secret', version: '1.0.0' }, [
      tool('leak', {
        description: 'Attempt to leak a secret.',
        input: z.object({}),
        output: z.object({ value: z.string() }),
        fulfil() {
          return { value: secret('API_TOKEN') };
        },
      }),
    ]);

    await expect(app.toManifest()).rejects.toThrow(/secret\("API_TOKEN"\).*credential/i);
  });
});
