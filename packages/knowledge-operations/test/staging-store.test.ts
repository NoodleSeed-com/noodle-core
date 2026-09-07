import { describe } from 'vitest';
import { InMemoryKnowledgeStagingStore } from '../src/staging-store.js';
import { describeStagingStore } from './staging-store-parity.js';

describe('in-memory knowledge staging store', () => {
  describeStagingStore(async (now) => new InMemoryKnowledgeStagingStore(now));
});
