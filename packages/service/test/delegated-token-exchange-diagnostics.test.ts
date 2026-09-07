import { createStaticSigningKeyProvider } from '@noodle-borg/auth';
import type { SecretBinding } from '@noodle-borg/connector-defs';
import {
  type CredentialUnavailableError,
  credentialUnavailableErrorSnapshot,
} from '@noodle-borg/runtime';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ManagedConfigBroker } from '../src/credential-broker.js';
import { localDevtoolsDelegatedExchangeBindingKey } from '../src/local-devtools-delegated-exchange.js';
import { InMemoryConfigStore } from '../src/store.js';
import { credentialBrokerScope as scope } from './credential-broker-fixtures.js';

const CLIENT_SECRET = 'hostile-client-secret-never-print';
const TOKEN_URL = 'https://exchange.example/private/token/path?trace=hostile-query-correlation-id';
const ASSERTION_REMEDIATION =
  'Check the displayed local issuer, JWKS, audience, tenant, deployment, and clock synchronization.';
const HOSTED_ASSERTION_REMEDIATION =
  'Check the configured platform issuer and JWKS, connector audience, and clock synchronization.';
const CLIENT_REMEDIATION = 'Check the delegated exchange development client ID and client secret.';
const TARGET_REMEDIATION = 'Check the connector audience and development token endpoint policy.';
const RESPONSE_REMEDIATION =
  'Configure the token endpoint to return the documented JSON token response.';
const OVERSIZED_RESPONSE_REMEDIATION =
  'Token endpoint response exceeded the 32 KiB limit. Return a documented JSON token response no larger than 32 KiB.';

const binding: SecretBinding = {
  connectorId: 'customer_api',
  connectorVersion: '1.0.0',
  operation: 'list_records',
  authKind: 'delegatedTokenExchange',
  secretRef: 'CUSTOMER_API_CLIENT_SECRET',
  tokenExchange: {
    tokenUrl: TOKEN_URL,
    clientId: 'development-client-id',
    scopes: ['records:read'],
    audience: 'development-customer-api',
    authMethod: 'client_secret_basic',
  },
};

const credentialRequest = {
  connectorId: 'customer_api',
  connectorVersion: '1.0.0',
  operation: 'list_records',
  customerIssuer: 'https://customer-idp.example',
  caller: {
    subject: 'customer-user-1',
    audience: 'https://cloud.test/o/acme/demo/mcp',
    identityKind: 'customer' as const,
  },
};

let signer: Awaited<ReturnType<typeof createStaticSigningKeyProvider>>;

beforeAll(async () => {
  signer = await createStaticSigningKeyProvider();
});

async function brokerFor(input: {
  readonly fetchImpl: typeof fetch;
  readonly selectedBinding?: SecretBinding;
  readonly secret?: string;
  readonly variables?: Readonly<Record<string, string>>;
  readonly localDevtools?: true;
  readonly onAttempt?: (event: {
    readonly bindingKey: string;
    readonly connectorId: string;
    readonly operation?: string;
    readonly audience: string;
  }) => void;
  readonly onSuccess?: (event: { readonly bindingKey: string }) => void;
}) {
  const configStore = new InMemoryConfigStore();
  if (input.secret !== undefined) {
    await configStore.setConfigValue({
      kind: 'secret',
      scope,
      name: 'CUSTOMER_API_CLIENT_SECRET',
      value: input.secret,
    });
  }
  for (const [name, value] of Object.entries(input.variables ?? {})) {
    await configStore.setConfigValue({ kind: 'variable', scope, name, value });
  }
  return new ManagedConfigBroker([input.selectedBinding ?? binding], configStore, scope, {
    delegatedExchange: {
      issuer: 'urn:noodleseed:devtools:test-key',
      signer,
      tenant: 'acme/demo/prod',
      deployment: 'demo-abc12345',
      ...(input.localDevtools === undefined ? {} : { localDevtools: input.localDevtools }),
      ...(input.onAttempt === undefined ? {} : { onAttempt: input.onAttempt }),
      ...(input.onSuccess === undefined ? {} : { onSuccess: input.onSuccess }),
    },
    fetchImpl: input.fetchImpl,
    now: () => 1_000,
  });
}

async function rejectedCredential(
  broker: ManagedConfigBroker,
): Promise<CredentialUnavailableError> {
  try {
    await broker.getCredential(credentialRequest);
  } catch (error) {
    return error as CredentialUnavailableError;
  }
  throw new Error('expected delegated token exchange to reject');
}

function serializedDiagnostic(error: CredentialUnavailableError): string {
  return JSON.stringify({
    name: error.name,
    message: error.message,
    ...credentialUnavailableErrorSnapshot(error),
  });
}

