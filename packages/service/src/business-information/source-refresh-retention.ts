import type { PoolClient } from 'pg';
import { SOURCE_REFRESH_REPLAY_MS } from './source-custody-budget.js';
import type { SourceRefreshReceipt } from './source-ingestion-contracts.js';
import type { StoredRefreshRequest } from './source-ingestion-memory-state.js';

export function terminalRefresh(state: SourceRefreshReceipt['state']): boolean {
  return state === 'completed' || state === 'superseded';
}

export function refreshReplayExpiresAt(terminalAt: string): string {
  return new Date(Date.parse(terminalAt) + SOURCE_REFRESH_REPLAY_MS).toISOString();
}

export function pruneMemoryRefreshReceipts(
  requests: Map<string, StoredRefreshRequest>,
  now: Date,
  limit: number,
): number {
  const expired = [...requests.entries()]
    .filter(
      ([, row]) =>
        terminalRefresh(row.state) &&
        row.terminalAt !== undefined &&
        Date.parse(row.terminalAt) + SOURCE_REFRESH_REPLAY_MS <= now.getTime(),
    )
    .sort((left, right) => (left[1].terminalAt ?? '').localeCompare(right[1].terminalAt ?? ''))
    .slice(0, limit);
  for (const [key] of expired) requests.delete(key);
  return expired.length;
}

export async function prunePostgresRefreshReceipts(
  client: PoolClient,
  organizations: readonly string[],
  limit: number,
): Promise<number> {
  if (limit === 0) return 0;
  const result = await client.query(
    `DELETE FROM business_source_refresh_requests WHERE ctid IN (
    SELECT ctid FROM business_source_refresh_requests WHERE org_slug=ANY($1::text[])
      AND state IN ('completed','superseded') AND terminal_at<=clock_timestamp()-($2 * interval '1 millisecond')
    ORDER BY terminal_at LIMIT $3 FOR UPDATE SKIP LOCKED
  )`,
    [organizations, SOURCE_REFRESH_REPLAY_MS, limit],
  );
  return result.rowCount ?? 0;
}
