import { sha256Canonical } from '@noodle-borg/compiler';
import {
  type ConnectorDef,
  compileConnectors,
  connectorFileSchema,
} from '@noodle-borg/connector-defs';
import { parse as parseYaml } from 'yaml';
import {
  type SourceCredentialAuthority,
  SourceCredentialError,
  type SourceCredentialIdentity,
} from './business-information/source-credential-fence.js';
import { normalizePersistedConnectorsForCompile } from './connector-normalize.js';
import { buildCredentialBindingIndex } from './credential-binding-index.js';
import type { ServerRegistry } from './registry.js';
import { type ConfigValueMetadata, scopeChain } from './store/config-values.js';

/** Capture only the source connector's declared dependencies; unrelated business settings do not invalidate it. */
export function sourceConfigurationAuthority(
  getRegistry: () => Pick<
    ServerRegistry,
    'getActiveByTenant' | 'getDeploymentSource' | 'configStore'
  >,
  credential?: SourceCredentialAuthority,
): SourceCredentialAuthority {
  return {
    async withCurrent(binding, work) {
      const registry = getRegistry();
      const target = await registry.getActiveByTenant(binding.scope);
      const deployed = target?.deploymentId
        ? await registry.getDeploymentSource(binding.scope, target.deploymentId)
        : undefined;
      if (!target || !deployed?.connectors || !registry.configStore.transactConfig)
        throw new SourceCredentialError();
      const file = connectorFileSchema.parse(
        parseYaml(normalizePersistedConnectorsForCompile(deployed.connectors)),
      );
      const selected = new Map<ConnectorDef, Set<string>>();
      const visit = (definition: ConnectorDef | undefined, name: string) => {
        const operation = definition?.operations[name];
        if (!definition || !operation) throw new SourceCredentialError();
        const names = selected.get(definition) ?? new Set<string>();
        if (names.has(name)) return;
        names.add(name);
        selected.set(definition, names);
        if ('calls' in operation)
          for (const call of Object.values(operation.calls ?? {})) {
            const [id, child] = call.split('.');
            const matches = file.connectors.filter((item) => item.id === id);
            if (matches.length !== 1 || !child) throw new SourceCredentialError();
            visit(matches[0], child);
          }
      };
      visit(
        file.connectors.find(
          (item) =>
            item.id === binding.scan.connector && item.version === binding.scan.connectorVersion,
        ),
        binding.scan.operation,
      );
      const connectors = [...selected].map(([definition, names]) => ({
        ...definition,
        operations: Object.fromEntries(
          Object.entries(definition.operations).filter(([name]) => names.has(name)),
        ),
      }));
      const compiled = compileConnectors(JSON.stringify({ connectors }));
      if (!compiled.ok) throw new SourceCredentialError();
      const variables = new Set(compiled.variableBindings);
      const secrets = new Set(
        compiled.secretBindings.flatMap((item) => (item.secretRef ? [item.secretRef] : [])),
      );
      const account = [...buildCredentialBindingIndex(target.served.artifact).byKey.values()].find(
        (item) =>
          item.descriptor.connectionId === binding.bindingReference &&
          item.descriptor.connectorId === binding.scan.connector &&
          item.descriptor.operation === binding.scan.operation,
      )?.source;
      for (const match of JSON.stringify(account ?? {}).matchAll(/\$\{env\.([A-Za-z0-9_]+)\}/g))
        if (match[1]) variables.add(match[1]);
      if (account?.kind === 'managedSecret') secrets.add(account.secret);
      if (account?.kind === 'clientCredentials') secrets.add(account.clientSecret);
      const defaults =
        target.served.artifact.server.variables?.filter((item) => variables.has(item.name)) ?? [];
      return registry.configStore.transactConfig(binding.scope.org, async (transaction) => {
        if ((await registry.getActiveByTenant(binding.scope))?.deploymentId !== target.deploymentId)
          throw new SourceCredentialError();
        const effective = new Map<string, ConfigValueMetadata>();
        for (const scope of scopeChain({ level: 'env', ...binding.scope }))
          for (const kind of ['variable', 'secret'] as const) {
            for (const row of await transaction.listConfigValues(kind, scope)) {
              if (!(kind === 'variable' ? variables : secrets).has(row.name)) continue;
              if (!row.generation) throw new SourceCredentialError();
              const key = `${kind}:${row.name}`;
              if (
                row.valueOrigin !== 'default' ||
                !effective.has(key) ||
                effective.get(key)?.valueOrigin === 'default'
              )
                effective.set(key, row);
            }
          }
        const configuration = sha256Canonical({
          connectors,
          account,
          defaults: defaults
            .filter((item) => !effective.has(`variable:${item.name}`))
            .map((item) => ({ name: item.name, default: item.default })),
          rows: [...effective]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, row]) => [key, row.scope, row.generation]),
        });
        const guarded = async (identity: SourceCredentialIdentity | undefined) =>
          work({ ...identity, configuration });
        return credential ? credential.withCurrent(binding, guarded) : work({ configuration });
      });
    },
  };
}
