import { PostgresDailyCounterStore } from '@noodle-borg/admission-limits/postgres';
import { PublicPageReader } from '@noodle-borg/knowledge-crawl';
import { CapabilityService } from '@noodle-borg/managed-capabilities';
import { PostgresCapabilityPolicyStore } from '@noodle-borg/managed-capabilities/postgres';
import type { AuditSink } from '@noodle-borg/module';
import type { Pool } from 'pg';

export async function hostedWebCapabilities(
  pool: Pool,
  targets: readonly { readonly org: string; readonly app: string; readonly env: string }[] = [],
  audit?: () => AuditSink | undefined,
): Promise<CapabilityService> {
  const policies = new PostgresCapabilityPolicyStore(pool);
  const counters = new PostgresDailyCounterStore(pool);
  await policies.ensureSchema();
  await counters.ensureSchema();
  return new CapabilityService({
    profile: 'hosted',
    policies,
    counters,
    reader: new PublicPageReader(),
    enabledScopes: targets,
    ...(audit === undefined
      ? {}
      : {
          audit: (fields) =>
            audit()?.emit({
              eventType: 'capability.web-extract.execution',
              org: fields.org,
              app: fields.app,
              env: fields.env,
              details: fields,
            }),
        }),
  });
}
