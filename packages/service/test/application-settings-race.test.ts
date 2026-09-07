import { ServerRegistry } from '../src/registry.js';
import { InMemoryConfigStore } from '../src/store/config-values.js';
import { InMemoryArtifactStore } from '../src/store/in-memory.js';
import { settingsDeploymentRaceSuite } from './application-settings-race-suite.js';

settingsDeploymentRaceSuite('memory settings/deployment authority', async () => {
  const config = new InMemoryConfigStore();
  const artifacts = new InMemoryArtifactStore();
  return { config, artifacts, registry: new ServerRegistry(artifacts, undefined, config) };
});
