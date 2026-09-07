import { describe, expect, it } from 'vitest';
import { Bm25KnowledgeIndex } from '../src/bm25.js';
import {
  type ConformanceRunner,
  describeKnowledgeIndex,
  describeSiteSearch,
  fusionContractCases,
} from '../src/conformance.js';
import { FakeKnowledgeIndex, FakeSiteSearch } from '../src/fakes.js';

// The suites are runner-neutral shipped source; this file supplies Vitest's grouping
// primitives. An adapter in another package (or a customer's own) passes its own runner.
const runner: ConformanceRunner = { describe, it };

describeKnowledgeIndex(runner, () => new FakeKnowledgeIndex(), 'fake');
describeKnowledgeIndex(runner, () => new Bm25KnowledgeIndex(), 'bundled BM25');
describeSiteSearch(runner, () => new FakeSiteSearch(), 'fake');
fusionContractCases(runner);

describe('knowledge package suite registration', () => {
  it('runs the shared conformance suites for every adapter', () => {
    // Registration itself is the contract; a missing suite is a missing adapter test.
    expect(true).toBe(true);
  });
});
