/**
 * Knowledge route dispatch. The service injects its auth and HTTP-posture callbacks; every
 * knowledge decision (paths, gating, validation, staging) stays in this package.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from './http.js';
import { parseKnowledgePath } from './paths.js';
import {
  handleKnowledgeDocumentUpload,
  handleKnowledgePreflight,
  type KnowledgeRouteDeps,
} from './routes.js';
import {
  handleKnowledgeList,
  handleKnowledgeRefresh,
  handleKnowledgeStatus,
} from './status-routes.js';

export interface KnowledgeDispatchDeps {
  /** Tenant control-plane auth; resolves false when the response was already written. */
  readonly authorize: (
    req: IncomingMessage,
    res: ServerResponse,
    org: string,
  ) => Promise<unknown | false>;
  readonly routeDeps: KnowledgeRouteDeps;
  readonly applySecurityHeaders: (res: ServerResponse) => void;
  /** Returns true when the request was already rejected (e.g. HTTPS enforcement). */
  readonly enforceHttps: (req: IncomingMessage, res: ServerResponse) => boolean;
}

export function dispatchKnowledgeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: KnowledgeDispatchDeps,
): boolean {
  const ref = parseKnowledgePath(url.pathname);
  if (ref === undefined) return false;
  const method =
    ref.kind === 'preflight' || ref.kind === 'refresh'
      ? 'POST'
      : ref.kind === 'document'
        ? 'PUT'
        : 'GET';
  if (method !== req.method) return false;
  const statusDeps = deps.routeDeps.status;
  if (
    (ref.kind === 'list' || ref.kind === 'status' || ref.kind === 'refresh') &&
    statusDeps === undefined
  ) {
    return false;
  }
  deps.applySecurityHeaders(res);
  if (deps.enforceHttps(req, res)) return true;
  (async () => {
    const identity = await deps.authorize(req, res, ref.tenant.org);
    if (identity === false) return;
    if (ref.kind === 'preflight') {
      await handleKnowledgePreflight(req, res, ref.tenant, deps.routeDeps);
    } else if (ref.kind === 'document') {
      await handleKnowledgeDocumentUpload(req, res, ref.tenant, ref.sha256, deps.routeDeps);
    } else if (statusDeps !== undefined && ref.kind === 'list') {
      await handleKnowledgeList(req, res, ref.tenant, statusDeps);
    } else if (statusDeps !== undefined && ref.kind === 'status') {
      await handleKnowledgeStatus(req, res, ref.tenant, ref.component, statusDeps);
    } else if (statusDeps !== undefined && ref.kind === 'refresh') {
      await handleKnowledgeRefresh(req, res, ref.tenant, ref.component, statusDeps);
    }
  })().catch(() => {
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
  });
  return true;
}
