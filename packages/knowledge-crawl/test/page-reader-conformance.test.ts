import { webExtractAdapterConformance } from '@noodle-borg/managed-capabilities/testing';
import { describe, it } from 'vitest';
import { PublicPageReader } from '../src/page-reader.js';

describe('first-party managed and portable reader conformance', () => {
  for (const test of webExtractAdapterConformance(
    () =>
      new PublicPageReader({
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /');
          if (url.endsWith('/refused')) return new Response('Unusable', { status: 503 });
          return new Response('<title>Reference</title><p>Public reference text</p>', {
            headers: { 'content-type': 'text/html' },
          });
        },
      }),
  ))
    it(test.name, test.run);
});
