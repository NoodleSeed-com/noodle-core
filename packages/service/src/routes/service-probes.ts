import type { IncomingMessage, ServerResponse } from 'node:http';
import { applySecurityHeaders, sendJson, type TlsPosture } from '@noodle-borg/transport-http';
import { type BuildInfo, serviceInfoPayload } from '../build-info.js';
import type { ServiceOptions } from '../options.js';

interface ProbeDeps {
  readonly tls: TlsPosture;
  readonly buildInfo: BuildInfo;
  readonly options: Pick<ServiceOptions, 'developerMcp'>;
  readonly whatsapp: unknown;
  readonly moduleHost: { ready(): boolean | Promise<boolean> };
}

export function createServiceProbeDispatcher(deps: ProbeDeps) {
  return (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
    if (req.method !== 'GET' || !['/healthz', '/readyz', '/v1/service/info'].includes(url.pathname))
      return false;
    handleServiceProbe(req, res, url, deps);
    return true;
  };
}

function handleServiceProbe(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  { tls, moduleHost, buildInfo, options, whatsapp }: ProbeDeps,
) {
  // Liveness/readiness probes: un-gated and **not** HTTPS-enforced — Cloud Run's internal probe is plain
  // HTTP, so enforcing HTTPS here would `426` the probe and the revision would never go healthy (ADR 0034).
  // `/healthz` is a pure liveness 200 (no store touch); `/readyz` reflects the injected readiness probe.
  if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/readyz')) {
    applySecurityHeaders(res, tls);
    if (url.pathname === '/healthz') return sendJson(res, 200, { status: 'ok' });
    void Promise.resolve()
      .then(() => moduleHost.ready())
      .then((ready) => sendJson(res, ready ? 200 : 503, { status: ready ? 'ready' : 'unready' }))
      .catch(() => sendJson(res, 503, { status: 'unready' }));
    return;
  }

  // Deployed-version visibility (ADR 0080): un-gated, non-HTTPS-enforced like the probes so the
  // post-deploy smoke can confirm exactly which commit is live. Non-sensitive fields only.
  if (req.method === 'GET' && url.pathname === '/v1/service/info') {
    applySecurityHeaders(res, tls);
    return sendJson(
      res,
      200,
      serviceInfoPayload(buildInfo, options.developerMcp === true, whatsapp !== undefined),
    );
  }
}
