import { describe } from 'vitest';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';
import { describeBusinessInformationStore } from './business-information-store-suite.js';

describe('in-memory business information store', () => {
  let now = new Date('2030-01-01T00:00:00.000Z');
  describeBusinessInformationStore(async () => {
    now = new Date('2030-01-01T00:00:00.000Z');
    return {
      store: new InMemoryBusinessInformationStore({ now: () => new Date(now) }),
      advance: (milliseconds) => {
        now = new Date(now.getTime() + milliseconds);
      },
    };
  });
});
