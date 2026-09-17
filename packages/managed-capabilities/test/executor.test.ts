import { describe, expect, it, vi } from 'vitest';
import { CapabilityBudget } from '../src/budget.js';
import type { WebCapability } from '../src/contracts.js';
import { executeWebExtract } from '../src/executor.js';

const declaration: WebCapability = {
  name: 'pages',
  class: 'web.extract.v1',
  title: 'Pages',
  description: 'Read public pages',
  provider: { kind: 'noodle-managed' },
};
function fixture() {
  const read = vi.fn(async ({ url }: { url: string }) => ({
    url,
    title: 'Example',
    text: 'Evidence',
    links: [],
    retrievedAt: '2026-09-16T00:00:00.000Z',
  }));
  const admit = vi.fn(async () => true);
  return {
    read,
    admit,
    deps: {
      reader: { read },
      admit,
      authorized: true,
      enabled: true,
      budget: new CapabilityBudget(),
      operatorPolicy: {},
    },
  };
}
describe('governed extraction', () => {
  it('cancels while admission is pending without dispatching any page read', async () => {
    const { deps, admit, read } = fixture();
    const controller = new AbortController();
    let release: (allowed: boolean) => void = () => {};
    admit.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const pending = executeWebExtract(
      declaration,
      { urls: ['https://example.com/'] },
      { ...deps, signal: controller.signal },
    );
    await vi.waitFor(() => expect(admit).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'capability_cancelled' });
    release(true);
    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
  });
  it('enforces the deadline even when an adapter ignores cancellation', async () => {
    const { deps, read } = fixture();
    read.mockImplementation(() => new Promise(() => {}));
    await expect(
      executeWebExtract(
        { ...declaration, policy: { timeoutMs: 100 } },
        { urls: ['https://example.com/'] },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'capability_budget_exhausted' });
    expect(read).toHaveBeenCalledOnce();
  });
  it('produces bounded attributed evidence, without a provider-specific shape', async () => {
    const { deps, admit } = fixture();
    const result = await executeWebExtract(declaration, { urls: ['https://example.com/'] }, deps);
    expect(result.status).toBe('complete');
    expect(result.items[0]?.sourceRef).toBe(result.sources[0]?.ref);
    expect(result.sources[0]?.url).toBe('https://example.com/');
    expect(admit).toHaveBeenCalledOnce();
  });
  it.each([
    'enabled',
    'authorized',
  ] as const)('denies %s before admission or I/O', async (field) => {
    const { deps, admit, read } = fixture();
    await expect(
      executeWebExtract(
        declaration,
        { urls: ['https://example.com/'] },
        { ...deps, [field]: false },
      ),
    ).rejects.toThrow();
    expect(admit).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
  it('validates the whole batch before I/O', async () => {
    const { deps, admit, read } = fixture();
    await expect(
      executeWebExtract(declaration, { urls: ['https://example.com/', 'http://localhost'] }, deps),
    ).rejects.toThrow();
    expect(admit).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
  it('intersects request, developer and operator domain restrictions', async () => {
    const { deps, read } = fixture();
    await expect(
      executeWebExtract(
        { ...declaration, policy: { domains: ['example.com'] } },
        { urls: ['https://example.com/'], domains: ['other.example'] },
        deps,
      ),
    ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it('fails closed when admission refuses or is unavailable', async () => {
    const { deps, admit, read } = fixture();
    admit.mockResolvedValue(false);
    await expect(
      executeWebExtract(declaration, { urls: ['https://example.com/'] }, deps),
    ).rejects.toMatchObject({ code: 'capability_budget_exhausted' });
    admit.mockRejectedValue(new Error('database password'));
    await expect(
      executeWebExtract(declaration, { urls: ['https://example.com/'] }, deps),
    ).rejects.toMatchObject({ code: 'capability_unavailable' });
    expect(read).not.toHaveBeenCalled();
  });
  it('cannot reset the shared call budget in parallel wrappers', async () => {
    const { deps, read } = fixture();
    const bounded = { ...declaration, policy: { maxCalls: 1 } };
    const results = await Promise.allSettled(
      [1, 2].map(() => executeWebExtract(bounded, { urls: ['https://example.com/'] }, deps)),
    );
    expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(read).toHaveBeenCalledOnce();
  });
  it('returns partial only with usable evidence and an attributable warning', async () => {
    const { deps, read } = fixture();
    read.mockRejectedValueOnce(new Error('unsafe provider detail'));
    const result = await executeWebExtract(
      declaration,
      { urls: ['https://example.com/a', 'https://example.com/b'] },
      deps,
    );
    expect(result.status).toBe('partial');
    expect(result.items).toHaveLength(1);
    expect(result.warnings).toEqual([{ requestIndex: 0, code: 'capability_provider_failed' }]);
    expect(JSON.stringify(result)).not.toContain('unsafe provider detail');
  });
  it('rejects unvalidated final sources returned by an adapter', async () => {
    const { deps, read } = fixture();
    read.mockResolvedValue({
      url: 'http://127.0.0.1/',
      title: '',
      text: 'oops',
      links: [],
      retrievedAt: '2026-09-16T00:00:00.000Z',
    });
    await expect(
      executeWebExtract(declaration, { urls: ['https://example.com/'] }, deps),
    ).rejects.toThrow();
  });
  it('truncates by UTF-8 bytes and identifies the limitation', async () => {
    const { deps, read } = fixture();
    read.mockResolvedValue({
      url: 'https://example.com/',
      title: '',
      text: '🌱'.repeat(1000),
      links: [],
      retrievedAt: '2026-09-16T00:00:00.000Z',
    });
    const result = await executeWebExtract(
      { ...declaration, policy: { maxTextBytes: 256 } },
      { urls: ['https://example.com/'] },
      deps,
    );
    expect(Buffer.byteLength(result.items[0]?.content.text ?? '')).toBeLessThanOrEqual(256);
    expect(result.items[0]?.truncated).toBe(true);
    expect(result.warnings[0]?.code).toBe('content_truncated');
  });
});
