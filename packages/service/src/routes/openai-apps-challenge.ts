import type { IncomingMessage, ServerResponse } from 'node:http';
import { OPENAI_APPS_CHALLENGE_PATH } from '@noodle-borg/module';
import {
  applySecurityHeaders,
  enforceHttps,
  sendJson,
  type TlsPosture,
} from '@noodle-borg/transport-http';
import { trustedPublicOrgWellKnownFromRequest } from '../mcp-public-routing.js';
import type { ServiceOptions } from '../options.js';
import type { ControlPlaneStore } from '../store.js';

export function handlePublicOpenAIAppsChallenge(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServiceOptions,
  tls: TlsPosture,
  controlPlane: ControlPlaneStore,
): void {
  applySecurityHeaders(res, tls);
  if (enforceHttps(req, res, tls)) return;
  void Promise.resolve()
    .then(async () => {
      const trustedOrg = await trustedPublicOrgWellKnownFromRequest(
        req,
        options,
        OPENAI_APPS_CHALLENGE_PATH,
        controlPlane,
      );
      if (trustedOrg.status === 'none') return sendJson(res, 404, { error: 'not found' });
      if (!trustedOrg.ok) {
        return sendJson(res, trustedOrg.status, {
          error: trustedOrg.status === 403 ? 'forbidden' : 'not found',
        });
      }
      const record = await controlPlane.getOrgOpenAIAppsChallenge(trustedOrg.org);
      if (record === undefined) return sendJson(res, 404, { error: 'not found' });
      const body = Buffer.from(record.challenge, 'utf8');
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': String(body.byteLength),
      });
      res.end(body);
    })
    .catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
}
