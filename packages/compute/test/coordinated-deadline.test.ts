import {
  compileManifest,
  computeSignatureHash,
  InMemoryCatalog,
  type OperationSignature,
} from '@noodle-borg/compiler';
import { QuickJsComputeEngine } from '@noodle-borg/compute';
import {
  type Connector,
  type ConnectorCall,
  executeTool,
  InMemoryConnectorRegistry,
  type OperationEvidence,
} from '@noodle-borg/runtime';
import { describe, expect, it, vi } from 'vitest';
import { CodeConnector } from '../src/code-connector.js';
import { DEFAULT_LIMITS } from '../src/engine.js';

const action: OperationSignature = {
  type: 'action',
  input: { type: 'object' },
  output: { type: 'object' },
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(
  stage: 'policy' | 'credential' | 'provider',
  type: 'read' | 'action' = 'action',
  outerType: 'read' | 'action' = 'action',
) {
  const engine = new QuickJsComputeEngine({ maxWorkers: 1, terminateGraceMs: 10 });
  const module = await engine.compile('(input,host)=>host.callOperation("write",{})');
  const disconnect = new AbortController();
  const entered = deferred();
  const release = deferred();
  const finished = deferred();
  const originalInstantiate = engine.instantiate.bind(engine);
  vi.spyOn(engine, 'instantiate').mockImplementation(async (module) => {
    const instance = await originalInstantiate(module);
    const invoke = instance.invoke.bind(instance);
    instance.invoke = (input, limits, host, timings) =>
      invoke(
        input,
        limits,
        host && {
          ...host,
          async callOperation(...args) {
            try {
              return await host.callOperation(...args);
            } finally {
              finished.resolve();
            }
          },
        },
        timings,
      );
    return instance;
  });
  let providerSignal: AbortSignal | undefined;
  const io = vi.fn(async (call: ConnectorCall) => {
    if (stage === 'provider') {
      providerSignal = call.signal;
      entered.resolve();
      await Promise.race([
        new Promise<void>((resolve) => {
          if (call.signal?.aborted) resolve();
          else call.signal?.addEventListener('abort', () => resolve(), { once: true });
        }),
        release.promise,
      ]);
      throw new Error('Provider request aborted');
    }
    return {};
  });
  const childSignature = { ...action, type };
  const outerSignature = { ...action, type: outerType };
  const evidence: OperationEvidence[] = [];
  const app = new CodeConnector({
    id: 'app',
    version: '1',
    engine,
    operations: {
      run: {
        signature: outerSignature,
        module,
        limits: { ...DEFAULT_LIMITS, timeoutMs: 500 },
        calls: {
          write: {
            resolved: true,
            alias: 'provider',
            connectorId: 'provider',
            connectorVersion: '1',
            operation: 'write',
            signatureHash: computeSignatureHash('write', childSignature),
          },
        },
        ...(outerType === 'action'
          ? {
              coordination: {
                connectionId: 'account',
                namespace: 'items',
                key: { kind: 'literal', value: 'one' },
                reference: { kind: 'literal', value: 'reference' },
              },
            }
          : {}),
      },
    },
  });
  const provider: Connector = {
    id: 'provider',
    version: '1',
    signature: () => childSignature,
    executionBoundMs: () => 5000,
    invoke: io,
  };
  const compiled = compileManifest(
    {
      manifestVersion: '1',
      server: { name: 'audit', title: 'Audit', version: '1' },
      connectors: { app: { id: 'app', version: '1' } },
      tools: [
        {
          name: 'run',
          description: 'Run',
          inputSchema: { type: 'object' },
          fulfilment: { use: 'app.run', args: {} },
        },
      ],
    },
    {
      catalog: new InMemoryCatalog([
        { id: 'app', version: '1', kind: 'catalog', operations: { run: outerSignature } },
      ]),
    },
  );
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
  const pause = async () => {
    entered.resolve();
    await release.promise;
  };
  const running = executeTool(
    compiled.artifact,
    'run',
    {},
    {
      connectors: new InMemoryConnectorRegistry([app, provider]),
      signal: disconnect.signal,
      broker: {
        async getCredential(ref) {
          if (ref.operation === 'write' && stage === 'credential') await pause();
          return { token: 'test', scope: 'test' };
        },
      },
      policy: {
        async before(ref) {
          if (ref.operation === 'write' && stage === 'policy') await pause();
          return { allow: true };
        },
        async after(_context, output) {
          return output;
        },
      },
      operationCoordination: {
        async acquire() {
          return {
            acquired: true,
            async finish(value) {
              evidence.push(value);
            },
            async resolvePrevious() {},
          };
        },
      },
    },
  );
  return {
    engine,
    entered,
    release,
    finished,
    running,
    io,
    evidence,
    providerSignal: () => providerSignal,
    disconnect,
  };
}

describe('coordinated compute parent deadline', () => {
  it.each([
    ['policy', 'read'],
    ['policy', 'action'],
    ['credential', 'read'],
    ['credential', 'action'],
  ] as const)('does not dispatch a late %s / %s child', async (stage, type) => {
    const test = await fixture(stage, type);
    try {
      await Promise.race([
        test.entered.promise,
        test.running.then((result) => {
          throw new Error(`Host call did not start: ${JSON.stringify(result)}`);
        }),
      ]);
      expect((await test.running).ok).toBe(false);
      expect(test.evidence).toEqual([{ outcome: type === 'action' ? 'unknown' : 'rejected' }]);
      test.release.resolve();
      await test.finished.promise;
      expect(test.io).not.toHaveBeenCalled();
    } finally {
      test.release.resolve();
      await test.engine.close();
    }
  });
  it.each([
    false,
    true,
  ])('keeps the parent deadline on a running provider after client disconnect=%s', async (disconnect) => {
    const test = await fixture('provider');
    try {
      await Promise.race([
        test.entered.promise,
        test.running.then(() => {
          throw new Error('Provider did not start');
        }),
      ]);
      if (disconnect) test.disconnect.abort();
      expect((await test.running).ok).toBe(false);
      expect(test.io).toHaveBeenCalledOnce();
      expect(test.providerSignal()?.aborted).toBe(true);
      expect(test.providerSignal()?.reason).toMatchObject({ name: 'TimeoutError' });
      expect(test.evidence).toEqual([{ outcome: 'unknown' }]);
    } finally {
      test.release.resolve();
      await test.engine.close();
    }
  });
  it('applies the declared timeout to read compute and its nested read', async () => {
    const test = await fixture('credential', 'read', 'read');
    try {
      await Promise.race([
        test.entered.promise,
        test.running.then(() => {
          throw new Error('Read did not start');
        }),
      ]);
      expect((await test.running).ok).toBe(false);
      test.release.resolve();
      await test.finished.promise;
      expect(test.io).not.toHaveBeenCalled();
      expect(test.evidence).toEqual([]);
    } finally {
      test.release.resolve();
      await test.engine.close();
    }
  });
});
