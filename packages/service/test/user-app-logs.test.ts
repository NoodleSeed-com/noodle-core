import { describe, expect, it } from 'vitest';
import { InMemoryUserAppLogStore } from '../src/index.js';

describe('InMemoryUserAppLogStore', () => {
  it('requires tenant scope and returns records newest-first', async () => {
    let now = Date.parse('2026-06-18T00:00:00.000Z');
    const store = new InMemoryUserAppLogStore({ now: () => new Date(now), id: () => `id-${now}` });

    await store.emit({
      level: 'info',
      message: 'first',
      org: 'acme',
      app: 'hello',
      env: 'prod',
      deploymentId: 'dep-1',
    });
    now += 1000;
    await store.emit({
      level: 'warn',
      message: 'second',
      org: 'acme',
      app: 'hello',
      env: 'prod',
      deploymentId: 'dep-1',
    });

    expect(
      (await store.list({ org: 'acme', app: 'hello', env: 'prod' })).map((e) => e.message),
    ).toEqual(['second', 'first']);
    const missingTenant = {
      level: 'info',
      message: 'missing',
      app: 'hello',
      env: 'prod',
    } as unknown as Parameters<typeof store.emit>[0];
    await expect(store.emit(missingTenant)).rejects.toThrow(/org is required/);
  });

  it('isolates tenants at query time and redacts non-scalar details', async () => {
    const store = new InMemoryUserAppLogStore();
    await store.emit({
      level: 'info',
      message: 'tenant A',
      org: 'acme',
      app: 'hello',
      env: 'prod',
      details: { safe: 'ok', leak: { token: 'secret' } },
    });
    await store.emit({
      level: 'info',
      message: 'tenant B',
      org: 'globex',
      app: 'hello',
      env: 'prod',
    });

    const acme = await store.list({ org: 'acme' });
    expect(acme.map((e) => e.message)).toEqual(['tenant A']);
    expect(acme[0]?.details).toEqual({ safe: 'ok', leak: '[unloggable]' });
    expect(JSON.stringify(acme)).not.toContain('secret');
  });

  it('bounds message size and records truncation', async () => {
    const store = new InMemoryUserAppLogStore({ maxMessageChars: 8 });
    await store.emit({
      level: 'error',
      message: '0123456789abcdef',
      org: 'acme',
      app: 'hello',
      env: 'prod',
    });

    const [event] = await store.list({ org: 'acme' });
    expect(event?.message).toBe('01234567');
    expect(event?.truncated).toBe(true);
  });
});
