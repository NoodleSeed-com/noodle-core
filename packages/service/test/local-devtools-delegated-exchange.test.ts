import { createStaticSigningKeyProvider, type SigningKeyProvider } from '@noodle-borg/auth';
import type { SecretBinding } from '@noodle-borg/connector-defs';
import { decodeJwt } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ServerRegistry, serveService } from '../src/index.js';
import {
  localDevtoolsDelegatedExchangeBindingKey,
  projectLocalDevtoolsDelegatedExchangeBindings,
} from '../src/local-devtools-delegated-exchange.js';

const TENANT = { org: 'acme', app: 'support', env: 'dev' } as const;
const MANIFEST = `
manifestVersion: "1"
server:
  name: local_delegated_exchange
  version: 1.0.0
  title: Local delegated exchange
tools:
  - name: health
    description: Return a local health marker.
    inputSchema:
      type: object
      additionalProperties: false
    fulfilment:
      steps:
        - id: result
          map:
            ok: true
      output:
        ok: \${steps.result.ok}
`;

const HOSTED_MANIFEST = MANIFEST.replace(
  '  title: Local delegated exchange',
  `  title: Local delegated exchange
  auth:
    issuer: https://customer-idp.example.test
    audience: customer-api`,
);

let signer: SigningKeyProvider;

