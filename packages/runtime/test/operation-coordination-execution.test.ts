import {
  compileManifest,
  computeSignatureHash,
  InMemoryCatalog,
  type OperationSignature,
} from '@noodle-borg/compiler';
import { describe, expect, it, vi } from 'vitest';
import type { Connector, ConnectorCall } from '../src/connector/types.js';
import { withConnectorSnapshot } from '../src/connector-snapshot.js';
import { executeTool } from '../src/execute.js';
import type {
  OperationCoordinationLease,
  OperationCoordinationPort,
} from '../src/operation-coordination.js';
import type { OperationEvidencePort } from '../src/operation-evidence.js';
import { deps } from './execute-fixtures.js';

const action: OperationSignature = {
  type: 'action',
  input: { type: 'object' },
  output: { type: 'object' },
};
const read: OperationSignature = { ...action, type: 'read' };
function fixture(handler: (call: ConnectorCall) => Promise<unknown>) {
  const io = vi.fn(async () => ({}));
  const connector: Connector = {
    id: 'inventory',
    version: '1',
    signature: (op) => (op === 'read' ? read : action),
    executionBoundMs: () => 1000,
    coordination: (op) =>
      op === 'reserve'
        ? {
            connectionId: 'account',
            namespace: 'items',
            key: { kind: 'literal', value: 'item-1' },
            reference: { kind: 'literal', value: 'reservation-1' },
          }
        : undefined,
    invoke: (call) => (call.operation === 'reserve' ? handler(call) : io()),
  };
  const compiled = compileManifest(
    {
      manifestVersion: '1',
      server: { name: 'inventory', version: '1', title: 'Inventory' },
      connectors: { inventory: { id: 'inventory', version: '1' } },
      tools: [
        {
          name: 'reserve',
          description: 'Reserve one item.',
          inputSchema: { type: 'object' },
          fulfilment: { use: 'inventory.reserve', args: {} },
        },
      ],
    },
    {
      catalog: new InMemoryCatalog([
        { id: 'inventory', version: '1', kind: 'catalog', operations: { reserve: action } },
      ]),
    },
  );
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
  const run = (port?: OperationCoordinationPort, operationEvidence?: OperationEvidencePort) =>
    executeTool(
      compiled.artifact,
      'reserve',
      {},
      withConnectorSnapshot(
        deps(connector, {
          ...(port ? { operationCoordination: port } : {}),
          ...(operationEvidence ? { operationEvidence } : {}),
        }),
      ),
    );
  return { run, io };
}
const ref = (operation: string) => ({
  resolved: true as const,
  connectorId: 'inventory',
  connectorVersion: '1',
  operation,
  signatureHash: computeSignatureHash(operation, operation === 'read' ? read : action),
});
function lease(acquired = true): OperationCoordinationLease {
  return {
    acquired,
    finish: vi.fn(async () => undefined),
    resolvePrevious: vi.fn(async () => undefined),
  };
}

