// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { visitorIdForSource } from '../src/visitor-id.js';

describe('visitorIdForSource', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('creates one identifier per source and reuses it', () => {
    const first = visitorIdForSource('pub_1||');
    expect(first).toBeTruthy();
    expect(visitorIdForSource('pub_1||')).toBe(first);
    // Two assistants on one page are two buckets, not one shared allowance.
    expect(visitorIdForSource('pub_2||')).not.toBe(first);
  });

  it('stores an opaque identifier and never a credential', () => {
    visitorIdForSource('pub_1||');
    const entries = Object.entries({ ...localStorage });
    expect(entries).toHaveLength(1);
    const [key, value] = entries[0] ?? [];
    // Namespaced so an embedder can see whose key it is, and a UUID so it carries nothing else.
    expect(key).toBe('noodleseed.assistant.visitor.pub_1||');
    expect(value).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('degrades to no identifier rather than throwing when storage is unavailable', () => {
    // Private modes and blocked site data throw on access; the visitor loses a fairness tier, not
    // their conversation.
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    });
    expect(visitorIdForSource('pub_1||')).toBeUndefined();
  });

  it('still serves this page when storage reads but cannot write', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    expect(visitorIdForSource('pub_1||')).toMatch(/^[0-9a-f-]{36}$/);
  });
});