describe('delegated token exchange diagnostics', () => {
  it('reports a rejected fetch as a network failure using only the endpoint origin', async () => {
    let assertion = '';
    let authorization = '';
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      assertion = body.get('subject_token') ?? '';
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      throw new Error('hostile network failure with trace-network-123 and /private/token/path');
    }) as unknown as typeof fetch;
    const broker = await brokerFor({ fetchImpl, secret: CLIENT_SECRET, localDevtools: true });

    const error = await rejectedCredential(broker);

    expect(credentialUnavailableErrorSnapshot(error)).toEqual({
      reason: 'credential_exchange_failed',
      fix: 'Cannot reach delegated token endpoint origin https://exchange.example. Check network reachability, TLS, and DNS.',
      next: ['noodle auth doctor --live'],
    });
    const serialized = serializedDiagnostic(error);
    expect(serialized).toContain('https://exchange.example');
    for (const hostile of [
      '/private/token/path',
      'hostile-query-correlation-id',
      'trace-network-123',
      CLIENT_SECRET,
      assertion,
      authorization,
    ]) {
      expect(serialized).not.toContain(hostile);
    }
  });

  it.each([
    {
      name: 'redirect',
      response: () => new Response('hostile redirect body', { status: 307 }),
      fix: 'Configure a direct delegated token endpoint that does not redirect.',
    },
    {
      name: 'HTTP 401',
      response: () => new Response('hostile unauthorized body', { status: 401 }),
      fix: `Token endpoint rejected client authentication with HTTP 401. ${CLIENT_REMEDIATION}`,
    },
    {
      name: 'HTTP 403',
      response: () => new Response('hostile forbidden body', { status: 403 }),
      fix: `Token endpoint rejected client authentication with HTTP 403. ${CLIENT_REMEDIATION}`,
    },
    {
      name: 'invalid_client',
      response: () => Response.json({ error: 'invalid_client' }, { status: 400 }),
      fix: `Token endpoint returned OAuth error invalid_client. ${CLIENT_REMEDIATION}`,
    },
    {
      name: 'invalid_request',
      response: () => Response.json({ error: 'invalid_request' }, { status: 400 }),
      fix: `Token endpoint returned OAuth error invalid_request. ${ASSERTION_REMEDIATION}`,
    },
    {
      name: 'invalid_grant',
      response: () => Response.json({ error: 'invalid_grant' }, { status: 400 }),
      fix: `Token endpoint returned OAuth error invalid_grant. ${ASSERTION_REMEDIATION}`,
    },
    {
      name: 'other safe OAuth code',
      response: () => Response.json({ error: 'assertion.rejected-1' }, { status: 400 }),
      fix: `Token endpoint returned OAuth error assertion.rejected-1. ${ASSERTION_REMEDIATION}`,
    },
    {
      name: 'invalid_target',
      response: () => Response.json({ error: 'invalid_target' }, { status: 400 }),
      fix: `Token endpoint returned OAuth error invalid_target. ${TARGET_REMEDIATION}`,
    },
    {
      name: 'malformed JSON success',
      response: () => new Response('{not-json', { status: 200 }),
      fix: RESPONSE_REMEDIATION,
    },
    {
      name: 'missing access token',
      response: () => Response.json({ token_type: 'Bearer' }),
      fix: RESPONSE_REMEDIATION,
    },
    {
      name: 'empty access token',
      response: () => Response.json({ access_token: '' }),
      fix: RESPONSE_REMEDIATION,
    },
    {
      name: 'declared oversized response',
      response: () =>
        new Response('{"access_token":"small"}', {
          headers: { 'content-length': '32769' },
        }),
      fix: OVERSIZED_RESPONSE_REMEDIATION,
    },
    {
      name: 'actual oversized response',
      response: () =>
        new Response(
          JSON.stringify({ access_token: 'hostile-downstream-token', padding: 'x'.repeat(32_769) }),
        ),
      fix: OVERSIZED_RESPONSE_REMEDIATION,
    },
  ])('maps $name to one curated remediation', async ({ response, fix }) => {
    const fetchImpl = vi.fn(async () => response()) as unknown as typeof fetch;
    const broker = await brokerFor({ fetchImpl, secret: CLIENT_SECRET, localDevtools: true });

    const error = await rejectedCredential(broker);

    expect(credentialUnavailableErrorSnapshot(error)).toEqual({
      reason: 'credential_exchange_failed',
      fix,
      next: ['noodle auth doctor --live'],
    });
  });

  it('keeps hosted OAuth assertion remediation configured-platform-specific', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: 'invalid_grant' }, { status: 400 }),
    ) as unknown as typeof fetch;
    const broker = await brokerFor({ fetchImpl, secret: CLIENT_SECRET });

    const error = await rejectedCredential(broker);

    expect(credentialUnavailableErrorSnapshot(error)).toEqual({
      reason: 'credential_exchange_failed',
      fix: `Token endpoint returned OAuth error invalid_grant. ${HOSTED_ASSERTION_REMEDIATION}`,
      next: ['noodle auth doctor --live'],
    });
  });

  it.each([
    { name: 'redirect', status: 307, contentLength: undefined },
    { name: 'declared oversized response', status: 200, contentLength: '32769' },
  ])('best-effort cancels the body before rejecting a $name', async ({ status, contentLength }) => {
    const cancel = vi.fn(async () => {
      throw new Error('hostile cancellation rejection');
    });
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('hostile unread response body'));
        },
        cancel,
      }),
      {
        status,
        ...(contentLength === undefined ? {} : { headers: { 'content-length': contentLength } }),
      },
    );
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch;
    const broker = await brokerFor({ fetchImpl, secret: CLIENT_SECRET, localDevtools: true });

    const error = await rejectedCredential(broker);

    expect(error).toMatchObject({ reason: 'credential_exchange_failed' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(serializedDiagnostic(error)).not.toContain('hostile cancellation rejection');
  });

  it('never propagates hostile endpoint fields through the public diagnostic snapshot', async () => {
    const hostile = {
      unsafeCode: '<script>trace-code-123</script>',
      description: 'hostile-error-description-456',
      uri: 'https://attacker.example/error/private?token=error-uri-secret',
      responseToken: 'hostile-response-token-789',
      trace: 'hostile-body-trace-abc',
      header: 'hostile-header-correlation-def',
    };
    const fetchImpl = vi.fn(async () =>
      Response.json(
        {
          error: hostile.unsafeCode,
          error_description: hostile.description,
          error_uri: hostile.uri,
          access_token: hostile.responseToken,
          trace_id: hostile.trace,
          arbitrary: { nested: 'hostile-arbitrary-value' },
        },
        { status: 400, headers: { 'x-correlation-id': hostile.header } },
      ),
    ) as unknown as typeof fetch;
    const broker = await brokerFor({ fetchImpl, secret: CLIENT_SECRET, localDevtools: true });

    const error = await rejectedCredential(broker);

    expect(credentialUnavailableErrorSnapshot(error)).toEqual({
      reason: 'credential_exchange_failed',
      fix: 'Delegated token endpoint returned HTTP 400. Check the endpoint configuration and documented token response.',
      next: ['noodle auth doctor --live'],
    });
    const serialized = serializedDiagnostic(error);
    for (const value of [...Object.values(hostile), 'hostile-arbitrary-value', CLIENT_SECRET]) {
      expect(serialized).not.toContain(value);
    }
  });

  it('distinguishes a missing secret reference contract from an unresolved known reference', async () => {
    const missingReferenceBinding = { ...binding, secretRef: undefined };
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const broker = await brokerFor({
      fetchImpl,
      selectedBinding: missingReferenceBinding,
      localDevtools: true,
    });

    const error = await rejectedCredential(broker);

    expect(credentialUnavailableErrorSnapshot(error)).toEqual({
      reason: 'credential_not_configured',
      fix: 'Configure the delegated token exchange client secret reference (`secretRef`).',
      next: ['noodle auth doctor'],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('names an unresolved local secret reference, exact scope, and canonical recovery command', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const broker = await brokerFor({ fetchImpl, localDevtools: true });

    const error = await rejectedCredential(broker);

    expect(credentialUnavailableErrorSnapshot(error)).toEqual({
      reason: 'credential_not_configured',
      fix: 'Secret reference "CUSTOMER_API_CLIENT_SECRET" is unresolved for local scope org/acme/app/demo/env/prod.',
      next: [
        'noodle secrets set CUSTOMER_API_CLIENT_SECRET --runtime local --scope env --org acme --app demo --env prod --from-env CUSTOMER_API_CLIENT_SECRET',
      ],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps hosted unresolved-secret recovery provider-neutral', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const broker = await brokerFor({ fetchImpl });

    const error = await rejectedCredential(broker);

    expect(credentialUnavailableErrorSnapshot(error)).toEqual({
      reason: 'credential_not_configured',
      fix: 'Set the managed secret required by delegated token exchange.',
      next: ['noodle auth doctor'],
    });
    expect(serializedDiagnostic(error)).not.toContain('CUSTOMER_API_CLIENT_SECRET');
    expect(serializedDiagnostic(error)).not.toContain('--runtime local');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('observes only the canonical binding key after a real parsed success', async () => {
    const onSuccess = vi.fn();
    const fetchImpl = vi.fn(async () =>
      Response.json({ access_token: 'downstream-token', expires_in: 900 }),
    ) as unknown as typeof fetch;
    const broker = await brokerFor({
      fetchImpl,
      secret: CLIENT_SECRET,
      localDevtools: true,
      onSuccess,
    });

    await expect(broker.getCredential(credentialRequest)).resolves.toEqual({
      token: 'downstream-token',
    });

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith({
      bindingKey: localDevtoolsDelegatedExchangeBindingKey(
        binding,
        binding.tokenExchange as NonNullable<SecretBinding['tokenExchange']>,
      ),
    });
    expect(Object.keys(onSuccess.mock.calls[0]?.[0] ?? {})).toEqual(['bindingKey']);
  });

  it('publishes only the live safe binding projection before a failed endpoint attempt', async () => {
    const variableBinding: SecretBinding = {
      ...binding,
      tokenExchange: {
        ...binding.tokenExchange,
        tokenUrl: '${env.EXCHANGE_TOKEN_URL}',
        clientId: '${env.EXCHANGE_CLIENT_ID}',
        audience: '${env.EXCHANGE_AUDIENCE}',
      } as NonNullable<SecretBinding['tokenExchange']>,
    };
    const order: string[] = [];
    const onAttempt = vi.fn((event) => {
      order.push('attempt');
      expect(event).toEqual({
        bindingKey: localDevtoolsDelegatedExchangeBindingKey(variableBinding, {
          ...(variableBinding.tokenExchange as NonNullable<SecretBinding['tokenExchange']>),
          tokenUrl: 'https://exchange-next.example/oauth/token',
          clientId: 'development-client-id-next',
          audience: 'development-customer-api-next',
        }),
        connectorId: 'customer_api',
        operation: 'list_records',
        audience: 'development-customer-api-next',
      });
      expect(Object.keys(event).sort()).toEqual([
        'audience',
        'bindingKey',
        'connectorId',
        'operation',
      ]);
      expect(JSON.stringify(event)).not.toMatch(/client-id|token|secret|scope/iu);
    });
    const fetchImpl = vi.fn(async () => {
      order.push('fetch');
      expect(onAttempt).toHaveBeenCalledTimes(1);
      return Response.json({ error: 'invalid_grant' }, { status: 400 });
    }) as unknown as typeof fetch;
    const broker = await brokerFor({
      fetchImpl,
      selectedBinding: variableBinding,
      secret: CLIENT_SECRET,
      variables: {
        EXCHANGE_TOKEN_URL: 'https://exchange-next.example/oauth/token',
        EXCHANGE_CLIENT_ID: 'development-client-id-next',
        EXCHANGE_AUDIENCE: 'development-customer-api-next',
      },
      localDevtools: true,
      onAttempt,
    });

    const error = await rejectedCredential(broker);

    expect(error).toMatchObject({ reason: 'credential_exchange_failed' });
    expect(order).toEqual(['attempt', 'fetch']);
  });

  it('does not let an observer exception alter the downstream credential', async () => {
    const onSuccess = vi.fn(() => {
      throw new Error('observer-hostile-error');
    });
    const fetchImpl = vi.fn(async () =>
      Response.json({ access_token: 'downstream-token', expires_in: 900 }),
    ) as unknown as typeof fetch;
    const broker = await brokerFor({
      fetchImpl,
      secret: CLIENT_SECRET,
      localDevtools: true,
      onSuccess,
    });

    await expect(broker.getCredential(credentialRequest)).resolves.toEqual({
      token: 'downstream-token',
    });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('observes a remote success once and never claims cache hits or failures', async () => {
    const onSuccess = vi.fn();
    const successfulFetch = vi.fn(async () =>
      Response.json({ access_token: 'downstream-token', expires_in: 900 }),
    ) as unknown as typeof fetch;
    const successfulBroker = await brokerFor({
      fetchImpl: successfulFetch,
      secret: CLIENT_SECRET,
      localDevtools: true,
      onSuccess,
    });

    await successfulBroker.getCredential(credentialRequest);
    await successfulBroker.getCredential(credentialRequest);

    expect(successfulFetch).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);

    const failedObserver = vi.fn();
    const failingBroker = await brokerFor({
      fetchImpl: vi.fn(async () =>
        Response.json({ error: 'invalid_grant' }, { status: 400 }),
      ) as unknown as typeof fetch,
      secret: CLIENT_SECRET,
      localDevtools: true,
      onSuccess: failedObserver,
    });
    await rejectedCredential(failingBroker);
    expect(failedObserver).not.toHaveBeenCalled();
  });
});
