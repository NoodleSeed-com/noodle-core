import { randomUUID } from 'node:crypto';
import {
  PostgresAssistantElevationCoordinator,
  PostgresAssistantElevationStore,
  PostgresAssistantStore,
} from '@noodle-borg/assistant-gateway/postgres';
import type { ArtifactState } from '@noodle-borg/compiler';
import { ensureAuditSchema } from '@noodle-borg/module-audit';
import { ensureStateHandleSchema, PostgresStateHandleStore } from '@noodle-borg/runtime/postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
const describePostgres = describe.skipIf(databaseUrl === undefined);
const NOW = new Date('2030-01-01T00:00:00.000Z');
const STATE: ArtifactState = {
  handles: {
    draft: {
      kind: 'draft',
      schema: { type: 'object', properties: { title: { type: 'string' } } },
      version: 'v1',
      scope: 'caller',
      ttlSeconds: 3_600,
      claimOnAuthentication: true,
    },
  },
};

describePostgres('PostgreSQL atomic assistant elevation', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const sessions = new PostgresAssistantStore(pool);
  const elevations = new PostgresAssistantElevationStore(pool);
  const coordinator = new PostgresAssistantElevationCoordinator(pool, { now: () => NOW });

  beforeAll(async () => {
    await sessions.ensureSchema();
    await elevations.ensureSchema();
    await ensureStateHandleSchema(pool);
    await ensureAuditSchema(pool);
  });

  afterAll(async () => pool.end());

  it('commits ticket spend, state rekey, session token replacement, and audit together', async () => {
    const fixture = await openFixture();
    const result = await coordinator.complete({
      continuation: fixture.continuation,
      tenant: fixture.tenant,
      caller: { subject: fixture.account, identityKind: 'customer' },
      clientId: fixture.clientId,
      origin: 'https://app.example.test',
      resume: true,
    });

    expect(result).toMatchObject({ ok: true, tool: 'finish_setup', resumeArmed: true });
    if (!result.ok) return;
    await expect(sessions.getSession(fixture.anonymousToken, NOW)).resolves.toBeUndefined();
    await expect(sessions.getSession(result.token, NOW)).resolves.toMatchObject({
      caller: { subject: fixture.account, identityKind: 'customer' },
      pendingResume: { tool: 'finish_setup' },
    });
    await expect(
      fixture.state.read({ handle: 'draft', callerSubject: fixture.account }),
    ).resolves.toMatchObject({ value: { title: 'Blueprint' }, revision: 1 });
    await expect(
      coordinator.complete({
        continuation: fixture.continuation,
        tenant: fixture.tenant,
        caller: { subject: fixture.account, identityKind: 'customer' },
        clientId: fixture.clientId,
        origin: 'https://app.example.test',
      }),
    ).resolves.toEqual({ ok: false, status: 403, code: 'elevation_ticket_invalid' });
    const audit = await pool.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_events
       WHERE event_type = 'assistant.state.claimed' AND deployment_id = $1`,
      [fixture.deploymentId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.details).toMatchObject({ handleCount: 1, recordCount: 1 });
  });

  it('leaves state/session unchanged but consumes the ticket when the destination key exists', async () => {
    const fixture = await openFixture();
    await fixture.state.patch({
      handle: 'draft',
      callerSubject: fixture.account,
      expectedRevision: 0,
      value: { title: 'Existing account draft' },
    });

    await expect(
      coordinator.complete({
        continuation: fixture.continuation,
        tenant: fixture.tenant,
        caller: { subject: fixture.account, identityKind: 'customer' },
        clientId: fixture.clientId,
        origin: 'https://app.example.test',
      }),
    ).resolves.toEqual({ ok: false, status: 409, code: 'elevation_state_conflict' });
    await expect(sessions.getSession(fixture.anonymousToken, NOW)).resolves.toMatchObject({
      caller: { subject: fixture.anonymous, identityKind: 'anonymous' },
    });
    const ticket = await pool.query<{ claimed_at: Date | null }>(
      `SELECT claimed_at FROM assistant_elevations WHERE continuation_hash IS NOT NULL AND session_id = $1`,
      [fixture.sessionId],
    );
    expect(ticket.rows[0]?.claimed_at).toEqual(NOW);
    await expect(
      fixture.state.read({ handle: 'draft', callerSubject: fixture.anonymous }),
    ).resolves.toMatchObject({ value: { title: 'Blueprint' } });
    await expect(
      coordinator.complete({
        continuation: fixture.continuation,
        tenant: fixture.tenant,
        caller: { subject: 'different-account', identityKind: 'customer' },
        clientId: fixture.clientId,
        origin: 'https://app.example.test',
      }),
    ).resolves.toEqual({ ok: false, status: 403, code: 'elevation_ticket_invalid' });
  });

  it('preserves one pending interaction and suppresses parallel one-shot resume', async () => {
    const fixture = await openFixture();
    await sessions.createInteraction({
      kind: 'confirmation',
      sessionId: fixture.sessionId,
      deploymentId: fixture.deploymentId,
      tool: 'confirm_blueprint',
      arguments: { approved: true },
      review: { approved: true },
      continuation: {
        kind: 'prepared_confirmation',
        version: 1,
        toolName: 'confirm_blueprint',
        nextStepIndex: 0,
      },
      context: {
        temporal: {
          instant: NOW.toISOString(),
          localDate: '2030-01-01',
          localTime: '00:00:00',
          utcOffset: '+00:00',
          weekday: 'Tuesday',
          timeZone: 'UTC',
          locale: 'en-US',
          source: { locale: 'server-default', timeZone: 'server-default' },
        },
        ambientStatus: 'not_configured',
      },
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    });

    const result = await coordinator.complete({
      continuation: fixture.continuation,
      tenant: fixture.tenant,
      caller: { subject: fixture.account, identityKind: 'customer' },
      clientId: fixture.clientId,
      origin: 'https://app.example.test',
      resume: true,
    });
    expect(result).toMatchObject({ ok: true, resumeArmed: false });
    if (result.ok) expect(result.session.pendingResume).toBeUndefined();
  });

  async function openFixture() {
    const id = randomUUID();
    const tenant = { org: `atomic-${id}`, app: 'onboarding', env: 'prod' };
    const deploymentId = `dep_${id}`;
    const anonymous = `anon_${id}`;
    const account = `account_${id}`;
    const client = await sessions.createClient({
      name: 'Backend',
      tenant,
      deploymentId,
      allowedOrigins: ['https://app.example.test'],
      now: NOW,
    });
    const created = await sessions.createSession({
      clientId: client.client.id,
      tenant,
      deploymentId,
      origin: 'https://www.example.test',
      caller: { subject: anonymous, identityKind: 'anonymous' },
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
      absoluteExpiresAt: new Date(NOW.getTime() + 2 * 60 * 60_000).toISOString(),
    });
    const state = new PostgresStateHandleStore(pool, {
      deploymentId,
      state: STATE,
      now: () => NOW,
    });
    await state.patch({
      handle: 'draft',
      callerSubject: anonymous,
      expectedRevision: 0,
      value: { title: 'Blueprint' },
    });
    const ticket = await elevations.request({
      sessionId: created.session.id,
      tenant,
      tool: 'finish_setup',
      claimableStateHandles: ['draft'],
      now: NOW,
    });
    return {
      tenant,
      deploymentId,
      anonymous,
      account,
      clientId: client.client.id,
      sessionId: created.session.id,
      anonymousToken: created.token,
      continuation: ticket.continuation,
      state,
    };
  }
});
