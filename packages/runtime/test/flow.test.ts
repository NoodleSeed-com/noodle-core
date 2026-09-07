import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CatalogConnector,
  compile,
  InMemoryCatalog,
  type OperationSignature,
  type RuntimeArtifact,
} from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { StaticServiceBroker } from '../src/broker/static.js';
import { InMemoryConnector, InMemoryConnectorRegistry } from '../src/connector/in-memory.js';
import type { ConnectorCall } from '../src/connector/types.js';
import { type ExecuteDeps, executeTool } from '../src/execute.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', '..', 'compiler', 'fixtures', 'valid');

/** Signatures mirrored by the runtime connector below, so compiled hashes match at runtime. */
const getOrderSig: OperationSignature = {
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
const getTrackingSig: OperationSignature = {
  type: 'read',
  input: {
    type: 'object',
    properties: { order_id: { type: 'string' } },
    required: ['order_id'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: { url: { type: 'string' } },
    additionalProperties: false,
  },
};
const acmeOrders: CatalogConnector = {
  id: 'acme_orders',
  version: '1.2.0',
  kind: 'catalog',
  operations: { get_order: getOrderSig, get_tracking: getTrackingSig },
};
const catalog = new InMemoryCatalog([acmeOrders]);

/** A two-operation flow with a map step and an `if`-gated map step, plus an output mapping. */
const FLOW_MANIFEST = `
manifestVersion: "1"
server:
  name: acme_support
  version: 1.0.0
  title: Acme Support
connectors:
  acme:
    id: acme_orders
    version: 1.2.0
tools:
  - name: track_order
    description: Look up an order, fetch its tracking, and shape a result.
    inputSchema:
      type: object
      properties:
        order_id:
          type: string
      required:
        - order_id
      additionalProperties: false
    fulfilment:
      steps:
        - id: lookup
          use: acme.get_order
          args:
            id: \${input.order_id}
        - id: track
          use: acme.get_tracking
          args:
            order_id: \${input.order_id}
        - id: shape
          map:
            ref: \${steps.lookup.order}
        - id: maybe
          if: \${input.order_id === "SKIP"}
          map:
            flag: \${true}
      output:
        tracking: \${steps.track.url}
        ref: \${steps.shape.ref}
        skipped_flag: \${steps.maybe.flag}
`;

/** Compile the flow manifest against the catalog into a resolved artifact. */
function flowArtifact(): RuntimeArtifact {
  const result = compile(FLOW_MANIFEST, { catalog });
  if (!result.ok)
    throw new Error(`flow manifest failed to compile: ${JSON.stringify(result.errors)}`);
  return result.artifact;
}

/** Build the acme_orders connector; get_tracking output is derived from the order id it received. */
function ordersConnector(): { connector: InMemoryConnector; calls: ConnectorCall[] } {
  const calls: ConnectorCall[] = [];
  const record =
    (op: string, run: (args: Readonly<Record<string, unknown>>) => unknown) =>
    (args: Readonly<Record<string, unknown>>, credential: ConnectorCall['credential']) => {
      calls.push({ operation: op, args, credential });
      return run(args);
    };
  const connector = new InMemoryConnector('acme_orders', '1.2.0', {
    get_order: {
      signature: getOrderSig,
      handler: record('get_order', (args) => ({ order: { id: args.id, status: 'open' } })),
    },
    get_tracking: {
      signature: getTrackingSig,
      handler: record('get_tracking', (args) => ({
        url: `https://track/${String(args.order_id)}`,
      })),
    },
  });
  return { connector, calls };
}

function deps(connector: InMemoryConnector): ExecuteDeps {
  return {
    connectors: new InMemoryConnectorRegistry([connector]),
    broker: new StaticServiceBroker({ token: 'svc-token' }),
  };
}

describe('flow execution', () => {
  it('runs ordered steps, threads step outputs, and builds the output mapping', async () => {
    const { connector, calls } = ordersConnector();
    const result = await executeTool(
      flowArtifact(),
      'track_order',
      { order_id: 'A1' },
      deps(connector),
    );

    expect(result).toEqual({
      ok: true,
      output: {
        tracking: 'https://track/A1',
        ref: { id: 'A1', status: 'open' },
        // `maybe` was skipped (order_id !== "SKIP"), so skipped_flag resolves to undefined and is omitted.
      },
    });
    // Both operation steps ran in order; `track` read input, `shape`/`output` read prior step outputs.
    expect(calls.map((c) => c.operation)).toEqual(['get_order', 'get_tracking']);
  });

  it('runs an if-gated step when its condition holds', async () => {
    const { connector } = ordersConnector();
    const result = await executeTool(
      flowArtifact(),
      'track_order',
      { order_id: 'SKIP' },
      deps(connector),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toEqual({
        tracking: 'https://track/SKIP',
        ref: { id: 'SKIP', status: 'open' },
        skipped_flag: true, // `maybe` ran because order_id === "SKIP"
      });
    }
  });

  it('skips an if-gated operation step without invoking its connector operation', async () => {
    const result = compile(
      `
manifestVersion: "1"
server:
  name: acme_support
  version: 1.0.0
  title: Acme Support
connectors:
  acme:
    id: acme_orders
    version: 1.2.0
tools:
  - name: maybe_track
    description: Conditionally fetch tracking.
    inputSchema:
      type: object
    fulfilment:
      steps:
        - id: lookup
          use: acme.get_order
          args:
            id: \${input.order_id}
        - id: track
          if: \${input.should_track}
          use: acme.get_tracking
          args:
            order_id: \${input.order_id}
      output:
        order: \${steps.lookup.order}
        tracking: \${steps.track.url}
`,
      { catalog },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { connector, calls } = ordersConnector();
    const executed = await executeTool(
      result.artifact,
      'maybe_track',
      { order_id: 'A1', should_track: false },
      deps(connector),
    );

    expect(executed).toEqual({
      ok: true,
      output: { order: { id: 'A1', status: 'open' } },
    });
    expect(calls.map((c) => c.operation)).toEqual(['get_order']);
  });

  it('propagates a per-step connector error and stops the flow', async () => {
    const calls: ConnectorCall[] = [];
    const connector = new InMemoryConnector('acme_orders', '1.2.0', {
      get_order: {
        signature: getOrderSig,
        handler: (args, credential) => {
          calls.push({ operation: 'get_order', args, credential });
          return { order: { id: args.id, status: 'open' } };
        },
      },
      get_tracking: {
        signature: getTrackingSig,
        handler: () => {
          throw new Error('tracking backend down');
        },
      },
    });
    const result = await executeTool(
      flowArtifact(),
      'track_order',
      { order_id: 'A1' },
      deps(connector),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('connector_error');
      expect(result.error.message).not.toContain('backend down');
    }
    // The first step still ran; the flow stopped at the failing second step.
    expect(calls.map((c) => c.operation)).toEqual(['get_order']);
  });

  it('declines a flow that contains an elicit step before running any step', async () => {
    // `elicit` is reserved at the manifest boundary (ADR 0150), so no compiled artifact carries it;
    // the runtime keeps this defensive decline for any artifact that does (e.g. hand-built or stale).
    const parsed = JSON.parse(readFileSync(join(fixtures, 'flow-basic.artifact.json'), 'utf8')) as {
      tools: { fulfilment: { steps: unknown[] } }[];
    };
    parsed.tools[0]?.fulfilment.steps.splice(1, 0, {
      id: 'confirm_input',
      kind: 'elicit',
      schema: { type: 'object' },
    });
    const flowBasic = parsed as unknown as RuntimeArtifact;
    const { connector, calls } = ordersConnector();
    const result = await executeTool(flowBasic, 'track_order', { order_id: 'A1' }, deps(connector));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unsupported_fulfilment');
    expect(calls).toHaveLength(0); // no side effect for a flow that cannot complete this phase
  });
});
