import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  authorizePublicConfiguration,
  effectiveAssistantBrowserConfiguration,
  publicEmbedTenant,
  publicSurfaceOf,
} from '@noodle-borg/assistant-gateway/portable';
import { sendJson } from '@noodle-borg/transport-http';
import type { AssistantRouteDeps } from './assistant.js';
import { applyBrowserCors } from './assistant-route-http.js';
import { activeAssistantTarget } from './assistant-session-target.js';

/** Browser-safe first paint for a public launcher; never mints a session or spends admission. */
export async function handlePublicAssistantConfiguration(
  req: IncomingMessage,
  res: ServerResponse,
  embedId: string,
  deps: AssistantRouteDeps,
): Promise<void> {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
  if (deps.publicEmbeds === undefined) {
    return sendJson(res, 503, { error: 'public assistant surfaces are not enabled' });
  }
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  const state: {
    target?: Awaited<ReturnType<typeof activeAssistantTarget>>;
  } = {};
  const authorized = await authorizePublicConfiguration(
    { embedId, origin },
    {
      embeds: deps.publicEmbeds,
      resolveActiveSurface: async (embed) => {
        state.target = await activeAssistantTarget(deps, publicEmbedTenant(embed));
        return state.target
          ? publicSurfaceOf(state.target.served.artifact.server.assistant)
          : undefined;
      },
    },
  );
  if (!authorized.ok) {
    return sendJson(res, authorized.status, {
      error: authorized.message,
      code: authorized.code,
    });
  }
  const target = state.target;
  if (target === undefined) {
    return sendJson(res, 409, { error: 'assistant deployment is unavailable' });
  }
  const resolved = await effectiveAssistantBrowserConfiguration(
    target.served.artifact.server,
    publicEmbedTenant(authorized.embed),
    deps.appearance,
    'public',
    target.businessNotice,
  );
  applyBrowserCors(req, res, origin);
  res.setHeader('cache-control', 'private, no-cache');
  return sendJson(res, 200, {
    ...(resolved.effective ? { configuration: resolved.effective } : {}),
    fallback: resolved.fallback,
    revision: resolved.record?.revision ?? 0,
  });
}
