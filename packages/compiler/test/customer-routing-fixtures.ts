import { type compileManifest, InMemoryCatalog } from '../src/index.js';

export const emptySchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

export const suffixPolicy = {
  allowedHttpsHostSuffixes: ['noodleseed.dev'],
} as const;

export const routedCatalog = new InMemoryCatalog([
  {
    id: 'customer_records',
    version: '1.0.0',
    kind: 'custom',
    credentialProfiles: { delegated: { kind: 'bearer' } },
    operations: {
      list_records: { type: 'read', input: emptySchema, output: emptySchema },
      write_record: { type: 'action', input: emptySchema, output: emptySchema },
      read_wrapping_action: { type: 'read', input: emptySchema, output: emptySchema },
    },
    customerRouting: {
      directEndpoint: 'customer_api',
      endpoints: { customer_api: suffixPolicy },
      operationEndpoints: {
        list_records: ['customer_api'],
        read_wrapping_action: ['customer_api'],
        write_record: ['customer_api'],
      },
      operationActionEndpoints: {
        list_records: [],
        read_wrapping_action: ['customer_api'],
        write_record: ['customer_api'],
      },
    },
  },
  {
    id: 'customer_wrapper',
    version: '1.0.0',
    kind: 'custom',
    operations: {
      nested_read: { type: 'read', input: emptySchema, output: emptySchema },
      nested_action: { type: 'action', input: emptySchema, output: emptySchema },
    },
    customerRouting: {
      endpoints: { customer_api: suffixPolicy },
      operationEndpoints: {
        nested_action: ['customer_api'],
        nested_read: ['customer_api'],
      },
      operationActionEndpoints: {
        nested_action: ['customer_api'],
        nested_read: [],
      },
    },
  },
]);

export const prototypeEndpointCatalog = new InMemoryCatalog([
  {
    id: 'customer_records',
    version: '1.0.0',
    kind: 'custom',
    operations: {
      list_records: { type: 'read', input: emptySchema, output: emptySchema },
    },
    customerRouting: {
      directEndpoint: '__proto__',
      endpoints: { ['__proto__']: suffixPolicy },
      operationEndpoints: { list_records: ['__proto__'] },
      operationActionEndpoints: { list_records: [] },
    },
  },
]);

export const staticCatalog = new InMemoryCatalog([
  {
    id: 'static_records',
    version: '1.0.0',
    kind: 'custom',
    operations: {
      list_records: { type: 'read', input: emptySchema, output: emptySchema },
    },
  },
]);

export function directAuth(
  endpoints: Record<string, { readonly claim: string }> = {
    customer_api: { claim: 'tenant.api_base_url' },
  },
) {
  return {
    issuer: 'https://id.noodleseed.dev',
    audience: 'https://org.cloud.noodleseed.dev/app/mcp',
    routing: { endpoints },
  };
}

export function federatedAuth(
  firstEndpoints: Record<string, { readonly claim: string }> = {
    customer_api: { claim: 'tenant.api_base_url' },
  },
  secondEndpoints: Record<string, { readonly claim: string }> = {
    customer_api: { claim: 'organization.routes.customer_api' },
  },
) {
  return {
    kind: 'federatedOidc',
    issuers: [
      {
        issuer: 'https://first.id.noodleseed.dev',
        audience: 'https://org.cloud.noodleseed.dev/app/mcp',
        routing: { endpoints: firstEndpoints },
      },
      {
        issuer: 'https://second.id.noodleseed.dev',
        audience: 'https://org.cloud.noodleseed.dev/app/mcp',
        routing: { endpoints: secondEndpoints },
      },
    ],
  };
}

interface AppOptions {
  readonly auth?: unknown;
  readonly connectorId?: string;
  readonly operation?: string;
  readonly confirm?: unknown;
  readonly bindingSource?: unknown;
  readonly surface?: 'tool' | 'resource' | 'prompt' | 'ambient';
}

export function app(options: AppOptions = {}) {
  const surface = options.surface ?? 'tool';
  const connector = {
    id: options.connectorId ?? 'customer_records',
    version: '1.0.0',
    ...(options.bindingSource === undefined
      ? {}
      : {
          binding: {
            profile: 'delegated',
            connection: {
              id: 'customer_records',
              source: options.bindingSource,
            },
          },
        }),
  };
  const fulfilment = {
    use: `api.${options.operation ?? 'list_records'}`,
    args: {},
  };
  const server = {
    name: 'customer_records',
    version: '1.0.0',
    title: 'Customer Records',
    ...(options.auth === undefined ? {} : { auth: options.auth }),
    ...(surface === 'ambient'
      ? {
          context: {
            ambient: {
              outputSchema: emptySchema,
              fulfilment,
            },
          },
        }
      : {}),
  };
  return {
    manifestVersion: '2',
    server,
    connectors: { api: connector },
    tools: [
      surface === 'tool'
        ? {
            name: 'list_records',
            description: 'List customer records.',
            inputSchema: emptySchema,
            ...(options.confirm === undefined ? {} : { annotations: { confirm: options.confirm } }),
            fulfilment,
          }
        : {
            name: 'noop',
            description: 'No-op.',
            inputSchema: emptySchema,
            fulfilment: { steps: [], output: { ok: true } },
          },
    ],
    ...(surface === 'resource'
      ? {
          resources: [
            {
              name: 'records',
              uri: 'records://current',
              fulfilment,
            },
          ],
        }
      : {}),
    ...(surface === 'prompt'
      ? {
          prompts: [
            {
              name: 'records',
              fulfilment,
            },
          ],
        }
      : {}),
  };
}

export function codes(result: ReturnType<typeof compileManifest>): readonly string[] {
  return result.ok ? [] : result.errors.map((error) => error.code);
}
