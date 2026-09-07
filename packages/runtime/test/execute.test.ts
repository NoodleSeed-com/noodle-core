import {
  compileManifest,
  computeSignatureHash,
  InMemoryCatalog,
  type OperationSignature,
  type RuntimeArtifact,
} from '@noodle-borg/compiler';
import { describe, expect, it, vi } from 'vitest';
import { StaticServiceBroker } from '../src/broker/static.js';
import { type CredentialBroker, CredentialUnavailableError } from '../src/broker/types.js';
import { InMemoryConnector, InMemoryConnectorRegistry } from '../src/connector/in-memory.js';
import type { ConnectorCall } from '../src/connector/types.js';
import { executeTool } from '../src/execute.js';
import type { PolicyGate } from '../src/policy/types.js';
import {
  artifact,
  deps,
  getOrderSignature,
  ordersConnector,
  recordingConnector,
  resolved,
  SERVICE_CREDENTIAL,
} from './execute-fixtures.js';

describe('executeTool', () => {
  it('refuses a shape-only artifact', async () => {
    const { connector } = ordersConnector();
    const result = await executeTool(
      artifact('minimal.artifact.json'),
      'get_order',
      {},
      deps(connector),
    );
    expect(result).toEqual({
      ok: false,
      error: { code: 'shape_only_artifact', message: expect.any(String) },
    });
  });

  it('executes a single operation: evaluates args and returns the output', async () => {
    const { connector, calls } = ordersConnector();
    const result = await executeTool(resolved(), 'get_order', { order_id: 'A1' }, deps(connector));
    expect(result).toEqual({ ok: true, output: { order: { id: 'A1', status: 'open' } } });
    // The `${input.order_id}` argument expression was evaluated into `id`.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual({ id: 'A1' });
  });

  it('executes a pure connector-free steps-less flow', async () => {
    const compiled = compileManifest(
      {
        manifestVersion: '1',
        server: { name: 'pure', version: '1.0.0', title: 'Pure' },
        tools: [
          {
            name: 'echo',
            description: 'Echo input.',
            inputSchema: { type: 'object' },
            fulfilment: { steps: [], output: { id: '${input.id}', ok: 'true' } },
          },
        ],
      },
      { catalog: new InMemoryCatalog([]) },
    );
    if (!compiled.ok) throw new Error(`compile failed: ${JSON.stringify(compiled.errors)}`);
    const { connector } = ordersConnector();
    const result = await executeTool(compiled.artifact, 'echo', { id: 'A1' }, deps(connector));
    expect(result).toEqual({ ok: true, output: { id: 'A1', ok: 'true' } });
  });

  it('threads managed variables into connector calls', async () => {
    const { connector, calls } = recordingConnector(() => ({ order: { id: 'A1' } }));
    const result = await executeTool(
      resolved(),
      'get_order',
      { order_id: 'A1' },
      deps(connector, { env: { REGION: 'us' } }),
    );

    expect(result.ok).toBe(true);
    expect(calls[0]?.env).toEqual({ REGION: 'us' });
  });

  it('carries trusted admission attribution privately without adding it to business arguments', async () => {
    const { connector, calls } = recordingConnector();
    const publicAdmission = { network: 'network-digest', visitor: 'visitor-digest' };
    const result = await executeTool(
      resolved(),
      'get_order',
      { order_id: 'A1', publicAdmission: { network: 'forged' } },
      { ...deps(connector), publicAdmission },
    );
    expect(result.ok).toBe(true);
    expect(calls[0]?.publicAdmission).toEqual(publicAdmission);
    expect(calls[0]?.args).toEqual({ id: 'A1' });
    expect(calls[0]?.env).not.toHaveProperty('publicAdmission');
    expect(JSON.stringify(result)).not.toContain('network-digest');
  });

  it('preserves connector result metadata through flow output mapping', async () => {
    const projectedSignature: OperationSignature = {
      type: 'read',
      input: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: { order: { type: 'object' } },
        additionalProperties: false,
      },
    };
    const compiled = compileManifest(
      {
        manifestVersion: '1',
        server: { name: 'projection_flow', version: '1.0.0', title: 'Projection Flow' },
        connectors: {
          orders: { id: 'acme_orders', version: '1.2.0' },
        },
        tools: [
          {
            name: 'get_projected_order',
            description: 'Return a projected order.',
            inputSchema: { type: 'object' },
            fulfilment: {
              steps: [
                {
                  id: 'fetched',
                  use: 'orders.get_order',
                  args: { id: '${input.order_id}' },
                },
              ],
              output: { order: '${steps.fetched.order}' },
            },
          },
        ],
      },
      {
        catalog: new InMemoryCatalog([
          {
            id: 'acme_orders',
            version: '1.2.0',
            kind: 'catalog',
            operations: { get_order: projectedSignature },
          },
        ]),
      },
    );
    if (!compiled.ok) throw new Error(`compile failed: ${JSON.stringify(compiled.errors)}`);
    const connector = new InMemoryConnector('acme_orders', '1.2.0', {
      get_order: {
        signature: projectedSignature,
        handler: () => ({
          order: { id: 'A1', status: 'open' },
          __noodleResultMeta: {
            noodle: { projection: { source: { label: 'Orders API' } } },
          },
        }),
      },
    });

    const result = await executeTool(
      compiled.artifact,
      'get_projected_order',
      { order_id: 'A1' },
      deps(connector),
    );
    expect(result).toEqual({
      ok: true,
      output: {
        order: { id: 'A1', status: 'open' },
        __noodleResultMeta: {
          noodle: { projection: { source: { label: 'Orders API' } } },
        },
      },
    });
  });

  it('passes only the broker credential to the connector — never an inbound token', async () => {
    const { connector, calls } = ordersConnector();
    const broker: CredentialBroker = {
      getCredential: vi.fn(async () => SERVICE_CREDENTIAL),
    };
    const result = await executeTool(
      resolved(),
      'get_order',
      { order_id: 'A1' },
      deps(connector, { broker }),
    );
    expect(result.ok).toBe(true);
    expect(broker.getCredential).toHaveBeenCalledTimes(1);
    expect(broker.getCredential).toHaveBeenCalledWith({
      connectorId: 'acme_orders',
      connectorVersion: '1.2.0',
      operation: 'get_order',
    });
    // The connector received exactly the broker's credential.
    expect(calls[0]?.credential).toBe(SERVICE_CREDENTIAL);
  });

  it('passes verified caller identity to the credential broker for delegated credentials', async () => {
    const { connector } = recordingConnector();
    const caller = {
      subject: 'firebase-customer-sub',
      email: 'customer@example.com',
      audience: 'https://cloud.test/o/acme/app/mcp',
      identityKind: 'customer' as const,
      identityProvider: 'firebase',
    };
    const broker: CredentialBroker = {
      getCredential: vi.fn(async () => SERVICE_CREDENTIAL),
    };
    const result = await executeTool(
      resolved(),
      'get_order',
      { order_id: 'A1' },
      deps(connector, { broker, caller }),
    );
    expect(result.ok).toBe(true);
    expect(broker.getCredential).toHaveBeenCalledWith({
      connectorId: 'acme_orders',
      connectorVersion: '1.2.0',
      operation: 'get_order',
      caller,
    });
  });

  it('passes verified caller claims to connector calls without adding token material', async () => {
    const { connector, calls } = recordingConnector();
    const caller = { subject: 'google-sub-1', email: 'owner@example.com' };
    const result = await executeTool(
      resolved(),
      'get_order',
      { order_id: 'A1' },
      deps(connector, { caller }),
    );
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.caller).toEqual(caller);
    expect(calls[0]).not.toHaveProperty('token');
  });

  it('leaves caller absent when execution has no verified identity', async () => {
    const { connector, calls } = recordingConnector();
    const result = await executeTool(resolved(), 'get_order', { order_id: 'A1' }, deps(connector));
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.caller).toBeUndefined();
  });

  it('exposes verified caller claims to fulfilment expressions as user', async () => {
    const compiled = compileManifest(
      {
        manifestVersion: '1',
        server: { name: 'user_scope', version: '1.0.0', title: 'User Scope' },
        tools: [
          {
            name: 'whoami',
            description: 'Return caller claims.',
            inputSchema: { type: 'object' },
            fulfilment: {
              steps: [],
              output: {
                subject: '${user.subject}',
                email: '${user.email ?? "anonymous"}',
              },
            },
          },
        ],
      },
      { catalog: new InMemoryCatalog([]) },
    );
    if (!compiled.ok) throw new Error(`compile failed: ${JSON.stringify(compiled.errors)}`);
    const { connector } = ordersConnector();

    await expect(
      executeTool(
        compiled.artifact,
        'whoami',
        {},
        deps(connector, { caller: { subject: 'user-sub', email: 'user@example.com' } }),
      ),
    ).resolves.toEqual({
      ok: true,
      output: { subject: 'user-sub', email: 'user@example.com' },
    });
    await expect(executeTool(compiled.artifact, 'whoami', {}, deps(connector))).resolves.toEqual({
      ok: true,
      output: { email: 'anonymous' },
    });
  });

  /**
   * An anonymous caller is a real principal with an opaque subject, not a signed-in person — so
   * `${user}` must be absent rather than resolving to that subject. The compiler already refuses to
   * project a `${user}`-reading tool onto a public surface (ADR 0201); this is the runtime half, so a
   * path that reaches an anonymous caller by any other route still cannot read an identity.
   */
  it('omits user from the expression scope for an anonymous caller', async () => {
    const compiled = compileManifest(
      {
        manifestVersion: '1',
        server: { name: 'anon_scope', version: '1.0.0', title: 'Anon Scope' },
        tools: [
          {
            name: 'whoami',
            description: 'Return caller claims.',
            inputSchema: { type: 'object' },
            fulfilment: {
              steps: [],
              output: { subject: '${user.subject ?? "none"}' },
            },
          },
        ],
      },
      { catalog: new InMemoryCatalog([]) },
    );
    if (!compiled.ok) throw new Error(`compile failed: ${JSON.stringify(compiled.errors)}`);
    const { connector } = ordersConnector();

    // A verified caller resolves its subject...
    await expect(
      executeTool(
        compiled.artifact,
        'whoami',
        {},
        deps(connector, { caller: { subject: 'user-sub' } }),
      ),
    ).resolves.toEqual({ ok: true, output: { subject: 'user-sub' } });

    // ...an anonymous one does not, even though it has a subject of its own.
    await expect(
      executeTool(
        compiled.artifact,
        'whoami',
        {},
        deps(connector, { caller: { subject: 'anon_7f2q', identityKind: 'anonymous' } }),
      ),
    ).resolves.toEqual({ ok: true, output: { subject: 'none' } });
  });

  it('exposes the verified name and declared session claims as user.name / user.claims.*', async () => {
    const compiled = compileManifest(
      {
        manifestVersion: '1',
        server: { name: 'user_claims', version: '1.0.0', title: 'User Claims' },
        tools: [
          {
            name: 'greet',
            description: 'Greet the verified user with session claims.',
            inputSchema: { type: 'object' },
            fulfilment: {
              steps: [],
              output: {
                greeting: 'Hello, ${user.name}!',
                tier: '${user.claims.accountTier}',
              },
            },
          },
        ],
      },
      { catalog: new InMemoryCatalog([]) },
    );
    if (!compiled.ok) throw new Error(`compile failed: ${JSON.stringify(compiled.errors)}`);
    const { connector } = ordersConnector();
    await expect(
      executeTool(
        compiled.artifact,
        'greet',
        {},
        deps(connector, {
          caller: { subject: 'user-sub', name: 'Fahd Rafi', claims: { accountTier: 'pro' } },
        }),
      ),
    ).resolves.toEqual({
      ok: true,
      output: { greeting: 'Hello, Fahd Rafi!', tier: 'pro' },
    });
  });

  it('preserves caller claims through host-mediated nested connector calls', async () => {
    const caller = { subject: 'google-sub-1', email: 'owner@example.com' };
    const { connector, calls } = recordingConnector((call) => {
      if (call.args.id === 'nested') return { order: { id: 'nested', status: 'open' } };
      const fulfilment = resolved().tools[0]?.fulfilment;
      if (fulfilment?.kind !== 'operation' || fulfilment.operationRef.resolved !== true) {
        throw new Error('expected resolved operation fixture');
      }
      const nestedRef = {
        ...fulfilment.operationRef,
        operation: 'get_related_order',
        signatureHash: computeSignatureHash('get_related_order', getOrderSignature),
      };
      return call.host?.callOperation(nestedRef, { id: 'nested' }, 'host');
    });
    const result = await executeTool(
      resolved(),
      'get_order',
      { order_id: 'A1' },
      deps(connector, { caller }),
    );
    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.caller)).toEqual([caller, caller]);
  });

  it('fails closed when host-mediated connector calls re-enter the same operation', async () => {
    const fixture = resolved();
    const fulfilment = fixture.tools[0]?.fulfilment;
    if (fulfilment?.kind !== 'operation' || fulfilment.operationRef.resolved !== true) {
      throw new Error('expected resolved operation fixture');
    }
    const { connector } = recordingConnector((call) =>
      call.host?.callOperation(fulfilment.operationRef, { id: 'nested' }, 'host'),
    );

    const result = await executeTool(fixture, 'get_order', { order_id: 'A1' }, deps(connector));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('circular_call_dependency');
  });

  it('does not confuse distinct nested operation tuples whose delimiter strings collide', async () => {
    const fixture = resolved();
    const fulfilment = fixture.tools[0]?.fulfilment;
    if (fulfilment?.kind !== 'operation' || fulfilment.operationRef.resolved !== true) {
      throw new Error('expected resolved operation fixture');
    }
    const topRef = {
      ...fulfilment.operationRef,
      connectorId: 'a',
      connectorVersion: 'b',
      operation: 'c.d',
      signatureHash: computeSignatureHash('c.d', getOrderSignature),
    };
    const nestedRef = {
      ...fulfilment.operationRef,
      connectorId: 'a',
      connectorVersion: 'b.c',
      operation: 'd',
      signatureHash: computeSignatureHash('d', getOrderSignature),
    };
    const collidingFixture: RuntimeArtifact = {
      ...fixture,
      tools: fixture.tools.map((tool, index) =>
        index === 0
          ? {
              ...tool,
              fulfilment: {
                ...fulfilment,
                operationRef: topRef,
              },
            }
          : tool,
      ),
    };
    const connector = {
      id: 'a',
      version: 'b',
      signature: () => getOrderSignature,
      async invoke(call: ConnectorCall) {
        if (call.operation === 'c.d') {
          return call.host?.callOperation(nestedRef, { id: 'nested' }, 'host');
        }
        return { order: { id: 'nested', status: 'open' } };
      },
    };

    const result = await executeTool(
      collidingFixture,
      'get_order',
      { order_id: 'A1' },
      {
        ...deps(connector),
        connectors: { resolve: () => connector },
      },
    );

    expect(result).toEqual({
      ok: true,
      output: { order: { id: 'nested', status: 'open' } },
    });
  });

  it('rejects an unknown tool', async () => {
    const { connector } = ordersConnector();
    const result = await executeTool(resolved(), 'nope', {}, deps(connector));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown_tool');
  });

  it('fails when no connector is registered for the operation', async () => {
    const empty = {
      connectors: new InMemoryConnectorRegistry([]),
      broker: new StaticServiceBroker(SERVICE_CREDENTIAL),
    };
    const result = await executeTool(resolved(), 'get_order', { order_id: 'A1' }, empty);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('connector_unavailable');
  });

  it('detects connector signature drift from the compiled artifact', async () => {
    const drifted = new InMemoryConnector('acme_orders', '1.2.0', {
      get_order: {
        signature: {
          type: 'read',
          input: {
            type: 'object',
            properties: { id: { type: 'number' } },
            required: ['id'],
            additionalProperties: false,
          },
          output: {},
        },
        handler: () => ({ order: {} }),
      },
    });
    const result = await executeTool(resolved(), 'get_order', { order_id: 'A1' }, deps(drifted));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('signature_drift');
  });

  it('detects a missing live operation signature as signature drift', async () => {
    const missingSignature = {
      id: 'acme_orders',
      version: '1.2.0',
      signature: () => undefined,
      invoke: async () => ({ order: {} }),
    };
    const result = await executeTool(
      resolved(),
      'get_order',
      { order_id: 'A1' },
      deps(missingSignature),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('signature_drift');
      expect(result.error.message).toContain('has no operation');
    }
  });

  it('honors a denying policy before the connector runs', async () => {
    const { connector, calls } = ordersConnector();
    const policy: PolicyGate = {
      before: async () => ({ allow: false, reason: 'blocked by test policy' }),
      after: async (_ctx, output) => output,
    };
    const result = await executeTool(
      resolved(),
      'get_order',
      { order_id: 'A1' },
      deps(connector, { policy }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('policy_denied');
    expect(calls).toHaveLength(0);
  });

  it('normalizes policy before hook failures without running the connector', async () => {
    const { connector, calls } = ordersConnector();
    const policy: PolicyGate = {
      before: async () => {
        throw new Error('policy secret');
      },
      after: async (_ctx, output) => output,
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
      expect(result.error.message).not.toContain('policy secret');
    }
    expect(calls).toHaveLength(0);
  });

  it('normalizes broker credential failures without invoking the connector', async () => {
    const { connector, calls } = ordersConnector();
    const broker: CredentialBroker = {
      getCredential: async () => {
        throw new Error('credential backend secret');
      },
    };
    const result = await executeTool(
      resolved(),
      'get_order',
      { order_id: 'A1' },
      deps(connector, { broker }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('credential_unavailable');
      expect(result.error.message).not.toContain('credential backend secret');
    }
    expect(calls).toHaveLength(0);
  });

  it('normalizes a getPrototypeOf-throwing broker rejection without invoking its trap', async () => {
    const { connector, calls } = ordersConnector();
    const poison =
      'customer_api sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa https://tenant.api.example.com/private';
    const broker: CredentialBroker = {
      getCredential: async () => {
        throw new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error(poison);
            },
          },
        );
      },
    };

    const result = await executeTool(
      resolved(),
      'get_order',
      { order_id: 'A1' },
      deps(connector, { broker }),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'credential_unavailable',
        message: 'credential unavailable for operation "get_order"',
      },
    });
    expect(JSON.stringify(result)).not.toContain(poison);
    expect(calls).toHaveLength(0);
  });

  it('uses constructor-time diagnostics when a branded broker rejection is later poisoned', async () => {
    const { connector, calls } = ordersConnector();
    const poison =
      'customer_api sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb https://tenant.api.example.com/private';
    const rejection = new CredentialUnavailableError('caller_identity_not_customer', {
      fix: 'Authenticate through the configured customer OIDC provider.',
      next: ['noodle auth doctor --live'],
    });
    for (const key of ['reason', 'fix', 'next']) {
      Object.defineProperty(rejection, key, {
        configurable: true,
        get() {
          throw new Error(`${key} trap ${poison}`);
        },
      });
    }
    const broker: CredentialBroker = {
      getCredential: async () => {
        throw rejection;
      },
    };

    const result = await executeTool(
      resolved(),
      'get_order',
      { order_id: 'A1' },
      deps(connector, { broker }),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'credential_unavailable',
        message: 'credential unavailable for operation "get_order"',
        reason: 'caller_identity_not_customer',
        fix: 'Authenticate through the configured customer OIDC provider.',
        next: ['noodle auth doctor --live'],
      },
    });
    expect(JSON.stringify(result)).not.toContain(poison);
    expect(calls).toHaveLength(0);
  });

  it('maps a broker route-binding failure to the safe customer route error', async () => {
    const { connector, calls } = ordersConnector();
    const poison =
      'customer_api sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc https://tenant.api.example.com/private';
    const broker: CredentialBroker = {
      getCredential: async () => {
        throw new CredentialUnavailableError('connector_route_unavailable', {
          fix: poison,
          next: [poison],
        });
      },
    };

    const result = await executeTool(
      resolved(),
      'get_order',
      { order_id: 'A1' },
      deps(connector, { broker }),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'connector_route_unavailable',
        message: 'Customer connector route is unavailable.',
      },
    });
    expect(JSON.stringify(result)).not.toContain(poison);
    expect(calls).toHaveLength(0);
  });

  it('surfaces only allowlisted broker diagnostics for self-diagnosing credential failures', async () => {
    const { connector, calls } = ordersConnector();
    const broker: CredentialBroker = {
      getCredential: async () => {
        throw new CredentialUnavailableError('caller_identity_not_customer', {
          fix: 'Authenticate through the configured customer OIDC provider.',
          next: ['noodle auth doctor --live'],
        });
      },
    };
    const result = await executeTool(
      resolved(),
      'get_order',
      { order_id: 'A1' },
      deps(connector, { broker }),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'credential_unavailable',
        message: 'credential unavailable for operation "get_order"',
        reason: 'caller_identity_not_customer',
        fix: 'Authenticate through the configured customer OIDC provider.',
        next: ['noodle auth doctor --live'],
      },
    });
    expect(calls).toHaveLength(0);
  });

  it('fails the call when a required argument evaluates to undefined', async () => {
    const { connector, calls } = ordersConnector();
    const result = await executeTool(resolved(), 'get_order', {}, deps(connector));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('arg_invalid');
      expect(result.error.path).toBe('args.id');
    }
    expect(calls).toHaveLength(0);
  });

  it('declines flow fulfilment that would require elicitation', async () => {
    // `elicit` is reserved at the manifest boundary (ADR 0150); the runtime keeps this defensive
    // decline for any artifact that still carries one (e.g. hand-built or stale).
    const parsed = artifact('flow-basic.artifact.json') as unknown as {
      tools: { name: string; fulfilment: { steps: unknown[] } }[];
    };
    parsed.tools[0]?.fulfilment.steps.splice(1, 0, {
      id: 'confirm_input',
      kind: 'elicit',
      schema: { type: 'object' },
    });
    const flow = parsed as unknown as RuntimeArtifact;
    const toolName = flow.tools[0]?.name ?? '';
    const { connector } = ordersConnector();
    const result = await executeTool(flow, toolName, {}, deps(connector));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unsupported_fulfilment');
  });

  it('fails when an argument type mismatch is detected at runtime', async () => {
    const { connector } = ordersConnector();
    const result = await executeTool(resolved(), 'get_order', { order_id: 123 }, deps(connector));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('arg_invalid');
      expect(result.error.path).toBe('args.id');
      expect(result.error.message).toContain('expects string');
    }
  });

  it('enforces nested connector argument constraints before invocation', async () => {
    const nestedSignature: OperationSignature = {
      ...getOrderSignature,
      input: {
        type: 'object',
        properties: {
          id: {
            type: 'object',
            properties: { value: { type: 'string', minLength: 3 } },
            required: ['value'],
            additionalProperties: false,
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
    };
    const testArtifact = resolved();
    const fulfilment = testArtifact.tools[0]?.fulfilment;
    if (fulfilment?.kind !== 'operation' || fulfilment.operationRef.resolved !== true) {
      throw new Error('expected resolved operation fixture');
    }
    fulfilment.operationRef.signatureHash = computeSignatureHash('get_order', nestedSignature);
    const calls: ConnectorCall[] = [];
    const connector = new InMemoryConnector('acme_orders', '1.2.0', {
      get_order: {
        signature: nestedSignature,
        handler: (args, credential) => {
          calls.push({ operation: 'get_order', args, credential });
          return { order: {} };
        },
      },
    });

    const result = await executeTool(
      testArtifact,
      'get_order',
      { order_id: { value: 'x' } },
      deps(connector),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('arg_invalid');
      expect(result.error.path).toBe('args.id.value');
    }
    expect(calls).toHaveLength(0);
  });
});
