import { describe } from 'vitest';
import { InMemorySourceIngestionStore } from '../src/business-information/source-ingestion-memory-store.js';
import { refreshBinding, sourceRefreshConformance } from './source-refresh-conformance.js';

describe('memory source refresh acceptance', () => {
  sourceRefreshConformance(async () => ({
    store: new InMemorySourceIngestionStore({
      identityKey: 'fixture-source-identity-at-least-32-bytes',
    }),
    binding: refreshBinding('memory'),
  }));
});
