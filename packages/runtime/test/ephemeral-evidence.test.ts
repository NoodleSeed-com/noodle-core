import { describe, expect, it } from 'vitest';
import { attachResultMeta, hasEphemeralEvidence, splitResultMeta } from '../src/result-meta.js';

describe('ephemeral evidence custody metadata', () => {
  it('propagates through composition and cannot be cleared by a later result', () => {
    const output = attachResultMeta({ evidence: 'source text' }, [
      { 'noodle/ephemeralEvidence': true },
      { 'noodle/ephemeralEvidence': false, ui: { resourceUri: 'ui://example' } },
    ]);
    expect(hasEphemeralEvidence(output)).toBe(true);
    expect(splitResultMeta(output).visible).toEqual({ evidence: 'source text' });
  });
  it('does not classify ordinary outputs or untrusted visible fields as custody metadata', () => {
    expect(hasEphemeralEvidence({ text: 'ordinary' })).toBe(false);
    expect(hasEphemeralEvidence({ 'noodle/ephemeralEvidence': true })).toBe(false);
  });
});
