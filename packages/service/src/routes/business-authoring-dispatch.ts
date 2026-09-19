import type { IncomingMessage, ServerResponse } from 'node:http';
import { applySecurityHeaders, enforceHttps, type TlsPosture } from '@noodle-borg/transport-http';
import { parseApplicationDraftPath } from '../application-drafts/paths.js';
import { parseBusinessWorkspacePath } from '../business-workspaces/paths.js';
import type { ServiceOptions } from '../options.js';
import {
  type ApplicationDraftRouteDeps,
  handleApplicationDraftRoute,
} from './application-drafts.js';
import { handleBusinessWorkspaceRoute } from './business-workspaces.js';

/** Explicit versioned authority, independent of the managed-record switch. */
export function dispatchBusinessAuthoringRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  authoring: ServiceOptions['businessAuthoring'],
  deps: Omit<ApplicationDraftRouteDeps, 'drafts' | 'workspaces'> & { readonly tls: TlsPosture },
): boolean {
  if (!authoring) return false;
  const workspace =
    url.pathname === '/v1/me/business-workspaces' || parseBusinessWorkspacePath(url.pathname);
  if (!workspace && !parseApplicationDraftPath(url.pathname)) return false;
  applySecurityHeaders(res, deps.tls);
  if (!enforceHttps(req, res, deps.tls)) {
    const merged = { ...deps, ...authoring };
    if (workspace) void handleBusinessWorkspaceRoute(req, res, url, merged);
    else void handleApplicationDraftRoute(req, res, url, merged);
  }
  return true;
}
