import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DailyCounterStore } from '@noodle-borg/admission-limits/portable';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import type { Logger, TlsPosture } from '@noodle-borg/transport-http';
import type { BusinessInformationStore } from '../business-information/portable.js';
import { respondRouteError } from '../http-util.js';
import type { ControlPlaneStore } from '../store.js';
import {
  handleBusinessGrants,
  handleManagedRecords,
  handlePublicSolutionIntake,
  handleSolutionCatalog,
  handleSolutionInstallations,
} from './business-information.js';
import {
  parsePublicSolutionIntakePath,
  parseSolutionInstallationPath,
} from './business-information-paths.js';

export interface BusinessInformationDispatchDeps {
  readonly store: BusinessInformationStore;
  readonly gate: DeployAuthGate;
  readonly controlPlane: ControlPlaneStore;
  readonly maxBody: number;
  readonly publicCounters: DailyCounterStore;
  readonly trustProxy: boolean;
  readonly now?: () => Date;
  readonly logger: Logger;
  readonly tls: TlsPosture;
  readonly applySecurityHeaders: (res: ServerResponse, tls: TlsPosture) => void;
  readonly enforceHttps: (req: IncomingMessage, res: ServerResponse, tls: TlsPosture) => boolean;
}

export function dispatchBusinessInformationRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: BusinessInformationDispatchDeps,
): boolean {
  if (url.pathname === '/v1/solutions/catalog') {
    return run(req, res, deps, () => Promise.resolve(handleSolutionCatalog(req, res)));
  }
  const publicRef = parsePublicSolutionIntakePath(url.pathname);
  if (publicRef !== undefined) {
    deps.applySecurityHeaders(res, deps.tls);
    if (deps.enforceHttps(req, res, deps.tls)) return true;
    applyPublicIntakeCors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }
    void handlePublicSolutionIntake(req, res, publicRef, deps).catch((error: unknown) =>
      respondRouteError(deps.logger, res, 'business_information.public_route.failed', error),
    );
    return true;
  }
  const installationRef = parseSolutionInstallationPath(url.pathname);
  if (installationRef === undefined) return false;
  if (installationRef.action === 'grants') {
    return run(req, res, deps, () => handleBusinessGrants(req, res, installationRef, deps));
  }
  if (
    installationRef.action === 'records' ||
    installationRef.action === 'activity' ||
    installationRef.action === 'export'
  ) {
    return run(req, res, deps, () => handleManagedRecords(req, res, url, installationRef, deps));
  }
  return run(req, res, deps, () => handleSolutionInstallations(req, res, installationRef, deps));
}

function applyPublicIntakeCors(res: ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'Content-Type, Idempotency-Key');
  res.setHeader('access-control-max-age', '600');
}

function run(
  req: IncomingMessage,
  res: ServerResponse,
  deps: BusinessInformationDispatchDeps,
  handle: () => Promise<void>,
): true {
  deps.applySecurityHeaders(res, deps.tls);
  if (deps.enforceHttps(req, res, deps.tls)) return true;
  void handle().catch((error: unknown) =>
    respondRouteError(deps.logger, res, 'business_information.route.failed', error),
  );
  return true;
}
