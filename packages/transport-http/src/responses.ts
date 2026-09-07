import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AdmissionContext, AdmissionGate } from '@noodle-borg/module';
import { JSON_RPC, LEGACY_MCP_ERROR } from '@noodle-borg/protocol';
import type { Logger } from './logging.js';

/** Emit one `mcp.request` lifecycle line with safe scalar fields only. */
export function logRequest(
  logger: Logger,
  routeId: string,
  req: IncomingMessage,
  res: ServerResponse,
  start: number,
): void {
  logger.info('mcp.request', {
    serverId: routeId,
    method: req.method ?? 'UNKNOWN',
    status: res.statusCode,
    latencyMs: Date.now() - start,
  });
}

export function guard(res: ServerResponse, fn: Promise<void>): Promise<void> {
  return fn.catch(() => {
    if (!res.headersSent) sendJson(res, 500, rpcError(JSON_RPC.INTERNAL_ERROR, 'internal error'));
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** A transport-level JSON-RPC error response with no id (per the Streamable HTTP spec). */
export function rpcError(
  code: number,
  message: string,
): { jsonrpc: '2.0'; id: null; error: { code: number; message: string } } {
  return { jsonrpc: '2.0', id: null, error: { code, message } };
}

export function admissionRpcError(
  context: AdmissionContext,
  decision: Exclude<Awaited<ReturnType<AdmissionGate>>, { allow: true }>,
): {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data: Record<string, string | number> };
} {
  const code =
    decision.code ??
    (decision.status === 429
      ? LEGACY_MCP_ERROR.ADMISSION_QUOTA_EXCEEDED
      : LEGACY_MCP_ERROR.ADMISSION_DENIED);
  const message =
    code === LEGACY_MCP_ERROR.ADMISSION_QUOTA_EXCEEDED
      ? 'Quota exceeded'
      : code === LEGACY_MCP_ERROR.ADMISSION_RATE_LIMITED
        ? 'Rate limited'
        : 'Access denied by policy';
  const data: Record<string, string | number> = { reason: decision.reason };
  if (decision.policyId !== undefined) data.policyId = decision.policyId;
  if (decision.policyVersion !== undefined) data.policyVersion = decision.policyVersion;
  if (decision.retryAfterSeconds !== undefined) data.retryAfterSeconds = decision.retryAfterSeconds;
  if (decision.resetAt !== undefined) data.resetAt = decision.resetAt;
  return {
    jsonrpc: '2.0',
    id: context.requestId ?? null,
    error: { code, message, data },
  };
}
