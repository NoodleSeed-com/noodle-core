import { InMemoryConnectionStore } from '../src/connections/store.js';
import { describeConnectionAuthority } from './connections-authority-suite.js';
import { describePortableConnections } from './connections-suite.js';

describePortableConnections(async () => {
  const store = new InMemoryConnectionStore();
  return { store, otherStore: store };
});
describeConnectionAuthority(async () => new InMemoryConnectionStore());
