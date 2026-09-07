import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TlsPosture } from '@noodle-borg/transport-http';
import {
  handleIntentCaptureSettings,
  handleIntentInsights,
  type IntentCaptureRouteDeps,
} from './intent-capture.js';
import { parseIntentCapturePath, parseTenantIntentsPath } from './paths.js';

export interface IntentCaptureDispatchDeps extends IntentCaptureRouteDeps {
  readonly applySecurityHeaders: (res: ServerResponse, tls: TlsPosture) => void;
  readonly enforceHttps: (req: IncomingMessage, res: ServerResponse, tls: TlsPosture) => boolean;
  readonly sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readonly tls: TlsPosture;
}

export function dispatchIntentCaptureRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: IntentCaptureDispatchDeps,
): boolean {
  const settingsRef = parseIntentCapturePath(url.pathname);
  const intentsRef = parseTenantIntentsPath(url.pathname);
  if (settingsRef === undefined && intentsRef === undefined) return false;
  deps.applySecurityHeaders(res, deps.tls);
  if (deps.enforceHttps(req, res, deps.tls)) return true;
  const operation =
    settingsRef !== undefined
      ? handleIntentCaptureSettings(req, res, settingsRef, deps)
      : req.method === 'GET' && intentsRef !== undefined
        ? handleIntentInsights(req, res, intentsRef, url, deps)
        : Promise.resolve(deps.sendJson(res, 405, { error: 'method not allowed' }));
  operation.catch(() => {
    if (!res.headersSent) deps.sendJson(res, 500, { error: 'internal error' });
  });
  return true;
}
