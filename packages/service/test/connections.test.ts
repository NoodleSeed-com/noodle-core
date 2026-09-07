import { InMemoryConnectionStore } from '../src/connections/store.js';
import { describePortableConnections } from './connections-suite.js';

describePortableConnections(async () => {
  const store = new InMemoryConnectionStore();
  return { store, otherStore: store };
});
