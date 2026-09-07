import { DEVELOPER_CAPABILITIES } from '@noodle-borg/developer-mcp';
import type { Pool } from 'pg';
import { z } from 'zod';

import { ensureDeveloperGrantSchema } from '../store/postgres-schema.js';
import {
  type ActiveDeveloperGrantLookup,
  type CreateDeveloperAccessGrant,
  createDeveloperAccessGrantRecord,
  type DeveloperAccessGrant,
  type DeveloperGrantFactoryOptions,
  type DeveloperGrantStore,
  normalizeDeveloperAccessGrant,
  normalizeDeveloperGrantTimestamp,
} from './developer-grant.js';

const developerGrantRowSchema = z.object({
  grant_version: z.literal(2),
  id: z.string(),
  client_id: z.string(),
  subject: z.string(),
  resource: z.string(),
  access_model: z.literal('live_user'),
  capabilities: z.array(z.enum(DEVELOPER_CAPABILITIES)),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
  expires_at: z.coerce.date().nullable(),
  revoked_at: z.coerce.date().nullable(),
});

export class PostgresDeveloperGrantStore implements DeveloperGrantStore {
  readonly #pool: Pool;
  readonly #options: DeveloperGrantFactoryOptions;

  constructor(pool: Pool, options: DeveloperGrantFactoryOptions = {}) {
    this.#pool = pool;
    this.#options = options;
  }

  async initialize(): Promise<void> {
    await ensureDeveloperGrantSchema(this.#pool);
  }

  async getOrCreateActive(input: CreateDeveloperAccessGrant): Promise<DeveloperAccessGrant> {
    const grant = createDeveloperAccessGrantRecord(input, this.#options);
    const existing = await this.getActive({
      clientId: grant.clientId,
      subject: grant.subject,
      resource: grant.resource,
      at: grant.createdAt,
    });
    if (existing !== undefined) return existing;

    // The partial uniqueness constraint deliberately treats an unrevoked row as active. Retire an
    // expired tuple before inserting its replacement so persistence matches the in-memory contract.
    await this.#pool.query(
      `UPDATE developer_access_grants
          SET revoked_at = $4::timestamptz,
              updated_at = $4::timestamptz
        WHERE grant_version = 2
          AND access_model = 'live_user'
          AND client_id = $1
          AND subject = $2
          AND resource = $3
          AND revoked_at IS NULL
          AND expires_at <= $4::timestamptz`,
      [grant.clientId, grant.subject, grant.resource, grant.createdAt],
    );

    const { rows } = await this.#pool.query(
      `INSERT INTO developer_access_grants
         (id, client_id, subject, org_slug, environments, capabilities,
          created_at, updated_at, expires_at, revoked_at,
          grant_version, resource, access_model)
       VALUES ($1, $2, $3, NULL, NULL, $4::jsonb, $5, $6, $7, NULL, 2, $8, 'live_user')
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        grant.id,
        grant.clientId,
        grant.subject,
        JSON.stringify(grant.capabilities),
        grant.createdAt,
        grant.updatedAt,
        grant.expiresAt ?? null,
        grant.resource,
      ],
    );
    if (rows[0] !== undefined) return grantFromRow(rows[0]);

    const raced = await this.getActive({
      clientId: grant.clientId,
      subject: grant.subject,
      resource: grant.resource,
      at: grant.createdAt,
    });
    if (raced !== undefined) return raced;
    throw new Error(`developer grant "${grant.id}" already exists`);
  }

  async getActive(input: ActiveDeveloperGrantLookup): Promise<DeveloperAccessGrant | undefined> {
    const at = normalizeDeveloperGrantTimestamp(
      'authorization time',
      input.at ?? new Date().toISOString(),
    );
    const { rows } = await this.#pool.query(
      `SELECT * FROM developer_access_grants
        WHERE grant_version = 2
          AND access_model = 'live_user'
          AND client_id = $1
          AND subject = $2
          AND resource = $3
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > $4::timestamptz)
        ORDER BY created_at DESC
        LIMIT 1`,
      [input.clientId, input.subject, input.resource, at],
    );
    return rows[0] === undefined ? undefined : grantFromRow(rows[0]);
  }

  async get(id: string): Promise<DeveloperAccessGrant | undefined> {
    const { rows } = await this.#pool.query(
      `SELECT * FROM developer_access_grants
        WHERE id = $1 AND grant_version = 2 AND access_model = 'live_user'`,
      [id],
    );
    return rows[0] === undefined ? undefined : grantFromRow(rows[0]);
  }

  async revoke(id: string, at: string): Promise<DeveloperAccessGrant | undefined> {
    const revokedAt = normalizeDeveloperGrantTimestamp('revokedAt', at);
    const { rows } = await this.#pool.query(
      `UPDATE developer_access_grants
       SET updated_at = CASE WHEN revoked_at IS NULL THEN $2::timestamptz ELSE updated_at END,
           revoked_at = COALESCE(revoked_at, $2::timestamptz)
       WHERE id = $1 AND grant_version = 2 AND access_model = 'live_user'
       RETURNING *`,
      [id, revokedAt],
    );
    return rows[0] === undefined ? undefined : grantFromRow(rows[0]);
  }
}

function grantFromRow(value: unknown): DeveloperAccessGrant {
  const row = developerGrantRowSchema.parse(value);
  return normalizeDeveloperAccessGrant({
    version: 2,
    id: row.id,
    clientId: row.client_id,
    subject: row.subject,
    resource: row.resource,
    accessModel: row.access_model,
    capabilities: row.capabilities,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at.toISOString() }),
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at.toISOString() }),
  });
}
