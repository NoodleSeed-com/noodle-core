import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { compileManifest, InMemoryCatalog, type Manifest } from '@noodle-borg/compiler';
import { InMemoryConnectorRegistry, StaticServiceBroker } from '@noodle-borg/runtime';
import { describe, expect, it } from 'vitest';
import { buildMcpServer, type ProtocolObservation } from '../src/index.js';
import { servedArtifact } from './harness.js';

/** Connect a client with an observation collector wired into the request context. */
async function connectObserved(
  options: { failing?: boolean; failingCategory?: 'timeout' | 'upstream_5xx' } = {},
): Promise<{ client: Client; observations: ProtocolObservation[] }> {
  const observations: ProtocolObservation[] = [];
  const server = buildMcpServer(servedArtifact(options), {
    observe: (observation) => observations.push(observation),
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport as Transport),
    client.connect(clientTransport as Transport),
  ]);
  return { client, observations };
}

describe('protocol request observation (two-tier outcome)', () => {
  it('observes a successful tools/call with tool identity and a token estimate', async () => {
    const { client, observations } = await connectObserved();
    await client.callTool({ name: 'get_order', arguments: { order_id: 'o-1' } });

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      method: 'tools/call',
      toolName: 'get_order',
      outcome: 'ok',
    });
    expect(observations[0]?.outputTokensEst).toBeGreaterThan(0);
  });

  it('classifies a model-actionable failure as tool_error with the execution code', async () => {
    const { client, observations } = await connectObserved({ failing: true });
    const result = await client.callTool({ name: 'get_order', arguments: { order_id: 'o-1' } });

    expect(result.isError).toBe(true); // recoverable: handed back to the model
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      method: 'tools/call',
      toolName: 'get_order',
      outcome: 'tool_error',
      errorKind: 'connector_error',
    });
  });

  it('refines a categorized connector failure into errorKind and safe attribution (#1309)', async () => {
    const { client, observations } = await connectObserved({ failingCategory: 'upstream_5xx' });
    const result = await client.callTool({ name: 'get_order', arguments: { order_id: 'o-1' } });

    expect(result.isError).toBe(true);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      method: 'tools/call',
      toolName: 'get_order',
      outcome: 'tool_error',
      errorKind: 'connector_error.upstream_5xx',
      connector: {
        connectorId: 'acme_orders',
        connectorVersion: '1.2.0',
        operation: 'get_order',
        category: 'upstream_5xx',
        statusClass: '5xx',
        attempts: 2,
        retryable: true,
      },
    });
    // The wire result stays generic: no category, status, or upstream text reaches the model.
    const wire = JSON.stringify(result);
    expect(wire).not.toContain('upstream_5xx');
    expect(wire).not.toContain('upstream rejected the call');
    expect(wire).not.toContain('503');
  });

  it('refines a connector timeout into errorKind and a stable wire classification (#1307)', async () => {
    const { client, observations } = await connectObserved({ failingCategory: 'timeout' });
    const result = await client.callTool({ name: 'get_order', arguments: { order_id: 'o-1' } });

    expect(result.isError).toBe(true);
    expect(observations[0]).toMatchObject({
      outcome: 'tool_error',
      errorKind: 'connector_error.timeout',
      connector: { connectorId: 'acme_orders', operation: 'get_order', category: 'timeout' },
    });
    // The wire carries only the allowlisted stable classification (#1307: a time-budget expiry is
    // model-actionable), never the upstream failure text.
    expect(result.structuredContent).toEqual({
      error: { code: 'connector_error', reason: 'timeout' },
    });
    expect(JSON.stringify(result)).not.toContain('upstream rejected the call');
  });

  it('classifies an unknown tool as mcp_error', async () => {
    const { client, observations } = await connectObserved();
    await expect(client.callTool({ name: 'nope', arguments: {} })).rejects.toThrow();

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      method: 'tools/call',
      toolName: 'nope',
      outcome: 'mcp_error',
      errorKind: 'unknown_tool',
    });
  });

  it('classifies invalid tool arguments as mcp_error invalid_params', async () => {
    const { client, observations } = await connectObserved();
    await expect(client.callTool({ name: 'get_order', arguments: {} })).rejects.toThrow();

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      method: 'tools/call',
      outcome: 'mcp_error',
      errorKind: 'invalid_params',
    });
  });

  it('emits nothing when no observer is configured (open loopback path unchanged)', async () => {
    const server = buildMcpServer(servedArtifact());
    const client = new Client({ name: 'test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport as Transport),
      client.connect(clientTransport as Transport),
    ]);
    const result = await client.callTool({ name: 'get_order', arguments: { order_id: 'o-1' } });
    expect(result.isError).toBeFalsy();
  });

  it('a throwing observer never breaks the request', async () => {
    const server = buildMcpServer(servedArtifact(), {
      observe: () => {
        throw new Error('observer bug');
      },
    });
    const client = new Client({ name: 'test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport as Transport),
      client.connect(clientTransport as Transport),
    ]);
    const result = await client.callTool({ name: 'get_order', arguments: { order_id: 'o-1' } });
    expect(result.isError).toBeFalsy();
  });
});

