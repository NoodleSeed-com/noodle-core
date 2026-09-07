import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import {
  type CounterRequest,
  counterRow,
  InMemoryDailyCounterStore,
} from '@noodle-borg/admission-limits/portable';
import { describe, expect, it, vi } from 'vitest';
import {
  admitBusinessMutation,
  admitBusinessTarget,
  authorizeBusinessApi,
  BUSINESS_API_LIMITS,
  businessApiCounter,
} from '../src/business-api-admission.js';

const now = new Date('2026-09-07T10:20:15Z');
function fixture(method = 'PATCH', path = '/v1/orgs/acme/solution-installations/install/settings') {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = path;
  const res = new ServerResponse(req);
  const counters = new InMemoryDailyCounterStore();
  const gate = {
    authorize: vi.fn(async () => ({
      ok: true as const,
      identity: { subject: 'verified-user', email: 'user@example.test', superAdmin: false },
    })),
  };
  const deps = { gate, publicCounters: counters, now: () => now };
  return { req, res, counters, gate, deps };
}
const target = { org: 'acme', installationId: 'install' };
async function fill(store: InMemoryDailyCounterStore, request: CounterRequest) {
  await store.consume({ ...request, amount: request.limit }, now);
}
async function used(store: InMemoryDailyCounterStore, request: CounterRequest) {
  return (await store.peek(counterRow(request, now).key, now)) ?? 0;
}
describe('authenticated business API admission', () => {
  it('authenticates and charges each request/lane once, then atomically charges only an authorized target', async () => {
    const f = fixture();
    await Promise.all([
      authorizeBusinessApi(f.req, f.res, f.deps),
      authorizeBusinessApi(f.req, f.res, f.deps),
    ]);
    expect(f.gate.authorize).toHaveBeenCalledTimes(1);
    const subject = businessApiCounter('mutation', 'subject', 'verified-user');
    expect(await used(f.counters, subject)).toBe(1);
    expect(await used(f.counters, businessApiCounter('mutation', 'org', 'acme'))).toBe(0);
    await Promise.all([admitBusinessTarget(f.res, target), admitBusinessTarget(f.res, target)]);
    expect(await used(f.counters, businessApiCounter('mutation', 'org', 'acme'))).toBe(1);
    expect(
      await used(f.counters, businessApiCounter('mutation', 'installation', ['acme', 'install'])),
    ).toBe(1);
    expect(subject.key).not.toContain('verified-user');
  });
  it('does not partially charge org when the installation is full and supplies safe Retry-After', async () => {
    const f = fixture();
    await authorizeBusinessApi(f.req, f.res, f.deps);
    await fill(f.counters, businessApiCounter('mutation', 'installation', ['acme', 'install']));
    expect(await admitBusinessTarget(f.res, target)).toBe(false);
    expect(f.res.statusCode).toBe(429);
    expect(f.res.getHeader('retry-after')).toBe('45');
    expect(await used(f.counters, businessApiCounter('mutation', 'org', 'acme'))).toBe(0);
  });
  it.each([
    ['GET', '/collections/requests/records'],
    ['DELETE', '/collections/requests/records/r1'],
    ['PATCH', ''],
    ['PATCH', '/channels'],
    ['POST', '/collections/catalog/source/pause'],
    ['POST', '/collections/catalog/source/refresh'],
  ])('preserves %s %s after mutation exhaustion', async (method, suffix) => {
    const f = fixture(method, `/v1/orgs/acme/solution-installations/install${suffix}`);
    for (const bucket of ['subject', 'org', 'installation'] as const)
      await fill(
        f.counters,
        businessApiCounter(
          'mutation',
          bucket,
          bucket === 'subject' ? 'verified-user' : bucket === 'org' ? 'acme' : ['acme', 'install'],
        ),
      );
    expect(await authorizeBusinessApi(f.req, f.res, f.deps)).not.toBe(false);
    expect(await admitBusinessTarget(f.res, target)).toBe(true);
  });
  it('keeps erasure/export in a separate recovery lane even when ordinary reads are exhausted', async () => {
    for (const [method, suffix] of [
      ['DELETE', '/records/r1'],
      ['GET', '/records/export'],
    ]) {
      const f = fixture(
        method,
        `/v1/orgs/acme/solution-installations/install/collections/requests${suffix}`,
      );
      await fill(f.counters, businessApiCounter('read', 'subject', 'verified-user'));
      expect(await authorizeBusinessApi(f.req, f.res, f.deps)).not.toBe(false);
      expect(await admitBusinessTarget(f.res, target)).toBe(true);
    }
  });
  it('admits receipt recovery before the separately bounded new mutation', async () => {
    const f = fixture(
      'POST',
      '/v1/orgs/acme/solution-installations/install/collections/requests/records',
    );
    await fill(f.counters, businessApiCounter('mutation', 'subject', 'verified-user'));
    expect(await authorizeBusinessApi(f.req, f.res, f.deps)).not.toBe(false);
    expect(await admitBusinessTarget(f.res, target)).toBe(true);
    expect(await admitBusinessMutation(f.res, target)).toBe(false);
    expect(f.res.statusCode).toBe(429);
  });
  it('fails closed without an atomic adapter or when it fails, without logging exception contents', async () => {
    const f = fixture();
    vi.spyOn(f.counters, 'consumeAll').mockRejectedValue(new Error('secret provider diagnostic'));
    expect(await authorizeBusinessApi(f.req, f.res, f.deps)).toBe(false);
    expect(f.res.statusCode).toBe(503);
    const other = fixture();
    Object.defineProperty(other.counters, 'consumeAll', { value: undefined });
    expect(await authorizeBusinessApi(other.req, other.res, other.deps)).toBe(false);
    expect(other.res.statusCode).toBe(503);
  });
  it('has generous ordinary allowances without commercial or fixture overrides', () => {
    expect(BUSINESS_API_LIMITS).toEqual({
      read: { subject: 6000, installation: 30000, org: 60000 },
      mutation: { subject: 1200, installation: 6000, org: 12000 },
      recovery: { subject: 6000, installation: 30000, org: 60000 },
    });
  });
});
