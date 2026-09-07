import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { insertAuditEvent, PostgresAuditStore } from '../src/index.js';

const createdAt = new Date('2026-07-15T12:00:00.000Z');
const eventId = '00000000-0000-4000-8000-000000000001';

describe('Postgres audit insertion', () => {
  it('writes the canonical redacted row through a transaction-compatible queryable', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await insertAuditEvent(
      { query } as unknown as Pick<Pool, 'query'>,
      {
        eventType: 'billing.migration.applied',
        org: 'platform',
        actorSubject: 'admin-subject',
        actorEmail: 'admin@noodleseed.com',
        decision: 'allow',
        status: 201,
        reasonCode: 'shadow_prepared',
        details: {
          organizationCount: 18,
          ready: true,
          secret: { token: 'must-not-be-persisted' },
        },
      },
      { now: () => createdAt, id: () => eventId },
    );

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO audit_events');
    expect(values).toEqual([
      eventId,
      'billing.migration.applied',
      'platform',
      null,
      null,
      null,
      'admin-subject',
      'admin@noodleseed.com',
      'allow',
      '201',
      'shadow_prepared',
      1,
      JSON.stringify({ organizationCount: 18, ready: true, secret: '[unloggable]' }),
      createdAt,
    ]);
    expect(JSON.stringify(values)).not.toContain('must-not-be-persisted');
  });

  it('keeps PostgresAuditStore.emit on the same canonical insertion path', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const store = new PostgresAuditStore({ query } as unknown as Pool, {
      now: () => createdAt,
      id: () => eventId,
    });

    await store.emit({
      eventType: 'billing.migration.rejected',
      org: 'platform',
      status: 409,
      details: { reason: 'drift', unsafe: ['not', 'stored'] },
    });

    const [, values] = query.mock.calls[0] as [string, unknown[]];
    expect(values).toEqual([
      eventId,
      'billing.migration.rejected',
      'platform',
      null,
      null,
      null,
      null,
      null,
      null,
      '409',
      null,
      1,
      JSON.stringify({ reason: 'drift', unsafe: '[unloggable]' }),
      createdAt,
    ]);
  });
});
