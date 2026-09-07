import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { compileManifest, InMemoryCatalog } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import type { ProtocolObservation } from '../src/index.js';
import { buildDeps, connectClient, connectClientTo, resolvedArtifact } from './harness.js';

/**
 * The tools surface, served by the official SDK bound to our artifact ([ADR 0021]). Driven through a
 * real SDK {@link Client} over an in-memory transport — semantic conformance, not byte fixtures.
 */
describe('tools/list', () => {
  it('maps the artifact tools to MCP tool descriptors', async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('get_order');
    expect(tools[0]?.description).toBe('Look up an order by its ID.');
    expect(tools[0]?.inputSchema.type).toBe('object');
  });

  it('adds the optional intent field only when the operator enables capture', async () => {
    const disabledClient = await connectClient();
    const enabledClient = await connectClientTo(
      { artifact: resolvedArtifact(), deps: buildDeps() },
      { intentCapture: { enabled: true } },
    );

    const disabled = (await disabledClient.listTools()).tools[0]?.inputSchema.properties;
    const enabled = (await enabledClient.listTools()).tools[0]?.inputSchema.properties;
    expect(disabled).not.toHaveProperty('__noodleIntent');
    expect(enabled).toHaveProperty('__noodleIntent');
  });
});

describe('tools/call', () => {
  it('captures intent in the observation but never sends it to customer execution', async () => {
    const observations: ProtocolObservation[] = [];
    const client = await connectClientTo(
      { artifact: resolvedArtifact(), deps: buildDeps() },
      {
        intentCapture: { enabled: true },
        observe: (observation) => observations.push(observation),
      },
    );

    const result = await client.callTool({
      name: 'get_order',
      arguments: {
        order_id: 'A1',
        __noodleIntent: {
          category: 'support',
          match: 'direct',
          goal: 'Check the current status of an order',
        },
      },
    });

    expect(result.structuredContent).toEqual({ order: { id: 'A1', status: 'open' } });
    expect(observations).toContainEqual({
      method: 'tools/call',
      toolName: 'get_order',
      outcome: 'ok',
      outputTokensEst: expect.any(Number),
      intent: {
        category: 'support',
        match: 'direct',
        goal: 'Check the current status of an order',
      },
    });
  });

  it('returns the tool output as content + structuredContent on success', async () => {
    const client = await connectClient();
    const result = await client.callTool({ name: 'get_order', arguments: { order_id: 'A1' } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ order: { id: 'A1', status: 'open' } });
    expect(result.content).toEqual([
      { type: 'text', text: '{"order":{"id":"A1","status":"open"}}' },
    ]);
  });

  it('reports an unknown tool as a JSON-RPC protocol error (-32602)', async () => {
    const client = await connectClient();
    await expect(client.callTool({ name: 'nope', arguments: {} })).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
    });
  });

  it('reports invalid tool arguments as structured InvalidParams with field paths', async () => {
    const client = await connectClient();
    await expect(client.callTool({ name: 'get_order', arguments: {} })).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      data: {
        reason: 'invalid_tool_arguments',
        validation: [{ path: 'order_id', message: 'missing required field "order_id"' }],
      },
    });
  });

  it('reports array item validation failures without dropping entries', async () => {
    const compiled = compileManifest(
      {
        manifestVersion: '1',
        server: { name: 'batch', version: '1.0.0', title: 'Batch' },
        tools: [
          {
            name: 'batch_lookup',
            description: 'Look up many orders.',
            inputSchema: {
              type: 'object',
              properties: {
                order_ids: { type: 'array', items: { type: 'string' } },
              },
              required: ['order_ids'],
              additionalProperties: false,
            },
            fulfilment: { steps: [], output: { ok: true } },
          },
        ],
      },
      { catalog: new InMemoryCatalog([]) },
    );
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));

    const client = await connectClientTo({ artifact: compiled.artifact, deps: buildDeps() });
    await expect(
      client.callTool({ name: 'batch_lookup', arguments: { order_ids: ['A1', 42] } }),
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      data: {
        reason: 'invalid_tool_arguments',
        validation: [{ path: 'order_ids.1', message: 'expected string' }],
      },
    });
  });

  it('reports scalar and array constraint failures with repairable field paths', async () => {
    const compiled = compileManifest(
      {
        manifestVersion: '1',
        server: { name: 'trip_search', version: '1.0.0', title: 'Trip Search' },
        tools: [
          {
            name: 'search_trips',
            description: 'Search public trip inventory.',
            inputSchema: {
              type: 'object',
              properties: {
                destination: { type: 'string', minLength: 2 },
                travellers: { type: 'integer', minimum: 1, maximum: 9 },
                interests: { type: 'array', items: { type: 'string', minLength: 2 }, minItems: 1 },
              },
              required: ['destination', 'travellers', 'interests'],
              additionalProperties: false,
            },
            fulfilment: { steps: [], output: { ok: true } },
          },
        ],
      },
      { catalog: new InMemoryCatalog([]) },
    );
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));

    const client = await connectClientTo({ artifact: compiled.artifact, deps: buildDeps() });
    await expect(
      client.callTool({
        name: 'search_trips',
        arguments: { destination: 'A', travellers: 0, interests: ['x'] },
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      data: {
        reason: 'invalid_tool_arguments',
        validation: [
          { path: 'destination', message: 'must be at least 2 characters' },
          { path: 'travellers', message: 'must be >= 1' },
          { path: 'interests.0', message: 'must be at least 2 characters' },
        ],
      },
    });
  });

  it('accepts internationalized and natural-language positive fixtures as ordinary strings', async () => {
    const compiled = compileManifest(
      {
        manifestVersion: '1',
        server: { name: 'lead_capture', version: '1.0.0', title: 'Lead Capture' },
        tools: [
          {
            name: 'capture_interest',
            description: 'Capture flexible consumer search intent.',
            inputSchema: {
              type: 'object',
              properties: {
                city: { type: 'string', minLength: 1 },
                phone: { type: 'string', minLength: 1 },
                intent: { type: 'string', minLength: 1 },
              },
              required: ['city', 'phone', 'intent'],
              additionalProperties: false,
            },
            fulfilment: { steps: [], output: { ok: true } },
          },
        ],
      },
      { catalog: new InMemoryCatalog([]) },
    );
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));

    const client = await connectClientTo({ artifact: compiled.artifact, deps: buildDeps() });
    await expect(
      client.callTool({
        name: 'capture_interest',
        arguments: {
          city: 'São Paulo',
          phone: '+44 20 7946 0958',
          intent: 'find a quiet hotel near museums tomorrow evening',
        },
      }),
    ).resolves.toMatchObject({ structuredContent: { ok: true } });
  });

  it('reports a connector failure as an isError tool result, not a protocol error', async () => {
    const client = await connectClient({ failing: true });
    const result = await client.callTool({ name: 'get_order', arguments: { order_id: 'A1' } });
    expect(result.isError).toBe(true);
    // The internal failure message is not leaked verbatim to the model-facing content.
    const text = (result.content as { text?: string }[])[0]?.text ?? '';
    expect(text).not.toContain('internal connector failure');
  });

  it('keeps app-only widget helper tools discoverable with app visibility and callable through the same tools/call path', async () => {
    const compiled = compileManifest(
      {
        manifestVersion: '1',
        server: { name: 'widget_hello', version: '1.0.0', title: 'Widget Hello' },
        tools: [
          {
            name: 'greet',
            description: 'Greet a person.',
            inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
            fulfilment: { steps: [], output: { message: 'Hello from the model-visible tool.' } },
          },
          {
            name: 'refresh_greeting',
            description: 'Refresh the widget greeting.',
            visibility: ['app'],
            inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
            fulfilment: { steps: [], output: { message: 'Refreshed from the app-only helper.' } },
          },
        ],
        widgets: [
          { name: 'greeting_card', tool: 'greet', html: '<main data-bind="message"></main>' },
        ],
      },
      { catalog: new InMemoryCatalog([]) },
    );
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));

    const client = await connectClientTo({ artifact: compiled.artifact, deps: buildDeps() });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['greet', 'refresh_greeting']);
    expect(tools.find((tool) => tool.name === 'refresh_greeting')?._meta).toEqual({
      ui: { visibility: ['app'] },
    });

    const result = await client.callTool({ name: 'refresh_greeting', arguments: { name: 'Ada' } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ message: 'Refreshed from the app-only helper.' });
  });

  it('provides enough list metadata for an MCP Apps host to allow app-only helper calls', async () => {
    const client = await connectClientTo({
      artifact: {
        artifactVersion: '0.4.0',
        server: { name: 'widget_hello', version: '1.0.0', title: 'Widget Hello' },
        capabilities: { tools: ['greet', 'refresh_greeting'], resources: [], prompts: [] },
        tools: [
          {
            name: 'greet',
            description: 'Greet a person.',
            inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
            fulfilment: {
              kind: 'flow',
              steps: [],
              output: { message: 'Hello from the model-visible tool.' },
            },
          },
          {
            name: 'refresh_greeting',
            description: 'Refresh the widget greeting.',
            inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
            _meta: {
              ui: { resourceUri: 'ui://widget_hello/greeting_card', visibility: ['app'] },
            },
            fulfilment: {
              kind: 'flow',
              steps: [],
              output: { message: 'Refreshed from the app-only helper.' },
            },
          },
        ],
      },
      deps: buildDeps(),
    });
    const { tools } = await client.listTools();
    const appCallable = new Set(
      tools
        .filter((tool) => {
          const ui = tool._meta?.ui as { resourceUri?: string; visibility?: string[] } | undefined;
          return (
            ui?.resourceUri === 'ui://widget_hello/greeting_card' && ui.visibility?.includes('app')
          );
        })
        .map((tool) => tool.name),
    );
    expect(appCallable.has('refresh_greeting')).toBe(true);
  });

  it('redacts credential-shaped fields only for widget-linked tool results', async () => {
    const compiled = compileManifest(
      {
        manifestVersion: '1',
        server: { name: 'widget_redaction', version: '1.0.0', title: 'Widget Redaction' },
        tools: [
          {
            name: 'show_widget',
            description: 'Render a widget with safe output.',
            inputSchema: { type: 'object', properties: {} },
            fulfilment: {
              steps: [],
              output: {
                visible: 'safe',
                token: 'secret-token-value',
                nested: { authorization: 'Bearer abc.def.ghi' },
              },
            },
          },
          {
            name: 'diagnostic',
            description: 'Return a non-widget diagnostic.',
            inputSchema: { type: 'object', properties: {} },
            fulfilment: { steps: [], output: { token: 'secret-token-value' } },
          },
        ],
        widgets: [
          {
            name: 'safe_card',
            tool: 'show_widget',
            html: '<main data-bind="visible"></main>',
          },
        ],
      },
      { catalog: new InMemoryCatalog([]) },
    );
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));

    const client = await connectClientTo({ artifact: compiled.artifact, deps: buildDeps() });
    await expect(client.callTool({ name: 'show_widget', arguments: {} })).resolves.toMatchObject({
      structuredContent: {
        visible: 'safe',
        token: '[REDACTED]',
        nested: { authorization: '[REDACTED]' },
      },
    });
    await expect(client.callTool({ name: 'diagnostic', arguments: {} })).resolves.toMatchObject({
      structuredContent: { token: 'secret-token-value' },
    });
  });
});

