import { describe, expect, it } from 'vitest';
import {
  createOperationCoordinationPort,
  InMemoryOperationCoordinationStore,
} from '../src/operation-coordination.js';

describe('external resource coordination', () => {
  const scope = { org: 'acme', app: 'service', env: 'test', installationId: 'install-1' };
  const intent = {
    id: 'a'.repeat(64),
    connectionId: 'account',
    namespace: 'inventory',
    key: 'item-42',
    reference: 'effect-1',
    executionBoundMs: 8000,
  };
  function fixture() {
    let now = 1000;
    let generation = 'generation-1';
    let authorized = true;
    const store = new InMemoryOperationCoordinationStore();
    const port = (selectedScope = scope) =>
      createOperationCoordinationPort({
        store,
        scope: selectedScope,
        epoch: 'local-epoch-00001',
        identityKey: 'k'.repeat(32),
        now: () => now,
        connectionGeneration: () => generation,
        authorize: async () => authorized,
      });
    return {
      store,
      port,
      setNow: (value: number) => {
        now = value;
      },
      setGeneration: (value: string) => {
        generation = value;
      },
      revoke: () => {
        authorized = false;
      },
    };
  }
  it('serializes one resource across port instances while other resources and tenants proceed', async () => {
    const f = fixture();
    const first = await f.port().acquire(intent);
    expect(first.acquired).toBe(true);
    const competing = await f.port().acquire({ ...intent, id: 'b'.repeat(64) });
    expect(competing.acquired).toBe(false);
    expect(competing.previous).toBeUndefined();
    expect((await f.port().acquire({ ...intent, key: 'item-43' })).acquired).toBe(true);
    expect((await f.port({ ...scope, org: 'other' }).acquire(intent)).acquired).toBe(true);
    expect((await f.port({ ...scope, installationId: 'install-2' }).acquire(intent)).acquired).toBe(
      true,
    );
    await first.finish({ outcome: 'completed', reference: 'effect-1' });
    expect((await f.port().acquire({ ...intent, id: 'c'.repeat(64) })).acquired).toBe(true);
  });
  it('keeps uncertain operations across deadlines and resolves only the original held token', async () => {
    const f = fixture();
    const first = await f.port().acquire(intent);
    await first.finish({ outcome: 'unknown' });
    f.setNow(100000);
    const blocked = await f.port().acquire({ ...intent, id: 'b'.repeat(64) });
    expect(blocked.acquired).toBe(false);
    expect(blocked.previous?.reference).toBe('effect-1');
    expect(blocked.previous?.operationDigest).toMatch(/^[a-f0-9]{64}$/);
    await blocked.resolvePrevious();
    const next = await f.port().acquire({ ...intent, id: 'c'.repeat(64) });
    expect(next.acquired).toBe(true);
    await expect(blocked.resolvePrevious()).rejects.toThrow();
    await first.finish({ outcome: 'completed' });
    expect((await f.port().acquire({ ...intent, id: 'd'.repeat(64) })).acquired).toBe(false);
  });
  it('does not release an expired executing claim merely because time passed', async () => {
    const f = fixture();
    await f.port().acquire(intent);
    f.setNow(100000);
    const blocked = await f.port().acquire({ ...intent, id: 'b'.repeat(64) });
    expect(blocked.acquired).toBe(false);
    expect(blocked.previous?.reference).toBe('effect-1');
  });
  it('connection generation changes neither bypass nor permit recovery of a prior claim', async () => {
    const f = fixture();
    const first = await f.port().acquire(intent);
    await first.finish({ outcome: 'unknown' });
    f.setGeneration('generation-2');
    const blocked = await f.port().acquire({ ...intent, id: 'b'.repeat(64) });
    expect(blocked.acquired).toBe(false);
    expect(blocked.previous).toBeUndefined();
    await expect(blocked.resolvePrevious()).rejects.toThrow();
  });
  it('rechecks live authorization before resolution', async () => {
    const f = fixture();
    const first = await f.port().acquire(intent);
    await first.finish({ outcome: 'unknown' });
    f.setNow(100000);
    const blocked = await f.port().acquire({ ...intent, id: 'b'.repeat(64) });
    f.revoke();
    await expect(blocked.resolvePrevious()).rejects.toThrow();
    await expect(f.port().acquire(intent)).rejects.toThrow();
  });
  it('does not admit work when durable coordination is unavailable', async () => {
    const store = new InMemoryOperationCoordinationStore();
    store.claim = async () => {
      throw new Error('database unavailable');
    };
    const port = createOperationCoordinationPort({
      store,
      scope,
      epoch: 'local-epoch-00001',
      identityKey: 'k'.repeat(32),
      authorize: async () => true,
      connectionGeneration: () => 'generation-1',
    });
    await expect(port.acquire(intent)).rejects.toThrow('database unavailable');
  });
});
