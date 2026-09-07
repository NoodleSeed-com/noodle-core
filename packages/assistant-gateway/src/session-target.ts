import type { RuntimeArtifact } from '@noodle-borg/compiler';
import { projectArtifactForSurface } from './artifact-projection.js';
import type { AssistantSessionRecord } from './assistant-store.js';
import {
  authenticatedSurfaceOf,
  publicSurfaceOf,
  surfaceBindingForOrigin,
} from './public-surface.js';

/**
 * The deployment a session may act on, already narrowed to the surface that admitted it.
 *
 * This is the seam ADR 0201's projection rests on. Every session-authenticated route resolves its target
 * through here instead of calling `registry.get` directly, so the dozen `artifact.tools.find(...)` sites
 * downstream get a projected artifact without knowing projection exists. Delete the projection call
 * below and the projection tests fail — one deletion, not a dozen.
 *
 * The surface is read from the session's pinned deployment, never from whatever is active now: projecting
 * artifact N by a surface read from artifact N+1 is a skew bug that would widen or narrow a live session
 * on someone else's deploy. 5.1b's `assertDistinctSurfaces` guarantees at most one public-audience
 * surface and at most one authenticated surface per artifact, so a binding never needs disambiguation.
 *
 * Sessions carry their binding explicitly (`boundSurface`, written at mint). A record from before the
 * binding existed derives it here from the pinned deployment and the session's own origin, so in-flight
 * sessions stay correct across the deploy that introduced binding; only a pre-surfaces artifact still
 * reaches the whole server, because the deployment-wide union is that released shape's entire contract.
 */

export interface AssistantSessionTarget {
  readonly served: { readonly artifact: RuntimeArtifact };
}

export async function resolveAssistantSessionTarget<Target extends AssistantSessionTarget>(
  load: (deploymentId: string) => Promise<Target | undefined>,
  session: AssistantSessionRecord,
): Promise<Target | undefined> {
  const target = await load(session.deploymentId);
  if (!target) return undefined;
  const assistant = target.served.artifact.server.assistant;
  const bound = session.boundSurface ?? deriveLegacyBinding(assistant, session);
  if (bound === 'pre-surfaces') return target;
  // Fail closed: an origin no surface owns must never widen to the whole server.
  if (bound === 'unowned') return undefined;
  // Fail closed on a vanished surface. A rollback to an artifact without the bound surface must end the
  // session's reach, never hand it the unprojected server.
  if (bound === 'authenticated') {
    const surface = authenticatedSurfaceOf(assistant);
    if (surface === undefined) return undefined;
    // An omitted allowlist on an authenticated surface is the authored whole-server intent, so the
    // exact binding still holds (instructions, budgets, attribution) without narrowing capabilities.
    if (surface.capabilities === undefined) return target;
    return projected(target, surface.capabilities);
  }
  const surface = publicSurfaceOf(assistant);
  if (surface === undefined) return undefined;
  return projected(target, surface.capabilities);
}

function projected<Target extends AssistantSessionTarget>(
  target: Target,
  capabilities: Parameters<typeof projectArtifactForSurface>[1],
): Target {
  return {
    ...target,
    served: {
      ...target.served,
      artifact: projectArtifactForSurface(target.served.artifact, capabilities),
    },
  } as Target;
}

/**
 * A record minted before `boundSurface` existed: the embed id marks the public surface; otherwise the
 * session's origin selects the owning surface on the pinned deployment. `pre-surfaces` means the whole
 * server on that released artifact shape; `unowned` fails closed above.
 */
function deriveLegacyBinding(
  assistant: unknown,
  session: AssistantSessionRecord,
): 'public' | 'authenticated' | 'unowned' | 'pre-surfaces' {
  if (session.publicEmbedId !== undefined) return 'public';
  return surfaceBindingForOrigin(assistant, session.origin).kind;
}
