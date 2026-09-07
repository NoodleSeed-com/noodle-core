import type { Pool } from 'pg';
import type {
  AssistantConfirmationInteractionRecord,
  AssistantInteractionClaimResult,
  AssistantInteractionCompletion,
  AssistantInteractionCompletionResult,
  AssistantInteractionCreateInput,
  AssistantInteractionRecord,
  AssistantInteractionScope,
  AssistantInteractionTransitionInput,
  AssistantInteractionTransitionResult,
  AssistantPendingConfirmationInteractionRecord,
  AssistantPendingInputInteractionRecord,
  AssistantPendingInteractionRecord,
} from './assistant-interaction-state.js';
import type {
  AssistantClientRecord,
  AssistantHistoryMessage,
  AssistantInitialSuggestionsClaim,
  AssistantPendingResume,
  AssistantSessionRecord,
  AssistantStore,
  AssistantSuggestedPrompts,
  AssistantTurnConsumption,
} from './assistant-store.js';
import {
  ASSISTANT_HISTORY_MAX_MESSAGES,
  ASSISTANT_SESSION_IDLE_MS,
  type AssistantSessionElevation,
} from './assistant-store.js';
import type { AssistantRecoverableView } from './assistant-view-availability.js';
import { PostgresAssistantInteractions } from './postgres-assistant-interactions.js';
import type { TenantRef } from './tenant-ref.js';

/** Durable clients + shared, crash-disposable active sessions for multi-instance assistant gateways. */
export class PostgresAssistantStore implements AssistantStore {
  readonly #pool: Pool;
  readonly #interactions: PostgresAssistantInteractions;

  constructor(pool: Pool) {
    this.#pool = pool;
    this.#interactions = new PostgresAssistantInteractions(pool);
  }

