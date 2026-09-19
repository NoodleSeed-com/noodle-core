import { describe, expect, it } from 'vitest';
import { InMemoryAtomicState } from '../src/in-memory-atomic-state.js';

function barrier() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('development-only atomic state', () => {
  it('hides staged writes and commits participating maps together', async () => {
    const state = new InMemoryAtomicState();
    const first = state.map<string, number>();
    const second = state.map<string, number>();
    const entered = barrier();
    const release = barrier();
    const work = state.run(async () => {
      first.set('a', 1);
      await state.run(async () => {
        second.set('b', 2);
      });
      expect([...first]).toEqual([['a', 1]]);
      expect([...second.values()]).toEqual([2]);
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    expect(first.size).toBe(0);
    expect(second.has('b')).toBe(false);
    release.resolve();
    await work;
    expect(first.get('a')).toBe(1);
    expect(second.get('b')).toBe(2);
  });

  it('rolls back every participant even when a nested failure is caught', async () => {
    const state = new InMemoryAtomicState();
    const values = state.map<string, number>();
    values.set('existing', 7);
    await expect(
      state.run(async () => {
        values.clear();
        await expect(
          state.run(async () => {
            values.set('partial', 1);
            throw new Error('participant failed');
          }),
        ).rejects.toThrow('participant failed');
      }),
    ).rejects.toThrow('participant failed');
    expect([...values]).toEqual([['existing', 7]]);
    await state.run(async () => {
      values.set('retry', 2);
    });
    expect(values.get('retry')).toBe(2);
  });

  it('never overwrites a concurrent nonparticipating mutation during commit or rollback', async () => {
    const state = new InMemoryAtomicState();
    const values = state.map<string, number>();
    const other = state.map<string, number>();
    const entered = barrier();
    const release = barrier();
    const work = state.run(async () => {
      values.set('staged', 1);
      other.set('also-staged', 2);
      entered.resolve();
      await release.promise;
    });
    const failed = expect(work).rejects.toThrow('memory transaction conflict');
    await entered.promise;
    values.set('concurrent', 3);
    release.resolve();
    await failed;
    expect([...values]).toEqual([['concurrent', 3]]);
    expect(other.size).toBe(0);
  });

  it('serializes concurrent transactions and rejects escaped work after settlement', async () => {
    const state = new InMemoryAtomicState();
    const values = state.map<string, number>();
    const release = barrier();
    let late: Promise<void> | undefined;
    await Promise.all(
      Array.from({ length: 4 }, () =>
        state.run(async () => {
          const value = values.get('count') ?? 0;
          await Promise.resolve();
          values.set('count', value + 1);
        }),
      ),
    );
    expect(values.get('count')).toBe(4);
    await state.run(async () => {
      late = release.promise.then(() => {
        values.set('escaped', 1);
      });
    });
    const failed = expect(late).rejects.toThrow('memory transaction is closed');
    release.resolve();
    await failed;
    expect(values.has('escaped')).toBe(false);
  });

  it('preserves map iteration, deletion and callback semantics within a transaction', async () => {
    const state = new InMemoryAtomicState();
    const values = state.map<string, number>();
    values.set('old', 1);
    await state.run(async () => {
      expect(values.delete('missing')).toBe(false);
      expect(values.delete('old')).toBe(true);
      values.set('new', 2);
      expect([...values.keys()]).toEqual(['new']);
      expect([...values.entries()]).toEqual([['new', 2]]);
      const seen: number[] = [];
      values.forEach((value, key, map) => {
        expect(key).toBe('new');
        expect(map).toBe(values);
        seen.push(value);
      });
      expect(seen).toEqual([2]);
    });
    expect([...values]).toEqual([['new', 2]]);
  });

  it('refuses commit while an unawaited nested participant is still running', async () => {
    const state = new InMemoryAtomicState();
    const values = state.map<string, number>();
    const release = barrier();
    let child: Promise<void> | undefined;
    await expect(
      state.run(async () => {
        values.set('parent', 1);
        child = state.run(async () => {
          await release.promise;
          values.set('child', 2);
        });
      }),
    ).rejects.toThrow('unfinished work');
    const failed = expect(child).rejects.toThrow('memory transaction is closed');
    release.resolve();
    await failed;
    expect(values.size).toBe(0);
  });
});
