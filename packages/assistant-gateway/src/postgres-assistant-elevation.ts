import { createHash, randomBytes } from 'node:crypto';
import { insertAuditEvent } from '@noodle-borg/module-audit';
import { adoptCallerState } from '@noodle-borg/runtime/postgres';
import type { Pool, PoolClient } from 'pg';
import type {
  AssistantElevationCoordinator,
  ElevationRequest,
  ElevationResult,
} from './elevation.js';
import { elevationDigest } from './elevation-store.js';
import { type AssistantSessionRow, sessionFromRow } from './postgres-assistant.js';

interface ElevationRow {
  readonly id: string;
  readonly session_id: string;
  readonly org_slug: string;
  readonly app_slug: string;
  readonly environment: string;
  readonly tool: string;
  readonly claimable_state_handles: unknown;
  readonly expires_at: Date;
  readonly claimed_at: Date | null;
}

/** Hosted atomic implementation. In-memory stores remain local/test-only and use the portable fallback. */
export class PostgresAssistantElevationCoordinator implements AssistantElevationCoordinator {
  readonly #pool: Pool;
  readonly #now: () => Date;

  constructor(pool: Pool, options: { readonly now?: () => Date } = {}) {
    this.#pool = pool;
    this.#now = options.now ?? (() => new Date());
  }

  async complete(request: ElevationRequest): Promise<ElevationResult> {
    const now = this.#now();
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const ticket = await this.#ticket(client, request.continuation);
      if (!ticket || ticket.claimed_at !== null) {
        return rollback(client, { ok: false, status: 403, code: 'elevation_ticket_invalid' });
      }
      if (
        ticket.org_slug !== request.tenant.org ||
        ticket.app_slug !== request.tenant.app ||
        ticket.environment !== request.tenant.env
      ) {
        return rollback(client, { ok: false, status: 403, code: 'elevation_tenant_mismatch' });
      }
      if (ticket.expires_at.getTime() <= now.getTime()) {
        return rollback(client, { ok: false, status: 403, code: 'elevation_ticket_expired' });
      }

      const current = await client.query<AssistantSessionRow>(
        `SELECT * FROM assistant_sessions WHERE id = $1 FOR UPDATE`,
        [ticket.session_id],
      );
      const session = current.rows[0];
      if (
        !session ||
        session.expires_at.getTime() <= now.getTime() ||
        session.absolute_expires_at.getTime() <= now.getTime()
      ) {
        return consumeAndCommitRefusal(client, ticket.id, now, {
          ok: false,
          status: 409,
          code: 'elevation_session_unavailable',
        });
      }
      if (session.caller.identityKind !== 'anonymous') {
        return consumeAndCommitRefusal(client, ticket.id, now, {
          ok: false,
          status: 409,
          code: 'elevation_already_signed_in',
        });
      }

      const handles = claimableHandles(ticket.claimable_state_handles);
      const adopted = await adoptCallerState(client, {
        deploymentId: session.deployment_id,
        handles,
        sourceCallerSubject: session.caller.subject,
        targetCallerSubject: request.caller.subject,
        redirectExpiresAt: session.absolute_expires_at,
        now,
      });
      if (!adopted.ok) {
        return consumeAndCommitRefusal(client, ticket.id, now, {
          ok: false,
          status: 409,
          code: 'elevation_state_conflict',
        });
      }

      const pending = await client.query(
        `SELECT 1 FROM assistant_pending_tool_calls
         WHERE session_id = $1 AND deployment_id = $2 AND status = 'pending' AND expires_at > $3
         LIMIT 1`,
        [session.id, session.deployment_id, now],
      );
      const resumeArmed = request.resume === true && (pending.rowCount ?? 0) === 0;
      const token = `nss_${randomBytes(24).toString('base64url')}`;
      const updated = await client.query<AssistantSessionRow>(
        `UPDATE assistant_sessions
         SET token_hash = $2, caller = $3::jsonb, client_id = $4, origin = $5,
             customer_routing = COALESCE($6::jsonb, customer_routing),
             pending_resume = $7::jsonb, latest_suggestions = NULL,
             bound_surface = COALESCE($8, bound_surface)
         WHERE id = $1 AND caller->>'identityKind' = 'anonymous'
         RETURNING *`,
        [
          session.id,
          createHash('sha256').update(token).digest('hex'),
          JSON.stringify(request.caller),
          request.clientId,
          request.origin,
          request.customerRouting ? JSON.stringify(request.customerRouting) : null,
          resumeArmed
            ? JSON.stringify({ tool: ticket.tool, requestedAt: now.toISOString() })
            : null,
          request.boundSurface ?? null,
        ],
      );
      const elevated = updated.rows[0];
      if (!elevated) {
        return rollback(client, {
          ok: false,
          status: 409,
          code: 'elevation_already_signed_in',
        });
      }
      await client.query(
        `UPDATE assistant_elevations SET claimed_at = $2 WHERE id = $1 AND claimed_at IS NULL`,
        [ticket.id, now],
      );
      if (handles.length > 0) {
        await insertAuditEvent(
          client,
          {
            eventType: 'assistant.state.claimed',
            org: request.tenant.org,
            app: request.tenant.app,
            env: request.tenant.env,
            deploymentId: session.deployment_id,
            actorSubject: request.caller.subject,
            decision: 'allow',
            details: {
              sessionId: session.id,
              ticketId: ticket.id,
              handleCount: adopted.adoptedHandles.length,
              recordCount: adopted.adoptedRecords,
            },
          },
          { now: () => now },
        );
      }
      await client.query('COMMIT');
      return {
        ok: true,
        session: sessionFromRow(elevated),
        token,
        tool: ticket.tool,
        resumeArmed,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async #ticket(client: PoolClient, continuation: string): Promise<ElevationRow | undefined> {
    const result = await client.query<ElevationRow>(
      `SELECT * FROM assistant_elevations WHERE continuation_hash = $1 FOR UPDATE`,
      [elevationDigest(continuation)],
    );
    return result.rows[0];
  }
}

function claimableHandles(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string'))].sort();
}

async function rollback<T extends ElevationResult>(client: PoolClient, result: T): Promise<T> {
  await client.query('ROLLBACK');
  return result;
}

/** A valid ticket is single-use even when the authenticated transition is refused deterministically. */
async function consumeAndCommitRefusal<T extends ElevationResult>(
  client: PoolClient,
  ticketId: string,
  now: Date,
  result: T,
): Promise<T> {
  await client.query(
    `UPDATE assistant_elevations SET claimed_at = $2 WHERE id = $1 AND claimed_at IS NULL`,
    [ticketId, now],
  );
  await client.query('COMMIT');
  return result;
}