describe('initialize capabilities', () => {
  it('advertises the tools capability and server info', async () => {
    const client = await connectClient();
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    expect(client.getServerVersion()).toMatchObject({
      name: 'acme_support',
      version: '1.0.0',
    });
  });
});

describe('tools/call applies schema defaults (roadmap S5)', () => {
  async function greetClient() {
    const compiled = compileManifest(
      {
        manifestVersion: '1',
        server: { name: 'greeter', version: '1.0.0', title: 'Greeter' },
        tools: [
          {
            name: 'greet',
            description: 'Greet someone by name.',
            inputSchema: {
              type: 'object',
              properties: { name: { type: 'string', default: 'world' } },
              additionalProperties: false,
            },
            fulfilment: { steps: [], output: { message: 'Hello, ${input.name}!' } },
          },
        ],
      },
      { catalog: new InMemoryCatalog([]) },
    );
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
    return connectClientTo({ artifact: compiled.artifact, deps: buildDeps() });
  }

  it('fills an omitted defaulted argument before the tool executes', async () => {
    const client = await greetClient();
    const result = await client.callTool({ name: 'greet', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ message: 'Hello, world!' });
  });

  it('never overrides a provided value with the default', async () => {
    const client = await greetClient();
    const result = await client.callTool({ name: 'greet', arguments: { name: 'Ada' } });
    expect(result.structuredContent).toEqual({ message: 'Hello, Ada!' });
  });
});
