import type { SecretBinding } from '@noodle-borg/connector-defs';
import type {
  CredentialRequest,
  CustomerRouteBinding,
  DownstreamCredential,
} from '@noodle-borg/runtime';
import { describe, expect, it, vi } from 'vitest';
import { ManagedConfigBroker } from '../src/credential-broker.js';
import { InMemoryOAuthStore } from '../src/oauth/store.js';
import { InMemoryConfigStore } from '../src/store.js';
import { credentialBrokerScope as scope } from './credential-broker-fixtures.js';

type DelegatedKind = 'firebase' | 'microsoft' | 'session-cookie';

const routeA = {
  key: 'customer_api',
  fingerprint: `sha256:${'a'.repeat(64)}`,
} as const satisfies CustomerRouteBinding;
const routeB = {
  key: routeA.key,
  fingerprint: `sha256:${'b'.repeat(64)}`,
} as const satisfies CustomerRouteBinding;
const caller = {
  subject: 'customer-user-1',
  audience: 'https://cloud.test/o/acme/demo/mcp',
  identityKind: 'customer' as const,
};

describe('routed delegated credential single-flight', () => {
  it.each([
    'firebase',
    'microsoft',
    'session-cookie',
  ] as const)('coalesces the same %s route while a different fingerprint proceeds independently', async (kind) => {
    const controlled = await controlledFixture(kind);
    const first = controlled.broker.getCredential({
      ...controlled.request,
      route: routeA,
    });
    const duplicate = controlled.broker.getCredential({
      ...controlled.request,
      route: routeA,
    });
    await vi.waitFor(() => expect(controlled.terminalCalls()).toBe(1));

    const otherRoute = controlled.broker.getCredential({
      ...controlled.request,
      route: routeB,
    });
    await vi.waitFor(() => expect(controlled.terminalCalls()).toBe(2));

    controlled.resolve(1, 'route-b');
    expectCredential(await otherRoute, kind, 'route-b');
    controlled.resolve(0, 'route-a');
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    expectCredential(firstResult, kind, 'route-a');
    expectCredential(duplicateResult, kind, 'route-a');
    expect(controlled.terminalCalls()).toBe(2);
  });

  it.each([
    'firebase',
    'microsoft',
    'session-cookie',
  ] as const)('cleans up a failed %s single-flight without disturbing another route', async (kind) => {
    let terminalCalls = 0;
    let refreshCalls = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (kind === 'session-cookie' && isFirebaseRefresh(url)) {
        refreshCalls += 1;
        return firebaseResponse(`firebase-id-${refreshCalls}`);
      }
      terminalCalls += 1;
      if (terminalCalls === 1) return new Response(null, { status: 503 });
      return successfulResponse(kind, terminalCalls === 2 ? 'route-b' : 'route-a');
    }) as unknown as typeof fetch;
    const { broker, request } = await createFixture(kind, fetchImpl);

    const failed = await Promise.allSettled([
      broker.getCredential({ ...request, route: routeA }),
      broker.getCredential({ ...request, route: routeA }),
    ]);
    expect(failed.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(terminalCalls).toBe(1);

    const otherRoute = await broker.getCredential({ ...request, route: routeB });
    expectCredential(otherRoute, kind, 'route-b');
    const retried = await broker.getCredential({ ...request, route: routeA });
    expectCredential(retried, kind, 'route-a');
    expect(terminalCalls).toBe(3);
    if (kind === 'session-cookie') expect(refreshCalls).toBe(3);
  });
});

async function controlledFixture(kind: DelegatedKind) {
  const gates: Deferred<Response>[] = [];
  let terminalCalls = 0;
  let refreshCalls = 0;
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    if (kind === 'session-cookie' && isFirebaseRefresh(url)) {
      refreshCalls += 1;
      return firebaseResponse(`firebase-id-${refreshCalls}`);
    }
    const gate = deferred<Response>();
    gates.push(gate);
    terminalCalls += 1;
    return gate.promise;
  }) as unknown as typeof fetch;
  const fixture = await createFixture(kind, fetchImpl);
  return {
    ...fixture,
    terminalCalls: () => terminalCalls,
    resolve(index: number, token: string) {
      const gate = gates[index];
      if (gate === undefined) throw new Error(`missing response gate ${index}`);
      gate.resolve(successfulResponse(kind, token));
    },
  };
}

async function createFixture(kind: DelegatedKind, fetchImpl: typeof fetch) {
  const provider = kind === 'microsoft' ? 'microsoft' : 'firebase';
  const delegated = new InMemoryOAuthStore();
  await delegated.putDelegatedCredential({
    resource: caller.audience,
    provider,
    subject: caller.subject,
    credential: { enc: 'none', values: { token: `${provider}-refresh-1` } },
    updatedAt: new Date(0).toISOString(),
  });
  const config = new InMemoryConfigStore();
  if (kind === 'microsoft') {
    await config.setConfigValue({
      kind: 'secret',
      scope,
      name: 'MICROSOFT_SECRET',
      value: 'client-secret',
    });
  }
  const broker = new ManagedConfigBroker([binding(kind)], config, scope, {
    delegatedCredentialStore: delegated,
    openCustomerCredential: async (sealed) => sealed.values.token ?? '',
    fetchImpl,
    now: () => 1_000,
    ...(kind === 'microsoft'
      ? {}
      : {
          serverAuth: {
            kind: 'bridge' as const,
            provider: 'firebase',
            projectId: 'firebase-project',
            apiKey: 'firebase-api-key',
          },
        }),
  });
  const request = {
    connectorId: 'customer_api',
    connectorVersion: '1.0.0',
    operation: 'list_records',
    caller: {
      ...caller,
      identityProvider: provider,
    },
  } satisfies CredentialRequest;
  return { broker, request };
}

function binding(kind: DelegatedKind): SecretBinding {
  const common = {
    connectorId: 'customer_api',
    connectorVersion: '1.0.0',
    operation: 'list_records',
    customerEndpoint: 'customer_api',
  };
  if (kind === 'firebase') {
    return {
      ...common,
      authKind: 'delegatedOAuth',
      delegated: { provider: 'firebase' },
    };
  }
  if (kind === 'microsoft') {
    return {
      ...common,
      authKind: 'delegatedOAuth',
      secretRef: 'MICROSOFT_SECRET',
      delegated: {
        provider: 'microsoft',
        tokenUrl: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
        clientId: 'client-id',
      },
    };
  }
  return {
    ...common,
    authKind: 'delegatedSessionCookie',
    delegated: {
      provider: 'firebase',
      sessionUrl: 'https://session.test/exchange',
    },
  };
}

function successfulResponse(kind: DelegatedKind, token: string): Response {
  if (kind === 'firebase') return firebaseResponse(token);
  if (kind === 'microsoft') {
    return Response.json({
      access_token: token,
      expires_in: 3_600,
    });
  }
  return new Response('{}', {
    headers: {
      'set-cookie': `session=${token}; Path=/; Max-Age=3600; Secure; HttpOnly`,
    },
  });
}

function firebaseResponse(token: string): Response {
  return Response.json({
    id_token: token,
    refresh_token: 'firebase-refresh-1',
    expires_in: '3600',
  });
}

function isFirebaseRefresh(url: string | URL | Request): boolean {
  return String(url).startsWith('https://securetoken.googleapis.com/');
}

function expectCredential(
  credential: DownstreamCredential,
  kind: DelegatedKind,
  token: string,
): void {
  if (kind === 'session-cookie') {
    expect(credential).toMatchObject({ kind: 'cookie', cookie: `session=${token}` });
    return;
  }
  expect(credential).toEqual({ token });
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}
