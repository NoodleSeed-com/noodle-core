import type { Logger, TlsPosture } from '@noodle-borg/transport-http';
import type { ServiceOptions } from '../options.js';
import type { ServerRegistry } from '../registry.js';
import type { AuditSink } from '../store/audit.js';
import type { ControlPlaneStore } from '../store.js';
import type { DeveloperMcpMountOptions } from './mount.js';

export interface DeveloperMcpServiceOptions {
  readonly registry: ServerRegistry;
  readonly controlPlane: ControlPlaneStore;
  readonly audit: AuditSink;
  readonly logger: Logger;
  readonly tls: TlsPosture;
  readonly maxBody: number;
  readonly options: ServiceOptions;
}

/** Project the service composition root into the narrower request-scoped Developer MCP mount. */
export function createDeveloperMcpMountOptions(
  input: DeveloperMcpServiceOptions,
): DeveloperMcpMountOptions {
  const { options } = input;
  return {
    registry: input.registry,
    controlPlane: input.controlPlane,
    audit: input.audit,
    logger: input.logger,
    tls: input.tls,
    maxBody: input.maxBody,
    protocolMode: options.mcpProtocolMode ?? 'dual',
    ...(options.developerGrantStore === undefined ? {} : { grants: options.developerGrantStore }),
    ...(options.verifyOwnerToken === undefined
      ? {}
      : { verifyOwnerToken: options.verifyOwnerToken }),
    ...(options.userAppLogStore === undefined ? {} : { logs: options.userAppLogStore }),
    ...(options.requestEventStore === undefined
      ? {}
      : { requestEvents: options.requestEventStore }),
    ...(options.publicBaseUrl === undefined ? {} : { publicBaseUrl: options.publicBaseUrl }),
    ...(options.mcpPublicRouting?.publicBaseDomain === undefined
      ? {}
      : { publicBaseDomain: options.mcpPublicRouting.publicBaseDomain }),
    ...(options.clock === undefined ? {} : { now: options.clock }),
  };
}
