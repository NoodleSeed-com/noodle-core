import type { SecretBox } from '@noodle-borg/runtime';
import type { Pool } from 'pg';
import type { ConfigScope, ConfigValueMetadata, ManagedConfigKind } from '../store.js';
import { scopeChain, validateConfigName, validateConfigScope } from '../store.js';
import {
  type ConfigRow,
  configRowToMetadata,
  openConfigSecret,
  scopeParts,
  sealConfigSecret,
  validateConfigKind,
} from './postgres-rows.js';

/**
 * Postgres backing for {@link ConfigStore} (managed secrets/variables), extracted from `postgres.ts` to
 * keep that file under the size gate — mirrors `postgres-apps.ts`/`postgres-envs.ts`. Pure SQL; the
 * `secretBox` param is the same one `PostgresArtifactStore` threads through everywhere it seals/opens a
 * secret envelope.
 */

export async function setConfigValueRow(
  pool: Pool,
  secretBox: SecretBox | undefined,
  input: {
    readonly kind: ManagedConfigKind;
    readonly scope: ConfigScope;
    readonly name: string;
    readonly value: string;
    readonly updatedBySubject?: string;
    readonly updatedByEmail?: string;
  },
): Promise<ConfigValueMetadata> {
  const kind = validateConfigKind(input.kind);
  const scope = validateConfigScope(input.scope);
  const name = validateConfigName(input.name);
  const parts = scopeParts(scope);
  const secretValue =
    kind === 'secret' ? JSON.stringify(await sealConfigSecret(input.value, secretBox)) : null;
  const variableValue = kind === 'variable' ? input.value : null;
  const { rows } = await pool.query<ConfigRow>(
    `INSERT INTO config_values
       (kind, scope_level, org_slug, app_slug, environment, name, secret_value, variable_value,
        updated_by_subject, updated_by_email)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
     ON CONFLICT (kind, scope_level, org_slug, app_slug, environment, name) DO UPDATE SET
       secret_value       = EXCLUDED.secret_value,
       variable_value     = EXCLUDED.variable_value,
       updated_at         = now(),
       updated_by_subject = EXCLUDED.updated_by_subject,
       updated_by_email   = EXCLUDED.updated_by_email
     RETURNING *`,
    [
      kind,
      parts.level,
      parts.org,
      parts.app,
      parts.env,
      name,
      secretValue,
      variableValue,
      input.updatedBySubject ?? null,
      input.updatedByEmail ?? null,
    ],
  );
  return configRowToMetadata(rows[0] as ConfigRow);
}

export async function deleteConfigValueRow(
  pool: Pool,
  kind: ManagedConfigKind,
  scope: ConfigScope,
  name: string,
): Promise<boolean> {
  const parts = scopeParts(validateConfigScope(scope));
  const { rowCount } = await pool.query(
    `DELETE FROM config_values
     WHERE kind = $1 AND scope_level = $2 AND org_slug = $3 AND app_slug = $4
       AND environment = $5 AND name = $6`,
    [
      validateConfigKind(kind),
      parts.level,
      parts.org,
      parts.app,
      parts.env,
      validateConfigName(name),
    ],
  );
  return (rowCount ?? 0) > 0;
}

export async function listConfigValuesRow(
  pool: Pool,
  kind: ManagedConfigKind,
  scope: ConfigScope,
): Promise<readonly ConfigValueMetadata[]> {
  const parts = scopeParts(validateConfigScope(scope));
  const { rows } = await pool.query<ConfigRow>(
    `SELECT *
     FROM config_values
     WHERE kind = $1 AND scope_level = $2 AND org_slug = $3 AND app_slug = $4 AND environment = $5
     ORDER BY name`,
    [validateConfigKind(kind), parts.level, parts.org, parts.app, parts.env],
  );
  return rows.map(configRowToMetadata);
}

export async function resolveConfigValuesRow(
  pool: Pool,
  secretBox: SecretBox | undefined,
  kind: ManagedConfigKind,
  scope: ConfigScope,
  name?: string,
): Promise<Record<string, string>> {
  const safeKind = validateConfigKind(kind);
  const safeName = name === undefined ? undefined : validateConfigName(name);
  const chain = scopeChain(validateConfigScope(scope)).map(scopeParts);
  const result: Record<string, string> = {};
  for (const parts of safeName === undefined ? chain : [...chain].reverse()) {
    const { rows } = await pool.query<ConfigRow>(
      `SELECT *
       FROM config_values
       WHERE kind = $1 AND scope_level = $2 AND org_slug = $3 AND app_slug = $4 AND environment = $5
         ${safeName === undefined ? '' : 'AND name = $6'}
       ORDER BY name`,
      [
        safeKind,
        parts.level,
        parts.org,
        parts.app,
        parts.env,
        ...(safeName === undefined ? [] : [safeName]),
      ],
    );
    if (safeName !== undefined) {
      const row = rows[0];
      if (row === undefined) continue;
      return {
        [safeName]:
          safeKind === 'secret'
            ? await openConfigSecret(row.secret_value, secretBox)
            : (row.variable_value ?? ''),
      };
    }
    for (const row of rows) {
      result[row.name] =
        safeKind === 'secret'
          ? await openConfigSecret(row.secret_value, secretBox)
          : (row.variable_value ?? '');
    }
  }
  return result;
}
