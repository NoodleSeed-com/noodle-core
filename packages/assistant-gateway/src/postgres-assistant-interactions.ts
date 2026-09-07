import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  ASSISTANT_INTERACTION_EXECUTION_LIMIT_MS,
  ASSISTANT_INTERACTION_OUTCOME_RETENTION_MS,
  ASSISTANT_INTERACTION_UNKNOWN_OUTCOME,
  type AssistantConfirmationInteractionRecord,
  type AssistantInteractionClaimResult,
  type AssistantInteractionCompletion,
  type AssistantInteractionCompletionResult,
  type AssistantInteractionCreateInput,
  type AssistantInteractionPublicOutcome,
  type AssistantInteractionRecord,
  type AssistantInteractionScope,
  type AssistantInteractionTransitionInput,
  type AssistantInteractionTransitionResult,
  type AssistantPendingConfirmationInteractionRecord,
  type AssistantPendingInputInteractionRecord,
  type AssistantPendingInteractionRecord,
  completedInteraction,
  createPendingInteraction,
  executingInteraction,
  expireStrandedExecutingInteraction,
  isPrunableInteraction,
  isTerminalInteraction,
  normalizePublicOutcome,
  shouldExpireStrandedExecutingInteraction,
  transitionedInteractions,
} from './assistant-interaction-state.js';
import {
  insertAssistantPendingInteraction,
  reserveAssistantInteractionPendingSlot,
} from './postgres-assistant-interaction-writes.js';