  async ensureSchema(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS assistant_clients (
        id text PRIMARY KEY,
        name text NOT NULL,
        org_slug text NOT NULL,
        app_slug text NOT NULL,
        environment text NOT NULL,
        deployment_id text NOT NULL,
        allowed_origins jsonb NOT NULL,
        secret_hash text NOT NULL,
        created_at timestamptz NOT NULL,
        revoked_at timestamptz
      )
    `);
    await this.#pool.query(`
      CREATE INDEX IF NOT EXISTS assistant_clients_tenant_idx
        ON assistant_clients (org_slug, app_slug, environment)
    `);
    await this.#pool.query(`
      CREATE UNLOGGED TABLE IF NOT EXISTS assistant_sessions (
        id text PRIMARY KEY,
        token_hash text UNIQUE NOT NULL,
        client_id text NOT NULL,
        org_slug text NOT NULL,
        app_slug text NOT NULL,
        environment text NOT NULL,
        deployment_id text NOT NULL,
        model_source text,
        origin text NOT NULL,
        caller jsonb NOT NULL,
        customer_routing jsonb,
        context jsonb,
        preferences jsonb,
        appearance jsonb,
        history jsonb NOT NULL DEFAULT '[]'::jsonb,
        model_tool_uses jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        absolute_expires_at timestamptz NOT NULL
      )
    `);
    await this.#interactions.ensureSchema();
    await this.#pool.query(`
      ALTER TABLE assistant_sessions
        ADD COLUMN IF NOT EXISTS preferences jsonb
    `);
    await this.#pool.query(`
      ALTER TABLE assistant_sessions
        ADD COLUMN IF NOT EXISTS customer_routing jsonb
    `);
    await this.#pool.query(`
      ALTER TABLE assistant_sessions
        ADD COLUMN IF NOT EXISTS public_embed_id text
    `);
    await this.#pool.query(`
      ALTER TABLE assistant_sessions
        ADD COLUMN IF NOT EXISTS turn_count bigint NOT NULL DEFAULT 0
    `);
    await this.#pool.query(`
      ALTER TABLE assistant_sessions
        ADD COLUMN IF NOT EXISTS pending_resume jsonb
    `);
    await this.#pool.query(`
      ALTER TABLE assistant_sessions
        ADD COLUMN IF NOT EXISTS model_source text
    `);
    await this.#pool.query(`
      ALTER TABLE assistant_sessions
        ADD COLUMN IF NOT EXISTS model_tool_uses jsonb NOT NULL DEFAULT '[]'::jsonb
    `);
    await this.#pool.query(`
      ALTER TABLE assistant_sessions
        ADD COLUMN IF NOT EXISTS bound_surface text
    `);
    await this.#pool.query(`
      ALTER TABLE assistant_sessions
        ADD COLUMN IF NOT EXISTS initial_suggestions jsonb
    `);
    await this.#pool.query(`
      ALTER TABLE assistant_sessions
        ADD COLUMN IF NOT EXISTS latest_suggestions jsonb
    `);
    await this.#pool.query(`
      ALTER TABLE assistant_sessions
        ADD COLUMN IF NOT EXISTS latest_view jsonb
    `);
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS console_approval_nonces (
        nonce text PRIMARY KEY,
        subject text NOT NULL,
        expires_at timestamptz NOT NULL,
        consumed_at timestamptz NOT NULL
      )
    `);
  }

  async createClient(input: {
    readonly name: string;
    readonly tenant: TenantRef;
    readonly deploymentId: string;
    readonly allowedOrigins: readonly string[];
    readonly now: Date;
  }): Promise<{ readonly client: AssistantClientRecord; readonly secret: string }> {
    const { createHash, randomBytes, randomUUID } = await import('node:crypto');
    const id = `embed_${randomUUID()}`;
    const secret = `nsa_${randomBytes(32).toString('base64url')}`;
    const secretHash = createHash('sha256').update(secret).digest('hex');
    const client: AssistantClientRecord = {
      id,
      name: input.name,
      tenant: { ...input.tenant },
      deploymentId: input.deploymentId,
      allowedOrigins: [...input.allowedOrigins],
      secretHash,
      createdAt: input.now.toISOString(),
    };
    await this.#pool.query(
      `INSERT INTO assistant_clients
        (id, name, org_slug, app_slug, environment, deployment_id, allowed_origins,
         secret_hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
      [
        id,
        input.name,
        input.tenant.org,
        input.tenant.app,
        input.tenant.env,
        input.deploymentId,
        JSON.stringify(input.allowedOrigins),
        secretHash,
        client.createdAt,
      ],
    );
    return { client, secret };
  }

  async listClients(tenant: TenantRef): Promise<readonly AssistantClientRecord[]> {
    const result = await this.#pool.query<AssistantClientRow>(
      `SELECT * FROM assistant_clients
       WHERE org_slug=$1 AND app_slug=$2 AND environment=$3 ORDER BY created_at`,
      [tenant.org, tenant.app, tenant.env],
    );
    return result.rows.map(clientFromRow);
  }

  async rotateClient(
    id: string,
    now: Date,
  ): Promise<{ readonly client: AssistantClientRecord; readonly secret: string } | undefined> {
    const { createHash, randomBytes } = await import('node:crypto');
    const secret = `nsa_${randomBytes(32).toString('base64url')}`;
    const secretHash = createHash('sha256').update(secret).digest('hex');
    const result = await this.#pool.query<AssistantClientRow>(
      `UPDATE assistant_clients SET secret_hash=$2, created_at=$3
       WHERE id=$1 AND revoked_at IS NULL RETURNING *`,
      [id, secretHash, now.toISOString()],
    );
    const row = result.rows[0];
    return row ? { client: clientFromRow(row), secret } : undefined;
  }

  async revokeClient(id: string, now: Date): Promise<boolean> {
    const result = await this.#pool.query(
      `UPDATE assistant_clients SET revoked_at=$2 WHERE id=$1 AND revoked_at IS NULL`,
      [id, now.toISOString()],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async authenticateClient(id: string, secret: string): Promise<AssistantClientRecord | undefined> {
    const { createHash, timingSafeEqual } = await import('node:crypto');
    const result = await this.#pool.query<AssistantClientRow>(
      `SELECT * FROM assistant_clients WHERE id=$1 AND revoked_at IS NULL`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const actual = Buffer.from(createHash('sha256').update(secret).digest('hex'), 'hex');
    const expected = Buffer.from(row.secret_hash, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected)
      ? clientFromRow(row)
      : undefined;
  }

  async createSession(
    input: Omit<
      AssistantSessionRecord,
      'id' | 'tokenHash' | 'history' | 'modelToolUses' | 'turnCount'
    >,
  ): Promise<{ readonly session: AssistantSessionRecord; readonly token: string }> {
    const { createHash, randomBytes, randomUUID } = await import('node:crypto');
    const id = `session_${randomUUID()}`;
    const token = `nss_${randomBytes(32).toString('base64url')}`;
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const session: AssistantSessionRecord = {
      ...input,
      id,
      tokenHash,
      history: [],
      modelToolUses: [],
      turnCount: 0,
    };
    await this.#pool.query(
      `INSERT INTO assistant_sessions
        (id, token_hash, client_id, org_slug, app_slug, environment, deployment_id, model_source, origin,
         caller, customer_routing, context, preferences, appearance, history, model_tool_uses, created_at, expires_at,
         absolute_expires_at, public_embed_id, turn_count, bound_surface)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,
         '[]'::jsonb,'[]'::jsonb,$15,$16,$17,$18,0,$19)`,
      [
        id,
        tokenHash,
        input.clientId,
        input.tenant.org,
        input.tenant.app,
        input.tenant.env,
        input.deploymentId,
        input.modelSource ?? null,
        input.origin,
        JSON.stringify(input.caller),
        input.customerRouting ? JSON.stringify(input.customerRouting) : null,
        input.context ? JSON.stringify(input.context) : null,
        input.preferences ? JSON.stringify(input.preferences) : null,
        input.configuration ? JSON.stringify(input.configuration) : null,
        input.createdAt,
        input.expiresAt,
        input.absoluteExpiresAt,
        input.publicEmbedId ?? null,
        input.boundSurface ?? null,
      ],
    );
    return { session, token };
  }

  /**
   * One statement, so the check and the spend share a single row lock: concurrent turns arriving at the
   * last slot cannot both be admitted. `RETURNING` gives the caller its own slot number, and the
   * `COALESCE` read covers the two refusals — the session is spent, or it does not exist — without a
   * second round trip that could observe a different state.
   */
  async consumeTurn(id: string, limit: number): Promise<AssistantTurnConsumption> {
    const spent = await this.#pool.query<{ turn_count: string }>(
      `UPDATE assistant_sessions SET turn_count = turn_count + 1
       WHERE id = $1 AND turn_count < $2::bigint
       RETURNING turn_count`,
      [id, limit],
    );
    const admitted = spent.rows[0];
    if (admitted) return { allowed: true, turnCount: Number(admitted.turn_count) };
    const current = await this.#pool.query<{ turn_count: string }>(
      `SELECT turn_count FROM assistant_sessions WHERE id = $1`,
      [id],
    );
    return { allowed: false, turnCount: Number(current.rows[0]?.turn_count ?? 0) };
  }

  async claimInitialSuggestions(id: string): Promise<AssistantInitialSuggestionsClaim> {
    const claimed = await this.#pool.query(
      `UPDATE assistant_sessions
       SET initial_suggestions = '{"status":"generating"}'::jsonb
       WHERE id = $1 AND initial_suggestions IS NULL
       RETURNING id`,
      [id],
    );
    if ((claimed.rowCount ?? 0) === 1) return { disposition: 'generate' };
    const current = await this.#pool.query<{
      initial_suggestions: AssistantSessionRecord['initialSuggestions'] | null;
    }>('SELECT initial_suggestions FROM assistant_sessions WHERE id = $1', [id]);
    const state = current.rows[0]?.initial_suggestions;
    return state?.status === 'ready'
      ? { disposition: 'ready', prompts: [...state.prompts] }
      : { disposition: 'unavailable' };
  }

  async completeInitialSuggestions(id: string, prompts: readonly string[]): Promise<boolean> {
    const completed = await this.#pool.query(
      `UPDATE assistant_sessions
       SET initial_suggestions = $2::jsonb
       WHERE id = $1 AND initial_suggestions->>'status' = 'generating'
       RETURNING id`,
      [id, JSON.stringify({ status: 'ready', prompts })],
    );
    return (completed.rowCount ?? 0) === 1;
  }

  async failInitialSuggestions(id: string): Promise<boolean> {
    const failed = await this.#pool.query(
      `UPDATE assistant_sessions
       SET initial_suggestions = '{"status":"failed"}'::jsonb
       WHERE id = $1 AND initial_suggestions->>'status' = 'generating'
       RETURNING id`,
      [id],
    );
    return (failed.rowCount ?? 0) === 1;
  }

  async replaceLatestSuggestions(
    id: string,
    suggestions: AssistantSuggestedPrompts | undefined,
  ): Promise<boolean> {
    const replaced = await this.#pool.query(
      `UPDATE assistant_sessions SET latest_suggestions = $2::jsonb WHERE id = $1 RETURNING id`,
      [id, suggestions === undefined ? null : JSON.stringify(suggestions)],
    );
    return (replaced.rowCount ?? 0) === 1;
  }

  async replaceLatestView(
    id: string,
    view: AssistantRecoverableView | undefined,
  ): Promise<boolean> {
    const replaced = await this.#pool.query(
      `UPDATE assistant_sessions SET latest_view = $2::jsonb WHERE id = $1 RETURNING id`,
      [id, view === undefined ? null : JSON.stringify(view)],
    );
    return (replaced.rowCount ?? 0) === 1;
  }

  async claimModelToolUse(id: string, tool: string): Promise<boolean> {
    const claimed = await this.#pool.query(
      `UPDATE assistant_sessions
       SET model_tool_uses = model_tool_uses || to_jsonb($2::text)
       WHERE id = $1 AND NOT model_tool_uses ? $2
       RETURNING id`,
      [id, tool],
    );
    return (claimed.rowCount ?? 0) === 1;
  }

  async releaseModelToolUse(id: string, tool: string): Promise<boolean> {
    const released = await this.#pool.query(
      `UPDATE assistant_sessions
       SET model_tool_uses = COALESCE(
         (SELECT jsonb_agg(value) FROM jsonb_array_elements(model_tool_uses) AS entry(value)
          WHERE value <> to_jsonb($2::text)),
         '[]'::jsonb
       )
       WHERE id = $1 AND model_tool_uses ? $2
       RETURNING id`,
      [id, tool],
    );
    return (released.rowCount ?? 0) === 1;
  }

  /**
   * One statement: two requests racing the same arm must not both see the pending resume. The
   * armed CTE locks and carries the OLD value — a plain `RETURNING pending_resume` reflects the
   * post-update NULL, not what was consumed.
   */
  async consumePendingResume(sessionId: string): Promise<AssistantPendingResume | undefined> {
    const consumed = await this.#pool.query<{ pending_resume: AssistantPendingResume }>(
      `WITH armed AS (
         SELECT id, pending_resume FROM assistant_sessions
         WHERE id = $1 AND pending_resume IS NOT NULL
         FOR UPDATE
       )
       UPDATE assistant_sessions AS sessions SET pending_resume = NULL
       FROM armed WHERE sessions.id = armed.id
       RETURNING armed.pending_resume`,
      [sessionId],
    );
    return consumed.rows[0]?.pending_resume;
  }

  /**
   * One statement, for the same reason `consumeTurn` is one: the anonymous token must not outlive the
   * elevation by even a moment. `WHERE caller->>'identityKind' = 'anonymous'` is what refuses a second
   * elevation — the guard is the update's own predicate, so there is no separate check to forget.
   */
  async elevateSession(input: {
    readonly sessionId: string;
    readonly caller: AssistantSessionRecord['caller'];
    readonly clientId: string;
    readonly origin: string;
    readonly customerRouting?: AssistantSessionRecord['customerRouting'];
    readonly boundSurface?: AssistantSessionRecord['boundSurface'];
    readonly pendingResume?: AssistantPendingResume;
    readonly now: Date;
  }): Promise<AssistantSessionElevation> {
    const { createHash, randomBytes } = await import('node:crypto');
    const token = `nss_${randomBytes(24).toString('base64url')}`;
    // client_id, origin, routing, and the surface binding rebind in the same statement: the issuer
    // basis (ADR 0152), the CORS pin, and the landing surface's projection must never lag the caller
    // they now describe. COALESCE keeps "absent means unchanged" for routing and the binding —
    // omission is not a decision.
    const elevated = await this.#pool.query<AssistantSessionRow>(
      `UPDATE assistant_sessions
          SET token_hash = $2, caller = $3::jsonb, client_id = $4, origin = $5,
              customer_routing = COALESCE($6::jsonb, customer_routing),
              pending_resume = $7::jsonb, latest_suggestions = NULL,
              bound_surface = COALESCE($8, bound_surface)
        WHERE id = $1 AND caller->>'identityKind' = 'anonymous'
        RETURNING *`,
      [
        input.sessionId,
        createHash('sha256').update(token).digest('hex'),
        JSON.stringify(input.caller),
        input.clientId,
        input.origin,
        input.customerRouting ? JSON.stringify(input.customerRouting) : null,
        input.pendingResume ? JSON.stringify(input.pendingResume) : null,
        input.boundSurface ?? null,
      ],
    );
    const row = elevated.rows[0];
    if (row) return { ok: true, session: sessionFromRow(row), token };
    const existing = await this.#pool.query<{ id: string }>(
      'SELECT id FROM assistant_sessions WHERE id = $1',
      [input.sessionId],
    );
    return existing.rows[0]
      ? { ok: false, reason: 'already_elevated' }
      : { ok: false, reason: 'unknown_session' };
  }

  async getSession(token: string, now: Date): Promise<AssistantSessionRecord | undefined> {
    const { createHash } = await import('node:crypto');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await this.#prune(now);
    const result = await this.#pool.query<AssistantSessionRow>(
      `UPDATE assistant_sessions
       SET expires_at=LEAST(absolute_expires_at, $3)
       WHERE token_hash=$1 AND expires_at>$2 AND absolute_expires_at>$2
       RETURNING *`,
      [
        tokenHash,
        now.toISOString(),
        new Date(now.getTime() + ASSISTANT_SESSION_IDLE_MS).toISOString(),
      ],
    );
    return result.rows[0] ? sessionFromRow(result.rows[0]) : undefined;
  }

  async appendHistory(id: string, messages: readonly AssistantHistoryMessage[]): Promise<void> {
    await this.#pool.query(
      `UPDATE assistant_sessions
       SET history=(SELECT COALESCE(jsonb_agg(value ORDER BY n), '[]'::jsonb)
                    FROM (SELECT value, n FROM jsonb_array_elements(history || $2::jsonb)
                          WITH ORDINALITY AS e(value, n) ORDER BY n DESC LIMIT ${ASSISTANT_HISTORY_MAX_MESSAGES}) recent)
       WHERE id=$1`,
      [id, JSON.stringify(messages)],
    );
  }

  async createInteraction(
    input: Extract<AssistantInteractionCreateInput, { readonly kind: 'confirmation' }>,
  ): Promise<AssistantPendingConfirmationInteractionRecord>;
  async createInteraction(
    input: Extract<AssistantInteractionCreateInput, { readonly kind: 'input' }>,
  ): Promise<AssistantPendingInputInteractionRecord>;
  async createInteraction(
    input: AssistantInteractionCreateInput,
  ): Promise<
    AssistantPendingConfirmationInteractionRecord | AssistantPendingInputInteractionRecord
  > {
    return input.kind === 'confirmation'
      ? this.#interactions.create(input)
      : this.#interactions.create(input);
  }

  async claimInteraction(
    input: AssistantInteractionScope,
  ): Promise<AssistantInteractionClaimResult> {
    return this.#interactions.claim(input);
  }

  async completeInteraction(
    input: AssistantInteractionScope & { readonly completion: AssistantInteractionCompletion },
  ): Promise<AssistantInteractionCompletionResult> {
    return this.#interactions.complete(input);
  }

  async transitionInteraction(
    input: AssistantInteractionTransitionInput,
  ): Promise<AssistantInteractionTransitionResult> {
    return this.#interactions.transition(input);
  }

  async getInteraction(
    input: AssistantInteractionScope,
  ): Promise<AssistantInteractionRecord | undefined> {
    return this.#interactions.get(input);
  }

  async findPendingInteraction(input: {
    readonly sessionId: string;
    readonly deploymentId: string;
    readonly now: Date;
  }): Promise<AssistantPendingInteractionRecord | undefined> {
    return this.#interactions.findPending(input);
  }

  async consumeInteraction(
    id: string,
    sessionId: string,
    deploymentId: string,
    now: Date,
  ): Promise<
    (AssistantConfirmationInteractionRecord & { readonly status: 'executing' }) | undefined
  > {
    return this.#interactions.consumeConfirmation({ id, sessionId, deploymentId, now });
  }

  async consumeConsoleApprovalNonce(
    nonce: string,
    subject: string,
    expiresAt: Date,
    now: Date,
  ): Promise<boolean> {
    if (expiresAt.getTime() <= now.getTime()) return false;
    const result = await this.#pool.query(
      `INSERT INTO console_approval_nonces (nonce, subject, expires_at, consumed_at)
       VALUES ($1,$2,$3,$4) ON CONFLICT (nonce) DO NOTHING RETURNING nonce`,
      [nonce, subject, expiresAt.toISOString(), now.toISOString()],
    );
    return result.rowCount === 1;
  }

  async #prune(now: Date): Promise<void> {
    await this.#interactions.prune(now);
    await this.#pool.query(`DELETE FROM console_approval_nonces WHERE expires_at <= $1`, [
      now.toISOString(),
    ]);
    await this.#pool.query(
      `DELETE FROM assistant_sessions WHERE expires_at <= $1 OR absolute_expires_at <= $1`,
      [now.toISOString()],
    );
  }
}

interface AssistantClientRow {
  id: string;
  name: string;
  org_slug: string;
  app_slug: string;
  environment: string;
  deployment_id: string;
  allowed_origins: string[];
  secret_hash: string;
  created_at: Date;
  revoked_at: Date | null;
}
export interface AssistantSessionRow {
  id: string;
  token_hash: string;
  client_id: string;
  org_slug: string;
  app_slug: string;
  environment: string;
  deployment_id: string;
  model_source: AssistantSessionRecord['modelSource'] | null;
  origin: string;
  caller: AssistantSessionRecord['caller'];
  customer_routing: AssistantSessionRecord['customerRouting'] | null;
  context: AssistantSessionRecord['context'] | null;
  preferences: AssistantSessionRecord['preferences'] | null;
  appearance: AssistantSessionRecord['configuration'] | null;
  history: AssistantHistoryMessage[];
  model_tool_uses: string[];
  public_embed_id: string | null;
  pending_resume: AssistantPendingResume | null;
  bound_surface: string | null;
  turn_count: string;
  initial_suggestions: AssistantSessionRecord['initialSuggestions'] | null;
  latest_suggestions: AssistantSessionRecord['latestSuggestions'] | null;
  latest_view: AssistantRecoverableView | null;
  created_at: Date;
  expires_at: Date;
  absolute_expires_at: Date;
}
function clientFromRow(row: AssistantClientRow): AssistantClientRecord {
  return {
    id: row.id,
    name: row.name,
    tenant: { org: row.org_slug, app: row.app_slug, env: row.environment },
    deploymentId: row.deployment_id,
    allowedOrigins: row.allowed_origins,
    secretHash: row.secret_hash,
    createdAt: row.created_at.toISOString(),
    ...(row.revoked_at ? { revokedAt: row.revoked_at.toISOString() } : {}),
  };
}

export function sessionFromRow(row: AssistantSessionRow): AssistantSessionRecord {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    clientId: row.client_id,
    tenant: { org: row.org_slug, app: row.app_slug, env: row.environment },
    deploymentId: row.deployment_id,
    ...(row.model_source ? { modelSource: row.model_source } : {}),
    origin: row.origin,
    caller: row.caller,
    ...(row.customer_routing
      ? { customerRouting: Object.freeze({ ...row.customer_routing }) }
      : {}),
    ...(row.context ? { context: row.context } : {}),
    ...(row.preferences ? { preferences: row.preferences } : {}),
    ...(row.appearance ? { configuration: row.appearance } : {}),
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    absoluteExpiresAt: row.absolute_expires_at.toISOString(),
    history: row.history,
    modelToolUses: row.model_tool_uses ?? [],
    ...(row.public_embed_id ? { publicEmbedId: row.public_embed_id } : {}),
    ...(row.pending_resume ? { pendingResume: row.pending_resume } : {}),
    ...(row.bound_surface === 'public' || row.bound_surface === 'authenticated'
      ? { boundSurface: row.bound_surface }
      : {}),
    turnCount: Number(row.turn_count ?? 0),
    ...(row.initial_suggestions ? { initialSuggestions: row.initial_suggestions } : {}),
    ...(row.latest_suggestions
      ? {
          latestSuggestions: {
            phase: row.latest_suggestions.phase,
            prompts: [...row.latest_suggestions.prompts],
          },
        }
      : {}),
    ...(row.latest_view ? { latestView: structuredClone(row.latest_view) } : {}),
  };
}
