import * as controlPlaneRows from '@noodle-borg/control-plane';
import { insertAuditEvent } from '@noodle-borg/module-audit';
import type { Pool } from 'pg';
import type {
  ActiveMcpSubdomainClaim,
  ChangeMcpSubdomainInput,
  McpSubdomainMutationResult,
  McpSubdomainSetting,
} from '../store.js';

/** PostgreSQL adapter for organization MCP claims and their transactionally committed audit event. */
export abstract class PostgresMcpSubdomainStore {
  readonly #mcpSubdomainPool: Pool;
  readonly #mcpSubdomainNow: () => Date;

  constructor(pool: Pool, now: () => Date) {
    this.#mcpSubdomainPool = pool;
    this.#mcpSubdomainNow = now;
  }

  getActiveMcpSubdomain(org: string): Promise<ActiveMcpSubdomainClaim | undefined> {
    return controlPlaneRows.getActiveMcpSubdomainRow(this.#mcpSubdomainPool, org);
  }

  resolveActiveMcpSubdomain(mcpSubdomain: string): Promise<ActiveMcpSubdomainClaim | undefined> {
    return controlPlaneRows.resolveActiveMcpSubdomainRow(this.#mcpSubdomainPool, mcpSubdomain);
  }

  getMcpSubdomainSetting(org: string): Promise<McpSubdomainSetting | undefined> {
    return controlPlaneRows.getMcpSubdomainSettingRow(this.#mcpSubdomainPool, org);
  }

  changeMcpSubdomain(input: ChangeMcpSubdomainInput): Promise<McpSubdomainMutationResult> {
    return controlPlaneRows.changeMcpSubdomainRow(this.#mcpSubdomainPool, input, {
      now: this.#mcpSubdomainNow,
      recordAudit: (client, result, mutation) =>
        insertAuditEvent(
          client,
          {
            eventType: 'org.mcp_subdomain.changed',
            org: result.orgSlug,
            actorSubject: mutation.actor.subject,
            ...(mutation.actor.email === undefined ? {} : { actorEmail: mutation.actor.email }),
            decision: 'allow',
            status: 200,
            details: {
              previousMcpSubdomain: result.previousMcpSubdomain,
              mcpSubdomain: result.mcpSubdomain,
            },
          },
          { now: () => new Date(result.changedAt) },
        ),
    });
  }
}
