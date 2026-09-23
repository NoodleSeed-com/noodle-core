import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServiceRunMode } from '@noodle-borg/module';
import { sendJson } from '@noodle-borg/transport-http';

export type { ServiceRunMode } from '@noodle-borg/module';

/**
 * How much of the service this process runs (ADR 0144, serving revision).
 *
 * - `full` (default, `NOODLE_RUN_MODE` absent): everything, exactly as before.
 * - `serve-only` (set only on a revision staged in production before approval): no worker, timer,
 *   queue consumer, sweep, sender or projector starts, no boot-time write is made, modules are told
 *   through `ModuleHostContext.runMode`, and only the read-only probes below are answered. The
 *   precedent is recovery quarantine (`recovery-quarantine.ts`), which keeps workers stopped too.
 */
export function parseServiceRunMode(value: string | undefined): ServiceRunMode {
  if (value === undefined || value === '') return 'full';
  if (value === 'serve-only') return 'serve-only';
  throw new Error('NOODLE_RUN_MODE must be absent or exactly serve-only');
}

/** The probes the stage smoke reads; none of them writes or sends anything. */
const SERVE_ONLY_PATHS = new Set([
  '/healthz',
  '/readyz',
  '/v1/service/info',
  '/v1/service/capabilities',
]);

/** Everything else fails closed: no tool call, MCP session, OAuth flow, webhook or control-plane write. */
export function serveOnlyHandler(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'GET' && SERVE_ONLY_PATHS.has(path)) return handler(req, res);
    res.setHeader('cache-control', 'no-store');
    // 403, not 5xx: a refusal by design, which the stage smoke asserts and a gateway never retries.
    sendJson(res, 403, {
      error: 'This revision is staged for approval and serves only read-only probes.',
      code: 'serve_only',
    });
  };
}
