import {
  type CatalogConnector,
  compileManifest,
  InMemoryCatalog,
  type Manifest,
  type OperationSignature,
} from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { StaticServiceBroker } from '../src/broker/static.js';
import { InMemoryConnector, InMemoryConnectorRegistry } from '../src/connector/in-memory.js';
import { type ExecuteDeps, executePrompt, executeResource } from '../src/execute.js';
import type { PolicyGate } from '../src/policy/types.js';

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
const acmeOrders: CatalogConnector = {
  id: 'acme_orders',
  version: '1.2.0',
  kind: 'catalog',
  operations: { get_order: getOrderSig },
};
const catalog = new InMemoryCatalog([acmeOrders]);

function deps(): ExecuteDeps {
  const connector = new InMemoryConnector('acme_orders', '1.2.0', {
    get_order: {
      signature: getOrderSig,
      handler: (args) => ({ order: { id: args.id, status: 'open' } }),
    },
  });
  return {
    connectors: new InMemoryConnectorRegistry([connector]),
    broker: new StaticServiceBroker({ token: 'svc' }),
  };
}

const ACME = { acme: { id: 'acme_orders', version: '1.2.0' } };

const base = {
  manifestVersion: '1' as const,
  server: { name: 'acme_support', version: '1.0.0', title: 'Acme Support' },
  tools: [
    {
      name: 'noop',
      description: 'A no-op tool.',
      inputSchema: { type: 'object' },
      fulfilment: { steps: [{ id: 'm', map: { v: 'ok' } }], output: { ok: '${steps.m.v}' } },
    },
  ],
};

/** Compile the base manifest plus the supplied resources/prompts (and connectors when needed). */
function build(extra: Partial<Manifest>) {
  const result = compileManifest({ ...base, ...extra } as Manifest, { catalog });
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.errors)}`);
  return result.artifact;
}

describe('executeResource', () => {
  it('refuses a shape-only artifact', async () => {
    const result = compileManifest({
      ...base,
      resources: [
        {
          name: 'changelog',
          uri: 'docs://changelog',
          fulfilment: { steps: [], output: { value: '# Changelog' } },
        },
      ],
    } as Manifest);
    if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.errors)}`);

    const executed = await executeResource(result.artifact, 'changelog', {}, deps());
    expect(executed).toMatchObject({ ok: false, error: { code: 'shape_only_artifact' } });
  });

  it('runs a static (steps-less) resource and returns its constant output', async () => {
    const artifact = build({
      resources: [
        {
          name: 'changelog',
          uri: 'docs://changelog',
          fulfilment: { steps: [], output: { value: '# Changelog' } },
        },
      ],
    });
    const result = await executeResource(artifact, 'changelog', {}, deps());
    expect(result).toEqual({ ok: true, output: { value: '# Changelog' } });
  });

  it('runs a templated resource: extracted URI vars feed a connector call', async () => {
    const artifact = build({
      connectors: ACME,
      resources: [
        {
          name: 'order',
          uri: 'orders://{id}',
          fulfilment: {
            steps: [{ id: 'get', use: 'acme.get_order', args: { id: '${input.id}' } }],
            output: { value: '${steps.get.order}' },
          },
        },
      ],
    });
    const result = await executeResource(artifact, 'order', { id: 'A1' }, deps());
    expect(result).toEqual({ ok: true, output: { value: { id: 'A1', status: 'open' } } });
  });

  it('runs a direct-operation resource fulfilment', async () => {
    const artifact = build({
      connectors: ACME,
      resources: [
        {
          name: 'order',
          uri: 'orders://{id}',
          fulfilment: { use: 'acme.get_order', args: { id: '${input.id}' } },
        },
      ],
    });
    const result = await executeResource(artifact, 'order', { id: 'A1' }, deps());
    expect(result).toEqual({ ok: true, output: { order: { id: 'A1', status: 'open' } } });
  });

  it('applies policy gates to connector-backed resources', async () => {
    const artifact = build({
      connectors: ACME,
      resources: [
        {
          name: 'order',
          uri: 'orders://{id}',
          fulfilment: {
            steps: [{ id: 'get', use: 'acme.get_order', args: { id: '${input.id}' } }],
            output: { value: '${steps.get.order}' },
          },
        },
      ],
    });
    const policy: PolicyGate = {
      before: async () => ({ allow: false, reason: 'blocked' }),
      after: async (_ctx, output) => output,
    };
    const result = await executeResource(artifact, 'order', { id: 'A1' }, { ...deps(), policy });
    expect(result).toMatchObject({ ok: false, error: { code: 'policy_denied' } });
  });

  it('fails with unknown_resource for a missing name', async () => {
    const artifact = build({
      resources: [{ name: 'x', uri: 'a://x', fulfilment: { steps: [], output: { value: '1' } } }],
    });
    const result = await executeResource(artifact, 'nope', {}, deps());
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown_resource' } });
  });
});

