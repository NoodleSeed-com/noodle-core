import { describe, expect, it } from 'vitest';
import {
  boundedDistance,
  COMPILE_ERROR_DOC_ANCHORS,
  docAnchorFor,
  nearestMatch,
  rankSuggestions,
  suggestionFields,
} from '../src/suggest.js';

describe('boundedDistance', () => {
  it('is 0 for identical strings', () => {
    expect(boundedDistance('get_order', 'get_order', 3)).toBe(0);
  });

  it('counts a single substitution', () => {
    expect(boundedDistance('cat', 'cap', 3)).toBe(1);
  });

  it('counts a single insertion (typo of a longer name)', () => {
    expect(boundedDistance('get_ordr', 'get_order', 3)).toBe(1);
  });

  it('returns the true distance up to the cap (kitten/sitting = 3)', () => {
    expect(boundedDistance('kitten', 'sitting', 3)).toBe(3);
  });

  it('early-exits to cap+1 when the true distance exceeds the cap', () => {
    expect(boundedDistance('kitten', 'sitting', 2)).toBe(3); // cap 2 -> 3
    expect(boundedDistance('abcdefgh', 'xyz', 3)).toBe(4); // length gap alone exceeds cap
  });
});

describe('nearestMatch', () => {
  const ops = ['get_order', 'get_tracking'];

  it('returns the candidate for a single-char typo within the threshold', () => {
    expect(nearestMatch('get_ordr', ops)).toBe('get_order');
  });

  it('returns undefined for a far-off probe (no spurious correction)', () => {
    expect(nearestMatch('delete_everything', ops)).toBeUndefined();
  });

  it('matches case-insensitively', () => {
    expect(nearestMatch('GET_ORDR', ops)).toBe('get_order');
  });

  it('is safe with no candidates', () => {
    expect(nearestMatch('anything', [])).toBeUndefined();
  });

  it('breaks ties to the lexicographically smaller candidate (deterministic)', () => {
    expect(nearestMatch('ab', ['ad', 'ac'])).toBe('ac');
  });
});

describe('rankSuggestions', () => {
  it('ranks the closest candidates first', () => {
    expect(rankSuggestions('get_ordr', ['get_tracking', 'get_order'])).toEqual([
      'get_order',
      'get_tracking',
    ]);
  });

  it('offers a candidate set even when nothing is a likely single correction', () => {
    expect(rankSuggestions('delete_everything', ['get_order', 'get_tracking'])).toContain(
      'get_order',
    );
  });

  it('respects the limit', () => {
    expect(rankSuggestions('a', ['b', 'c', 'd', 'e'], 2)).toHaveLength(2);
  });

  it('is empty with no candidates', () => {
    expect(rankSuggestions('a', [])).toEqual([]);
  });
});

describe('suggestionFields', () => {
  it('attaches didYouMean + suggestions + a stable docAnchor for a near typo', () => {
    const fields = suggestionFields('unknown_operation', 'get_ordr', ['get_order', 'get_tracking']);
    expect(fields.didYouMean).toBe('get_order');
    expect(fields.suggestions).toContain('get_order');
    expect(fields.docAnchor).toBe('compile-errors#unknown-operation');
  });

  it('omits didYouMean for a far probe but still offers the candidate set + docAnchor', () => {
    const fields = suggestionFields('unknown_operation', 'delete_everything', [
      'get_order',
      'get_tracking',
    ]);
    expect(fields.didYouMean).toBeUndefined();
    expect(fields.suggestions).toContain('get_order');
    expect(fields.docAnchor).toBe('compile-errors#unknown-operation');
  });

  it('omits didYouMean and suggestions when there are no candidates, keeping docAnchor', () => {
    const fields = suggestionFields('connector_not_in_catalog', 'acme', []);
    expect(fields.didYouMean).toBeUndefined();
    expect(fields.suggestions).toBeUndefined();
    expect(fields.docAnchor).toBe('compile-errors#connector-not-in-catalog');
  });
});

describe('docAnchorFor', () => {
  it('maps an error code to a hyphenated anchor', () => {
    expect(docAnchorFor('unknown_schema_ref')).toBe('compile-errors#unknown-schema-ref');
  });

  it('maps every product-guide and App Package error to its documented repair anchor', () => {
    expect(COMPILE_ERROR_DOC_ANCHORS).toMatchObject({
      agent_guide_invalid: 'compile-errors#agent-guide-invalid',
      agent_guide_duplicate_workflow: 'compile-errors#agent-guide-duplicate-workflow',
      agent_guide_duplicate_example: 'compile-errors#agent-guide-duplicate-example',
      agent_guide_example_workflow_missing: 'compile-errors#agent-guide-example-workflow-missing',
      agent_guide_capability_missing: 'compile-errors#agent-guide-capability-missing',
      agent_guide_capability_kind: 'compile-errors#agent-guide-capability-kind',
      app_package_sensitive_content: 'compile-errors#app-package-sensitive-content',
    });
    for (const [code, anchor] of Object.entries(COMPILE_ERROR_DOC_ANCHORS)) {
      expect(docAnchorFor(code)).toBe(anchor);
    }
  });

  it('does not read inherited object properties as configured anchors', () => {
    expect(docAnchorFor('constructor')).toBe('compile-errors#constructor');
    expect(docAnchorFor('toString')).toBe('compile-errors#toString');
  });
});
