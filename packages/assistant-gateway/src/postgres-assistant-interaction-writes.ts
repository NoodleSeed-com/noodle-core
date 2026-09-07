import { ADMISSION_DEFAULTS } from '@noodle-borg/admission-limits/portable';
import type { PoolClient } from 'pg';
import {
  AssistantInteractionCapacityError,
  type AssistantPendingInteractionRecord,
  DEFAULT_MAX_PENDING_INTERACTIONS_PER_SESSION,
} from './assistant-interaction-state.js';

/** Caller must hold the session advisory transaction lock before reserving a pending slot. */
export async function reserveAssistantInteractionPendingSlot(
  client: PoolClient,
  sessionId: string,
  now: string,
): Promise<void> {
  await client.query(
    `DELETE FROM assistant_pending_tool_calls
     WHERE session_id=$1 AND status='pending' AND expires_at <= $2`,
    [sessionId, now],
  );
  const count = await client.query<{ pending_count: number }>(
    `SELECT COUNT(*)::int AS pending_count
     FROM assistant_pending_tool_calls
     WHERE session_id=$1 AND status='pending' AND expires_at > $2`,
    [sessionId, now],
  );
  // An anonymous visitor gets the public envelope's bound; a signed-in embed keeps the wider default.
  // The two audiences genuinely differ: a stranger holding several half-finished confirmations is a
  // way to accumulate state on a surface nobody is accountable for, which the envelope has always said
  // is one — it simply had nothing reading it.
  const owner = await client.query<{ public_embed_id: string | null }>(
    'SELECT public_embed_id FROM assistant_sessions WHERE id = $1',
    [sessionId],
  );
  const limit =
    owner.rows[0]?.public_embed_id === null || owner.rows[0]?.public_embed_id === undefined
      ? DEFAULT_MAX_PENDING_INTERACTIONS_PER_SESSION
      : ADMISSION_DEFAULTS.pendingInteractions;
  if ((count.rows[0]?.pending_count ?? 0) >= limit) {
    throw new AssistantInteractionCapacityError();
  }
}

export async function insertAssistantPendingInteraction(
  client: PoolClient,
  interaction: AssistantPendingInteractionRecord,
): Promise<void> {
  await client.query(
    `INSERT INTO assistant_pending_tool_calls
      (id, kind, status, session_id, deployment_id, tool, arguments, message,
       requested_schema, continuation, review, invocation_context, created_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14)`,
    [
      interaction.id,
      interaction.kind,
      interaction.status,
      interaction.sessionId,
      interaction.deploymentId,
      interaction.tool,
      interaction.kind === 'confirmation' ? JSON.stringify(interaction.arguments) : null,
      interaction.kind === 'input' ? interaction.message : null,
      interaction.kind === 'input' ? JSON.stringify(interaction.requestedSchema) : null,
      interaction.continuation !== undefined ? JSON.stringify(interaction.continuation) : null,
      interaction.kind === 'confirmation' && interaction.review !== undefined
        ? JSON.stringify(interaction.review)
        : null,
      interaction.context ? JSON.stringify(interaction.context) : null,
      interaction.createdAt,
      interaction.expiresAt,
    ],
  );
}
