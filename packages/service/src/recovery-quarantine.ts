import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { applySecurityHeaders, sendJson } from '@noodle-borg/transport-http';
import { resolveBuildInfo, serviceInfoPayload } from './build-info.js';
import type { LocalRunningService } from './local-options.js';
import type { ServiceOptions } from './options.js';
import { ServerRegistry } from './registry.js';
import { closeHttpServer, listenHttpServer } from './service-resource-cleanup.js';

/** Deployment state outside the restored database. Reopening is never inferred from database flags. */
export type RecoveryMode = 'quarantined' | 'reopened';

export function resolveRecoveryMode(value: string | undefined): RecoveryMode | undefined {
  if (value === undefined) return undefined;
  if (value === 'quarantined' || value === 'reopened') return value;
  throw new Error('Invalid recovery mode; expected quarantined or reopened');
}

/** Deliberately no authorization/store lookup, artifact serving or application dispatch. */
export function createRecoveryQuarantineHandler(
  options: Pick<ServiceOptions, 'tls' | 'buildInfo'>,
): (req: IncomingMessage, res: ServerResponse) => void {
  const build = options.buildInfo ?? resolveBuildInfo();
  return (req, res) => {
    applySecurityHeaders(res, options.tls ?? {});
    res.setHeader('cache-control', 'no-store');
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'GET') {
      if (path === '/healthz') return sendJson(res, 200, { status: 'ok' });
      if (path === '/readyz') return sendJson(res, 503, { status: 'quarantined' });
      if (path === '/v1/service/info') return sendJson(res, 200, serviceInfoPayload(build, false));
    }
    sendJson(res, 503, {
      error: 'This service is quarantined for recovery.',
      code: 'recovery_quarantined',
    });
  };
}

/** No restored store is constructed or borrowed; even startup migrations/workers remain stopped. */
export async function serveRecoveryQuarantine(
  options: Pick<ServiceOptions, 'tls' | 'buildInfo'> & {
    readonly host?: string;
    readonly port?: number;
  },
): Promise<LocalRunningService> {
  const host = options.host ?? '127.0.0.1';
  const http = createServer(createRecoveryQuarantineHandler(options));
  await listenHttpServer(http, options.port ?? 8787, host);
  const { port } = http.address() as AddressInfo;
  return {
    http,
    port,
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    // The existing programmatic return contract gets an empty local registry, never restored authority.
    registry: new ServerRegistry(),
    close: () => closeHttpServer(http),
  };
}
