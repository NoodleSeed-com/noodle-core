import { MapServiceBroker } from '@noodle-borg/runtime';
import type { ServedTarget } from '@noodle-borg/transport-http';
import type {
  BusinessInformationStore,
  SolutionInstallation,
} from './business-information/portable.js';
import { PortableConnections, type PortableConnectionsOptions } from './connections/service.js';
import {
  type ApplicationConnections,
  ConnectionError,
  type ConnectionKey,
  type ConnectionTarget,
} from './connections/types.js';
import { buildCredentialBindingIndex } from './credential-binding-index.js';
import type { LocalExternalCredentialProvider } from './external-credential-exchange.js';
import type { ServerRegistry } from './registry.js';
import { sourceCredentialAuthority } from './source-credential-authority.js';

export interface ApplicationConnectionsOptions
  extends Pick<
    PortableConnectionsOptions,
    'store' | 'providers' | 'credentialEpoch' | 'portalOrigins' | 'guardedFetch' | 'now' | 'audit'
  > {
  readonly installations: Pick<
    BusinessInformationStore,
    'listInstallations' | 'getInstallation' | 'getGrant'
  >;
  readonly getRegistry: () => Pick<ServerRegistry, 'getActiveByTenant'>;
}
/** Compose existing installation authority, compiled bindings and portable credential custody. */
export function createApplicationConnections(options: ApplicationConnectionsOptions) {
  async function resolveConnectionTargets(
    installation: SolutionInstallation,
  ): Promise<readonly ConnectionTarget[]> {
    const scope = installation.scope;
    const served = await options
      .getRegistry()
      .getActiveByTenant({ org: scope.org, app: scope.app, env: scope.env });
    if (!served) return [];
    const grouped = new Map<string, ConnectionTarget>();
    for (const { descriptor } of buildCredentialBindingIndex(served.served.artifact)
      .externalExchange) {
      const previous = grouped.get(descriptor.connectionId);
      if (previous && previous.connectionConfigRevision !== descriptor.connectionConfigRevision)
        throw new ConnectionError('connection_conflict');
      const key = { ...scope, connectionId: descriptor.connectionId };
      const provider = await options.providers(key);
      grouped.set(descriptor.connectionId, {
        key,
        label: provider?.label ?? descriptor.connectionId,
        connectionConfigRevision: descriptor.connectionConfigRevision,
        requiredScopes: [
          ...new Set([...(previous?.requiredScopes ?? []), ...descriptor.requiredScopes]),
        ].sort(),
      });
    }
    return [...grouped.values()].sort((left, right) =>
      left.key.connectionId.localeCompare(right.key.connectionId),
    );
  }
  async function resolveTarget(key: ConnectionKey): Promise<ConnectionTarget | undefined> {
    const installation = await options.installations.getInstallation(key);
    return (
      installation &&
      (await resolveConnectionTargets(installation)).find(
        (target) => target.key.connectionId === key.connectionId,
      )
    );
  }
  const connections = new PortableConnections({
    ...options,
    resolveTarget,
    authorize: async (key, actor) => {
      const installation = await options.installations.getInstallation(key);
      if (!installation) return false;
      const grant = await options.installations.getGrant(key, actor);
      return grant?.role === 'administrator' && grant.revokedAt === undefined;
    },
  });
  async function installationFor(served: ServedTarget): Promise<SolutionInstallation | undefined> {
    if (!served.org || !served.app || !served.environment) return undefined;
    const matches = (await options.installations.listInstallations(served.org)).filter(
      (item) => item.scope.app === served.app && item.scope.env === served.environment,
    );
    if (matches.length > 1) throw new ConnectionError('connection_conflict');
    return matches[0];
  }
  const localProvider: LocalExternalCredentialProvider = {
    async getCredential(input) {
      const parts = input.tenantId.split('/');
      const [org, app, env] = parts;
      if (parts.length !== 3 || !org || !app || !env || !input.expectedConnectionGeneration)
        throw new ConnectionError('connection_denied');
      const served = await options.getRegistry().getActiveByTenant({ org, app, env });
      if (!served || served.deploymentId !== input.deploymentId)
        throw new ConnectionError('connection_denied');
      const allowed = buildCredentialBindingIndex(served.served.artifact).byKey.get(
        MapServiceBroker.bindingKey(input.descriptor),
      );
      if (allowed?.source.kind !== 'externalExchange')
        throw new ConnectionError('connection_denied');
      const installation = await installationFor(served);
      if (!installation?.intakeActive) throw new ConnectionError('connection_unavailable');
      const target = (await resolveConnectionTargets(installation)).find(
        (value) =>
          value.key.connectionId === input.descriptor.connectionId &&
          value.connectionConfigRevision === input.descriptor.connectionConfigRevision,
      );
      if (!target) throw new ConnectionError('connection_unavailable');
      return connections.acquire(
        target,
        input.descriptor.requiredScopes,
        input.expectedConnectionGeneration,
      );
    },
  };
  async function readGenerations(served: ServedTarget): Promise<Readonly<Record<string, string>>> {
    const installation = await installationFor(served);
    const values: Record<string, string> = {};
    for (const { descriptor } of buildCredentialBindingIndex(served.served.artifact)
      .externalExchange)
      values[descriptor.connectionId] =
        `unconfigured:${options.credentialEpoch}:${descriptor.connectionConfigRevision}`;
    if (!installation) return values;
    for (const target of await resolveConnectionTargets(installation)) {
      const view = await connections.inspect(target);
      values[target.key.connectionId] =
        view.state === 'ready'
          ? (await connections.readGeneration(target)).generation
          : `${view.state}:${view.revision}:${options.credentialEpoch}:${target.connectionConfigRevision}`;
    }
    return values;
  }
  return {
    connections,
    resolveConnectionTargets,
    localProvider,
    readGenerations,
    sourceCredentials: sourceCredentialAuthority(options, connections, resolveConnectionTargets),
  } satisfies ApplicationConnections;
}
