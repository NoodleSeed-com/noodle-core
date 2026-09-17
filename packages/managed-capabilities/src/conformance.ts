import assert from 'node:assert/strict';
import { CapabilityBudget } from './budget.js';
import type { WebCapability } from './contracts.js';
import { executeWebExtract, type PublicPageReaderPort } from './executor.js';

export type PageReaderScenario = 'page' | 'refused' | 'partial';
/** Runner-neutral adapter contract. Fixtures serve public text at /ok and refuse /refused. */
export function webExtractAdapterConformance(
  create: (scenario: PageReaderScenario) => PublicPageReaderPort,
) {
  const declaration: WebCapability = {
    name: 'pages',
    class: 'web.extract.v1',
    title: 'Read pages',
    description: 'Read public evidence.',
    provider: { kind: 'noodle-managed' },
  };
  const input = { urls: ['https://example.com/ok'] };
  const deps = (reader: PublicPageReaderPort) => ({
    reader,
    budget: new CapabilityBudget(),
    enabled: true,
    authorized: true,
    operatorPolicy: {},
    admit: async () => true,
  });
  return [
    {
      name: 'normalizes source evidence without adapter-specific data',
      run: async () => {
        const result = await executeWebExtract(declaration, input, deps(create('page')));
        assert.equal(result.status, 'complete');
        assert.equal(result.items[0]?.sourceRef, result.sources[0]?.ref);
        assert.equal(result.sources[0]?.url, input.urls[0]);
        assert.ok(result.items[0]?.content.text.includes('Public reference text'));
      },
    },
    {
      name: 'fails safely when no source is usable',
      run: async () => {
        await assert.rejects(
          executeWebExtract(
            declaration,
            { urls: ['https://example.com/refused'] },
            deps(create('refused')),
          ),
          { code: 'capability_provider_failed' },
        );
      },
    },
    {
      name: 'attributes partial results to their requested inputs',
      run: async () => {
        const result = await executeWebExtract(
          declaration,
          { urls: [...input.urls, 'https://example.com/refused'] },
          deps(create('partial')),
        );
        assert.equal(result.status, 'partial');
        assert.equal(result.items.length, 1);
        assert.equal(result.items[0]?.requestIndex, 0);
        assert.equal(result.warnings[0]?.requestIndex, 1);
      },
    },
    {
      name: 'rejects unsafe and cancelled requests before adapter dispatch',
      run: async () => {
        let calls = 0;
        const reader = create('page');
        const observed: PublicPageReaderPort = {
          read: (request) => {
            calls += 1;
            return reader.read(request);
          },
        };
        await assert.rejects(
          executeWebExtract(declaration, { urls: ['https://127.0.0.1/'] }, deps(observed)),
        );
        await assert.rejects(
          executeWebExtract(declaration, input, { ...deps(observed), signal: AbortSignal.abort() }),
          { code: 'capability_cancelled' },
        );
        assert.equal(calls, 0);
      },
    },
  ] as const;
}
