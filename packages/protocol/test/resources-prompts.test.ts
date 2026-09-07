import {
  type CatalogConnector,
  compileManifest,
  InMemoryCatalog,
  type Manifest,
  type OperationSignature,
} from '@noodle-borg/compiler';
import {
  type ExecuteDeps,
  InMemoryConnector,
  InMemoryConnectorRegistry,
  StaticServiceBroker,
} from '@noodle-borg/runtime';
import { describe, expect, it } from 'vitest';
import type { ServedArtifact } from '../src/index.js';
import { connectClientTo } from './harness.js';

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

function failingDeps(): ExecuteDeps {
  const connector = new InMemoryConnector('acme_orders', '1.2.0', {
    get_order: {
      signature: getOrderSig,
      handler: () => {
        throw new Error('internal connector secret');
      },
    },
  });
  return {
    connectors: new InMemoryConnectorRegistry([connector]),
    broker: new StaticServiceBroker({ token: 'svc' }),
  };
}

const MANIFEST: Manifest = {
  manifestVersion: '1',
  server: { name: 'acme_support', version: '1.0.0', title: 'Acme Support' },
  connectors: { acme: { id: 'acme_orders', version: '1.2.0' } },
  tools: [
    {
      name: 'noop',
      description: 'A no-op tool.',
      inputSchema: { type: 'object' },
      fulfilment: { steps: [{ id: 'm', map: { v: 'ok' } }], output: { ok: '${steps.m.v}' } },
    },
  ],
  resources: [
    {
      name: 'triage_guide',
      uri: 'docs://triage-guide',
      mimeType: 'text/markdown',
      description: 'How to triage.',
      fulfilment: { steps: [], output: { value: '# Triage Guide' } },
    },
    {
      name: 'ticket',
      uri: 'tickets://{id}',
      fulfilment: {
        steps: [{ id: 'get', use: 'acme.get_order', args: { id: '${input.id}' } }],
        output: { value: '${steps.get.order}' },
      },
    },
  ],
  prompts: [
    {
      name: 'triage',
      description: 'Triage a ticket.',
      arguments: [{ name: 'id', description: 'ticket id', required: true }],
      fulfilment: { steps: [], output: { value: 'Triage ticket ${input.id}' } },
    },
  ],
};

function served(): ServedArtifact {
  const result = compileManifest(MANIFEST, { catalog });
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.errors)}`);
  return { artifact: result.artifact, deps: deps() };
}

describe('resources surface', () => {
  it('advertises the resources capability and lists only fixed resources', async () => {
    const client = await connectClientTo(served());
    expect(client.getServerCapabilities()?.resources).toBeDefined();
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(['docs://triage-guide']);
    expect(resources[0]?.mimeType).toBe('text/markdown');
  });

  it('lists templated resources under resources/templates/list', async () => {
    const client = await connectClientTo(served());
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual(['tickets://{id}']);
  });

  it('reads a fixed resource as text content with its mime type', async () => {
    const client = await connectClientTo(served());
    const { contents } = await client.readResource({ uri: 'docs://triage-guide' });
    expect(contents[0]).toMatchObject({
      uri: 'docs://triage-guide',
      mimeType: 'text/markdown',
      text: '# Triage Guide',
    });
  });

  it('reads a templated resource: the URI var feeds the connector, object → JSON text', async () => {
    const client = await connectClientTo(served());
    const { contents } = await client.readResource({ uri: 'tickets://A1' });
    expect(contents[0]?.text).toBe(JSON.stringify({ id: 'A1', status: 'open' }));
  });

  it('reports connector-backed resource failures as internal protocol errors without leaking details', async () => {
    const client = await connectClientTo({ artifact: served().artifact, deps: failingDeps() });
    await expect(client.readResource({ uri: 'tickets://A1' })).rejects.toMatchObject({
      code: -32603,
      message: expect.not.stringContaining('internal connector secret'),
    });
  });

  it('returns a clean not-found error for malformed percent-encoding in a templated URI', async () => {
    const client = await connectClientTo(served());
    await expect(client.readResource({ uri: 'tickets://bad%ZZ' })).rejects.toMatchObject({
      code: -32002,
    });
  });

  it('feeds all variables from a multi-variable resource template into fulfilment', async () => {
    const result = compileManifest(
      {
        manifestVersion: '1',
        server: { name: 'multi_resource', version: '1.0.0', title: 'Multi Resource' },
        tools: MANIFEST.tools,
        resources: [
          {
            name: 'post',
            uri: 'users://{userId}/posts/{postId}',
            fulfilment: {
              steps: [],
              output: { value: 'user=${input.userId};post=${input.postId}' },
            },
          },
        ],
      } as Manifest,
      { catalog },
    );
    if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.errors)}`);

    const client = await connectClientTo({ artifact: result.artifact, deps: deps() });
    const { contents } = await client.readResource({ uri: 'users://u%207/posts/p%209' });
    expect(contents[0]?.text).toBe('user=u 7;post=p 9');
  });

  it('returns -32002 for an unknown resource URI', async () => {
    const client = await connectClientTo(served());
    await expect(client.readResource({ uri: 'nope://x' })).rejects.toMatchObject({ code: -32002 });
  });
});

