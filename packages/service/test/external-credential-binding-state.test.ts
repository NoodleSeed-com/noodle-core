import { createStaticSigningKeyProvider } from '@noodle-borg/auth';
import { computeConnectionConfigRevision, type RuntimeArtifact } from '@noodle-borg/compiler';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryExternalCredentialSubjectPinStore } from '../src/external-credential-exchange.js';
import { ServerRegistry } from '../src/registry.js';
import {
  boundArtifact,
  combineArtifacts,
  config,
  DEPLOYMENT,
  harness,
  ISSUER,
  request,
  response,
  TENANT,
} from './external-credential-exchange.fixtures.js';

const routeFingerprintA = `sha256:${'a'.repeat(64)}`;
const routeFingerprintB = `sha256:${'b'.repeat(64)}`;

describe('external credential binding state and registry integration', () => {
  it('route-binds external credential cache and single-flight identities without changing assertions', async () => {
    const artifact = routedArtifact(boundArtifact('personal', 'personal_mail'), 'customer_api');
    const descriptor = request(artifact);
    let release: ((value: Response) => void) | undefined;
    const firstResponse = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const guardedFetch = vi
      .fn()
      .mockImplementationOnce(async () => firstResponse)
      .mockImplementation(async () =>
        response(`route-token-${guardedFetch.mock.calls.length}`, 'provider-rev-1', 120),
      ) as unknown as typeof fetch;
    const { broker } = await harness({
      artifacts: [artifact],
      configs: [config('personal_mail', descriptor.connectionConfigRevision as string)],
      guardedFetch,
    });
    const route = { key: 'customer_api', fingerprint: routeFingerprintA } as const;

    const first = broker.getCredential({ ...descriptor, route });
    const second = broker.getCredential({ ...descriptor, route });
    await vi.waitFor(() => expect(guardedFetch).toHaveBeenCalledTimes(1));
    const firstInit = guardedFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    const assertion = new URLSearchParams(String(firstInit?.body)).get('subject_token') ?? '';
    const assertionPayload = JSON.parse(
      Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString(),
    ) as Record<string, unknown>;
    expect(assertionPayload).not.toHaveProperty('route');
    release?.(response('route-token-1', 'provider-rev-1', 120));
    await expect(Promise.all([first, second])).resolves.toEqual([
      { token: 'route-token-1' },
      { token: 'route-token-1' },
    ]);
    await broker.getCredential({ ...descriptor, route });
    await broker.getCredential({
      ...descriptor,
      route: { key: route.key, fingerprint: routeFingerprintB },
    });
    expect(guardedFetch).toHaveBeenCalledTimes(2);
  });

  it('cleans up a failed external exchange only for its exact route identity', async () => {
    const artifact = routedArtifact(boundArtifact('personal', 'personal_mail'), 'customer_api');
    const descriptor = request(artifact);
    const guardedFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockImplementation(async () =>
        response(`route-token-${guardedFetch.mock.calls.length}`, 'provider-rev-1', 120),
      ) as unknown as typeof fetch;
    const { broker } = await harness({
      artifacts: [artifact],
      configs: [config('personal_mail', descriptor.connectionConfigRevision as string)],
      guardedFetch,
    });
    const route = { key: 'customer_api', fingerprint: routeFingerprintA } as const;

    await expect(broker.getCredential({ ...descriptor, route })).rejects.toMatchObject({
      reason: 'credential_exchange_failed',
    });
    await expect(
      broker.getCredential({
        ...descriptor,
        route: { key: route.key, fingerprint: routeFingerprintB },
      }),
    ).resolves.toEqual({ token: 'route-token-2' });
    await expect(broker.getCredential({ ...descriptor, route })).resolves.toEqual({
      token: 'route-token-3',
    });
    expect(guardedFetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['missing', undefined],
    ['wrong-key', { key: 'other_api', fingerprint: routeFingerprintA }],
    ['empty-fingerprint', { key: 'customer_api', fingerprint: '' }],
    ['URL-fingerprint', { key: 'customer_api', fingerprint: 'https://tenant.example/api' }],
    ['oversized-fingerprint', { key: 'customer_api', fingerprint: 'x'.repeat(10_000) }],
  ] as const)('rejects a %s routed external binding before provider lookup or egress', async (_label, route) => {
    const artifact = routedArtifact(boundArtifact('personal', 'personal_mail'), 'customer_api');
    const descriptor = request(artifact);
    const guardedFetch = vi.fn() as unknown as typeof fetch;
    const { broker, providers } = await harness({
      artifacts: [artifact],
      configs: [config('personal_mail', descriptor.connectionConfigRevision as string)],
      guardedFetch,
    });
    const providerLookup = vi.spyOn(providers, 'getProviderConfig');

    await expect(
      broker.getCredential({
        ...descriptor,
        ...(route === undefined ? {} : { route }),
      }),
    ).rejects.toMatchObject({ reason: 'connector_route_unavailable' });
    expect(providerLookup).not.toHaveBeenCalled();
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it('rejects an unexpected route on a static external binding before provider lookup or egress', async () => {
    const artifact = boundArtifact('personal', 'personal_mail');
    const descriptor = request(artifact);
    const guardedFetch = vi.fn() as unknown as typeof fetch;
    const { broker, providers } = await harness({
      artifacts: [artifact],
      configs: [config('personal_mail', descriptor.connectionConfigRevision as string)],
      guardedFetch,
    });
    const providerLookup = vi.spyOn(providers, 'getProviderConfig');

    await expect(
      broker.getCredential({
        ...descriptor,
        route: { key: 'customer_api', fingerprint: routeFingerprintA },
      }),
    ).rejects.toMatchObject({ reason: 'connector_route_unavailable' });
    expect(providerLookup).not.toHaveBeenCalled();
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it('requires a safe route binding before probing a routed external exchange', async () => {
    const artifact = routedArtifact(boundArtifact('personal', 'personal_mail'), 'customer_api');
    const descriptor = request(artifact);
    const guardedFetch = vi.fn(async () =>
      response('DO-NOT-LEAK-ROUTED-TOKEN'),
    ) as unknown as typeof fetch;
    const { broker } = await harness({
      artifacts: [artifact],
      configs: [config('personal_mail', descriptor.connectionConfigRevision as string)],
      guardedFetch,
    });

    await expect(broker.probeDelegatedCredentials?.({ subject: 'unused' })).resolves.toEqual([
      expect.objectContaining({
        connectorId: 'gmail',
        authKind: 'externalExchange',
        ok: false,
        reason: 'connector_route_unavailable',
      }),
    ]);
    await expect(
      broker.probeDelegatedCredentials?.({ subject: 'unused' }, () => null),
    ).resolves.toEqual([
      expect.objectContaining({
        connectorId: 'gmail',
        ok: false,
        reason: 'connector_route_unavailable',
      }),
    ]);
    expect(guardedFetch).not.toHaveBeenCalled();

    const probes = await broker.probeDelegatedCredentials?.({ subject: 'unused' }, () => ({
      key: 'customer_api',
      fingerprint: routeFingerprintA,
      baseUrl: 'https://must-not-cross.test/private',
    }));
    expect(probes).toEqual([
      expect.objectContaining({
        connectorId: 'gmail',
        authKind: 'externalExchange',
        ok: true,
      }),
    ]);
    expect(guardedFetch).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(probes);
    expect(serialized).not.toContain('customer_api');
    expect(serialized).not.toContain(routeFingerprintA);
    expect(serialized).not.toContain('must-not-cross.test');
    expect(serialized).not.toContain('DO-NOT-LEAK-ROUTED-TOKEN');
  });

  it('isolates two bindings and caches by complete descriptor, expiry, subject, and revisions', async () => {
    let now = 1_800_000_000_000;
    let providerRevision = 'provider-rev-1';
    const personal = boundArtifact('personal', 'personal_mail');
    const work = boundArtifact('work', 'work_mail');
    const personalTool = personal.tools[0];
    const workTool = work.tools[0];
    if (personalTool === undefined || workTool === undefined) throw new Error('tool required');
    const combined: RuntimeArtifact = {
      ...personal,
      connectorBindings: { ...personal.connectorBindings, ...work.connectorBindings },
      capabilities: { tools: ['personal_search', 'work_search'] },
      tools: [
        { ...personalTool, name: 'personal_search' },
        { ...workTool, name: 'work_search' },
      ],
    };
    const personalRequest = request({ ...combined, tools: [personalTool] });
    const workRequest = request({ ...combined, tools: [workTool] });
    const guardedFetch = vi.fn(async (_url: URL, init: RequestInit) => {
      const body = new URLSearchParams(String(init.body));
      const assertion = body.get('subject_token');
      const payloadPart = assertion?.split('.')[1];
      if (payloadPart === undefined) throw new Error('assertion payload required');
      const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString()) as {
        binding_id: string;
      };
      return response(`${payload.binding_id}-token-${providerRevision}`, providerRevision, 60);
    }) as unknown as typeof fetch;
    const { broker } = await harness({
      artifacts: [combined],
      configs: [
        config('personal_mail', personalRequest.connectionConfigRevision as string),
        config('work_mail', workRequest.connectionConfigRevision as string),
      ],
      guardedFetch,
      now: () => now,
    });

    await expect(broker.getCredential(personalRequest)).resolves.toEqual({
      token: 'personal-token-provider-rev-1',
    });
    await expect(broker.getCredential(workRequest)).resolves.toEqual({
      token: 'work-token-provider-rev-1',
    });
    await expect(broker.getCredential(personalRequest)).resolves.toEqual({
      token: 'personal-token-provider-rev-1',
    });
    expect(guardedFetch).toHaveBeenCalledTimes(2);

    now += 61_000;
    providerRevision = 'provider-rev-2';
    await expect(broker.getCredential(personalRequest)).resolves.toEqual({
      token: 'personal-token-provider-rev-2',
    });
    expect(guardedFetch).toHaveBeenCalledTimes(3);
  });

  it('rejects account subject drift across provider endpoint configuration revisions', async () => {
    const artifact = boundArtifact('personal', 'personal_mail');
    const descriptor = request(artifact);
    let subject = 'opaque-account-subject';
    const guardedFetch = vi.fn(async () =>
      response('personal-token', 'provider-rev-1', 120, subject),
    ) as unknown as typeof fetch;
    const initialConfig = config('personal_mail', descriptor.connectionConfigRevision as string);
    const { broker, providers } = await harness({
      artifacts: [artifact],
      configs: [initialConfig],
      guardedFetch,
    });
    await expect(broker.getCredential(descriptor)).resolves.toEqual({
      token: 'personal-token',
    });

    providers.set({
      ...initialConfig,
      configRevision: 'provider-config-2',
      endpoint: 'https://provider.example.test/v2/exchange',
    });
    subject = 'different-account-subject';
    await expect(broker.getCredential(descriptor)).rejects.toMatchObject({
      reason: 'credential_exchange_failed',
    });
    expect(guardedFetch).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a token when endpoint config drifts without a revision bump', async () => {
    const artifact = boundArtifact('personal', 'personal_mail');
    const descriptor = request(artifact);
    let token = 'personal-token-1';
    const guardedFetch = vi.fn(async () => response(token)) as unknown as typeof fetch;
    const initialConfig = config('personal_mail', descriptor.connectionConfigRevision as string);
    const { broker, providers } = await harness({
      artifacts: [artifact],
      configs: [initialConfig],
      guardedFetch,
    });
    await expect(broker.getCredential(descriptor)).resolves.toEqual({ token });

    providers.set({
      ...initialConfig,
      endpoint: 'https://provider.example.test/v2/exchange',
    });
    token = 'personal-token-2';
    await expect(broker.getCredential(descriptor)).resolves.toEqual({ token });
    expect(guardedFetch).toHaveBeenCalledTimes(2);
  });

  it('pins one subject across operations and aliases of the same compiled logical connection', async () => {
    const combined = combineArtifacts(
      boundArtifact('primary', 'shared_mail', 'search'),
      boundArtifact('primary', 'shared_mail', 'send'),
      boundArtifact('secondary', 'shared_mail', 'search'),
    );
    const requests = [request(combined, 0), request(combined, 1), request(combined, 2)];
    const revision = requests[0]?.connectionConfigRevision;
    if (revision === undefined) throw new Error('connection revision required');
    const guardedFetch = vi.fn(async (_url: URL, init: RequestInit) => {
      const assertion = new URLSearchParams(String(init.body)).get('subject_token');
      const payload = JSON.parse(
        Buffer.from(assertion?.split('.')[1] ?? '', 'base64url').toString(),
      ) as { operation: string; binding_id: string };
      const canonical = payload.operation === 'search' && payload.binding_id === 'primary';
      return response(
        `${payload.binding_id}-${payload.operation}-token`,
        'provider-rev-1',
        120,
        canonical ? 'shared-subject' : `drift-${payload.binding_id}-${payload.operation}`,
      );
    }) as unknown as typeof fetch;
    const { broker } = await harness({
      artifacts: [combined],
      configs: [config('shared_mail', revision)],
      guardedFetch,
    });

    await expect(broker.getCredential(requests[0] as ReturnType<typeof request>)).resolves.toEqual({
      token: 'primary-search-token',
    });
    await expect(
      broker.getCredential(requests[1] as ReturnType<typeof request>),
    ).rejects.toMatchObject({ reason: 'credential_exchange_failed' });
    await expect(
      broker.getCredential(requests[2] as ReturnType<typeof request>),
    ).rejects.toMatchObject({ reason: 'credential_exchange_failed' });
  });

  it('persists the subject pin across fresh broker instances sharing one store', async () => {
    const artifact = boundArtifact('personal', 'personal_mail');
    const descriptor = request(artifact);
    const subjectPins = new InMemoryExternalCredentialSubjectPinStore();
    const providerConfig = config('personal_mail', descriptor.connectionConfigRevision as string);
    const first = await harness({
      artifacts: [artifact],
      configs: [providerConfig],
      subjectPins,
      guardedFetch: vi.fn(async () =>
        response('first-token', 'provider-rev-1', 120, 'stable-subject'),
      ) as unknown as typeof fetch,
    });
    await expect(first.broker.getCredential(descriptor)).resolves.toEqual({ token: 'first-token' });

    const restarted = await harness({
      artifacts: [artifact],
      configs: [providerConfig],
      subjectPins,
      guardedFetch: vi.fn(async () =>
        response('second-token', 'provider-rev-2', 120, 'different-subject'),
      ) as unknown as typeof fetch,
    });
    await expect(restarted.broker.getCredential(descriptor)).rejects.toMatchObject({
      reason: 'credential_exchange_failed',
    });
  });

  it('atomically pins one subject across concurrent service instances and provider configs', async () => {
    const artifact = boundArtifact('personal', 'personal_mail');
    const descriptor = request(artifact);
    const revision = descriptor.connectionConfigRevision as string;
    const subjectPins = new InMemoryExternalCredentialSubjectPinStore();
    let arrivals = 0;
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const exchange = (subject: string) =>
      vi.fn(async () => {
        arrivals += 1;
        if (arrivals === 2) release?.();
        await barrier;
        return response(`${subject}-token`, 'provider-rev-1', 120, subject);
      }) as unknown as typeof fetch;
    const first = await harness({
      artifacts: [artifact],
      configs: [config('personal_mail', revision)],
      subjectPins,
      guardedFetch: exchange('subject-a'),
    });
    const second = await harness({
      artifacts: [artifact],
      configs: [
        config('personal_mail', revision, {
          endpoint: 'https://provider.example.test/v2/exchange',
          configRevision: 'provider-config-2',
        }),
      ],
      subjectPins,
      guardedFetch: exchange('subject-b'),
    });

    const results = await Promise.allSettled([
      first.broker.getCredential(descriptor),
      second.broker.getCredential(descriptor),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('allows a new compiled connection revision to establish a new subject', async () => {
    const subjectPins = new InMemoryExternalCredentialSubjectPinStore();
    const identity = {
      tenantId: TENANT,
      deploymentId: DEPLOYMENT,
      connectionId: 'personal_mail',
    };
    await expect(
      subjectPins.pinOrVerify({
        ...identity,
        connectionConfigRevision: 'sha256:connection-v1',
        connectionSubject: 'subject-v1',
      }),
    ).resolves.toBe(true);
    await expect(
      subjectPins.pinOrVerify({
        ...identity,
        connectionConfigRevision: 'sha256:connection-v2',
        connectionSubject: 'subject-v2',
      }),
    ).resolves.toBe(true);
    await expect(
      subjectPins.pinOrVerify({
        ...identity,
        connectionConfigRevision: 'sha256:connection-v1',
        connectionSubject: 'subject-v2',
      }),
    ).resolves.toBe(false);
  });

  it('keeps one current cache entry per compiled descriptor across repeated config rotations', async () => {
    const artifact = boundArtifact('personal', 'personal_mail');
    const descriptor = request(artifact);
    const baseConfig = config('personal_mail', descriptor.connectionConfigRevision as string);
    let exchanges = 0;
    const guardedFetch = vi.fn(async () => {
      exchanges += 1;
      return response(`token-${exchanges}`, `provider-rev-${exchanges}`);
    }) as unknown as typeof fetch;
    const { broker, providers } = await harness({
      artifacts: [artifact],
      configs: [baseConfig],
      guardedFetch,
    });

    for (const version of ['v1', 'v2', 'v3', 'v1']) {
      providers.set({
        ...baseConfig,
        endpoint: `https://provider.example.test/${version}/exchange`,
        configRevision: `provider-config-${version}`,
      });
      await expect(broker.getCredential(descriptor)).resolves.toEqual({
        token: `token-${exchanges + 1}`,
      });
    }
    expect(guardedFetch).toHaveBeenCalledTimes(4);
  });

  it('anchors token expiry to the provider response before awaiting a delayed subject pin', async () => {
    let now = 1_800_000_000_000;
    let pinCalls = 0;
    const subjectPins = {
      async pinOrVerify() {
        pinCalls += 1;
        now += pinCalls === 1 ? 30_000 : 55_000;
        return true;
      },
    };
    const artifact = boundArtifact('personal', 'personal_mail');
    const descriptor = request(artifact);
    const guardedFetch = vi.fn(async () =>
      response(`token-${guardedFetch.mock.calls.length}`, 'provider-rev-1', 60),
    ) as unknown as typeof fetch;
    const { broker } = await harness({
      artifacts: [artifact],
      configs: [config('personal_mail', descriptor.connectionConfigRevision as string)],
      guardedFetch,
      subjectPins,
      now: () => now,
    });

    await expect(broker.getCredential(descriptor)).resolves.toEqual({ token: 'token-1' });
    expect(now).toBe(1_800_000_030_000);

    now += 24_999;
    await expect(broker.getCredential(descriptor)).resolves.toEqual({ token: 'token-1' });
    expect(guardedFetch).toHaveBeenCalledTimes(1);

    now += 1;
    await expect(broker.getCredential(descriptor)).rejects.toMatchObject({
      reason: 'credential_exchange_failed',
    });
    expect(guardedFetch).toHaveBeenCalledTimes(2);
    expect(pinCalls).toBe(2);
  });

  it('invokes a compiled externalExchange binding through the served registry target', async () => {
    const signer = await createStaticSigningKeyProvider();
    const subjectPins = new InMemoryExternalCredentialSubjectPinStore();
    const connection = {
      id: 'personal_mail',
      source: { kind: 'externalExchange' as const },
    };
    const connectionRevision = computeConnectionConfigRevision(connection);
    const providers = {
      async getProviderConfig(input: {
        readonly tenantId: string;
        readonly deploymentId: string;
        readonly connectionId: string;
      }) {
        return config(input.connectionId, connectionRevision, {
          tenantId: input.tenantId,
          deploymentId: input.deploymentId,
        });
      },
    };
    const guardedFetch = vi.fn(async () => response('registry-token')) as unknown as typeof fetch;
    const signature = {
      type: 'read' as const,
      input: { type: 'object', properties: {}, additionalProperties: false },
      output: { type: 'object', properties: {}, additionalProperties: false },
    };
    const registry = new ServerRegistry(undefined, undefined, undefined, {
      platformCatalog: [
        {
          id: 'gmail',
          version: '1.0.0',
          kind: 'catalog',
          credentialProfiles: { oauth: { kind: 'bearer' } },
          operationCredentials: {
            search: {
              profiles: ['oauth'],
              scopes: ['gmail.readonly'],
              audience: 'https://gmail.googleapis.com/',
            },
          },
          operations: { search: signature },
        } as never,
      ],
      externalCredentialExchange: {
        issuer: ISSUER,
        signer,
        providers,
        subjectPins,
        guardedFetch,
      } as never,
    });
    const deployed = await registry.deploy(
      { org: 'acme', app: 'mail', env: 'prod' },
      JSON.stringify({
        manifestVersion: '2',
        server: { name: 'mail', version: '1.0.0', title: 'Mail' },
        connectors: {
          personal: {
            id: 'gmail',
            version: '1.0.0',
            binding: { profile: 'oauth', connection },
          },
        },
        tools: [
          {
            name: 'search',
            description: 'Search mail.',
            inputSchema: signature.input,
            fulfilment: { use: 'personal.search', args: {} },
          },
        ],
      }),
      {
        actor: { subject: 'owner', email: 'owner@example.test', superAdmin: false },
        accessMode: 'owner-only',
      },
    );
    expect(deployed.ok).toBe(true);
    if (!deployed.ok) return;
    const target = await registry.getActiveByTenant({ org: 'acme', app: 'mail', env: 'prod' });
    if (target === undefined) throw new Error('served target required');
    const descriptor = request(target.served.artifact as RuntimeArtifact);

    await expect(
      target.served.deps.broker.getCredential({
        ...descriptor,
        tenantId: TENANT,
        deploymentId: deployed.deploymentId,
      }),
    ).resolves.toEqual({ token: 'registry-token' });
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });

  it('emits safe live probes without provider secrets or identifiers', async () => {
    const artifact = boundArtifact('personal', 'personal_mail');
    const descriptor = request(artifact);
    const guardedFetch = vi.fn(async () =>
      response('DO-NOT-LEAK-TOKEN'),
    ) as unknown as typeof fetch;
    const { broker } = await harness({
      artifacts: [artifact],
      configs: [config('personal_mail', descriptor.connectionConfigRevision as string)],
      guardedFetch,
    });
    const probes = await broker.probeDelegatedCredentials?.({ subject: 'unused' });
    expect(probes).toEqual([
      expect.objectContaining({
        connectorId: 'gmail',
        operation: 'search',
        bindingId: 'personal',
        authKind: 'externalExchange',
        ok: true,
      }),
    ]);
    const serialized = JSON.stringify(probes);
    for (const privateValue of [
      'DO-NOT-LEAK-TOKEN',
      'private=config',
      'opaque-account-subject',
      'provider-rev-1',
      'provider-config-1',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });
});

function routedArtifact(artifact: RuntimeArtifact, key: string): RuntimeArtifact {
  const tool = artifact.tools[0];
  if (
    tool === undefined ||
    tool.fulfilment.kind !== 'operation' ||
    !tool.fulfilment.operationRef.resolved
  ) {
    throw new Error('resolved tool operation required');
  }
  return {
    ...artifact,
    artifactSchemaVersion: '0.15.0',
    customerEndpoints: {
      [key]: { allowedHttpsOrigins: ['https://customer.example.test'] },
    },
    tools: [
      {
        ...tool,
        fulfilment: {
          ...tool.fulfilment,
          operationRef: {
            ...tool.fulfilment.operationRef,
            customerEndpoint: key,
          },
        },
      },
    ],
  };
}
