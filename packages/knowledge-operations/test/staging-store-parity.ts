import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import type { KnowledgeStagingStore } from '../src/staging-store.js';

/**
 * One behavioural contract for the encrypted transient staging store (ADR 0202 D5): sealed,
 * content-addressed by tenant + sha256, TTL-bounded, idempotent, tenant-isolated.
 */
export function describeStagingStore(
  makeStore: (now?: () => Date) => Promise<KnowledgeStagingStore>,
): void {
  const tenant = 'acme/app/prod';
  const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

  it('round-trips sealed bytes by tenant and hash', async () => {
    const store = await makeStore();
    const sealed = Buffer.from('sealed-bytes');
    await store.put(tenant, sha('doc'), sealed, 12);
    expect(await store.has(tenant, sha('doc'))).toBe(true);
    expect((await store.get(tenant, sha('doc')))?.equals(sealed)).toBe(true);
  });

  it('re-upload of the same hash is idempotent', async () => {
    const store = await makeStore();
    await store.put(tenant, sha('doc'), Buffer.from('first'), 5);
    await store.put(tenant, sha('doc'), Buffer.from('first'), 5);
    expect((await store.get(tenant, sha('doc')))?.toString('utf8')).toBe('first');
  });

  it('isolates tenants', async () => {
    const store = await makeStore();
    await store.put(tenant, sha('doc'), Buffer.from('mine'), 4);
    expect(await store.has('other/app/prod', sha('doc'))).toBe(false);
    expect(await store.get('other/app/prod', sha('doc'))).toBeUndefined();
  });

  it('sweeps only entries older than the TTL', async () => {
    let current = new Date('2026-08-16T10:00:00Z');
    const store = await makeStore(() => current);
    await store.put(tenant, sha('old'), Buffer.from('old'), 3);
    current = new Date('2026-08-16T10:50:00Z');
    await store.put(tenant, sha('new'), Buffer.from('new'), 3);
    current = new Date('2026-08-16T11:10:00Z');
    const swept = await store.sweepExpired();
    expect(swept).toBe(1);
    expect(await store.has(tenant, sha('old'))).toBe(false);
    expect(await store.has(tenant, sha('new'))).toBe(true);
  });
}
