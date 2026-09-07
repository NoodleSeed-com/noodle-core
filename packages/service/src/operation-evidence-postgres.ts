import type { OperationEvidence, SealedSecret, SecretBox } from '@noodle-borg/runtime';
import type { Pool } from 'pg';
import type { InstallationScope } from './business-information/contracts.js';
import { inTransaction } from './business-information/postgres-transaction.js';
import {
  completeOperationEvidence,
  type OperationEvidenceCursor,
  type OperationEvidenceRecord,
  type OperationEvidenceStore,
  type OperationHistorySetting,
  operationEvidenceKey,
} from './operation-evidence.js';
import type {
  OperationHistoryPreviewCounts,
  OperationHistoryPreviewInput,
} from './operation-history-preview.js';

interface EvidenceRow {
  readonly id: string;
  readonly protected: SealedSecret;
  readonly outcome: OperationEvidenceRecord['outcome'];
  readonly completed_at: string | null;
  readonly history_expires_at: string;
}

/** Portable PostgreSQL authority. All execution attribution/references are sealed with a scope binding. */
export class PostgresOperationEvidenceStore implements OperationEvidenceStore {
  constructor(
    readonly pool: Pool,
    readonly secretBox: SecretBox,
  ) {}

  async preview(
    scope: InstallationScope,
    input: OperationHistoryPreviewInput,
  ): Promise<OperationHistoryPreviewCounts> {
    const { rows } = await this.pool.query<{
      id: string;
      visible: string;
      expires: string;
      hidden: string;
    }>(
      `WITH terminal AS (
        SELECT CASE WHEN outcome='dispatching' THEN execution_deadline ELSE COALESCE(completed_at,started_at) END AS completed,
          CASE WHEN outcome='dispatching' THEN execution_deadline+history_expires_at-started_at ELSE history_expires_at END AS expires
        FROM operation_evidence WHERE scope_key=$1 AND (outcome<>'dispatching' OR execution_deadline<=$2)
      ), visible AS (
        SELECT * FROM terminal WHERE completed BETWEEN $2-$4::bigint*86400000 AND $2 AND expires>$2
      )
      SELECT target.id, count(visible.completed)::text AS visible,
        count(*) FILTER (WHERE visible.expires<=$3)::text AS expires,
        count(*) FILTER (WHERE visible.expires>$3 AND visible.completed >= $3-$4::bigint*86400000
          AND visible.completed < $3-target.days::bigint*86400000)::text AS hidden
      FROM jsonb_to_recordset($5::jsonb) AS target(id text,days integer)
      LEFT JOIN visible ON true GROUP BY target.id`,
      [
        operationEvidenceKey(scope, ''),
        input.asOf,
        input.paidPeriodEnd,
        input.currentMaximumDays,
        JSON.stringify(input.scenarios.map(({ id, maximumDays }) => ({ id, days: maximumDays }))),
      ],
    );
    return {
      currentlyAccessibleCount: Number(rows[0]?.visible ?? 0),
      physicallyExpiresByPeriodEndCount: Number(rows[0]?.expires ?? 0),
      scenarios: input.scenarios.map(({ id }) => ({
        id,
        additionallyHiddenAtPeriodEndCount: Number(rows.find((row) => row.id === id)?.hidden ?? 0),
      })),
    };
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS operation_evidence (
      scope_key text NOT NULL, id text NOT NULL, protected jsonb NOT NULL,
      started_at bigint NOT NULL, execution_deadline bigint NOT NULL, history_expires_at bigint NOT NULL,
      outcome text NOT NULL CHECK (outcome IN ('dispatching','completed','rejected','accepted','unknown','returned')),
      completed_at bigint, PRIMARY KEY(scope_key,id)
    )`);
    await this.pool.query(
      'CREATE TABLE IF NOT EXISTS operation_history_settings (scope_key text PRIMARY KEY, days integer NOT NULL CHECK(days BETWEEN 1 AND 365), revision integer NOT NULL)',
    );
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS operation_evidence_expiry ON operation_evidence(history_expires_at)',
    );
    await this.pool.query(
      'CREATE INDEX IF NOT EXISTS operation_evidence_history ON operation_evidence(scope_key,started_at DESC,id)',
    );
  }

  async readRetention(scope: InstallationScope): Promise<OperationHistorySetting | undefined> {
    const { rows } = await this.pool.query<OperationHistorySetting>(
      'SELECT days,revision FROM operation_history_settings WHERE scope_key=$1',
      [operationEvidenceKey(scope, '')],
    );
    return rows[0];
  }
  async setRetention(
    scope: InstallationScope,
    days: number,
    expectedRevision: number | undefined,
  ): Promise<boolean> {
    const key = operationEvidenceKey(scope, '');
    const { rowCount } =
      expectedRevision === undefined
        ? await this.pool.query(
            'INSERT INTO operation_history_settings(scope_key,days,revision) VALUES($1,$2,1) ON CONFLICT DO NOTHING',
            [key, days],
          )
        : await this.pool.query(
            'UPDATE operation_history_settings SET days=$2,revision=revision+1 WHERE scope_key=$1 AND revision=$3',
            [key, days, expectedRevision],
          );
    return rowCount === 1;
  }

  async claim(record: OperationEvidenceRecord): Promise<boolean> {
    const sealed = await this.secretBox.seal(JSON.stringify(record));
    const { rowCount } = await this.pool.query(
      `INSERT INTO operation_evidence
      (scope_key,id,protected,started_at,execution_deadline,history_expires_at,outcome)
      VALUES($1,$2,$3::jsonb,$4,$5,$6,'dispatching') ON CONFLICT DO NOTHING`,
      [
        operationEvidenceKey(record.scope, ''),
        record.id,
        JSON.stringify(sealed),
        record.startedAt,
        record.executionDeadline,
        record.historyExpiresAt,
      ],
    );
    return rowCount === 1;
  }

  async finish(
    scope: InstallationScope,
    id: string,
    lease: string,
    epoch: string,
    evidence: OperationEvidence,
    now: number,
    historyDays?: number,
  ): Promise<boolean> {
    return inTransaction(this.pool, async (client) => {
      const { rows } = await client.query<EvidenceRow>(
        'SELECT id,protected,outcome,completed_at,history_expires_at FROM operation_evidence WHERE scope_key=$1 AND id=$2 FOR UPDATE',
        [operationEvidenceKey(scope, ''), id],
      );
      const row = rows[0];
      if (!row) return false;
      const record = await this.open(scope, row);
      const complete = completeOperationEvidence(record, lease, epoch, evidence, now, historyDays);
      if (!complete) return false;
      const sealed = await this.secretBox.seal(JSON.stringify(complete));
      await client.query(
        'UPDATE operation_evidence SET protected=$3::jsonb,outcome=$4,completed_at=$5,history_expires_at=$6 WHERE scope_key=$1 AND id=$2',
        [
          operationEvidenceKey(scope, ''),
          id,
          JSON.stringify(sealed),
          complete.outcome,
          now,
          complete.historyExpiresAt,
        ],
      );
      return true;
    });
  }

  async list(
    scope: InstallationScope,
    now: number,
    days: number,
    limit: number,
    before?: OperationEvidenceCursor,
  ): Promise<readonly OperationEvidenceRecord[]> {
    await this.sweep(now);
    const { rows } = await this.pool.query<EvidenceRow>(
      `SELECT id,protected,outcome,completed_at,history_expires_at FROM operation_evidence
      WHERE scope_key=$1 AND (outcome='dispatching' OR COALESCE(completed_at,started_at) >= $2)
      AND (started_at < $3 OR (started_at=$3 AND id > $6)) AND history_expires_at > $4
      ORDER BY started_at DESC,id LIMIT $5`,
      [
        operationEvidenceKey(scope, ''),
        now - days * 86_400_000,
        before?.startedAt ?? now + 1,
        now,
        limit,
        before?.id ?? '',
      ],
    );
    return Promise.all(rows.map((row) => this.open(scope, row)));
  }

  async sweep(now: number): Promise<void> {
    await this.pool.query(
      "UPDATE operation_evidence SET outcome='unknown',completed_at=execution_deadline,history_expires_at=execution_deadline+history_expires_at-started_at WHERE outcome='dispatching' AND execution_deadline <= $1",
      [now],
    );
    await this.pool.query('DELETE FROM operation_evidence WHERE history_expires_at <= $1', [now]);
  }

  private async open(scope: InstallationScope, row: EvidenceRow): Promise<OperationEvidenceRecord> {
    const record: OperationEvidenceRecord = JSON.parse(await this.secretBox.open(row.protected));
    if (operationEvidenceKey(record.scope, record.id) !== operationEvidenceKey(scope, row.id))
      throw new Error('Operation evidence scope mismatch');
    return {
      ...record,
      outcome: row.outcome,
      historyExpiresAt: Number(row.history_expires_at),
      ...(row.completed_at === null ? {} : { completedAt: Number(row.completed_at) }),
    };
  }
}
