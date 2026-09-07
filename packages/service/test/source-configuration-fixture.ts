import { InMemoryConnectorRegistry, StaticServiceBroker } from '@noodle-borg/runtime';
import type { ConfigStore } from '../src/store/config-values.js';
import { boundArtifact } from './external-credential-exchange.fixtures.js';
import { sourceBinding } from './source-credential-fence-suite.js';

export const sourceConnectorDocument = JSON.stringify({
  connectors: [
    {
      id: 'gmail',
      version: '1.0.0',
      http: {
        baseUrl: '${env.SOURCE_ORIGIN}',
        allowedOrigins: ['https://source.example'],
        auth: { kind: 'bearer', secret: 'SOURCE_TOKEN' },
      },
      operations: {
        scan: {
          type: 'read',
          method: 'GET',
          path: '/records',
          input: { type: 'object' },
          output: { type: 'object' },
          request: { query: { resource: '${env.SOURCE_RESOURCE}' } },
        },
        unused: {
          type: 'read',
          method: 'GET',
          path: '/other',
          input: { type: 'object' },
          output: { type: 'object' },
          request: { query: { unused: '${env.UNRELATED}' } },
        },
      },
    },
  ],
});
export function sourceConfigurationFixture(configStore: ConfigStore) {
  const declaration = {
    ...sourceBinding,
    scan: {
      ...sourceBinding.scan,
      connector: 'gmail',
      connectorVersion: '1.0.0',
      operation: 'scan',
    },
  };
  const artifact = boundArtifact('inventory', declaration.bindingReference ?? 'account', 'scan');
  const target = {
    org: declaration.scope.org,
    app: declaration.scope.app,
    environment: declaration.scope.env,
    deploymentId: 'installed-one',
    served: {
      artifact,
      deps: {
        connectors: new InMemoryConnectorRegistry([]),
        broker: new StaticServiceBroker({ token: 'unused' }),
      },
    },
  };
  const registry = {
    configStore,
    getActiveByTenant: async () => target,
    getDeploymentSource: async () => ({ manifest: '{}', connectors: sourceConnectorDocument }),
  };
  return { declaration, registry };
}
