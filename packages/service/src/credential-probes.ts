import type { SecretBinding } from '@noodle-borg/connector-defs';
import {
  type CredentialProbeRouteResolver,
  type CredentialRequest,
  credentialUnavailableErrorSnapshot,
  type DelegatedCredentialProbe,
  type DownstreamCredential,
  MapServiceBroker,
} from '@noodle-borg/runtime';
import type { AllowedCredentialBinding } from './credential-binding-index.js';
import { resolveCredentialProbeRoute } from './credential-probe-route.js';
import type { ExternalCredentialBindingBroker } from './external-credential-binding-broker.js';

/** Safely probe broker exchanges without invoking any connector business operation. */
export async function probeCredentials(input: {
  readonly caller: NonNullable<CredentialRequest['caller']>;
  readonly customerIssuer?: string;
  readonly externalBindings: readonly AllowedCredentialBinding[];
  readonly externalBroker: ExternalCredentialBindingBroker | undefined;
  readonly bindings: Iterable<SecretBinding>;
  readonly getCredential: (request: CredentialRequest) => Promise<DownstreamCredential>;
  readonly resolveRoute?: CredentialProbeRouteResolver;
}): Promise<readonly DelegatedCredentialProbe[]> {
  const seen = new Set<string>();
  const probes: DelegatedCredentialProbe[] = [];
  for (const binding of input.externalBindings) {
    const descriptor = binding.descriptor;
    const route = resolveCredentialProbeRoute({
      connectorId: descriptor.connectorId,
      connectorVersion: descriptor.connectorVersion,
      ...(binding.customerEndpoint === undefined
        ? {}
        : { customerEndpoint: binding.customerEndpoint }),
      ...(input.resolveRoute === undefined ? {} : { resolveRoute: input.resolveRoute }),
    });
    if (!route.ok) {
      probes.push({
        connectorId: descriptor.connectorId,
        operation: descriptor.operation,
        bindingId: descriptor.bindingId,
        connectionId: descriptor.connectionId,
        profile: descriptor.profile,
        authKind: 'externalExchange',
        ok: false,
        reason: 'connector_route_unavailable',
      });
      continue;
    }
    try {
      await input.getCredential({
        ...descriptor,
        ...(route.route === undefined ? {} : { route: route.route }),
        ...(input.externalBroker === undefined
          ? {}
          : {
              tenantId: input.externalBroker.options.tenant,
              deploymentId: input.externalBroker.options.deployment,
            }),
      });
      probes.push({
        connectorId: descriptor.connectorId,
        operation: descriptor.operation,
        bindingId: descriptor.bindingId,
        connectionId: descriptor.connectionId,
        profile: descriptor.profile,
        authKind: 'externalExchange',
        ok: true,
      });
    } catch (error) {
      const diagnostic = credentialUnavailableErrorSnapshot(error);
      probes.push({
        connectorId: descriptor.connectorId,
        operation: descriptor.operation,
        bindingId: descriptor.bindingId,
        connectionId: descriptor.connectionId,
        profile: descriptor.profile,
        authKind: 'externalExchange',
        ok: false,
        reason: diagnostic?.reason ?? 'credential_exchange_failed',
      });
    }
  }
  for (const binding of input.bindings) {
    const authKind = binding.authKind;
    if (
      authKind !== 'delegatedOAuth' &&
      authKind !== 'delegatedSessionCookie' &&
      authKind !== 'delegatedTokenExchange'
    ) {
      continue;
    }
    const key = MapServiceBroker.key(binding.connectorId, binding.operation);
    if (seen.has(key)) continue;
    seen.add(key);
    const route = resolveCredentialProbeRoute({
      connectorId: binding.connectorId,
      connectorVersion: binding.connectorVersion,
      ...(binding.customerEndpoint === undefined
        ? {}
        : { customerEndpoint: binding.customerEndpoint }),
      ...(input.resolveRoute === undefined ? {} : { resolveRoute: input.resolveRoute }),
    });
    if (!route.ok) {
      probes.push({
        connectorId: binding.connectorId,
        ...(binding.operation === undefined ? {} : { operation: binding.operation }),
        authKind,
        ok: false,
        reason: 'connector_route_unavailable',
      });
      continue;
    }
    try {
      await input.getCredential({
        connectorId: binding.connectorId,
        connectorVersion: binding.connectorVersion,
        operation: binding.operation ?? '',
        caller: input.caller,
        ...(input.customerIssuer === undefined ? {} : { customerIssuer: input.customerIssuer }),
        ...(route.route === undefined ? {} : { route: route.route }),
      });
      probes.push({
        connectorId: binding.connectorId,
        ...(binding.operation === undefined ? {} : { operation: binding.operation }),
        authKind,
        ok: true,
      });
    } catch (error) {
      const diagnostic = credentialUnavailableErrorSnapshot(error);
      probes.push({
        connectorId: binding.connectorId,
        ...(binding.operation === undefined ? {} : { operation: binding.operation }),
        authKind,
        ok: false,
        reason: diagnostic?.reason ?? 'credential_exchange_failed',
        ...(diagnostic?.fix === undefined
          ? {
              fix: 'Check the delegated connector configuration and downstream token endpoint.',
            }
          : { fix: diagnostic.fix }),
        ...(diagnostic?.next === undefined ? {} : { next: diagnostic.next }),
      });
    }
  }
  return probes;
}