/** Logged single-executor handoff: private inputs are removed atomically before dispatch. */
export class PostgresAssistantInteractions {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async ensureSchema(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS assistant_pending_tool_calls (
        id text PRIMARY KEY,
        kind text NOT NULL DEFAULT 'confirmation',
        status text NOT NULL DEFAULT 'pending',
        session_id text NOT NULL,
        deployment_id text NOT NULL DEFAULT '',
        tool text NOT NULL,
        arguments jsonb,
        message text,
        requested_schema jsonb,
        continuation jsonb,
        review jsonb,
        invocation_context jsonb,
        created_at timestamptz NOT NULL,
        claimed_at timestamptz,
        completed_at timestamptz,
        public_outcome jsonb,
        payload_scrubbed_at timestamptz,
        expires_at timestamptz NOT NULL
      )
    `);
    // Additive rolling migration from the confirmation-only table. Legacy rows have no deployment
    // binding and therefore fail closed when consumed by the new service.
    await this.#pool.query(`
      ALTER TABLE assistant_pending_tool_calls
        ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'confirmation',
        ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending',
        ADD COLUMN IF NOT EXISTS deployment_id text NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS message text,
        ADD COLUMN IF NOT EXISTS requested_schema jsonb,
        ADD COLUMN IF NOT EXISTS continuation jsonb,
        ADD COLUMN IF NOT EXISTS review jsonb,
        ADD COLUMN IF NOT EXISTS invocation_context jsonb,
        ADD COLUMN IF NOT EXISTS created_at timestamptz,
        ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
        ADD COLUMN IF NOT EXISTS completed_at timestamptz,
        ADD COLUMN IF NOT EXISTS public_outcome jsonb,
        ADD COLUMN IF NOT EXISTS payload_scrubbed_at timestamptz
    `);
    await this.#pool.query(`
      UPDATE assistant_pending_tool_calls
      SET created_at=expires_at - interval '10 minutes'
      WHERE created_at IS NULL
    `);
    await this.#pool.query(`
      ALTER TABLE assistant_pending_tool_calls
        ALTER COLUMN created_at SET NOT NULL,
        ALTER COLUMN arguments DROP NOT NULL
    `);
    // Confirmations used to live in an UNLOGGED scratch table. Outcomes and executing/unknown states
    // must survive database restart and participate in replication, so migrate the relation in place.
    await this.#pool.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_class
          WHERE oid='assistant_pending_tool_calls'::regclass AND relpersistence='u'
        ) THEN
          ALTER TABLE assistant_pending_tool_calls SET LOGGED;
        END IF;
      END $$
    `);
    await this.#pool.query(`
      CREATE INDEX IF NOT EXISTS assistant_interactions_session_status_idx
        ON assistant_pending_tool_calls (session_id, status, expires_at)
    `);
  }

  async create(
    input: Extract<AssistantInteractionCreateInput, { readonly kind: 'confirmation' }>,
  ): Promise<AssistantPendingConfirmationInteractionRecord>;
  async create(
    input: Extract<AssistantInteractionCreateInput, { readonly kind: 'input' }>,
  ): Promise<AssistantPendingInputInteractionRecord>;
  async create(
    input: AssistantInteractionCreateInput,
  ): Promise<
    AssistantPendingConfirmationInteractionRecord | AssistantPendingInputInteractionRecord
  > {
    const id = `interaction_${randomUUID()}`;
    const interaction =
      input.kind === 'confirmation'
        ? createPendingInteraction(id, input)
        : createPendingInteraction(id, input);
    await this.#transaction(async (client) => {
      // Serialize proposals for one session across service instances so the cap cannot race.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        interaction.sessionId,
      ]);
      await reserveAssistantInteractionPendingSlot(
        client,
        interaction.sessionId,
        interaction.createdAt,
      );
      await insertAssistantPendingInteraction(client, interaction);
    });
    return interaction;
  }

  async claim(input: AssistantInteractionScope): Promise<AssistantInteractionClaimResult> {
    return this.#claim(input);
  }

  async complete(
    input: AssistantInteractionScope & { readonly completion: AssistantInteractionCompletion },
  ): Promise<AssistantInteractionCompletionResult> {
    return this.#transaction(async (client) => {
      const current = await this.#lockedInteraction(client, input);
      if (!current) return { disposition: 'unavailable' };
      if (isPrunableInteraction(current, input.now)) {
        await client.query(`DELETE FROM assistant_pending_tool_calls WHERE id=$1`, [current.id]);
        return { disposition: 'unavailable' };
      }
      if (isTerminalInteraction(current)) {
        return { disposition: 'replay', interaction: current };
      }
      const mayCompleteExecution =
        current.status === 'executing' &&
        (input.completion.status === 'succeeded' || input.completion.status === 'failed');
      const mayResolvePending =
        current.status === 'pending' &&
        (input.completion.status === 'declined' || input.completion.status === 'cancelled');
      if (!mayCompleteExecution && !mayResolvePending) {
        return { disposition: 'conflict', interaction: current };
      }
      const completed = completedInteraction(current, input.completion, input.now);
      const result = await client.query<AssistantInteractionRow>(
        `UPDATE assistant_pending_tool_calls
         SET status=$2, arguments=NULL, continuation=NULL, review=NULL,
             invocation_context=NULL, completed_at=$3, public_outcome=$4::jsonb,
             payload_scrubbed_at=$3
         WHERE id=$1 RETURNING *`,
        [
          completed.id,
          completed.status,
          completed.completedAt,
          JSON.stringify(completed.publicOutcome),
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('assistant interaction disappeared during completion');
      return { disposition: 'completed', interaction: interactionFromRow(row) };
    });
  }

  async transition(
    input: AssistantInteractionTransitionInput,
  ): Promise<AssistantInteractionTransitionResult> {
    return this.#transaction(async (client) => {
      // Use the same session lock as proposal creation so the pending cap remains race-free.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        input.sessionId,
      ]);
      const current = await this.#lockedInteraction(client, input);
      if (!current) return { disposition: 'unavailable' };
      if (isPrunableInteraction(current, input.now)) {
        await client.query(`DELETE FROM assistant_pending_tool_calls WHERE id=$1`, [current.id]);
        return { disposition: 'unavailable' };
      }
      if (isTerminalInteraction(current)) {
        return { disposition: 'replay', interaction: current };
      }
      if (current.status !== 'executing') {
        return { disposition: 'conflict', interaction: current };
      }
      const transitioned = transitionedInteractions(current, input, `interaction_${randomUUID()}`);
      await reserveAssistantInteractionPendingSlot(
        client,
        current.sessionId,
        input.now.toISOString(),
      );
      await insertAssistantPendingInteraction(client, transitioned.next);
      const result = await client.query<AssistantInteractionRow>(
        `UPDATE assistant_pending_tool_calls
         SET status='succeeded', arguments=NULL, continuation=NULL, review=NULL,
             invocation_context=NULL, completed_at=$2, public_outcome=$3::jsonb,
             payload_scrubbed_at=$2
         WHERE id=$1 RETURNING *`,
        [
          transitioned.interaction.id,
          transitioned.interaction.completedAt,
          JSON.stringify(transitioned.interaction.publicOutcome),
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('assistant interaction disappeared during transition');
      const persisted = interactionFromRow(row);
      if (persisted.status !== 'succeeded') {
        throw new Error('assistant interaction transition did not persist succeeded status');
      }
      return { disposition: 'transitioned', interaction: persisted, next: transitioned.next };
    });
  }

  async get(input: AssistantInteractionScope): Promise<AssistantInteractionRecord | undefined> {
    await this.prune(input.now);
    const result = await this.#pool.query<AssistantInteractionRow>(
      `SELECT * FROM assistant_pending_tool_calls
       WHERE id=$1 AND session_id=$2 AND deployment_id=$3`,
      [input.id, input.sessionId, input.deploymentId],
    );
    return result.rows[0] ? interactionFromRow(result.rows[0]) : undefined;
  }

  async findPending(input: {
    readonly sessionId: string;
    readonly deploymentId: string;
    readonly now: Date;
  }): Promise<AssistantPendingInteractionRecord | undefined> {
    const result = await this.#pool.query<AssistantInteractionRow>(
      `SELECT * FROM assistant_pending_tool_calls
       WHERE session_id = $1 AND deployment_id = $2 AND status = 'pending' AND expires_at > $3
       ORDER BY created_at DESC LIMIT 1`,
      [input.sessionId, input.deploymentId, input.now],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const interaction = interactionFromRow(row);
    return interaction.status === 'pending' ? interaction : undefined;
  }

  async consumeConfirmation(
    input: AssistantInteractionScope,
  ): Promise<
    (AssistantConfirmationInteractionRecord & { readonly status: 'executing' }) | undefined
  > {
    const result = await this.#claim(input, 'confirmation');
    return result.disposition === 'claimed' && result.interaction.kind === 'confirmation'
      ? result.interaction
      : undefined;
  }

  async prune(now: Date): Promise<void> {
    const completedAt = now.toISOString();
    await this.#pool.query(
      `UPDATE assistant_pending_tool_calls
       SET status='failed', arguments=NULL, continuation=NULL, review=NULL,
           invocation_context=NULL,
           completed_at=$1, public_outcome=$2::jsonb, payload_scrubbed_at=$1
       WHERE status='executing' AND claimed_at <= $3`,
      [
        completedAt,
        JSON.stringify(ASSISTANT_INTERACTION_UNKNOWN_OUTCOME),
        new Date(now.getTime() - ASSISTANT_INTERACTION_EXECUTION_LIMIT_MS).toISOString(),
      ],
    );
    await this.#pool.query(
      `DELETE FROM assistant_pending_tool_calls
       WHERE (status='pending' AND expires_at <= $1)
          OR (status IN ('succeeded','failed','declined','cancelled') AND completed_at <= $2)`,
      [
        now.toISOString(),
        new Date(now.getTime() - ASSISTANT_INTERACTION_OUTCOME_RETENTION_MS).toISOString(),
      ],
    );
  }

  async #claim(
    input: AssistantInteractionScope,
    expectedKind?: AssistantInteractionRecord['kind'],
  ): Promise<AssistantInteractionClaimResult> {
    return this.#transaction(async (client) => {
      const current = await this.#lockedInteraction(client, input, expectedKind);
      if (!current) return { disposition: 'unavailable' };
      if (isPrunableInteraction(current, input.now)) {
        await client.query(`DELETE FROM assistant_pending_tool_calls WHERE id=$1`, [current.id]);
        return { disposition: 'unavailable' };
      }
      if (current.status !== 'pending') {
        return { disposition: 'replay', interaction: current };
      }
      const claimed = executingInteraction(current, input.now);
      const result = await client.query<AssistantInteractionRow>(
        `UPDATE assistant_pending_tool_calls
         SET status='executing', claimed_at=$2, arguments=NULL, continuation=NULL, review=NULL, invocation_context=NULL, payload_scrubbed_at=$2
         WHERE id=$1 RETURNING *`,
        [claimed.id, claimed.claimedAt],
      );
      const row = result.rows[0];
      if (!row) throw new Error('assistant interaction disappeared during claim');
      const persisted = interactionFromRow(row);
      if (persisted.status !== 'executing') {
        throw new Error('assistant interaction claim did not persist executing status');
      }
      return { disposition: 'claimed', interaction: claimed };
    });
  }

  async #lockedInteraction(
    client: PoolClient,
    input: AssistantInteractionScope,
    expectedKind?: AssistantInteractionRecord['kind'],
  ): Promise<AssistantInteractionRecord | undefined> {
    const result = await client.query<AssistantInteractionRow>(
      `SELECT * FROM assistant_pending_tool_calls
       WHERE id=$1 AND session_id=$2 AND deployment_id=$3
         AND ($4::text IS NULL OR kind=$4)
       FOR UPDATE`,
      [input.id, input.sessionId, input.deploymentId, expectedKind ?? null],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const interaction = interactionFromRow(row);
    if (!shouldExpireStrandedExecutingInteraction(interaction, input.now)) return interaction;

    const expired = expireStrandedExecutingInteraction(interaction, input.now);
    const updated = await client.query<AssistantInteractionRow>(
      `UPDATE assistant_pending_tool_calls
       SET status='failed', arguments=NULL, continuation=NULL, review=NULL,
           invocation_context=NULL,
           completed_at=$2, public_outcome=$3::jsonb, payload_scrubbed_at=$2
       WHERE id=$1 RETURNING *`,
      [expired.id, expired.completedAt, JSON.stringify(expired.publicOutcome)],
    );
    const updatedRow = updated.rows[0];
    if (!updatedRow) throw new Error('assistant interaction disappeared during expiry');
    return interactionFromRow(updatedRow);
  }

  async #transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

interface AssistantInteractionRow {
  id: string;
  kind: 'confirmation' | 'input';
  status: AssistantInteractionRecord['status'];
  session_id: string;
  deployment_id: string;
  tool: string;
  arguments: unknown | null;
  message: string | null;
  requested_schema: Readonly<Record<string, unknown>> | null;
  continuation: unknown | null;
  review: unknown | null;
  invocation_context: AssistantInteractionRecord['context'] | null;
  created_at: Date;
  claimed_at: Date | null;
  completed_at: Date | null;
  public_outcome: AssistantInteractionPublicOutcome | null;
  payload_scrubbed_at: Date | null;
  expires_at: Date;
}

function interactionFromRow(row: AssistantInteractionRow): AssistantInteractionRecord {
  const common = {
    id: row.id,
    sessionId: row.session_id,
    deploymentId: row.deployment_id,
    ...(row.invocation_context ? { context: row.invocation_context } : {}),
    ...(row.payload_scrubbed_at
      ? { payloadScrubbedAt: row.payload_scrubbed_at.toISOString() }
      : {}),
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  };
  const payload =
    row.kind === 'confirmation'
      ? {
          kind: 'confirmation' as const,
          tool: row.tool,
          arguments: row.arguments,
          ...(row.continuation !== null ? { continuation: row.continuation } : {}),
          ...(row.review !== null ? { review: row.review } : {}),
        }
      : {
          kind: 'input' as const,
          tool: row.tool,
          message: requiredRowValue(row.message, 'message'),
          requestedSchema: requiredRowValue(row.requested_schema, 'requested_schema'),
          continuation: row.continuation,
        };
  if (row.status === 'pending') return { ...common, ...payload, status: 'pending' };
  const claimedAt = row.claimed_at?.toISOString();
  if (row.status === 'executing') {
    return {
      ...common,
      ...payload,
      status: 'executing',
      claimedAt: requiredRowValue(claimedAt, 'claimed_at'),
    };
  }
  const completedAt = requiredRowValue(row.completed_at?.toISOString(), 'completed_at');
  const publicOutcome = normalizePublicOutcome(
    requiredRowValue(row.public_outcome, 'public_outcome'),
  );
  if (row.status === 'succeeded' || row.status === 'failed') {
    return {
      ...common,
      ...payload,
      status: row.status,
      claimedAt: requiredRowValue(claimedAt, 'claimed_at'),
      completedAt,
      publicOutcome,
    };
  }
  if (row.status === 'declined' || row.status === 'cancelled') {
    return { ...common, ...payload, status: row.status, completedAt, publicOutcome };
  }
  throw new Error('invalid assistant interaction status in persistence');
}

function requiredRowValue<T>(value: T | null | undefined, field: string): T {
  if (value === null || value === undefined) {
    throw new Error(`assistant interaction row is missing ${field}`);
  }
  return value;
}
