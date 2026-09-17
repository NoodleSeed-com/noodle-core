import { describe, it } from 'vitest';
import { webExtractAdapterConformance } from '../src/conformance.js';

describe('deterministic adapter conformance', () => {
  for (const test of webExtractAdapterConformance(() => ({
    async read({ url, signal, beforeRequest }) {
      signal.throwIfAborted();
      beforeRequest();
      if (url.endsWith('/refused')) throw new Error('refused');
      return {
        url,
        title: 'Reference',
        text: 'Public reference text',
        links: [],
        retrievedAt: new Date().toISOString(),
      };
    },
  })))
    it(test.name, test.run);
});
