import { describe, expect, it } from 'vitest';
import { visitorBucket } from '../src/visitor-bucket.js';

/**
 * The visitor identifier is supplied by the browser, so it is a fairness key and nothing else.
 *
 * It cannot be an abuse bound — anyone can clear storage or forge a new value — which is why the
 * per-address tier stays underneath it. What it buys is that a hundred people behind one corporate
 * NAT each get their own allowance instead of racing for a shared ten.
 */
describe('visitorBucket', () => {
  it('turns a client-supplied identifier into a stable opaque bucket', () => {
    const bucket = visitorBucket('v_0123456789abcdef');
    expect(bucket).toMatch(/^vis_[0-9a-f]{32}$/);
    expect(visitorBucket('v_0123456789abcdef')).toBe(bucket);
    expect(visitorBucket('v_fedcba9876543210')).not.toBe(bucket);
  });

  it('never echoes the value it was given', () => {
    // The identifier is the browser's; whatever a page puts in it must not reappear in a counter key,
    // a log line, or an audit payload.
    expect(visitorBucket('user@example.com')).not.toContain('example');
    expect(visitorBucket('user@example.com')).toMatch(/^vis_[0-9a-f]{32}$/);
  });

  it('refuses what it cannot treat as an identifier, rather than inventing a bucket', () => {
    // Absent, empty, or unbounded input falls back to address-only fairness: a lost tier, never a
    // shared one, and never an unbounded hash input from a stranger.
    expect(visitorBucket(undefined)).toBeUndefined();
    expect(visitorBucket('')).toBeUndefined();
    expect(visitorBucket('   ')).toBeUndefined();
    expect(visitorBucket(42)).toBeUndefined();
    expect(visitorBucket({ id: 'v_1' })).toBeUndefined();
    expect(visitorBucket('v'.repeat(129))).toBeUndefined();
    expect(visitorBucket('v'.repeat(128))).toMatch(/^vis_[0-9a-f]{32}$/);
  });
});
