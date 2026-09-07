import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ASSISTANT_INTERACTION_EXECUTING_GRACE_MS,
  ASSISTANT_INTERACTION_OUTCOME_RETENTION_MS,
  AssistantInteractionCapacityError,
  type AssistantSessionRecord,
  DEFAULT_MAX_PENDING_INTERACTIONS_PER_SESSION,
} from '../src/assistant-store.js';
import { PostgresAssistantStore } from '../src/postgres-assistant.js';

const databaseUrl = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
const describePostgres = describe.skipIf(databaseUrl === undefined);

describePostgres('Postgres assistant store', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const store = new PostgresAssistantStore(pool);
  const tenant = { org: `assistant-${randomUUID()}`, app: 'smoke', env: 'prod' };
  const now = new Date('2030-01-01T00:00:00Z');

  beforeAll(async () => {
    await store.ensureSchema();
    await store.ensureSchema();
  });
  afterAll(async () => pool.end());

  async function createSession(): Promise<{
    readonly token: string;
    readonly session: AssistantSessionRecord;
  }> {
    const created = await store.createClient({
      name: `web-${randomUUID()}`,
      tenant,
      deploymentId: 'dep_1',
      allowedOrigins: ['https://app.example.com'],
      now,
    });
    expect(await store.authenticateClient(created.client.id, created.secret)).toBeDefined();
    return store.createSession({
      clientId: created.client.id,
      tenant,
      deploymentId: 'dep_1',
      modelSource: 'noodle-managed',
      origin: 'https://app.example.com',
      caller: { subject: 'user', identityKind: 'customer' },
      customerRouting: {
        customer_api: 'https://tenant-a.api.example.com/v1',
      },
      preferences: { locale: 'en-GB', timeZone: 'Europe/London' },
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      absoluteExpiresAt: new Date(now.getTime() + 120_000).toISOString(),
    });
  }

  it('migrates the legacy unlogged interaction table to durable logged storage', async () => {
    await pool.query(`ALTER TABLE assistant_pending_tool_calls SET UNLOGGED`);
    const legacy = await pool.query<{ relpersistence: string }>(
      `SELECT relpersistence FROM pg_class WHERE oid='assistant_pending_tool_calls'::regclass`,
    );
    expect(legacy.rows[0]?.relpersistence).toBe('u');

    await store.ensureSchema();
    const result = await pool.query<{ relpersistence: string }>(
      `SELECT relpersistence FROM pg_class WHERE oid='assistant_pending_tool_calls'::regclass`,
    );
    expect(result.rows[0]?.relpersistence).toBe('p');
  });

  it('persists preferences and atomically claims with replay across store instances', async () => {
    const session = await createSession();
    await expect(store.getSession(session.token, now)).resolves.toMatchObject({
      preferences: { locale: 'en-GB', timeZone: 'Europe/London' },
      customerRouting: { customer_api: 'https://tenant-a.api.example.com/v1' },
      modelSource: 'noodle-managed',
      caller: { subject: 'user', identityKind: 'customer' },
    });
    const context = {
      temporal: {
        instant: now.toISOString(),
        localDate: '2030-01-01',
        localTime: '00:00:00',
        utcOffset: '+00:00',
        weekday: 'Tuesday',
        timeZone: 'UTC',
        locale: 'en-GB',
        source: { locale: 'user-preference' as const, timeZone: 'server-default' as const },
      },
      ambientStatus: 'not_configured' as const,
    };
    const pending = await store.createInteraction({
      kind: 'confirmation',
      sessionId: session.session.id,
      deploymentId: 'dep_1',
      tool: 'update',
      arguments: { value: 1, nested: { exact: true } },
      review: { value: 1, nested: { exact: true } },
      continuation: {
        kind: 'prepared_confirmation',
        version: 1,
        toolName: 'update',
        nextStepIndex: 2,
      },
      context,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    await expect(
      store.claimInteraction({
        id: pending.id,
        sessionId: session.session.id,
        deploymentId: 'stale-deployment',
        now,
      }),
    ).resolves.toEqual({ disposition: 'unavailable' });

    const secondStore = new PostgresAssistantStore(pool);
    const attempts = await Promise.all([
      store.claimInteraction({
        id: pending.id,
        sessionId: session.session.id,
        deploymentId: 'dep_1',
        now,
      }),
      secondStore.claimInteraction({
        id: pending.id,
        sessionId: session.session.id,
        deploymentId: 'dep_1',
        now,
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.disposition === 'claimed')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.disposition === 'replay')).toHaveLength(1);
    expect(attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          interaction: expect.objectContaining({
            kind: 'confirmation',
            status: 'executing',
            arguments: { value: 1, nested: { exact: true } },
            review: { value: 1, nested: { exact: true } },
            continuation: {
              kind: 'prepared_confirmation',
              version: 1,
              toolName: 'update',
              nextStepIndex: 2,
            },
            context,
            createdAt: now.toISOString(),
          }),
        }),
      ]),
    );
  });

  it('claims initial suggestions once and persists replay plus latest follow-ups', async () => {
    const created = await createSession();
    const other = new PostgresAssistantStore(pool);
    const [first, second] = await Promise.all([
      store.claimInitialSuggestions(created.session.id),
      other.claimInitialSuggestions(created.session.id),
    ]);
    expect([first.disposition, second.disposition].sort()).toEqual(['generate', 'unavailable']);
    await expect(
      store.completeInitialSuggestions(created.session.id, ['Show my account']),
    ).resolves.toBe(true);
    await expect(other.claimInitialSuggestions(created.session.id)).resolves.toEqual({
      disposition: 'ready',
      prompts: ['Show my account'],
    });
    await store.replaceLatestSuggestions(created.session.id, {
      phase: 'follow_up',
      prompts: ['What happens next?'],
    });
    await expect(store.getSession(created.token, now)).resolves.toMatchObject({
      latestSuggestions: { phase: 'follow_up', prompts: ['What happens next?'] },
    });
  });

  it('completes once and replays only its stored safe public outcome', async () => {
    const session = await createSession();
    const context = {
      temporal: {
        instant: now.toISOString(),
        localDate: '2030-01-01',
        localTime: '00:00:00',
        utcOffset: '+00:00',
        weekday: 'Tuesday',
        timeZone: 'UTC',
        locale: 'en-GB',
        source: { locale: 'server-default' as const, timeZone: 'server-default' as const },
      },
      ambientStatus: 'not_configured' as const,
    };
    const pending = await store.createInteraction({
      kind: 'confirmation',
      sessionId: session.session.id,
      deploymentId: 'dep_1',
      tool: 'update',
      arguments: { value: 2 },
      continuation: { privateState: 'erase-on-completion' },
      review: { privateProjection: 'erase-on-completion' },
      context,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    await store.claimInteraction({
      id: pending.id,
      sessionId: pending.sessionId,
      deploymentId: pending.deploymentId,
      now,
    });
    const completion = await store.completeInteraction({
      id: pending.id,
      sessionId: pending.sessionId,
      deploymentId: pending.deploymentId,
      now: new Date(now.getTime() + 1_000),
      completion: {
        status: 'succeeded',
        arguments: null,
        payloadScrubbedAt: new Date(now.getTime() + 1_000).toISOString(),
        publicOutcome: {
          code: 'updated',
          summary: 'Account updated.',
          details: { requestId: 'request-1', password: 'do-not-store' } as never,
        },
      },
    });
    expect(completion).toMatchObject({
      disposition: 'completed',
      interaction: {
        status: 'succeeded',
        publicOutcome: {
          code: 'updated',
          details: { requestId: 'request-1', password: '[redacted]' },
        },
      },
    });
    if (completion.disposition !== 'completed') throw new Error('expected completion');
    expect(completion.interaction).not.toHaveProperty('result');
    expect(completion.interaction).not.toHaveProperty('error');
    expect(completion.interaction).not.toHaveProperty('context');
    expect(completion.interaction).not.toHaveProperty('continuation');
    expect(completion.interaction).not.toHaveProperty('review');
    const stored = await pool.query<{
      arguments: unknown;
      continuation: unknown;
      invocation_context: unknown;
      payload_scrubbed_at: Date | null;
      review: unknown;
    }>(
      `SELECT arguments, continuation, review, invocation_context, payload_scrubbed_at
       FROM assistant_pending_tool_calls WHERE id=$1`,
      [pending.id],
    );
    expect(stored.rows[0]).toEqual({
      arguments: null,
      continuation: null,
      invocation_context: null,
      payload_scrubbed_at: new Date(now.getTime() + 1_000),
      review: null,
    });

    await expect(
      store.completeInteraction({
        id: pending.id,
        sessionId: pending.sessionId,
        deploymentId: pending.deploymentId,
        now: new Date(now.getTime() + 2_000),
        completion: {
          status: 'failed',
          publicOutcome: { code: 'different', summary: 'must not overwrite' },
        },
      }),
    ).resolves.toEqual({ disposition: 'replay', interaction: completion.interaction });
  });

  it('persists input continuations and atomically resolves pending decline', async () => {
    const session = await createSession();
    const pending = await store.createInteraction({
      kind: 'input',
      sessionId: session.session.id,
      deploymentId: 'dep_1',
      tool: 'submit_time_off',
      message: 'Which team?',
      requestedSchema: { type: 'object', properties: { team: { type: 'string' } } },
      continuation: { flow: 'book_leave', step: 2, state: { defaultTeam: 'team-1' } },
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    await expect(
      store.completeInteraction({
        id: pending.id,
        sessionId: pending.sessionId,
        deploymentId: pending.deploymentId,
        now,
        completion: { status: 'declined' },
      }),
    ).resolves.toMatchObject({
      disposition: 'completed',
      interaction: {
        kind: 'input',
        status: 'declined',
        tool: 'submit_time_off',
        continuation: null,
        payloadScrubbedAt: now.toISOString(),
        publicOutcome: { code: 'interaction_declined' },
      },
    });
  });

  it('atomically completes an execution and creates one replay-linked next interaction', async () => {
    const session = await createSession();
    const parent = await store.createInteraction({
      kind: 'confirmation',
      sessionId: session.session.id,
      deploymentId: session.session.deploymentId,
      tool: 'request_time_off',
      arguments: { start: '2030-01-03', end: '2030-01-04' },
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    await store.claimInteraction({
      id: parent.id,
      sessionId: parent.sessionId,
      deploymentId: parent.deploymentId,
      now,
    });
    const handoff = {
      id: parent.id,
      sessionId: parent.sessionId,
      deploymentId: parent.deploymentId,
      now: new Date(now.getTime() + 1_000),
      publicOutcome: {
        code: 'input_requested',
        summary: 'More information is required.',
        details: { tool: parent.tool },
      },
      next: {
        kind: 'input' as const,
        tool: parent.tool,
        message: 'Which team should receive this request?',
        requestedSchema: {
          type: 'object',
          properties: { team: { type: 'string' } },
          required: ['team'],
        },
        continuation: { kind: 'confirmation_preparation', nextStepIndex: 2 },
        expiresAt: new Date(now.getTime() + 61_000).toISOString(),
      },
    };

    const transitioned = await store.transitionInteraction(handoff);
    expect(transitioned).toMatchObject({
      disposition: 'transitioned',
      interaction: {
        status: 'succeeded',
        arguments: null,
        payloadScrubbedAt: new Date(now.getTime() + 1_000).toISOString(),
        publicOutcome: {
          code: 'input_requested',
          details: { tool: parent.tool, nextInteractionId: expect.any(String) },
        },
      },
      next: { kind: 'input', status: 'pending' },
    });
    if (transitioned.disposition !== 'transitioned') throw new Error('expected transition');
    expect(transitioned.interaction).not.toHaveProperty('context');
    expect(transitioned.interaction.publicOutcome.details?.nextInteractionId).toBe(
      transitioned.next.id,
    );

    const secondStore = new PostgresAssistantStore(pool);
    await expect(secondStore.transitionInteraction(handoff)).resolves.toEqual({
      disposition: 'replay',
      interaction: transitioned.interaction,
    });
    const children = await pool.query<{ id: string }>(
      `SELECT id FROM assistant_pending_tool_calls
       WHERE session_id=$1 AND id <> $2 AND tool=$3 AND status='pending'`,
      [parent.sessionId, parent.id, parent.tool],
    );
    expect(children.rows).toEqual([{ id: transitioned.next.id }]);
  });

  it('rolls back the child insert when the parent transition update fails', async () => {
    const session = await createSession();
    const suffix = randomUUID().replaceAll('-', '_');
    const tool = `crash_window_${suffix}`;
    const trigger = `fail_assistant_handoff_${suffix}`;
    const triggerFunction = `${trigger}_fn`;
    const parent = await store.createInteraction({
      kind: 'confirmation',
      sessionId: session.session.id,
      deploymentId: session.session.deploymentId,
      tool,
      arguments: { privateValue: 'must-remain-on-parent' },
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    await store.claimInteraction({
      id: parent.id,
      sessionId: parent.sessionId,
      deploymentId: parent.deploymentId,
      now,
    });
    await pool.query(`
      CREATE FUNCTION ${triggerFunction}() RETURNS trigger AS $$
      BEGIN
        IF OLD.tool = '${tool}' AND NEW.status = 'succeeded' THEN
          RAISE EXCEPTION 'injected parent transition failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await pool.query(`
      CREATE TRIGGER ${trigger}
      BEFORE UPDATE ON assistant_pending_tool_calls
      FOR EACH ROW EXECUTE FUNCTION ${triggerFunction}()
    `);

    try {
      await expect(
        store.transitionInteraction({
          id: parent.id,
          sessionId: parent.sessionId,
          deploymentId: parent.deploymentId,
          now: new Date(now.getTime() + 1_000),
          publicOutcome: { code: 'input_requested', summary: 'More information is required.' },
          next: {
            kind: 'input',
            tool,
            message: 'Which team?',
            requestedSchema: { type: 'object' },
            continuation: { privateValue: 'must-not-be-orphaned' },
            expiresAt: new Date(now.getTime() + 61_000).toISOString(),
          },
        }),
      ).rejects.toThrow('injected parent transition failure');
    } finally {
      await pool.query(`DROP TRIGGER ${trigger} ON assistant_pending_tool_calls`);
      await pool.query(`DROP FUNCTION ${triggerFunction}()`);
    }

    const rows = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM assistant_pending_tool_calls WHERE tool=$1 ORDER BY id`,
      [tool],
    );
    expect(rows.rows).toEqual([{ id: parent.id, status: 'executing' }]);
  });

  it('retains executing and terminal replay state past proposal expiry', async () => {
    const session = await createSession();
    const pending = await store.createInteraction({
      kind: 'confirmation',
      sessionId: session.session.id,
      deploymentId: 'dep_1',
      tool: 'slow_update',
      arguments: { exact: true },
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 500).toISOString(),
    });
    await store.claimInteraction({
      id: pending.id,
      sessionId: pending.sessionId,
      deploymentId: pending.deploymentId,
      now,
    });
    const afterExpiry = new Date(now.getTime() + 1_000);
    await expect(
      store.getInteraction({
        id: pending.id,
        sessionId: pending.sessionId,
        deploymentId: pending.deploymentId,
        now: afterExpiry,
      }),
    ).resolves.toMatchObject({ status: 'executing' });
    await store.completeInteraction({
      id: pending.id,
      sessionId: pending.sessionId,
      deploymentId: pending.deploymentId,
      now: afterExpiry,
      completion: {
        status: 'succeeded',
        publicOutcome: { code: 'done', summary: 'Slow update completed.' },
      },
    });
    await expect(
      store.claimInteraction({
        id: pending.id,
        sessionId: pending.sessionId,
        deploymentId: pending.deploymentId,
        now: new Date(afterExpiry.getTime() + 60_000),
      }),
    ).resolves.toMatchObject({ disposition: 'replay', interaction: { status: 'succeeded' } });
  });

  it('prunes expired pending interactions', async () => {
    const session = await createSession();
    const expired = await store.createInteraction({
      kind: 'confirmation',
      sessionId: session.session.id,
      deploymentId: 'dep_1',
      tool: 'update',
      arguments: {},
      createdAt: new Date(now.getTime() - 120_000).toISOString(),
      expiresAt: new Date(now.getTime() - 60_000).toISOString(),
    });
    await expect(
      store.getInteraction({
        id: expired.id,
        sessionId: expired.sessionId,
        deploymentId: expired.deploymentId,
        now,
      }),
    ).resolves.toBeUndefined();
    const rows = await pool.query(`SELECT id FROM assistant_pending_tool_calls WHERE id=$1`, [
      expired.id,
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it('enforces the pending interaction cap atomically across store instances', async () => {
    const session = await createSession();
    const secondStore = new PostgresAssistantStore(pool);
    const attempts = await Promise.allSettled(
      Array.from({ length: DEFAULT_MAX_PENDING_INTERACTIONS_PER_SESSION + 1 }, (_, index) =>
        (index % 2 === 0 ? store : secondStore).createInteraction({
          kind: 'confirmation',
          sessionId: session.session.id,
          deploymentId: session.session.deploymentId,
          tool: 'bounded_update',
          arguments: { index },
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        }),
      ),
    );

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(
      DEFAULT_MAX_PENDING_INTERACTIONS_PER_SESSION,
    );
    const rejected = attempts.filter(
      (attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(AssistantInteractionCapacityError);
  });

  it('expires stranded executions into scrubbed, bounded unknown-outcome tombstones', async () => {
    const session = await createSession();
    const context = {
      temporal: {
        instant: now.toISOString(),
        localDate: '2030-01-01',
        localTime: '00:00:00',
        utcOffset: '+00:00',
        weekday: 'Tuesday',
        timeZone: 'UTC',
        locale: 'en-GB',
        source: { locale: 'user-preference' as const, timeZone: 'server-default' as const },
      },
      ambientStatus: 'available' as const,
      ambient: { privateTeam: 'erase-me' },
    };
    const confirmation = await store.createInteraction({
      kind: 'confirmation',
      sessionId: session.session.id,
      deploymentId: session.session.deploymentId,
      tool: 'stranded_confirmation',
      arguments: { privateNote: 'erase-me' },
      continuation: { privateContinuation: 'erase-me' },
      review: { privateProjection: 'erase-me' },
      context,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    const input = await store.createInteraction({
      kind: 'input',
      sessionId: session.session.id,
      deploymentId: session.session.deploymentId,
      tool: 'stranded_input',
      message: 'Choose a team',
      requestedSchema: { type: 'object', properties: { team: { type: 'string' } } },
      continuation: { completedSteps: { privateValue: 'erase-me-too' } },
      context,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    await Promise.all(
      [confirmation, input].map((interaction) =>
        store.claimInteraction({
          id: interaction.id,
          sessionId: interaction.sessionId,
          deploymentId: interaction.deploymentId,
          now,
        }),
      ),
    );

    const scrubbedAt = new Date(now.getTime() + ASSISTANT_INTERACTION_EXECUTING_GRACE_MS);
    await expect(
      store.getInteraction({
        id: confirmation.id,
        sessionId: confirmation.sessionId,
        deploymentId: confirmation.deploymentId,
        now: scrubbedAt,
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      arguments: null,
      payloadScrubbedAt: scrubbedAt.toISOString(),
      publicOutcome: { code: 'interaction_outcome_unknown' },
    });
    await expect(
      store.getInteraction({
        id: input.id,
        sessionId: input.sessionId,
        deploymentId: input.deploymentId,
        now: scrubbedAt,
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      continuation: null,
      payloadScrubbedAt: scrubbedAt.toISOString(),
      publicOutcome: { code: 'interaction_outcome_unknown' },
    });
    const rows = await pool.query<{
      arguments: unknown;
      continuation: unknown;
      invocation_context: unknown;
      payload_scrubbed_at: Date | null;
      public_outcome: unknown;
      review: unknown;
      status: string;
    }>(
      `SELECT arguments, continuation, review, invocation_context, payload_scrubbed_at, public_outcome, status
       FROM assistant_pending_tool_calls WHERE id = ANY($1::text[]) ORDER BY id`,
      [[confirmation.id, input.id]],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          arguments: null,
          continuation: null,
          invocation_context: null,
          payload_scrubbed_at: scrubbedAt,
          public_outcome: expect.objectContaining({ code: 'interaction_outcome_unknown' }),
          review: null,
          status: 'failed',
        }),
      ]),
    );

    await expect(
      store.getInteraction({
        id: confirmation.id,
        sessionId: confirmation.sessionId,
        deploymentId: confirmation.deploymentId,
        now: new Date(scrubbedAt.getTime() + ASSISTANT_INTERACTION_OUTCOME_RETENTION_MS),
      }),
    ).resolves.toBeUndefined();
  });

  it('atomically consumes a console approval nonce across store instances', async () => {
    const secondStore = new PostgresAssistantStore(pool);
    const expiresAt = new Date(now.getTime() + 60_000);
    const nonce = `approval-${randomUUID()}`;
    const attempts = await Promise.all([
      store.consumeConsoleApprovalNonce(nonce, 'user-1', expiresAt, now),
      secondStore.consumeConsoleApprovalNonce(nonce, 'user-1', expiresAt, now),
    ]);
    expect(attempts.sort()).toEqual([false, true]);
  });
});