// ─── resources/read + prompts/get observation ─────────────────────────────────

const OBS_MANIFEST: Manifest = {
  manifestVersion: '1',
  server: { name: 'obs_fixture', version: '1.0.0', title: 'Obs Fixture' },
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
      name: 'guide',
      uri: 'docs://guide',
      mimeType: 'text/markdown',
      description: 'A fixed guide.',
      fulfilment: { steps: [], output: { value: '# Guide' } },
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

async function connectObservedFixture(): Promise<{
  client: Client;
  observations: ProtocolObservation[];
}> {
  const result = compileManifest(OBS_MANIFEST, { catalog: new InMemoryCatalog([]) });
  if (!result.ok) throw new Error(`compile failed: ${JSON.stringify(result.errors)}`);
  const observations: ProtocolObservation[] = [];
  const server = buildMcpServer(
    {
      artifact: result.artifact,
      deps: {
        connectors: new InMemoryConnectorRegistry([]),
        broker: new StaticServiceBroker({ token: 'svc' }),
      },
    },
    { observe: (observation) => observations.push(observation) },
  );
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport as Transport),
    client.connect(clientTransport as Transport),
  ]);
  return { client, observations };
}

describe('resources/read + prompts/get observation', () => {
  it('observes a successful resource read with a token estimate', async () => {
    const { client, observations } = await connectObservedFixture();
    await client.readResource({ uri: 'docs://guide' });
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      method: 'resources/read',
      resourceName: 'guide',
      outcome: 'ok',
    });
    expect(observations[0]?.outputTokensEst).toBeGreaterThan(0);
  });

  it('classifies an unknown resource URI as mcp_error resource_not_found', async () => {
    const { client, observations } = await connectObservedFixture();
    await expect(client.readResource({ uri: 'docs://missing' })).rejects.toThrow();
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      method: 'resources/read',
      outcome: 'mcp_error',
      errorKind: 'resource_not_found',
    });
  });

  it('observes a successful prompts/get with a token estimate', async () => {
    const { client, observations } = await connectObservedFixture();
    await client.getPrompt({ name: 'triage', arguments: { id: 'T-1' } });
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      method: 'prompts/get',
      promptName: 'triage',
      outcome: 'ok',
    });
    expect(observations[0]?.outputTokensEst).toBeGreaterThan(0);
  });

  it('classifies an unknown prompt as mcp_error unknown_prompt', async () => {
    const { client, observations } = await connectObservedFixture();
    await expect(client.getPrompt({ name: 'nope' })).rejects.toThrow();
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      method: 'prompts/get',
      promptName: 'nope',
      outcome: 'mcp_error',
      errorKind: 'unknown_prompt',
    });
  });

  it('classifies a missing required prompt argument as mcp_error invalid_params', async () => {
    const { client, observations } = await connectObservedFixture();
    await expect(client.getPrompt({ name: 'triage' })).rejects.toThrow();
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      method: 'prompts/get',
      promptName: 'triage',
      outcome: 'mcp_error',
      errorKind: 'invalid_params',
    });
  });
});
