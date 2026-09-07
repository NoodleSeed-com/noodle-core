import { expect, it } from 'vitest';
import type { AssistantStore } from '../src/index.js';

const SIGNED_IN = {
  subject: 'user_42',
  identityKind: 'customer',
  email: 'visitor@acme.test',
} as const;

/**
 * Binding an open conversation to a signed-in caller (ADR 0201, 5.6b), asserted against every store.
 *
 * These are security properties, not conveniences: the old token must be dead the instant the new one
 * exists, a second elevation must be impossible, and the surface that admitted the visitor must keep
 * being charged for them.
 */
export function describeSessionElevation(
  label: string,
  open: () => Promise<{
    readonly store: AssistantStore;
    readonly newSession: () => Promise<{ readonly id: string; readonly token: string }>;
  }>,
): void {
  // Deliberately close to the seed instant. `getSession` prunes every session expired before the clock
  // it is given, and the Postgres suites share one database, so reading far in the future would delete
  // a neighbouring suite's sessions mid-run.
  const now = new Date('2030-01-01T00:00:30Z');

  it(`${label}: swaps the caller and kills the anonymous token in one step`, async () => {
    const { store, newSession } = await open();
    const anonymous = await newSession();

    const elevated = await store.elevateSession({
      sessionId: anonymous.id,
      caller: SIGNED_IN,
      clientId: 'client_backend',
      origin: 'https://app.parity.test',
      now,
    });
    expect(elevated.ok).toBe(true);
    if (!elevated.ok) return;

    expect(elevated.session.caller).toMatchObject({ subject: 'user_42', identityKind: 'customer' });
    expect(elevated.token).not.toBe(anonymous.token);
    // The elevating client becomes the issuer basis (ADR 0152): a public session's clientId is the
    // embed id, and leaving it would make post-elevation delegated exchanges assert an issuer no
    // customer token endpoint pins — while `noodle assistant doctor` probes the client's and stays green.
    expect(elevated.session.clientId).toBe('client_backend');
    // Origin re-pins to the one the elevating client designates: the anonymous pin protected the
    // anonymous token, but the conversation continues wherever the visitor lands after signing in,
    // and CORS on every session route follows session.origin. Without the re-pin, a login redirect
    // to another allowed origin produced an elevated token no page could use.
    expect(elevated.session.origin).toBe('https://app.parity.test');
    // The plan's "old token dead". A window where both tokens work is a window where both identities act.
    expect(await store.getSession(anonymous.token, now)).toBeUndefined();
    expect((await store.getSession(elevated.token, now))?.id).toBe(anonymous.id);
  });

  it(`${label}: keeps the conversation and the surface that admitted it`, async () => {
    const { store, newSession } = await open();
    const anonymous = await newSession();
    await store.appendHistory(anonymous.id, [{ role: 'user', content: 'before signing in' }]);

    const elevated = await store.elevateSession({
      sessionId: anonymous.id,
      caller: SIGNED_IN,
      clientId: 'client_backend',
      origin: 'https://app.parity.test',
      now,
    });
    expect(elevated.ok).toBe(true);
    if (!elevated.ok) return;

    const reread = await store.getSession(elevated.token, now);
    // Same conversation: elevation is not a fresh start, and the visitor never said this twice.
    expect(reread?.history.map((entry) => entry.content)).toContain('before signing in');
    // Same admitting surface: admission keeps charging the embed the visitor arrived through, even
    // though the issuer basis (clientId) now names the elevating client. The exact surface binding
    // written at mint survives the elevation round trip in every store.
    expect(reread?.publicEmbedId).toBe('pub_parity000000000000000');
    expect(reread?.boundSurface).toBe('public');
    expect(reread?.clientId).toBe('client_backend');
    expect(reread?.turnCount).toBe(0);
  });

  it(`${label}: clears follow-up suggestions generated for the anonymous identity`, async () => {
    const { store, newSession } = await open();
    const anonymous = await newSession();
    await store.replaceLatestSuggestions(anonymous.id, {
      phase: 'follow_up',
      prompts: ['Continue as this anonymous visitor'],
    });

    const elevated = await store.elevateSession({
      sessionId: anonymous.id,
      caller: SIGNED_IN,
      clientId: 'client_backend',
      origin: 'https://app.parity.test',
      now,
    });
    expect(elevated.ok).toBe(true);
    if (!elevated.ok) return;

    expect(elevated.session.latestSuggestions).toBeUndefined();
    expect((await store.getSession(elevated.token, now))?.latestSuggestions).toBeUndefined();
  });

  it(`${label}: lands on the surface owning the elevation origin when told to`, async () => {
    const { store, newSession } = await open();
    const anonymous = await newSession();

    // The login redirect landed on the authenticated surface's origin; the route computed the
    // ownership and the store rebinds in the same statement that elevates (ADR 0201, 2026-08-26).
    const elevated = await store.elevateSession({
      sessionId: anonymous.id,
      caller: SIGNED_IN,
      clientId: 'client_backend',
      origin: 'https://app.parity.test',
      boundSurface: 'authenticated',
      now,
    });
    expect(elevated.ok).toBe(true);
    if (!elevated.ok) return;
    expect(elevated.session.boundSurface).toBe('authenticated');
    expect((await store.getSession(elevated.token, now))?.boundSurface).toBe('authenticated');
  });

  it(`${label}: adopts customer routing at elevation, and only then`, async () => {
    const { store, newSession } = await open();
    const anonymous = await newSession();

    // Elevation is the first authenticated moment — the only chance a routed connector's session
    // ever gets its customer routes. An anonymous mint has no backend to supply them.
    const elevated = await store.elevateSession({
      sessionId: anonymous.id,
      caller: SIGNED_IN,
      clientId: 'client_backend',
      origin: 'https://app.parity.test',
      customerRouting: { customer_api: 'https://tenant-a.api.parity.test/v1' },
      now,
    });
    expect(elevated.ok).toBe(true);
    if (!elevated.ok) return;

    const reread = await store.getSession(elevated.token, now);
    expect(reread?.customerRouting).toEqual({
      customer_api: 'https://tenant-a.api.parity.test/v1',
    });
  });

  it(`${label}: an elevation without routing leaves the session's routing untouched`, async () => {
    const { store, newSession } = await open();
    const anonymous = await newSession();

    const elevated = await store.elevateSession({
      sessionId: anonymous.id,
      caller: SIGNED_IN,
      clientId: 'client_backend',
      origin: 'https://app.parity.test',
      now,
    });
    expect(elevated.ok).toBe(true);
    if (!elevated.ok) return;

    // Absent means unchanged, never cleared: omission is not a routing decision.
    expect((await store.getSession(elevated.token, now))?.customerRouting).toBeUndefined();
  });

  it(`${label}: refuses a second elevation`, async () => {
    const { store, newSession } = await open();
    const anonymous = await newSession();

    const first = await store.elevateSession({
      sessionId: anonymous.id,
      caller: SIGNED_IN,
      clientId: 'client_backend',
      origin: 'https://app.parity.test',
      now,
    });
    expect(first.ok).toBe(true);

    // Already signed in: a second exchange must not re-bind the conversation to a different person.
    expect(
      await store.elevateSession({
        sessionId: anonymous.id,
        caller: { ...SIGNED_IN, subject: 'user_99' },
        clientId: 'client_other',
        origin: 'https://other.parity.test',
        now,
      }),
    ).toEqual({ ok: false, reason: 'already_elevated' });
  });

  it(`${label}: refuses a session it does not have`, async () => {
    const { store } = await open();
    expect(
      await store.elevateSession({
        sessionId: 'session_missing',
        caller: SIGNED_IN,
        clientId: 'client_backend',
        origin: 'https://app.parity.test',
        now,
      }),
    ).toEqual({ ok: false, reason: 'unknown_session' });
  });

  it(`${label}: arms a pending resume in the same statement that elevates`, async () => {
    const { store, newSession } = await open();
    const anonymous = await newSession();

    const elevated = await store.elevateSession({
      sessionId: anonymous.id,
      caller: SIGNED_IN,
      clientId: 'client_backend',
      origin: 'https://app.parity.test',
      pendingResume: { tool: 'time_off_balance', requestedAt: now.toISOString() },
      now,
    });
    expect(elevated.ok).toBe(true);
    if (!elevated.ok) return;

    expect((await store.getSession(elevated.token, now))?.pendingResume).toEqual({
      tool: 'time_off_balance',
      requestedAt: now.toISOString(),
    });
  });

  it(`${label}: an elevation without a resume leaves the session unarmed`, async () => {
    const { store, newSession } = await open();
    const anonymous = await newSession();

    const elevated = await store.elevateSession({
      sessionId: anonymous.id,
      caller: SIGNED_IN,
      clientId: 'client_backend',
      origin: 'https://app.parity.test',
      now,
    });
    expect(elevated.ok).toBe(true);
    if (!elevated.ok) return;
    expect((await store.getSession(elevated.token, now))?.pendingResume).toBeUndefined();
  });

  it(`${label}: consumes a pending resume exactly once`, async () => {
    const { store, newSession } = await open();
    const anonymous = await newSession();

    const elevated = await store.elevateSession({
      sessionId: anonymous.id,
      caller: SIGNED_IN,
      clientId: 'client_backend',
      origin: 'https://app.parity.test',
      pendingResume: { tool: 'my_teams', requestedAt: now.toISOString() },
      now,
    });
    expect(elevated.ok).toBe(true);

    // One seam, one statement: two turn requests racing the same arm must not both resume.
    expect(await store.consumePendingResume(anonymous.id)).toEqual({
      tool: 'my_teams',
      requestedAt: now.toISOString(),
    });
    expect(await store.consumePendingResume(anonymous.id)).toBeUndefined();
    if (!elevated.ok) return;
    expect((await store.getSession(elevated.token, now))?.pendingResume).toBeUndefined();
  });

  it(`${label}: consuming an unarmed session returns undefined`, async () => {
    const { store, newSession } = await open();
    const anonymous = await newSession();
    expect(await store.consumePendingResume(anonymous.id)).toBeUndefined();
    expect(await store.consumePendingResume('session_missing')).toBeUndefined();
  });
}