beforeAll(async () => {
  const actual = await createStaticSigningKeyProvider();
  signer = {
    signingKey: vi.fn(() => actual.signingKey()),
    publicJwks: vi.fn(() => actual.publicJwks()),
    verifierKey: vi.fn(() => actual.verifierKey()),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function localRuntime() {
  return {
    resolve: vi.fn(async () => ({ issuer: 'urn:noodleseed:devtools:test-key', signer })),
    onSuccess: vi.fn(),
  };
}

function delegatedConnectors(count = 1, managed = false): string {
  const entries = Array.from({ length: count }, (_, index) => {
    const ordinal = index + 1;
    return `
  - id: delegated_${ordinal}
    version: 1.0.${index}
    http:
      baseUrl: https://api-${ordinal}.example.test/v1
      allowedOrigins:
        - https://api-${ordinal}.example.test
      auth:
        kind: delegatedTokenExchange
        tokenUrl: https://api-${ordinal}.example.test/exchange
        clientId: ${managed ? '${env.CLIENT_ID}' : `client-${ordinal}`}
        clientSecret: DELEGATED_SECRET_${ordinal}
        scopes:
          - records:read
        audience: ${managed ? '${env.AUDIENCE}' : `api-${ordinal}`}
    operations:
      read:
        type: read
        method: GET
        path: /records
        output:
          type: object
          additionalProperties: true`;
  });
  return `connectors:${entries.join('')}`;
}

async function configureDelegatedBindings(registry: ServerRegistry, count: number): Promise<void> {
  const scope = { level: 'env' as const, ...TENANT };
  for (let ordinal = 1; ordinal <= count; ordinal += 1) {
    await registry.configStore.setConfigValue({
      kind: 'secret',
      scope,
      name: `DELEGATED_SECRET_${ordinal}`,
      value: `secret-${ordinal}`,
    });
  }
}

async function exchangeThroughActiveBroker(registry: ServerRegistry): Promise<{
  readonly issuer: unknown;
  readonly tenant: unknown;
  readonly deployment: unknown;
}> {
  const fetchImpl = vi.fn(async () =>
    Response.json({ access_token: 'downstream-token', token_type: 'Bearer', expires_in: 600 }),
  );
  vi.stubGlobal('fetch', fetchImpl);
  const target = await registry.getActiveByTenant(TENANT);
  expect(target).toBeDefined();
  const credential = await target?.served.deps.broker.getCredential({
    connectorId: 'delegated_1',
    connectorVersion: '1.0.0',
    operation: 'read',
    caller: {
      subject: 'customer-user-1',
      audience: 'https://local.example.test/mcp',
      identityKind: 'customer',
    },
    customerIssuer: 'https://customer-idp.example.test',
  });
  expect(credential).toEqual({ token: 'downstream-token' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
  const assertion = new URLSearchParams(String(init.body)).get('subject_token');
  expect(assertion).not.toBeNull();
  const payload = decodeJwt(assertion as string);
  return { issuer: payload.iss, tenant: payload.tenant, deployment: payload.deployment };
}

describe('local Devtools delegated exchange service boundary', () => {
  it('accepts a local runtime on an exclusive IPv4 loopback bind', async () => {
    const running = await serveService({
      host: '127.0.0.1',
      port: 0,
      localDevtoolsDelegatedExchange: localRuntime(),
    });
    await running.close();
  });

  it.each([
    '0.0.0.0',
    '::',
    'devtools.example.test',
  ])('rejects a local runtime on non-loopback host %s before listening', async (host) => {
    await expect(
      serveService({ host, port: 0, localDevtoolsDelegatedExchange: localRuntime() }),
    ).rejects.toThrow('local Devtools delegated exchange requires an exclusive loopback bind');
  });

  it('rejects local and hosted OAuth signing authorities together', async () => {
    await expect(
      serveService({
        host: '127.0.0.1',
        port: 0,
        localDevtoolsDelegatedExchange: localRuntime(),
        oauth: { issuer: 'https://cloud.example.test', signer },
      }),
    ).rejects.toThrow('local Devtools and hosted OAuth signing authorities cannot coexist');
  });

  it('rejects local and hosted registry signing authorities together', () => {
    expect(
      () =>
        new ServerRegistry(undefined, undefined, undefined, {
          delegatedExchange: { issuer: 'https://cloud.example.test', signer },
          localDevtoolsDelegatedExchange: localRuntime(),
        }),
    ).toThrow('local Devtools and hosted OAuth signing authorities cannot coexist');
  });
});

describe('local Devtools delegated exchange registry composition', () => {
  it('preserves the hosted issuer and signer path without a local resolver', async () => {
    const registry = new ServerRegistry(undefined, undefined, undefined, {
      delegatedExchange: { issuer: 'https://cloud.example.test', signer },
    });
    await configureDelegatedBindings(registry, 1);

    const deployed = await registry.deploy(TENANT, HOSTED_MANIFEST, {
      accessMode: 'customers',
      actor: { subject: 'deployer', email: 'deployer@example.test', superAdmin: false },
      connectors: delegatedConnectors(),
    });
    expect(deployed.ok ? undefined : deployed.errors).toBeUndefined();
    const assertion = await exchangeThroughActiveBroker(registry);
    expect(assertion).toEqual({
      issuer: 'https://cloud.example.test',
      tenant: 'acme/support/dev',
      deployment: deployed.ok ? deployed.deploymentId : undefined,
    });
  });

  it('does not resolve a local authority when no delegated binding exists', async () => {
    const runtime = localRuntime();
    const registry = new ServerRegistry(undefined, undefined, undefined, {
      localDevtoolsDelegatedExchange: runtime,
    });

    const deployed = await registry.deploy(TENANT, MANIFEST, { accessMode: 'public' });

    expect(deployed.ok ? undefined : deployed.errors).toBeUndefined();
    expect(runtime.resolve).toHaveBeenCalledTimes(0);
  });

  it.each([
    1, 3,
  ])('resolves one local authority for a compile with %s delegated bindings', async (count) => {
    const runtime = localRuntime();
    const registry = new ServerRegistry(undefined, undefined, undefined, {
      localDevtoolsDelegatedExchange: runtime,
    });
    await configureDelegatedBindings(registry, count);

    const deployed = await registry.deploy(TENANT, MANIFEST, {
      accessMode: 'public',
      connectors: delegatedConnectors(count),
    });

    expect(deployed.ok ? undefined : deployed.errors).toBeUndefined();
    expect(runtime.resolve).toHaveBeenCalledTimes(1);
  });

  it('binds the resolved local issuer and signer to authoritative tenant and deployment identity', async () => {
    const runtime = localRuntime();
    const registry = new ServerRegistry(undefined, undefined, undefined, {
      localDevtoolsDelegatedExchange: runtime,
    });
    await configureDelegatedBindings(registry, 1);

    const deployed = await registry.deploy(TENANT, MANIFEST, {
      accessMode: 'public',
      connectors: delegatedConnectors(),
    });
    expect(deployed.ok ? undefined : deployed.errors).toBeUndefined();
    const assertion = await exchangeThroughActiveBroker(registry);

    expect(runtime.resolve).toHaveBeenCalledTimes(1);
    expect(signer.signingKey).toHaveBeenCalledTimes(1);
    expect(assertion).toEqual({
      issuer: 'urn:noodleseed:devtools:test-key',
      tenant: 'acme/support/dev',
      deployment: deployed.ok ? deployed.deploymentId : undefined,
    });
  });

  it.each([
    ['connector compilation', 'connectors:\n  - not-a-valid-connector'],
    ['missing managed config', delegatedConnectors(1, true)],
  ])('fails %s before resolving the local authority', async (_failure, connectors) => {
    const runtime = localRuntime();
    const registry = new ServerRegistry(undefined, undefined, undefined, {
      localDevtoolsDelegatedExchange: runtime,
    });

    const deployed = await registry.deploy(TENANT, MANIFEST, {
      accessMode: 'public',
      connectors,
    });

    expect(deployed.ok).toBe(false);
    expect(runtime.resolve).toHaveBeenCalledTimes(0);
  });
});

describe('local Devtools delegated exchange binding keys', () => {
  const binding: SecretBinding = {
    connectorId: 'crm',
    connectorVersion: '1.0.0',
    operation: 'list',
    authKind: 'delegatedTokenExchange',
    secretRef: 'CRM_SECRET',
    tokenExchange: {
      tokenUrl: '${env.TOKEN_URL}',
      clientId: '${env.CLIENT_ID}',
      audience: '${env.AUDIENCE}',
      scopes: ['read', 'write'],
      authMethod: 'client_secret_basic',
    },
  };
  const resolved = {
    tokenUrl: 'https://tokens.example/exchange',
    clientId: 'client-1',
    audience: 'crm-api',
    scopes: ['read', 'write'],
    authMethod: 'client_secret_basic' as const,
  };

  it('projects a stable hand-derived length-prefixed fingerprint without raw binding configuration', () => {
    const variables = {
      AUDIENCE: 'crm-api',
      CLIENT_ID: 'client-1',
      TOKEN_URL: 'https://tokens.example/exchange',
    };

    expect(projectLocalDevtoolsDelegatedExchangeBindings([binding], variables)).toEqual([
      {
        bindingKey: 'sha256:16db10ae5535f1b7f42b6ff90a48f13d17203f36edcf7d6136b02920b1422f33',
        connectorId: 'crm',
        operation: 'list',
        audience: 'crm-api',
      },
    ]);
    expect(
      projectLocalDevtoolsDelegatedExchangeBindings([{ ...binding }], {
        TOKEN_URL: variables.TOKEN_URL,
        CLIENT_ID: variables.CLIENT_ID,
        AUDIENCE: variables.AUDIENCE,
      }),
    ).toEqual(projectLocalDevtoolsDelegatedExchangeBindings([binding], variables));
    const publicJson = JSON.stringify(
      projectLocalDevtoolsDelegatedExchangeBindings([binding], variables),
    );
    for (const privateValue of [
      variables.TOKEN_URL,
      variables.CLIENT_ID,
      'CRM_SECRET',
      'client_secret_basic',
      'read',
      'write',
      '1.0.0',
    ]) {
      expect(publicJson).not.toContain(privateValue);
    }
  });

  it('uses the resolved token URL as the public effective audience when none is declared', () => {
    const withoutAudience: SecretBinding = {
      ...binding,
      tokenExchange: {
        tokenUrl: '${env.TOKEN_URL}',
        clientId: '${env.CLIENT_ID}',
        scopes: ['read', 'write'],
        authMethod: 'client_secret_basic',
      },
    };

    const [projection] = projectLocalDevtoolsDelegatedExchangeBindings([withoutAudience], {
      CLIENT_ID: 'client-1',
      TOKEN_URL: 'https://tokens.example/exchange',
    });

    expect(projection?.audience).toBe('https://tokens.example/exchange');
  });

  it('changes the key when any canonical binding field changes', () => {
    const original = localDevtoolsDelegatedExchangeBindingKey(binding, resolved);
    const variants: Array<readonly [SecretBinding, typeof resolved]> = [
      [{ ...binding, connectorId: 'crm-v2' }, resolved],
      [{ ...binding, connectorVersion: '2.0.0' }, resolved],
      [{ ...binding, operation: 'get' }, resolved],
      [{ ...binding, secretRef: 'OTHER_SECRET' }, resolved],
      [binding, { ...resolved, tokenUrl: 'https://tokens.example/other' }],
      [binding, { ...resolved, clientId: 'client-2' }],
      [binding, { ...resolved, audience: 'crm-admin' }],
      [binding, { ...resolved, scopes: ['write', 'read'] }],
      [binding, { ...resolved, authMethod: 'client_secret_post' }],
    ];

    expect(original).toMatch(/^sha256:[0-9a-f]{64}$/u);
    for (const [candidateBinding, candidateResolved] of variants) {
      expect(
        localDevtoolsDelegatedExchangeBindingKey(candidateBinding, candidateResolved),
      ).not.toBe(original);
    }
  });

  it('filters non-delegated and incomplete bindings from the public projection', () => {
    expect(
      projectLocalDevtoolsDelegatedExchangeBindings(
        [
          { connectorId: 'static', connectorVersion: '1.0.0', authKind: 'static' },
          {
            connectorId: 'incomplete',
            connectorVersion: '1.0.0',
            authKind: 'delegatedTokenExchange',
          },
        ],
        {},
      ),
    ).toEqual([]);
  });
});
