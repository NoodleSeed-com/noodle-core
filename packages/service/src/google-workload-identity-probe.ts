import {
  type CredentialProbeRouteResolver,
  type CredentialRequest,
  credentialUnavailableErrorSnapshot,
  type DelegatedCredentialProbe,
  type DownstreamCredential,
} from '@noodle-borg/runtime';
import type { AllowedCredentialBinding } from './credential-binding-index.js';
import { resolveCredentialProbeRoute } from './credential-probe-route.js';
import type { GoogleWorkloadIdentityOptions } from './google-workload-identity.js';

/** Run credential-only Google exchanges and emit diagnostics safe for operators and logs. */
export async function probeGoogleWorkloadIdentityCredentials(input: {
  readonly bindings: readonly AllowedCredentialBinding[];
  readonly options: GoogleWorkloadIdentityOptions | undefined;
  readonly getCredential: (request: CredentialRequest) => Promise<DownstreamCredential>;
  readonly resolveRoute?: CredentialProbeRouteResolver;
}): Promise<readonly DelegatedCredentialProbe[]> {
  const probes: DelegatedCredentialProbe[] = [];
  for (const allowed of input.bindings) {
    const descriptor = allowed.descriptor;
    const route = resolveCredentialProbeRoute({
      connectorId: descriptor.connectorId,
      connectorVersion: descriptor.connectorVersion,
      ...(allowed.customerEndpoint === undefined
        ? {}
        : { customerEndpoint: allowed.customerEndpoint }),
      ...(input.resolveRoute === undefined ? {} : { resolveRoute: input.resolveRoute }),
    });
    if (!route.ok) {
      probes.push({
        ...probeIdentity(descriptor),
        ok: false,
        reason: 'connector_route_unavailable',
      });
      continue;
    }
    try {
      await input.getCredential({
        ...descriptor,
        ...(route.route === undefined ? {} : { route: route.route }),
        ...(input.options === undefined
          ? {}
          : {
              tenantId: input.options.tenant,
              deploymentId: input.options.deployment,
            }),
      });
      probes.push({
        ...probeIdentity(descriptor),
        ok: true,
      });
    } catch (error) {
      const diagnostic = credentialUnavailableErrorSnapshot(error);
      probes.push({
        ...probeIdentity(descriptor),
        ok: false,
        reason: diagnostic?.reason ?? 'credential_exchange_failed',
        ...(diagnostic?.fix === undefined ? {} : { fix: diagnostic.fix }),
        ...(diagnostic?.next === undefined ? {} : { next: diagnostic.next }),
      });
    }
  }
  return probes;
}

function probeIdentity(descriptor: AllowedCredentialBinding['descriptor']): {
  readonly connectorId: string;
  readonly operation: string;
  readonly bindingId: string;
  readonly connectionId: string;
  readonly profile: string;
  readonly authKind: 'googleWorkloadIdentity';
} {
  return {
    connectorId: descriptor.connectorId,
    operation: descriptor.operation,
    bindingId: descriptor.bindingId,
    connectionId: descriptor.connectionId,
    profile: descriptor.profile,
    authKind: 'googleWorkloadIdentity',
  };
}
