import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { manifestJsonSchema } from '../src/schema-export.js';

describe('manifest JSON Schema export', () => {
  const schema = manifestJsonSchema();

  it('declares the JSON Schema 2020-12 dialect', () => {
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('compiles as a usable schema under ajv (2020-12)', () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema);

    expect(
      validate({
        manifestVersion: '1',
        server: { name: 'acme_support', version: '1.0.0', title: 'Acme Support' },
        tools: [
          {
            name: 'get_order',
            description: 'Look up an order.',
            inputSchema: { type: 'object' },
            fulfilment: { use: 'acme.get_order' },
          },
        ],
      }),
    ).toBe(true);

    expect(validate({ manifestVersion: '0.9' })).toBe(false);
  });

  it('publishes the non-empty tool authorization contract', () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema);
    const manifest = {
      manifestVersion: '1',
      server: { name: 'acme_support', version: '1.0.0', title: 'Acme Support' },
      tools: [
        {
          name: 'get_order',
          description: 'Look up an order.',
          authorization: {},
          inputSchema: { type: 'object' },
          fulfilment: { use: 'acme.get_order' },
        },
      ],
    };

    expect(validate(manifest)).toBe(false);
    expect(
      validate({
        ...manifest,
        tools: [
          {
            ...manifest.tools[0],
            authorization: { requiredScopes: ['orders:read'] },
          },
        ],
      }),
      JSON.stringify(validate.errors),
    ).toBe(true);
  });

  it('publishes the non-empty customer routing and claim-path contracts', () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema);
    const manifest = {
      manifestVersion: '2',
      server: {
        name: 'customer_records',
        version: '1.0.0',
        title: 'Customer Records',
        auth: {
          issuer: 'https://id.noodleseed.dev',
          audience: 'https://org.cloud.noodleseed.dev/app/mcp',
          routing: {
            endpoints: {
              customer_api: { claim: 'tenant.api_base_url' },
            },
          },
        },
      },
      tools: [
        {
          name: 'list_records',
          description: 'List customer records.',
          inputSchema: { type: 'object' },
          fulfilment: { steps: [], output: { ok: true } },
        },
      ],
    };

    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
    expect(
      validate({
        ...manifest,
        server: {
          ...manifest.server,
          auth: {
            ...manifest.server.auth,
            routing: { endpoints: {} },
          },
        },
      }),
    ).toBe(false);
    expect(
      validate({
        ...manifest,
        server: {
          ...manifest.server,
          auth: {
            ...manifest.server.auth,
            routing: {
              endpoints: {
                'customer-api': { claim: 'tenant.api_base_url' },
              },
            },
          },
        },
      }),
    ).toBe(false);
    expect(
      validate({
        ...manifest,
        server: {
          ...manifest.server,
          auth: {
            ...manifest.server.auth,
            routing: {
              endpoints: {
                customer_api: { claim: 'tenant..api_base_url' },
              },
            },
          },
        },
      }),
    ).toBe(false);
  });

  it('preserves the Atlas presentation boundary and accessibility constraints', () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema);
    const manifest = {
      manifestVersion: '1',
      server: {
        name: 'assistant_schema',
        version: '1.0.0',
        title: 'Assistant Schema',
        assistant: {
          model: {
            kind: 'openai-compatible',
            baseUrl: 'https://models.example/v1',
            model: 'example',
            apiKey: 'MODEL_KEY',
          },
          allowedOrigins: ['https://app.example.com'],
          labels: {
            composerPlaceholder: 'Message Atlas…',
            sessionReady: 'Atlas support is online',
          },
          presentation: {
            panel: { surface: 'solid', elevation: 'dramatic', border: 'strong', radius: 20 },
            launcher: { icon: 'chat', size: 'lg', status: 'session', effect: 'pulse' },
            header: {
              mark: 'status',
              badge: { text: 'ONLINE', tone: 'success', indicator: true },
            },
            composer: { leadingIcon: 'brand-mark', sendIcon: 'paper-plane', shape: 'rounded' },
            messages: { userStyle: 'accent', assistantStyle: 'bubble' },
          },
        },
      },
      tools: [
        {
          name: 'status',
          description: 'Read status.',
          inputSchema: { type: 'object' },
          fulfilment: { steps: [], output: { ok: true } },
        },
      ],
    };
    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);

    expect(
      validate({
        ...manifest,
        manifestVersion: '2',
        server: {
          ...manifest.server,
          assistant: {
            ...manifest.server.assistant,
            model: { kind: 'noodle-managed' },
          },
        },
      }),
      JSON.stringify(validate.errors),
    ).toBe(true);

    expect(
      validate({
        ...manifest,
        server: {
          ...manifest.server,
          assistant: {
            ...manifest.server.assistant,
            presentation: {
              ...manifest.server.assistant.presentation,
              emptyState: { variant: 'hero' },
            },
          },
        },
      }),
    ).toBe(false);

    expect(
      validate({
        ...manifest,
        server: {
          ...manifest.server,
          assistant: {
            ...manifest.server.assistant,
            presentation: {
              ...manifest.server.assistant.presentation,
              launcher: {
                ...manifest.server.assistant.presentation.launcher,
                variant: 'orbital',
              },
            },
          },
        },
      }),
    ).toBe(false);

    expect(
      validate({
        ...manifest,
        server: {
          ...manifest.server,
          assistant: {
            ...manifest.server.assistant,
            labels: { ...manifest.server.assistant.labels, composerPlaceholder: '' },
          },
        },
      }),
    ).toBe(false);

    expect(
      validate({
        ...manifest,
        server: {
          ...manifest.server,
          assistant: {
            ...manifest.server.assistant,
            allowedOrigins: ['http://app.example.com'],
          },
        },
      }),
    ).toBe(false);
  });

  it('exports full-string validation for assistant origins', () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema);
    const manifest = {
      manifestVersion: '1',
      server: {
        name: 'assistant_origins',
        version: '1.0.0',
        title: 'Assistant Origins',
        assistant: {
          model: {
            kind: 'openai-compatible',
            baseUrl: 'https://models.example/v1',
            model: 'example',
            apiKey: 'MODEL_KEY',
          },
          allowedOrigins: ['https://app.example.com:8443'],
        },
      },
      tools: [
        {
          name: 'status',
          description: 'Read status.',
          inputSchema: { type: 'object' },
          fulfilment: { steps: [], output: { ok: true } },
        },
      ],
    };
    const withOrigin = (origin: string) => ({
      ...manifest,
      server: {
        ...manifest.server,
        assistant: { ...manifest.server.assistant, allowedOrigins: [origin] },
      },
    });

    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
    for (const origin of [
      'https://app.example.com/path',
      'https://app.example.com?mode=embed',
      'https://app.example.com#assistant',
      'https://user:password@app.example.com',
      'https://app.example.com/',
      'http://localhost:3000/',
    ]) {
      expect(validate(withOrigin(origin)), origin).toBe(false);
    }
  });
});
