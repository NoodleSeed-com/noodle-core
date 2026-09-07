import { describe, expect, it, vi } from 'vitest';
import { executePreparedTool, prepareToolForConfirmation } from '../src/confirmation.js';
import { executeTool } from '../src/execute.js';
import { deps, recordingConnector, resolved } from './execute-fixtures.js';

describe('trusted operation identity', () => {
  it('does not acquire credentials or start a connector after execution was cancelled', async () => {
    const { connector, calls } = recordingConnector();
    const controller = new AbortController();
    const getCredential = vi.fn(async () => ({}));
    const policy = {
      before: async () => {
        controller.abort();
        return { allow: true as const };
      },
      after: async (_context: unknown, output: unknown) => output,
    };
    const result = await executeTool(
      resolved(),
      'get_order',
      { order_id: 'A1' },
      deps(connector, { signal: controller.signal, broker: { getCredential }, policy }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'execution_cancelled' } });
    expect(getCredential).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
  it('rejects confirmation after a configuration or connected account generation changes', async () => {
    const { connector, calls } = recordingConnector(() => ({ order: { id: 'A1' } }));
    const first = deps(connector, {
      executionBinding: { revision: 'a', connections: { account: 'one' } },
    });
    const prepared = await prepareToolForConfirmation(
      resolved(),
      'get_order',
      { order_id: 'A1' },
      first,
    );
    if (prepared.status !== 'confirmation_required') throw new Error('Expected confirmation');
    const result = await executePreparedTool(
      resolved(),
      prepared.continuation,
      deps(connector, {
        executionBinding: { revision: 'b', connections: { account: 'two' } },
      }),
    );
    expect(result).toMatchObject({ status: 'failed', error: { code: 'configuration_changed' } });
    expect(calls).toHaveLength(0);
  });
  it('mints distinct opaque identities for distinct invocations and ignores model keys', async () => {
    const { connector, calls } = recordingConnector(() => ({ order: { id: 'A1' } }));
    for (let n = 0; n < 2; n++) {
      await executeTool(
        resolved(),
        'get_order',
        { order_id: 'A1', operation_key: 'forged' },
        deps(connector),
      );
    }
    expect(calls[0]?.execution?.id).toMatch(/^[a-f0-9]{64}$/);
    expect(calls[0]?.execution?.id).not.toBe(calls[1]?.execution?.id);
    expect(calls[0]?.args).toEqual({ id: 'A1' });
    expect(Object.isFrozen(calls[0]?.execution)).toBe(true);
  });

  it('preserves the trusted invocation identity but fences tenant and deployment changes', async () => {
    const { connector, calls } = recordingConnector(() => ({ order: { id: 'A1' } }));
    const authority = {
      invocationId: 'trusted-confirmation-nonce',
      tenantId: 'a',
      deploymentId: 'v1',
    };
    for (const extra of [
      authority,
      authority,
      { ...authority, tenantId: 'b' },
      { ...authority, deploymentId: 'v2' },
    ]) {
      await executeTool(resolved(), 'get_order', { order_id: 'A1' }, deps(connector, extra));
    }
    expect(calls[0]?.execution?.id).toBe(calls[1]?.execution?.id);
    expect(new Set(calls.map((call) => call.execution?.id)).size).toBe(3);
  });
});
