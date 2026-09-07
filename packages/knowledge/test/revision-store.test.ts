import { describe, expect, it } from 'vitest';
import { InMemoryKnowledgeRevisionStore, revisionContentHash } from '../src/revision-store.js';
import { describeRevisionStore } from './revision-store-parity.js';

describe('in-memory knowledge revision store', () => {
  describeRevisionStore(async (codec) => new InMemoryKnowledgeRevisionStore(codec));
});

describe('revision identity', () => {
  const doc = { sha256: 'a'.repeat(64), path: 'docs/a.md', title: 'Guide' };

  /**
   * Identity must cover the metadata a citation shows, not just the bytes: a deploy that only
   * retitles a document (or moves it, or changes its source URL) must produce a NEW revision,
   * or content-hash reuse pins the deployment to the stale metadata and rollback restores the
   * wrong titles. The first shipped hash covered sha256s alone.
   */
  it('changes when title, path, or sourceUrl change and holds when nothing does', () => {
    const base = revisionContentHash([doc]);
    expect(revisionContentHash([{ ...doc }])).toBe(base);
    expect(revisionContentHash([{ ...doc, title: 'Renamed' }])).not.toBe(base);
    expect(revisionContentHash([{ ...doc, path: 'docs/b.md' }])).not.toBe(base);
    expect(revisionContentHash([{ ...doc, sourceUrl: 'https://acme.test/a' }])).not.toBe(base);
  });

  it('is delimiter-safe against crafted titles', () => {
    const crafted = revisionContentHash([{ ...doc, title: 'Guide\ndocs/b.md' }]);
    const twoField = revisionContentHash([{ ...doc, title: 'Guide', path: 'docs/b.md' }]);
    expect(crafted).not.toBe(twoField);
  });
});
