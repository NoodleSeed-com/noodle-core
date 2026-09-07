import type { ResolvedOperationRef } from '@noodle-borg/compiler';
import { describe, expect, it, vi } from 'vitest';
import { executeTool } from '../src/execute.js';
import { cloneRoutedOutput } from '../src/routed-output-guard.js';
import { harness, operationRef, ROUTE_URL } from './customer-routing-fixtures.js';

describe('customer route output guard', () => {
  it.each([
    { nested: { value: `backend echoed ${ROUTE_URL}/private` } },
    { nested: { [`${ROUTE_URL}/private`]: 'value' } },
  ])('fails closed before policy when routed output contains its base URL', async (output) => {
    const run = harness();
    vi.spyOn(run.connector, 'invoke').mockResolvedValue(output);

    const result = await executeTool(run.artifact, 'list_records', {}, run.deps);

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'connector_error',
        message: 'connector failed for operation "list_records"',
      },
    });
    expect(JSON.stringify(result)).not.toContain(ROUTE_URL);
    expect(run.policy.after).not.toHaveBeenCalled();
  });

  it.each([
    ['upper-case scheme and host', ROUTE_URL, 'HTTPS://TENANT.API.NOODLESEED.DEV/v1'],
    ['explicit default port', ROUTE_URL, 'https://tenant.api.noodleseed.dev:443/v1'],
    ['host-only echo', ROUTE_URL, 'tenant.api.noodleseed.dev'],
    ['host-only object key', ROUTE_URL, { 'TENANT.API.NOODLESEED.DEV': true }],
    ['percent-encoded host', ROUTE_URL, 'tenant%2Eapi%2Enoodleseed%2Edev'],
    ['percent-encoded URL', ROUTE_URL, 'https%3A%2F%2Ftenant%2Eapi%2Enoodleseed%2Edev%2Fv1'],
    ['Unicode form of a punycode host', 'https://xn--bcher-kva.example/v1', 'bücher.example'],
    ['malformed percent encoding', ROUTE_URL, 'unrelated-%E0%A4%A'],
  ])('detects a routed hostname in %s output', (_name, baseUrl, output) => {
    expect(cloneRoutedOutput(output, baseUrl)).toEqual({ ok: false });
  });

  it('allows unrelated output that does not echo the routed hostname', () => {
    expect(
      cloneRoutedOutput(
        { message: 'request completed', host: 'other.api.noodleseed.dev' },
        ROUTE_URL,
      ),
    ).toMatchObject({ ok: true });
  });

  it('returns a detached, deeply frozen JSON-data clone for downstream policy', () => {
    const source = {
      message: 'request completed',
      nested: [{ id: 1 }, true, null],
    };

    const result = cloneRoutedOutput(source, ROUTE_URL);

    expect(result).toMatchObject({ ok: true, value: source });
    if (!result.ok) throw new Error('expected cloned output');
    expect(result.value).not.toBe(source);
    expect(Object.getPrototypeOf(result.value)).toBeNull();
    expect(Object.isFrozen(result.value)).toBe(true);
    const nested = (result.value as { readonly nested: readonly unknown[] }).nested;
    expect(nested).not.toBe(source.nested);
    expect(Object.isFrozen(nested)).toBe(true);
    expect(Object.isFrozen(nested[0])).toBe(true);

    source.message = ROUTE_URL;
    source.nested[0] = { id: 2 };
    expect(result.value).toMatchObject({
      message: 'request completed',
      nested: [{ id: 1 }, true, null],
    });
  });

  it('passes only the verified clone to policy and never the mutable connector object', async () => {
    const run = harness();
    const source = {};
    vi.spyOn(run.connector, 'invoke').mockResolvedValue(source);
    let policyOutput: unknown;
    run.policy.after.mockImplementation(async (_context, output) => {
      policyOutput = output;
      return output;
    });

    await expect(executeTool(run.artifact, 'list_records', {}, run.deps)).resolves.toEqual({
      ok: true,
      output: {},
    });

    expect(policyOutput).not.toBe(source);
    expect(Object.getPrototypeOf(policyOutput)).toBeNull();
    expect(Object.isFrozen(policyOutput)).toBe(true);
  });

  it.each([
    [
      'a non-enumerable toJSON closure',
      () => {
        const value = {};
        Object.defineProperty(value, 'toJSON', {
          enumerable: false,
          value: () => ROUTE_URL,
        });
        return value;
      },
    ],
    [
      'an accessor',
      () =>
        Object.defineProperty({}, 'value', {
          enumerable: true,
          get: () => 'safe',
        }),
    ],
    ['a function value', () => ({ value: () => 'safe' })],
    ['a symbol value', () => ({ value: Symbol('safe') })],
    ['a symbol key', () => ({ [Symbol('route')]: 'safe' })],
    ['an undefined value', () => ({ value: undefined })],
    ['a bigint value', () => ({ value: 1n })],
    ['a non-finite number', () => ({ value: Number.POSITIVE_INFINITY })],
    ['a custom prototype', () => Object.create({ inherited: true })],
    [
      'a cycle',
      () => {
        const value: { self?: unknown } = {};
        value.self = value;
        return value;
      },
    ],
    ['a sparse array', () => Array(2)],
    ['an array with an extra property', () => Object.assign([], { extra: 'value' })],
    [
      'a non-enumerable own property',
      () => Object.defineProperty({}, 'hidden', { enumerable: false, value: 'safe' }),
    ],
    [
      'a descriptor-failing proxy',
      () =>
        new Proxy(
          { value: 'safe' },
          {
            getOwnPropertyDescriptor() {
              throw new Error('descriptor trap failed');
            },
          },
        ),
    ],
    [
      'a depth overflow',
      () => {
        const root: Record<string, unknown> = {};
        let cursor = root;
        for (let depth = 0; depth < 34; depth += 1) {
          const next: Record<string, unknown> = {};
          cursor.next = next;
          cursor = next;
        }
        return root;
      },
    ],
    ['a node-count overflow', () => Array.from({ length: 10_001 }, () => null)],
  ])('fails closed before policy for %s', async (_name, outputFactory) => {
    const run = harness();
    vi.spyOn(run.connector, 'invoke').mockResolvedValue(outputFactory());

    await expect(executeTool(run.artifact, 'list_records', {}, run.deps)).resolves.toMatchObject({
      ok: false,
      error: { code: 'connector_error' },
    });
    expect(run.policy.after).not.toHaveBeenCalled();
  });

  it('uses descriptor snapshots so later proxy values cannot change policy input', async () => {
    const run = harness();
    let descriptorReads = 0;
    const source = new Proxy(
      { value: 'first' },
      {
        getOwnPropertyDescriptor(_target, property) {
          descriptorReads += 1;
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: property === 'value' && descriptorReads > 1 ? ROUTE_URL : 'first',
          };
        },
      },
    );
    vi.spyOn(run.connector, 'invoke').mockResolvedValue(source);
    let policyOutput: unknown;
    run.policy.after.mockImplementation(async (_context, output) => {
      policyOutput = output;
      return {};
    });

    await expect(executeTool(run.artifact, 'list_records', {}, run.deps)).resolves.toEqual({
      ok: true,
      output: {},
    });
    expect(descriptorReads).toBe(1);
    expect(policyOutput).toEqual({ value: 'first' });
    expect(policyOutput).not.toBe(source);
  });

  it.each([
    'mutation',
    'proxy',
  ] as const)('uses the private HostCallError snapshot after connector %s', async (mode) => {
    const run = harness();
    const rootRef = operationRef(run.artifact);
    const missingRef: ResolvedOperationRef = {
      ...rootRef,
      connectorId: 'missing_connector',
    };
    vi.spyOn(run.connector, 'invoke').mockImplementation(async (call) => {
      try {
        return await call.host?.callOperation(missingRef, {}, 'nested');
      } catch (error) {
        if (mode === 'mutation') {
          Object.assign(error as object, {
            code: 'connector_error',
            message: ROUTE_URL,
            path: ROUTE_URL,
          });
          throw error;
        }
        throw new Proxy(error as object, {
          getPrototypeOf() {
            throw new Error(`host proxy trap ${ROUTE_URL}`);
          },
        });
      }
    });
    const deps = {
      ...run.deps,
      connectors: {
        resolve: (ref: ResolvedOperationRef) =>
          ref.connectorId === rootRef.connectorId ? run.connector : undefined,
      },
    };

    const result = await executeTool(run.artifact, 'list_records', {}, deps);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: mode === 'mutation' ? 'connector_unavailable' : 'connector_error',
      },
    });
    expect(JSON.stringify(result)).not.toContain(ROUTE_URL);
  });
});
