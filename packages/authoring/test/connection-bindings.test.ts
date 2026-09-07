import { describe, expect, it } from 'vitest';
import * as sdk from '../src/index.js';

describe('connector connection bindings', () => {
  it('exports the canonical connection and binding helpers', () => {
    expect(typeof (sdk as Record<string, unknown>).connection).toBe('function');
    expect(typeof (sdk as Record<string, unknown>).bind).toBe('function');
    expect(typeof (sdk as Record<string, unknown>).externalExchange).toBe('function');
    expect(typeof (sdk as Record<string, unknown>).googleWorkloadIdentity).toBe('function');
    expect(typeof (sdk as Record<string, unknown>).managedSecret).toBe('function');
    expect(typeof (sdk as Record<string, unknown>).clientCredentials).toBe('function');
  });

  it('serializes direct and service-account-impersonating Google workload identities as variables only', () => {
    const api = sdk as typeof sdk & {
      googleWorkloadIdentity: (options: {
        provider: unknown;
        access:
          | { kind: 'direct' }
          | { kind: 'serviceAccountImpersonation'; serviceAccount: unknown };
      }) => unknown;
    };

    expect(
      api.connection(
        'google_cloud',
        api.googleWorkloadIdentity({
          provider: sdk.variable('GOOGLE_WIF_PROVIDER'),
          access: { kind: 'direct' },
        }),
      ),
    ).toEqual({
      id: 'google_cloud',
      source: {
        kind: 'googleWorkloadIdentity',
        provider: '${env.GOOGLE_WIF_PROVIDER}',
        access: { kind: 'direct' },
      },
    });

    expect(
      api.connection(
        'google_workspace',
        api.googleWorkloadIdentity({
          provider: sdk.variable('GOOGLE_WIF_PROVIDER'),
          access: {
            kind: 'serviceAccountImpersonation',
            serviceAccount: sdk.variable('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
          },
        }),
      ),
    ).toEqual({
      id: 'google_workspace',
      source: {
        kind: 'googleWorkloadIdentity',
        provider: '${env.GOOGLE_WIF_PROVIDER}',
        access: {
          kind: 'serviceAccountImpersonation',
          serviceAccount: '${env.GOOGLE_SERVICE_ACCOUNT_EMAIL}',
        },
      },
    });

    expect(() =>
      api.googleWorkloadIdentity({
        provider: sdk.secret('GOOGLE_WIF_PROVIDER'),
        access: { kind: 'direct' },
      }),
    ).toThrow(/secret|variable/i);
    expect(() =>
      api.googleWorkloadIdentity({
        provider: sdk.variable('GOOGLE_WIF_PROVIDER'),
        access: {
          kind: 'serviceAccountImpersonation',
          serviceAccount: sdk.secret('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
        },
      }),
    ).toThrow(/secret|variable/i);
  });

  it('binds two aliases of one connector without emitting provider accounts or credential values', async () => {
    const mail = sdk
      .connector('mail')
      .version('1.0.0')
      .http({
        baseUrl: 'https://mail.example.com',
        credentialProfiles: {
          delegated: { kind: 'bearer' },
          service: { kind: 'bearer' },
        },
        operations: {
          search: {
            type: 'read',
            path: '/messages',
            input: sdk.z.object({}),
            output: sdk.z.object({}),
          },
        },
      });
    const personal = sdk.connection('personal_mail', sdk.externalExchange());
    const work = sdk.connection('work_mail', sdk.externalExchange());
    const app = sdk.server(
      'mail_reader',
      {
        title: 'Mail Reader',
        version: '1.0.0',
        use: {
          personal: sdk.bind(mail, { profile: 'delegated', connection: personal }),
          work: sdk.bind(mail, { profile: 'delegated', connection: work }),
        },
      },
      [
        sdk.tool('search_personal', {
          description: 'Search personal mail.',
          input: sdk.z.object({}),
          fulfil: ({ connectors }) => ({ result: connectors.personal.search({}) }),
        }),
        sdk.tool('search_work', {
          description: 'Search work mail.',
          input: sdk.z.object({}),
          fulfil: ({ connectors }) => ({ result: connectors.work.search({}) }),
        }),
      ],
    );

    const manifest = await app.toManifest();
    expect(manifest.connectors).toEqual({
      personal: {
        id: 'mail',
        version: '1.0.0',
        binding: {
          profile: 'delegated',
          connection: { id: 'personal_mail', source: { kind: 'externalExchange' } },
        },
      },
      work: {
        id: 'mail',
        version: '1.0.0',
        binding: {
          profile: 'delegated',
          connection: { id: 'work_mail', source: { kind: 'externalExchange' } },
        },
      },
    });
    const emitted = JSON.stringify(manifest);
    expect(emitted).not.toContain('@');
    expect(emitted).not.toContain('token');
    expect(emitted).not.toContain('secretValue');
  });

  it('serializes managed-secret and client-credentials sources as managed reference names only', () => {
    const api = sdk as typeof sdk & {
      connection: (id: string, source: unknown) => { id: string; source: unknown };
      managedSecret: (
        secret: unknown,
        capabilities?: { readonly scopes?: readonly string[]; readonly audience?: string },
      ) => unknown;
      clientCredentials: (options: {
        tokenUrl: unknown;
        clientId: unknown;
        clientSecret: unknown;
        scopes?: readonly string[];
        audience?: string;
      }) => unknown;
    };
    expect(typeof api.connection).toBe('function');
    if (typeof api.connection !== 'function') return;

    expect(
      api.connection(
        'api_key',
        api.managedSecret(sdk.secret('MAIL_API_KEY'), {
          scopes: ['mail.read'],
          audience: 'https://mail.example.com',
        }),
      ),
    ).toEqual({
      id: 'api_key',
      source: {
        kind: 'managedSecret',
        secret: 'MAIL_API_KEY',
        scopes: ['mail.read'],
        audience: 'https://mail.example.com',
      },
    });
    expect(
      api.connection(
        'service_account',
        api.clientCredentials({
          tokenUrl: sdk.variable('MAIL_TOKEN_URL'),
          clientId: sdk.variable('MAIL_CLIENT_ID'),
          clientSecret: sdk.secret('MAIL_CLIENT_SECRET'),
          scopes: ['mail.read'],
        }),
      ),
    ).toEqual({
      id: 'service_account',
      source: {
        kind: 'clientCredentials',
        tokenUrl: '${env.MAIL_TOKEN_URL}',
        clientId: '${env.MAIL_CLIENT_ID}',
        clientSecret: 'MAIL_CLIENT_SECRET',
        scopes: ['mail.read'],
      },
    });
  });

  it('authors catalog profiles and operation scope requirements as TypeScript data', () => {
    const mail = sdk
      .connector('mail')
      .version('1.0.0')
      .http({
        baseUrl: 'https://mail.example.com',
        credentialProfiles: { delegated: { kind: 'bearer' } },
        operations: {
          search: {
            type: 'read',
            path: '/messages',
            input: sdk.z.object({}),
            output: sdk.z.object({}),
            credentials: {
              profiles: ['delegated'],
              scopes: ['mail.read'],
              audience: 'https://mail.example.com',
            },
          },
        },
      });
    const app = sdk.server('mail_reader', {
      title: 'Mail Reader',
      version: '1.0.0',
      provides: { mail },
    });

    expect(app.toConnectorCatalog()).toMatchObject({
      connectors: [
        {
          credentialProfiles: { delegated: { kind: 'bearer' } },
          operations: {
            search: {
              credentials: {
                profiles: ['delegated'],
                scopes: ['mail.read'],
                audience: 'https://mail.example.com',
              },
            },
          },
        },
      ],
    });
  });

  it('preserves declared profiles for curated refs and emits them for owned compute catalogs', async () => {
    const curated = sdk
      .connector('curated_mail')
      .version('1.0.0')
      .credentials({ user_oauth: { kind: 'bearer' } })
      .operation('search', {
        type: 'read',
        input: sdk.z.object({}),
        output: sdk.z.object({}),
      });
    const connection = sdk.connection('personal_mail', sdk.externalExchange());
    const app = sdk.server('curated_reader', {
      title: 'Curated Reader',
      version: '1.0.0',
      use: { mail: sdk.bind(curated, { profile: 'user_oauth', connection }) },
    });

    expect(curated.credentialProfiles).toEqual({ user_oauth: { kind: 'bearer' } });
    expect((await app.toManifest()).connectors?.mail).toMatchObject({
      id: 'curated_mail',
      version: '1.0.0',
      binding: { profile: 'user_oauth' },
    });
    expect(app.toConnectorCatalog()).toBeUndefined();

    const owned = sdk
      .connector('owned_compute')
      .version('1.0.0')
      .credentials({ service: { kind: 'bearer' } })
      .compute('lookup', {
        type: 'read',
        input: sdk.z.object({}),
        output: sdk.z.object({}),
        run: (input) => input,
      });
    const ownedApp = sdk.server('owned_reader', {
      title: 'Owned Reader',
      version: '1.0.0',
      provides: { owned },
    });
    expect(ownedApp.toConnectorCatalog()).toMatchObject({
      connectors: [{ id: 'owned_compute', credentialProfiles: { service: { kind: 'bearer' } } }],
    });
  });
});
