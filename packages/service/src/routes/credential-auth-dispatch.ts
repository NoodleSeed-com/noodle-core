import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import type { TlsPosture } from '@noodle-borg/transport-http';
import type { ResolveEndpointUrlOptions } from '../mcp-public-routing.js';
import type { ServiceOptions } from '../options.js';
import type { ServerRegistry } from '../registry.js';
import type { AuditSink } from '../store/audit.js';
import type { ControlPlaneStore } from '../store.js';
import { dispatchAuthDoctorRoute } from './auth-doctor-dispatch.js';
import { dispatchGoogleWorkloadIdentityRoute } from './google-workload-identity-dispatch.js';

interface CredentialAuthDispatchDeps {
  readonly registry: ServerRegistry;
  readonly serviceBase: string;
  readonly resolveEndpointOptions: ResolveEndpointUrlOptions;
  readonly googleWorkloadIdentity: ServiceOptions['googleWorkloadIdentity'];
  readonly gate: DeployAuthGate;
  readonly controlPlane: ControlPlaneStore;
  readonly audit: AuditSink;
  readonly applySecurityHeaders: (res: ServerResponse, tls: TlsPosture) => void;
  readonly enforceHttps: (req: IncomingMessage, res: ServerResponse, tls: TlsPosture) => boolean;
  readonly sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readonly tls: TlsPosture;
}

/** Co-locate downstream credential diagnostics/lifecycle outside the root service router. */
export function dispatchCredentialAuthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: CredentialAuthDispatchDeps,
): boolean {
  if (dispatchAuthDoctorRoute(req, res, url, deps)) return true;
  return dispatchGoogleWorkloadIdentityRoute(
    req,
    res,
    url,
    deps.googleWorkloadIdentity === undefined
      ? undefined
      : {
          ...deps.googleWorkloadIdentity,
          gate: deps.gate,
          controlPlane: deps.controlPlane,
          registry: deps.registry,
          audit: deps.audit,
          applySecurityHeaders: deps.applySecurityHeaders,
          enforceHttps: deps.enforceHttps,
          sendJson: deps.sendJson,
          tls: deps.tls,
        },
  );
}
