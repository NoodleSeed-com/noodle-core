import { publicSurfaceOf } from '@noodle-borg/assistant-gateway/portable';
import type { ServiceOptions } from '../options.js';
import type { ServerRegistry } from '../registry.js';
import type { TenantRef } from '../store.js';

/**
 * The public embed id a deploy hands back, so the developer never runs a provisioning command.
 *
 * The id is what a browser presents to mint an anonymous session, so until deploy creates one a public
 * surface is compiled, validated, and completely unreachable. Provisioning here rather than through a
 * separate command is ADR 0201's one-line experience: deploy, paste the snippet, done.
 *
 * Read from the just-activated artifact rather than the submitted manifest, so the id follows what the
 * runtime will actually serve — the same source minting and projection read.
 */
export async function provisionPublicEmbed(
  registry: ServerRegistry,
  options: ServiceOptions,
  tenant: TenantRef,
  deploymentId: string | undefined,
): Promise<string | undefined> {
  const embeds = options.publicEmbeds;
  if (embeds === undefined || deploymentId === undefined) return undefined;

  const target = await registry.get(deploymentId);
  const surface = publicSurfaceOf(target?.served.artifact.server.assistant);
  if (surface === undefined) return undefined;

  try {
    const record = await embeds.ensure({ ...tenant, surfaceMode: surface.mode, now: new Date() });
    return record.embedId;
  } catch {
    // The deployment is already live by the time this runs; a store failure must never turn it into a
    // failed deploy. The developer sees no snippet and redeploys — `ensure` is idempotent, so the retry
    // costs nothing. And if the store is down here, minting is down too, so no reachability is lost.
    await options.userAppLogStore?.emit({
      level: 'warn',
      message: 'public assistant embed id could not be provisioned',
      org: tenant.org,
      app: tenant.app,
      env: tenant.env,
      details: { deploymentId },
    });
    return undefined;
  }
}
