import { computeSignatureHash, type OperationSignature } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { InMemoryConnector } from '../src/connector/in-memory.js';
import { ConnectorInvocationError, type ConnectorTraceEvent } from '../src/connector/types.js';
import { executeTool } from '../src/execute.js';
import type { PolicyGate } from '../src/policy/types.js';
import {
  deps,
  getOrderSignature,
  ordersConnector,
  recordingConnector,
  resolved,
} from './execute-fixtures.js';

describe('executeTool', () => {
  it('fails the call when the connector output violates the signature schema', async () => {
    const badConnector = new InMemoryConnector('acme_orders', '1.2.0', {
      get_order: {
        signature: getOrderSignature,
        handler: () => ({ order: 'not-an-object' }),
      },
    });
    const result = await executeTool(
      resolved(),
      'get_order',
      { order_id: 'A1' },
      deps(badConnector),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('output_invalid');
      expect(result.error.path).toBe('output.order');
      expect(result.error.message).toContain('expects object');
    }
  });

  it('enforces nested connector output constraints', async () => {
    const nestedOutputSignature: OperationSignature = {
      ...getOrderSignature,
      output: {
        type: 'object',
        properties: {
          order: {
            type: 'object',
            properties: {
              lines: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { quantity: { type: 'integer', minimum: 1 } },
                  required: ['quantity'],
                  additionalProperties: false,
                },
              },
            },
            required: ['lines'],
            additionalProperties: false,
          },
        },
        required: ['order'],
        additionalProperties: false,
      },
    };
    const testArtifact = resolved();
    const fulfilment = testArtifact.tools[0]?.fulfilment;
    if (fulfilment?.kind !== 'operation' || fulfilment.operationRef.resolved !== true) {
      throw new Error('expected resolved operation fixture');
    }
    fulfilment.operationRef.signatureHash = computeSignatureHash(
      'get_order',
      nestedOutputSignature,
    );
    const connector = new InMemoryConnector('acme_orders', '1.2.0', {
      get_order: {
        signature: nestedOutputSignature,
        handler: () => ({ order: { lines: [{ quantity: 0 }] } }),
      },
    });

    const result = await executeTool(
      testArtifact,
      'get_order',
      { order_id: 'A1' },
      deps(connector),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('output_invalid');
      expect(result.error.path).toBe('output.order.lines.0.quantity');
    }
  });

  it('intercepts connector execution failures and normalizes them to connector_error without leaking details', async () => {
    const failingConnector = new InMemoryConnector('acme_orders', '1.2.0', {
      get_order: {
        signature: getOrderSignature,
        handler: () => {
          throw new Error('internal DB error or secret leak');
        },
      },
    });
    const result = await executeTool(
      resolved(),
      'get_order',
      { order_id: 'A1' },
      deps(failingConnector),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('connector_error');
      expect(result.error.message).toBe('connector failed for operation "get_order"');
      expect(result.error.message).not.toContain('internal DB error');
    }
  });

  it('exposes only the allowlisted response-too-large reason for size failures', async () => {
    const sensitiveDetail = 'customer-42 Bearer secret-token-value';
    const { connector } = recordingConnector(() => {
      throw new ConnectorInvocationError(`response too large for ${sensitiveDetail}`, {
        category: 'response_too_large',
        attempts: 1,
        retryable: false,
        responseExcerpt: sensitiveDetail,
      });
    });

    const result = await executeTool(resolved(), 'get_order', { order_id: 'A1' }, deps(connector));

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'connector_error',
        message: 'connector failed for operation "get_order"',
        reason: 'response_too_large',
        connector: {
          connectorId: 'acme_orders',
          connectorVersion: '1.2.0',
          operation: 'get_order',
          category: 'response_too_large',
          attempts: 1,
          retryable: false,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(sensitiveDetail);
    expect(JSON.stringify(result)).not.toContain('secret-token-value');
  });

  it('exposes stable timeout classifications for connector time-budget failures', async () => {
    for (const category of ['timeout', 'queue_timeout'] as const) {
      const { connector } = recordingConnector(() => {
        throw new ConnectorInvocationError('compute exceeded its time budget', {
          category,
          attempts: 1,
          retryable: category === 'queue_timeout',
        });
      });

      const result = await executeTool(
        resolved(),
        'get_order',
        { order_id: 'A1' },
        deps(connector),
      );

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'connector_error',
          message: 'connector failed for operation "get_order"',
          reason: category,
          connector: {
            connectorId: 'acme_orders',
            connectorVersion: '1.2.0',
            operation: 'get_order',
            category,
            attempts: 1,
            retryable: category === 'queue_timeout',
          },
        },
      });
    }
  });

  it('records queue-wait and execution durations separately on timed-out connector calls', async () => {
    const trace: ConnectorTraceEvent[] = [];
    const { connector } = recordingConnector(() => {
      throw new ConnectorInvocationError('compute exceeded its time budget', {
        category: 'timeout',
        attempts: 1,
        queueWaitMs: 120,
        executionMs: 40,
      });
    });

    const result = await executeTool(
      resolved(),
      'get_order',
      { order_id: 'A1' },
      deps(connector, { trace: { record: (event) => trace.push(event) } }),
    );

    expect(result.ok).toBe(false);
    expect(trace).toEqual([
      {
        kind: 'connector',
        connectorId: 'acme_orders',
        connectorVersion: '1.2.0',
        operation: 'get_order',
        category: 'timeout',
        attempts: 1,
        queueWaitMs: 120,
        executionMs: 40,
      },
    ]);
  });

  it('records safe connector failure details through an optional trace sink', async () => {
    const trace: ConnectorTraceEvent[] = [];
    const { connector } = recordingConnector(() => {
      throw new ConnectorInvocationError('backend responded 502', {
        status: 502,
        category: 'upstream_5xx',
        attempts: 3,
        retryable: true,
        responseExcerpt: 'backend unavailable',
      });
    });
    const result = await executeTool(
      resolved(),
      'get_order',
      { order_id: 'A1' },
      deps(connector, { trace: { record: (event) => trace.push(event) } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: 'connector_error',
        message: 'connector failed for operation "get_order"',
        reason: 'upstream_5xx',
        connector: {
          connectorId: 'acme_orders',
          connectorVersion: '1.2.0',
          operation: 'get_order',
          category: 'upstream_5xx',
          statusClass: '5xx',
          attempts: 3,
          retryable: true,
        },
      });
      expect(JSON.stringify(result)).not.toContain('backend unavailable');
      expect(JSON.stringify(result)).not.toContain('502');
    }
    expect(trace).toEqual([
      {
        kind: 'connector',
        connectorId: 'acme_orders',
        connectorVersion: '1.2.0',
        operation: 'get_order',
        status: 502,
        category: 'upstream_5xx',
        attempts: 3,
        retryable: true,
        responseExcerpt: 'backend unavailable',
      },
    ]);
  });

  it('honors output redaction/modification performed by the policy after hook', async () => {
    const { connector } = ordersConnector();
    const policy: PolicyGate = {
      before: async () => ({ allow: true }),
      after: async (_ctx, output) => {
        return {
          order: {
            ...((output as Record<string, Record<string, unknown>>).order ?? {}),
            status: '[REDACTED]',
          },
        };
      },
    };
    const result = await executeTool(
      resolved(),
      'get_order',
      { order_id: 'A1' },
      deps(connector, { policy }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toEqual({
        order: { id: 'A1', status: '[REDACTED]' },
      });
    }
  });

  it('normalizes policy after hook failures without leaking details', async () => {
    const { connector } = ordersConnector();
    const policy: PolicyGate = {
      before: async () => ({ allow: true }),
      after: async () => {
        throw new Error('redaction rule secret');
      },
    };
    const result = await executeTool(
      resolved(),
      'get_order',
      { order_id: 'A1' },
      deps(connector, { policy }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('policy_error');
      expect(result.error.message).not.toContain('redaction rule secret');
    }
  });

  it('validates output returned by the policy after hook', async () => {
    const { connector } = ordersConnector();
    const policy: PolicyGate = {
      before: async () => ({ allow: true }),
      after: async () => ({ order: 'redacted-to-wrong-type' }),
    };
    const result = await executeTool(
      resolved(),
      'get_order',
      { order_id: 'A1' },
      deps(connector, { policy }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('output_invalid');
      expect(result.error.path).toBe('output.order');
    }
  });

  it('fails validation when the connector output is not a non-null object container', async () => {
    const badConnector = new InMemoryConnector('acme_orders', '1.2.0', {
      get_order: {
        signature: getOrderSignature,
        handler: () => 'not-an-object-container-but-a-string',
      },
    });
    const result = await executeTool(
      resolved(),
      'get_order',
      { order_id: 'A1' },
      deps(badConnector),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('output_invalid');
      expect(result.error.path).toBe('output');
      expect(result.error.message).toContain('container must be a non-null object');
    }
  });

  it('fails when a required output field is missing', async () => {
    const requiredOutputSig: OperationSignature = {
      ...getOrderSignature,
      output: {
        type: 'object',
        properties: { order: { type: 'object' } },
        required: ['order'],
        additionalProperties: false,
      },
    };
    const testArtifact = resolved();
    const fulfilment = testArtifact.tools[0]?.fulfilment;
    if (fulfilment?.kind !== 'operation' || fulfilment.operationRef.resolved !== true) {
      throw new Error('expected resolved operation fixture');
    }
    fulfilment.operationRef.signatureHash = computeSignatureHash('get_order', requiredOutputSig);
    const badConnector = new InMemoryConnector('acme_orders', '1.2.0', {
      get_order: {
        signature: requiredOutputSig,
        handler: () => ({}),
      },
    });
    const result = await executeTool(
      testArtifact,
      'get_order',
      { order_id: 'A1' },
      deps(badConnector),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('output_invalid');
      expect(result.error.path).toBe('output.order');
      expect(result.error.message).toContain('missing required output field "order"');
    }
  });

  it('rejects an optional output field when it is present with the wrong type', async () => {
    const optionalOutputSig: OperationSignature = {
      ...getOrderSignature,
      output: {
        type: 'object',
        properties: { order: { type: 'object' } },
        additionalProperties: false,
      },
    };
    const testArtifact = resolved();
    const fulfilment = testArtifact.tools[0]?.fulfilment;
    if (fulfilment?.kind !== 'operation' || fulfilment.operationRef.resolved !== true) {
      throw new Error('expected resolved operation fixture');
    }
    fulfilment.operationRef.signatureHash = computeSignatureHash('get_order', optionalOutputSig);
    const badConnector = new InMemoryConnector('acme_orders', '1.2.0', {
      get_order: {
        signature: optionalOutputSig,
        handler: () => ({ order: 'wrong type' }),
      },
    });
    const result = await executeTool(
      testArtifact,
      'get_order',
      { order_id: 'A1' },
      deps(badConnector),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('output_invalid');
      expect(result.error.path).toBe('output.order');
    }
  });

  it('allows primitive output when an operation declares no output fields', async () => {
    const emptyOutputSig: OperationSignature = {
      ...getOrderSignature,
      output: {},
    };
    const testArtifact = resolved();
    const fulfilment = testArtifact.tools[0]?.fulfilment;
    if (fulfilment?.kind !== 'operation' || fulfilment.operationRef.resolved !== true) {
      throw new Error('expected resolved operation fixture');
    }
    fulfilment.operationRef.signatureHash = computeSignatureHash('get_order', emptyOutputSig);
    const primitiveConnector = new InMemoryConnector('acme_orders', '1.2.0', {
      get_order: {
        signature: emptyOutputSig,
        handler: () => 'ok',
      },
    });
    const result = await executeTool(
      testArtifact,
      'get_order',
      { order_id: 'A1' },
      deps(primitiveConnector),
    );
    expect(result).toEqual({ ok: true, output: 'ok' });
  });

  it('rejects array and null output containers when output fields are declared', async () => {
    for (const output of [null, []]) {
      const badConnector = new InMemoryConnector('acme_orders', '1.2.0', {
        get_order: {
          signature: getOrderSignature,
          handler: () => output,
        },
      });
      const result = await executeTool(
        resolved(),
        'get_order',
        { order_id: 'A1' },
        deps(badConnector),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('output_invalid');
        expect(result.error.path).toBe('output');
        expect(result.error.message).toContain('container must be a non-null object');
      }
    }
  });
});
