/**
 * Boot-time recovery of persisted deploy records into the in-memory serving maps — the loop
 * body of `ServerRegistry.recover`, moved verbatim behind injected registry internals.
 */
import type { ServedArtifact } from '@noodle-borg/protocol';
import type { ServedTarget } from '@noodle-borg/transport-http';
import { customerAuthAudienceConflictFailure } from './customer-auth-audience-binding.js';
import { missingCapabilityErrors, serverAuthRequiredError } from './registry-helpers.js';
import { tenantDeploymentKey, tryServedTargetFor } from './registry-targets.js';
import type { DeployError, RecoverResult } from './registry-types.js';
import type { DeployRecord, TenantAuthConfig } from './store.js';

interface RecoverContext {
  readonly compilePersistedRecord: (
    record: DeployRecord,
  ) => Promise<
    | { readonly ok: true; readonly served: ServedArtifact }
    | { readonly ok: false; readonly errors: readonly DeployError[] }
  >;
  readonly serviceCapabilities: readonly string[];
  readonly customerVerifierFactory: unknown;
  readonly hasCustomerAuthAudienceConflict: (
    record: DeployRecord,
    auth: TenantAuthConfig | undefined,
  ) => Promise<boolean>;
  readonly servers: Map<string, ServedTarget>;
  readonly records: Map<string, DeployRecord>;
  readonly activeTenants: Map<string, string>;
}

export async function recoverRegistryRecords(
  records: readonly DeployRecord[],
  ctx: RecoverContext,
): Promise<RecoverResult> {
  const failed: Array<{ deploymentId: string; errors: readonly DeployError[] }> = [];
  let recovered = 0;
  for (const record of records) {
    if (record.archivedAt !== undefined) continue;
    if (record.accessMode === undefined) {
      failed.push({
        deploymentId: record.deploymentId,
        errors: [
          {
            code: 'unsupported_legacy_access_mode',
            path: 'accessMode',
            message:
              'caller-key deployments are no longer supported; redeploy with owner-only or org-members access',
          },
        ],
      });
      continue;
    }
    const built = await ctx.compilePersistedRecord(record);
    if (!built.ok) {
      failed.push({ deploymentId: record.deploymentId, errors: built.errors });
      continue;
    }
    const missingCapabilities = missingCapabilityErrors(
      built.served.artifact.requirements?.capabilities ?? [],
      ctx.serviceCapabilities as never,
    );
    if (missingCapabilities.length > 0) {
      failed.push({ deploymentId: record.deploymentId, errors: missingCapabilities });
      continue;
    }
    if (
      record.active &&
      (await ctx.hasCustomerAuthAudienceConflict(record, built.served.artifact.server.auth))
    ) {
      failed.push({
        deploymentId: record.deploymentId,
        errors: customerAuthAudienceConflictFailure().errors,
      });
      continue;
    }
    const target = tryServedTargetFor(
      record,
      built.served,
      ctx.customerVerifierFactory as Parameters<typeof tryServedTargetFor>[2],
    );
    if (target === undefined) {
      failed.push({
        deploymentId: record.deploymentId,
        errors: serverAuthRequiredError().errors,
      });
      continue;
    }
    ctx.servers.set(record.deploymentId, target);
    ctx.records.set(record.deploymentId, record);
    if (record.active) {
      ctx.activeTenants.set(
        tenantDeploymentKey(
          { org: record.orgSlug, app: record.appSlug, env: record.environment },
          record.serverVersion,
        ),
        record.deploymentId,
      );
    }
    recovered++;
  }
  return { recovered, failed };
}
