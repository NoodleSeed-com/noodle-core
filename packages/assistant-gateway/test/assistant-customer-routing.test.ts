import type { CustomerEndpointPolicy, RuntimeArtifact } from '@noodle-borg/compiler';
import type { ExecuteDeps } from '@noodle-borg/runtime';
import { describe, expect, it } from 'vitest';
import {
  parseAssistantCustomerRouting,
  withAssistantSessionExecutionAuthority,
} from '../src/assistant-customer-routing.js';
import { type AssistantSessionRecord, InMemoryAssistantStore } from '../src/assistant-store.js';

const DECLARATIONS = {
  customer_api: { allowedHttpsHostSuffixes: ['noodleseed.dev'] },
} as const satisfies Readonly<Record<string, CustomerEndpointPolicy>>;

const VALID_ROUTE = 'https://tenant-a.api.noodleseed.dev/v1';

describe('assistant customer routing', () => {
  it('canonicalizes only supplied, declared, policy-allowed endpoint routes', () => {
    expect(
      parseAssistantCustomerRouting(DECLARATIONS, {
        endpoints: { customer_api: `${VALID_ROUTE}/` },
      }),
    ).toEqual({
      ok: true,
      customerRouting: { customer_api: VALID_ROUTE },
    });
  });

  it('keeps omitted and partial routing fail-closed without rejecting the session', () => {
    expect(parseAssistantCustomerRouting(DECLARATIONS, undefined)).toEqual({ ok: true });
    expect(parseAssistantCustomerRouting(DECLARATIONS, { endpoints: {} })).toEqual({
      ok: true,
      customerRouting: {},
    });

    const session = assistantSession({});
    const deps = withAssistantSessionExecutionAuthority(
      {} as ExecuteDeps,
      { customerEndpoints: DECLARATIONS } as RuntimeArtifact,
      session,
    );
    expect(deps.customerRoutes?.endpoints.customer_api).toMatchObject({ available: false });
  });

  it.each([
    ['null routing', null],
    ['array routing', []],
    ['missing endpoint map', {}],
    ['null endpoint map', { endpoints: null }],
    ['array endpoint map', { endpoints: [] }],
    ['unknown endpoint', { endpoints: { other_api: VALID_ROUTE } }],
    ['non-string route', { endpoints: { customer_api: 42 } }],
    ['plain HTTP route', { endpoints: { customer_api: 'http://tenant-a.api.noodleseed.dev' } }],
    ['IP literal route', { endpoints: { customer_api: 'https://127.0.0.1/v1' } }],
    ['disallowed route', { endpoints: { customer_api: 'https://tenant-a.example.net/v1' } }],
  ])('rejects %s without reflecting the supplied value', (_name, input) => {
    const result = parseAssistantCustomerRouting(DECLARATIONS, input);

    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain('tenant-a');
    expect(JSON.stringify(result)).not.toContain('127.0.0.1');
  });

  it('adds the assistant issuer and frozen private route authority without changing caller identity', () => {
    const session = assistantSession({ customer_api: VALID_ROUTE });
    const deps = withAssistantSessionExecutionAuthority(
      {} as ExecuteDeps,
      { customerEndpoints: DECLARATIONS } as RuntimeArtifact,
      session,
    );

    expect(deps.customerIssuer).toBe('urn:noodleseed:assistant-client:embed_123');
    expect(deps.customerRoutes?.endpoints.customer_api).toMatchObject({
      available: true,
      baseUrl: VALID_ROUTE,
    });
    expect(session.caller).toEqual({ subject: 'user_123', identityKind: 'customer' });
  });

  it('round-trips a defensive route copy only in private in-memory session state', async () => {
    const store = new InMemoryAssistantStore();
    const now = new Date('2030-01-01T00:00:00.000Z');
    const created = await store.createSession({
      ...assistantSession({ customer_api: VALID_ROUTE }),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      absoluteExpiresAt: new Date(now.getTime() + 120_000).toISOString(),
    });

    const stored = await store.getSession(created.token, now);
    expect(stored?.customerRouting).toEqual({ customer_api: VALID_ROUTE });
    expect(stored?.caller).not.toHaveProperty('customerRouting');
  });
});

function assistantSession(customerRouting: Readonly<Record<string, string>>): Omit<
  AssistantSessionRecord,
  'id' | 'tokenHash' | 'history'
> & {
  readonly customerRouting: Readonly<Record<string, string>>;
} {
  return {
    clientId: 'embed_123',
    tenant: { org: 'acme', app: 'support', env: 'prod' },
    deploymentId: 'dep_123',
    origin: 'https://app.example.com',
    caller: { subject: 'user_123', identityKind: 'customer' },
    customerRouting,
    createdAt: '2030-01-01T00:00:00.000Z',
    expiresAt: '2030-01-01T00:01:00.000Z',
    absoluteExpiresAt: '2030-01-01T00:02:00.000Z',
  };
}
