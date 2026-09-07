import { resolveConfigScope } from '../src/store.js';

export const credentialBrokerScope = resolveConfigScope({
  org: 'acme',
  app: 'demo',
  env: 'prod',
});