describe('prompts surface', () => {
  it('advertises the prompts capability and lists prompts with arguments', async () => {
    const client = await connectClientTo(served());
    expect(client.getServerCapabilities()?.prompts).toBeDefined();
    const { prompts } = await client.listPrompts();
    expect(prompts[0]?.name).toBe('triage');
    expect(prompts[0]?.arguments).toEqual([
      { name: 'id', description: 'ticket id', required: true },
    ]);
  });

  it('gets a prompt: arguments interpolate into a single user text message', async () => {
    const client = await connectClientTo(served());
    const result = await client.getPrompt({ name: 'triage', arguments: { id: '42' } });
    expect(result.description).toBe('Triage a ticket.');
    expect(result.messages).toEqual([
      { role: 'user', content: { type: 'text', text: 'Triage ticket 42' } },
    ]);
  });

  it('reports connector-backed prompt failures as internal protocol errors without leaking details', async () => {
    const result = compileManifest(
      {
        ...MANIFEST,
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
      },
      { catalog },
    );
    if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.errors)}`);

    const client = await connectClientTo({ artifact: result.artifact, deps: failingDeps() });
    await expect(
      client.getPrompt({ name: 'summarize', arguments: { id: 'A1' } }),
    ).rejects.toMatchObject({
      code: -32603,
      message: expect.not.stringContaining('internal connector secret'),
    });
  });

  it('rejects a missing required argument with InvalidParams (-32602)', async () => {
    const client = await connectClientTo(served());
    await expect(client.getPrompt({ name: 'triage', arguments: {} })).rejects.toMatchObject({
      code: -32602,
    });
  });

  it('permits an empty string for a required prompt argument', async () => {
    const client = await connectClientTo(served());
    const result = await client.getPrompt({ name: 'triage', arguments: { id: '' } });
    expect(result.messages[0]?.content.text).toBe('Triage ticket ');
  });

  it('rejects an unknown prompt with InvalidParams (-32602)', async () => {
    const client = await connectClientTo(served());
    await expect(client.getPrompt({ name: 'nope' })).rejects.toMatchObject({ code: -32602 });
  });
});

describe('tools-only artifact advertises neither capability', () => {
  it('omits resources/prompts capabilities when none are present', async () => {
    const result = compileManifest(
      {
        manifestVersion: '1',
        server: { name: 's', version: '1.0.0', title: 'S' },
        tools: MANIFEST.tools,
      } as Manifest,
      { catalog },
    );
    if (!result.ok) throw new Error('compile failed');
    const client = await connectClientTo({ artifact: result.artifact, deps: deps() });
    expect(client.getServerCapabilities()?.resources).toBeUndefined();
    expect(client.getServerCapabilities()?.prompts).toBeUndefined();
  });
});
