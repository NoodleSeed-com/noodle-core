import { describe, expect, it, vi } from 'vitest';
import {
  completeElevation,
  type ElevationPorts,
  InMemoryAssistantElevationStore,
} from '../src/index.js';

const TENANT = { org: 'acme', app: 'site', env: 'prod' } as const;
const OTHER = { org: 'rival', app: 'site', env: 'prod' } as const;
const NOW = new Date('2030-01-01T00:00:00.000Z');
const CALLER = { subject: 'user_42', identityKind: 'customer' } as const;

async function open(overrides: Partial<ElevationPorts> = {}) {
  const elevations = new InMemoryAssistantElevationStore();
  const { continuation } = await elevations.request({
    sessionId: 'sess_1',
    tenant: TENANT,
    tool: 'my_orders',
    now: NOW,
  });
  const elevateSession = vi.fn(async () => ({
    ok: true as const,
    session: { id: 'sess_1' } as never,
    token: 'nss_new',
  }));
  const ports: ElevationPorts = {
    elevations,
    elevateSession,
    now: () => NOW,
    ...overrides,
  };
  return { ports, continuation, elevateSession };
}

describe('completeElevation', () => {
  it('binds the conversation to the signed-in caller and reports what they signed in for', async () => {
    const { ports, continuation, elevateSession } = await open();

    const result = await completeElevation(
      {
        continuation,
        tenant: TENANT,
        caller: CALLER,
        clientId: 'client_backend',
        origin: 'https://app.acme.test',
        customerRouting: { customer_api: 'https://tenant-a.api.acme.test/v1' },
      },
      ports,
    );

    expect(result).toMatchObject({ ok: true, token: 'nss_new', tool: 'my_orders' });
    // The elevating client becomes the session's issuer basis (ADR 0152), the designated origin
    // becomes the session's CORS pin, and the backend-verified routes ride along: elevation is the
    // first authenticated moment, so it is the only chance a routed connector's session gets them.
    expect(elevateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'client_backend',
        origin: 'https://app.acme.test',
        customerRouting: { customer_api: 'https://tenant-a.api.acme.test/v1' },
      }),
    );
  });

  it('never reaches the session when the continuation belongs to another tenant', async () => {
    const { ports, continuation, elevateSession } = await open();

    const result = await completeElevation(
      {
        continuation,
        tenant: OTHER,
        caller: CALLER,
        clientId: 'client_backend',
        origin: 'https://app.acme.test',
      },
      ports,
    );

    expect(result).toEqual({ ok: false, status: 403, code: 'elevation_tenant_mismatch' });
    // The ordering is the point: a cross-tenant attempt must not touch the session at all.
    expect(elevateSession).not.toHaveBeenCalled();
  });

  it('distinguishes an invalid continuation from an expired one', async () => {
    const { ports } = await open();

    expect(
      await completeElevation(
        {
          continuation: 'elv_nope',
          tenant: TENANT,
          caller: CALLER,
          clientId: 'client_backend',
          origin: 'https://app.acme.test',
        },
        ports,
      ),
    ).toEqual({ ok: false, status: 403, code: 'elevation_ticket_invalid' });

    const late = await open({ now: () => new Date(NOW.getTime() + 60 * 60 * 1000) });
    expect(
      await completeElevation(
        {
          continuation: late.continuation,
          tenant: TENANT,
          caller: CALLER,
          clientId: 'client_backend',
          origin: 'https://app.acme.test',
        },
        late.ports,
      ),
    ).toEqual({ ok: false, status: 403, code: 'elevation_ticket_expired' });
  });

  it('spends the continuation once, so a replay cannot elevate again', async () => {
    const { ports, continuation, elevateSession } = await open();

    expect(
      (
        await completeElevation(
          {
            continuation,
            tenant: TENANT,
            caller: CALLER,
            clientId: 'client_backend',
            origin: 'https://app.acme.test',
          },
          ports,
        )
      ).ok,
    ).toBe(true);
    expect(
      await completeElevation(
        {
          continuation,
          tenant: TENANT,
          caller: CALLER,
          clientId: 'client_backend',
          origin: 'https://app.acme.test',
        },
        ports,
      ),
    ).toEqual({ ok: false, status: 403, code: 'elevation_ticket_invalid' });
    expect(elevateSession).toHaveBeenCalledTimes(1);
  });

  it('reports an already signed-in conversation separately from a missing one', async () => {
    const alreadyIn = await open({
      elevateSession: vi.fn(async () => ({
        ok: false as const,
        reason: 'already_elevated' as const,
      })),
    });
    expect(
      await completeElevation(
        {
          continuation: alreadyIn.continuation,
          tenant: TENANT,
          caller: CALLER,
          clientId: 'client_backend',
          origin: 'https://app.acme.test',
        },
        alreadyIn.ports,
      ),
    ).toEqual({ ok: false, status: 409, code: 'elevation_already_signed_in' });

    const missing = await open({
      elevateSession: vi.fn(async () => ({
        ok: false as const,
        reason: 'unknown_session' as const,
      })),
    });
    expect(
      await completeElevation(
        {
          continuation: missing.continuation,
          tenant: TENANT,
          caller: CALLER,
          clientId: 'client_backend',
          origin: 'https://app.acme.test',
        },
        missing.ports,
      ),
    ).toEqual({ ok: false, status: 409, code: 'elevation_session_unavailable' });
  });

  it('arms the resume with the intercepted tool only when explicitly asked', async () => {
    const { ports, continuation, elevateSession } = await open();
    await completeElevation(
      {
        continuation,
        tenant: TENANT,
        caller: CALLER,
        clientId: 'client_backend',
        origin: 'https://app.acme.test',
        resume: true,
      },
      ports,
    );
    expect(elevateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingResume: { tool: 'my_orders', requestedAt: NOW.toISOString() },
      }),
    );
  });

  it('never arms the resume when the flag is absent (probes pass nothing)', async () => {
    // The doctor's synthetic elevation calls this port with no resume knowledge; an armed probe
    // would leave a throwaway session ready to run a real tool.
    const { ports, continuation, elevateSession } = await open();
    await completeElevation(
      { continuation, tenant: TENANT, caller: CALLER, clientId: 'c', origin: 'https://a.test' },
      ports,
    );
    expect(elevateSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ pendingResume: expect.anything() }),
    );
  });
});
