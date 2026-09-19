import { describe } from 'vitest';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';
import { businessPageConformance } from './business-page-conformance.js';

describe('hosted business pages (memory, development only)', () => {
  businessPageConformance(async () => new InMemoryBusinessInformationStore());
});
