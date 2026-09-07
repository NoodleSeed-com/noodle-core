import type { IncomingMessage, ServerResponse } from 'node:http';
import { applySecurityHeaders, sendJson, type TlsPosture } from '@noodle-borg/transport-http';
import { type BuildInfo, cliCompatibilityError } from './build-info.js';

export function rejectIncompatibleCli(
  req: IncomingMessage,
  res: ServerResponse,
  buildInfo: BuildInfo,
  tls: TlsPosture,
): boolean {
  const error = cliCompatibilityError(buildInfo, req.headers['x-noodle-cli-version']);
  if (!error) return false;
  applySecurityHeaders(res, tls);
  sendJson(res, 409, error);
  return true;
}