describe('coordinated action dispatch through the runtime snapshot', () => {
  it('fails before connector I/O if coordination authority is unavailable', async () => {
    const handler = vi.fn(async () => ({}));
    const f = fixture(handler);
    expect(await f.run()).toMatchObject({
      ok: false,
      error: { code: 'execution_admission_error' },
    });
    expect(handler).not.toHaveBeenCalled();
  });
  it('allows reads and one nested write only, with explicit terminal evidence', async () => {
    const held = lease();
    const f = fixture(async (call) => {
      expect(call.coordination?.acquired).toBe(true);
      await call.host?.callOperation(ref('read'), {}, 'read');
      await call.host?.callOperation(ref('write'), {}, 'write');
      await expect(call.host?.callOperation(ref('second_write'), {}, 'second')).rejects.toThrow();
      call.reportOutcome?.({ outcome: 'completed', reference: 'reservation-1' });
      return {};
    });
    const acquire = vi.fn(async () => held);
    expect((await f.run({ acquire })).ok).toBe(true);
    expect(acquire).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'account', key: 'item-1', executionBoundMs: 1000 }),
    );
    expect(f.io).toHaveBeenCalledTimes(2);
    expect(held.finish).toHaveBeenCalledWith({ outcome: 'completed', reference: 'reservation-1' });
  });
  it('permits source inspection but never writes in a blocked or recovered invocation', async () => {
    const held = lease(false);
    const f = fixture(async (call) => {
      await call.host?.callOperation(ref('read'), {}, 'read');
      await expect(call.host?.callOperation(ref('write'), {}, 'before')).rejects.toThrow();
      await call.resolveCoordination?.();
      await expect(call.host?.callOperation(ref('write'), {}, 'after')).rejects.toThrow();
      return {};
    });
    expect((await f.run({ acquire: async () => held })).ok).toBe(true);
    expect(f.io).toHaveBeenCalledTimes(1);
    expect(held.resolvePrevious).toHaveBeenCalledOnce();
  });
  it('links nested durable receipts to the trusted coordinated business attempt', async () => {
    const begin = vi.fn<OperationEvidencePort['begin']>(async () => ({
      finish: vi.fn(async () => undefined),
    }));
    const f = fixture(async (call) => {
      await call.host?.callOperation(ref('read'), {}, 'read');
      await call.host?.callOperation(ref('write'), { parentId: 'forged' }, 'write');
      call.reportOutcome?.({ outcome: 'completed', reference: 'reservation-1' });
      return {};
    });
    expect((await f.run({ acquire: async () => lease() }, { begin })).ok).toBe(true);
    expect(begin).toHaveBeenCalledTimes(2);
    const parent = begin.mock.calls[0]?.[0];
    const child = begin.mock.calls[1]?.[0];
    expect(parent).toMatchObject({ connectionId: 'account', operation: { operation: 'reserve' } });
    expect(parent?.parentId).toBeUndefined();
    expect(child).toMatchObject({ parentId: parent?.id, operation: { operation: 'write' } });
    expect(child?.parentId).not.toBe('forged');
    expect(child?.id).not.toBe(parent?.id);
  });
  it('retains an unknown claim after a thrown provider error without terminal proof', async () => {
    const held = lease();
    const f = fixture(async (call) => {
      await call.host?.callOperation(ref('write'), {}, 'write');
      throw new Error('private provider details');
    });
    const result = await f.run({ acquire: async () => held });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private provider details');
    expect(held.finish).toHaveBeenCalledWith({ outcome: 'unknown' });
  });
  it('never releases custody from evidence rejected by the shared privacy boundary', async () => {
    const held = lease();
    const f = fixture(async (call) => {
      await call.host?.callOperation(ref('write'), {}, 'write');
      call.reportOutcome?.({
        outcome: 'completed',
        reference: 'https://private.example/?token=secret',
      });
      return {};
    });
    expect((await f.run({ acquire: async () => held })).ok).toBe(true);
    expect(held.finish).toHaveBeenCalledWith({ outcome: 'unknown' });
  });
  it('releases harmless validation failures when the sandbox admitted no nested action', async () => {
    const held = lease();
    const f = fixture(async (call) => {
      await call.host?.callOperation(ref('read'), {}, 'read');
      throw new Error('configuration unavailable');
    });
    expect((await f.run({ acquire: async () => held })).ok).toBe(false);
    expect(held.finish).toHaveBeenCalledWith({ outcome: 'rejected' });
    expect(f.io).toHaveBeenCalledTimes(1);
  });
  it('fails closed on durable admission and terminal storage errors', async () => {
    const handler = vi.fn(async () => ({}));
    const f = fixture(handler);
    expect(
      (
        await f.run({
          acquire: async () => {
            throw new Error('offline');
          },
        })
      ).ok,
    ).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    const held = lease();
    held.finish = async () => {
      throw new Error('offline');
    };
    expect((await f.run({ acquire: async () => held })).ok).toBe(false);
  });
});