describe('executePrompt', () => {
  it('refuses a shape-only artifact', async () => {
    const result = compileManifest({
      ...base,
      prompts: [
        {
          name: 'triage',
          arguments: [{ name: 'id', required: true }],
          fulfilment: { steps: [], output: { value: 'Triage ${input.id}' } },
        },
      ],
    } as Manifest);
    if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.errors)}`);

    const executed = await executePrompt(result.artifact, 'triage', { id: '42' }, deps());
    expect(executed).toMatchObject({ ok: false, error: { code: 'shape_only_artifact' } });
  });

  it('interpolates arguments into a static prompt output', async () => {
    const artifact = build({
      prompts: [
        {
          name: 'triage',
          arguments: [{ name: 'id', required: true }],
          fulfilment: { steps: [], output: { value: 'Triage ticket ${input.id}' } },
        },
      ],
    });
    const result = await executePrompt(artifact, 'triage', { id: '42' }, deps());
    expect(result).toEqual({ ok: true, output: { value: 'Triage ticket 42' } });
  });

  it('runs a connector-backed prompt', async () => {
    const artifact = build({
      connectors: ACME,
      prompts: [
        {
          name: 'summarize',
          arguments: [{ name: 'id', required: true }],
          fulfilment: {
            steps: [{ id: 'get', use: 'acme.get_order', args: { id: '${input.id}' } }],
            output: { value: 'Order ${steps.get.order.status}' },
          },
        },
      ],
    });
    const result = await executePrompt(artifact, 'summarize', { id: 'A1' }, deps());
    expect(result).toEqual({ ok: true, output: { value: 'Order open' } });
  });

  it('runs a direct-operation prompt fulfilment', async () => {
    const artifact = build({
      connectors: ACME,
      prompts: [
        {
          name: 'summarize',
          arguments: [{ name: 'id', required: true }],
          fulfilment: { use: 'acme.get_order', args: { id: '${input.id}' } },
        },
      ],
    });
    const result = await executePrompt(artifact, 'summarize', { id: 'A1' }, deps());
    expect(result).toEqual({ ok: true, output: { order: { id: 'A1', status: 'open' } } });
  });

  it('applies policy gates to connector-backed prompts', async () => {
    const artifact = build({
      connectors: ACME,
      prompts: [
        {
          name: 'summarize',
          arguments: [{ name: 'id', required: true }],
          fulfilment: {
            steps: [{ id: 'get', use: 'acme.get_order', args: { id: '${input.id}' } }],
            output: { value: 'Order ${steps.get.order.status}' },
          },
        },
      ],
    });
    const policy: PolicyGate = {
      before: async () => ({ allow: false, reason: 'blocked' }),
      after: async (_ctx, output) => output,
    };
    const result = await executePrompt(artifact, 'summarize', { id: 'A1' }, { ...deps(), policy });
    expect(result).toMatchObject({ ok: false, error: { code: 'policy_denied' } });
  });

  it('fails with unknown_prompt for a missing name', async () => {
    const artifact = build({
      prompts: [{ name: 'p', fulfilment: { steps: [], output: { value: 'x' } } }],
    });
    const result = await executePrompt(artifact, 'nope', {}, deps());
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown_prompt' } });
  });
});
