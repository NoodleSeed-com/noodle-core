import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryPublicEmbedStore } from '@noodle-borg/assistant-gateway';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServiceHandler, InMemoryAssistantStore, ServerRegistry } from '../src/index.js';

const ORIGIN = 'https://www.example.com';
const SURFACE_INSTRUCTIONS = 'Guide anonymous visitors consultatively and never push them.';
const MANIFEST = `
manifestVersion: "2"
server:
  name: surface_instructions
  version: 1.0.0
  title: Surface instructions
  instructions: Keep shared product claims accurate.
  assistant:
    model:
      kind: openai-compatible
      baseUrl: \${env.ASSISTANT_MODEL_BASE_URL}
      model: \${env.ASSISTANT_MODEL}
      apiKey: ASSISTANT_MODEL_API_KEY
    surfaces:
      - mode: public
        origins: [${ORIGIN}]
        instructions: ${SURFACE_INSTRUCTIONS}
        capabilities: [{ kind: tool, name: capture_interest }]
    allowedOrigins: [${ORIGIN}]
tools:
  - name: capture_interest
    title: Submit consultation request
    description: Submit the visitor's confirmed consultation request.
    annotations:
      readOnlyHint: false
      destructiveHint: false
      openWorldHint: true
      confirm: true
      x-noodleseed-model-latest-message-includes-any: [contact support]
    inputSchema:
      type: object
      properties: { topic: { type: string } }
      required: [topic]
      additionalProperties: false
    fulfilment:
      steps: []
      output: { received: "\${input.topic}" }
`;

const REQUIRED_ONCE_MANIFEST = `
manifestVersion: "2"
server:
  name: required_once
  version: 1.0.0
  title: Required once
  assistant:
    model:
      kind: openai-compatible
      baseUrl: \${env.ASSISTANT_MODEL_BASE_URL}
      model: \${env.ASSISTANT_MODEL}
      apiKey: ASSISTANT_MODEL_API_KEY
    surfaces:
      - mode: public
        origins: [${ORIGIN}]
        capabilities: [{ kind: tool, name: show_card }, { kind: tool, name: show_diagram }]
    allowedOrigins: [${ORIGIN}]
tools:
  - name: show_card
    title: Show card
    description: Render the explicitly requested card.
    annotations:
      readOnlyHint: true
      x-noodleseed-model-latest-message-includes-any: [show me a card]
      x-noodleseed-model-once-per-session: true
      x-noodleseed-model-required-when-visible: true
    inputSchema:
      type: object
      properties: {}
      additionalProperties: false
    fulfilment:
      steps: []
      output: { shown: true }
  - name: show_diagram
    title: Show diagram
    description: Render the explicitly requested diagram.
    annotations:
      readOnlyHint: true
      x-noodleseed-model-latest-message-includes-any: [show diagram]
      x-noodleseed-model-required-when-visible: true
    inputSchema:
      type: object
      properties: {}
      additionalProperties: false
    fulfilment:
      steps: []
      output: { shown: true }
`;

describe('assistant surface instructions', () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  it('uses the exact public-surface instructions for both the turn and its resolution narration', async () => {
    const tenant = { org: 'acme', app: 'sales', env: 'prod' } as const;
    const scope = { level: 'env' as const, ...tenant };
    const registry = new ServerRegistry();
    await registry.configStore.setConfigValue({
      kind: 'variable',
      scope,
      name: 'ASSISTANT_MODEL_BASE_URL',
      value: 'https://models.example/v1',
    });
    await registry.configStore.setConfigValue({
      kind: 'variable',
      scope,
      name: 'ASSISTANT_MODEL',
      value: 'assistant-model',
    });
    await registry.configStore.setConfigValue({
      kind: 'secret',
      scope,
      name: 'ASSISTANT_MODEL_API_KEY',
      value: 'provider-key',
    });
    const deployed = await registry.deploy(tenant, MANIFEST, { accessMode: 'public' });
    if (!deployed.ok) throw new Error(JSON.stringify(deployed.errors));

    const modelFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'capture-call',
                    type: 'function',
                    function: {
                      name: 'capture_interest',
                      arguments: '{"topic":"public assistant"}',
                    },
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          choices: [{ message: { role: 'assistant', content: 'Request received.' } }],
        }),
      );
    const publicEmbeds = new InMemoryPublicEmbedStore();
    const embed = await publicEmbeds.ensure({ ...tenant, surfaceMode: 'public', now: new Date() });
    const server = createServer(
      createServiceHandler(registry, {
        assistantStore: new InMemoryAssistantStore(),
        publicEmbeds,
        admissionCounters: {
          durable: true,
          consume: async ({ limit }: { readonly limit: number }) => ({
            allowed: true,
            used: 1,
            limit,
          }),
          peek: async () => 0,
        },
        assistantModelFetch: modelFetch,
      }),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const mint = await fetch(`${base}/v1/assistant/public-sessions`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ embedId: embed.embedId }),
    });
    expect(mint.status).toBe(201);
    const session = await mint.json();
    const headers = {
      authorization: `Bearer ${session.token}`,
      origin: ORIGIN,
      'content-type': 'application/json',
    };
    const turn = await fetch(session.endpoints.turns, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: 'Please contact support.' }),
    });
    const turnBody = await turn.text();
    expect(turn.status, turnBody).toBe(200);
    const interactionId = /event: tool_proposed\ndata: \{"id":"([^"]+)"/.exec(turnBody)?.[1];
    expect(interactionId).toBeTruthy();

    const accepted = await fetch(session.endpoints.interactions, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: interactionId, action: 'accept' }),
    });
    expect(accepted.status, await accepted.clone().text()).toBe(200);

    expect(modelFetch).toHaveBeenCalledTimes(2);
    for (const [, init] of modelFetch.mock.calls) {
      const request = JSON.parse(String(init?.body)) as {
        readonly messages: readonly { readonly role: string; readonly content: string }[];
      };
      const system = request.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n');
      expect(system).toContain(
        `Surface instructions (public website surface; same trust level as tenant instructions):\n${SURFACE_INSTRUCTIONS}`,
      );
      expect(system.indexOf('Tenant instructions:')).toBeLessThan(
        system.indexOf('Surface instructions (public website surface'),
      );
    }
  });

  it('answers in words when the model reaches for a tool this turn does not offer', async () => {
    const tenant = { org: 'acme', app: 'recover', env: 'prod' } as const;
    const scope = { level: 'env' as const, ...tenant };
    const registry = new ServerRegistry();
    await registry.configStore.setConfigValue({
      kind: 'variable',
      scope,
      name: 'ASSISTANT_MODEL_BASE_URL',
      value: 'https://models.example/v1',
    });
    await registry.configStore.setConfigValue({
      kind: 'variable',
      scope,
      name: 'ASSISTANT_MODEL',
      value: 'assistant-model',
    });
    await registry.configStore.setConfigValue({
      kind: 'secret',
      scope,
      name: 'ASSISTANT_MODEL_API_KEY',
      value: 'provider-key',
    });
    const deployed = await registry.deploy(tenant, MANIFEST, { accessMode: 'public' });
    if (!deployed.ok) throw new Error(JSON.stringify(deployed.errors));

    const toolMessages: string[] = [];
    const modelFetch = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as {
        readonly tools?: readonly { readonly function: { readonly name: string } }[];
        readonly messages: readonly { readonly role: string; readonly content?: string }[];
      };
      for (const entry of request.messages.filter((one) => one.role === 'tool')) {
        toolMessages.push(entry.content ?? '');
      }
      // First step reaches for the gated tool; the second is the recovery step, where the model has
      // been told the tool is unavailable and is offered none, so it must answer in words.
      if (toolMessages.length === 0) {
        return Response.json({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'gated-call',
                    type: 'function',
                    function: { name: 'capture_interest', arguments: '{"topic":"pilot"}' },
                  },
                ],
              },
            },
          ],
        });
      }
      expect(request.tools ?? []).toEqual([]);
      return Response.json({
        choices: [{ message: { role: 'assistant', content: 'Happy to help — what do you need?' } }],
      });
    });
    const publicEmbeds = new InMemoryPublicEmbedStore();
    const embed = await publicEmbeds.ensure({ ...tenant, surfaceMode: 'public', now: new Date() });
    const server = createServer(
      createServiceHandler(registry, {
        assistantStore: new InMemoryAssistantStore(),
        publicEmbeds,
        admissionCounters: {
          durable: true,
          consume: async ({ limit }: { readonly limit: number }) => ({
            allowed: true,
            used: 1,
            limit,
          }),
          peek: async () => 0,
        },
        assistantModelFetch: modelFetch,
      }),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const mint = await fetch(`${base}/v1/assistant/public-sessions`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ embedId: embed.embedId }),
    });
    const session = await mint.json();
    const turn = await fetch(session.endpoints.turns, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.token}`,
        origin: ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message: 'What is a safe first pilot workflow?' }),
    });
    const turnBody = await turn.text();

    expect(turn.status, turnBody).toBe(200);
    expect(turnBody).not.toContain('event: error');
    expect(turnBody).toContain('Happy to help');
    // The visitor never sees the omitted tool, and it is never proposed or executed.
    expect(turnBody).not.toContain('capture_interest');
    expect(turnBody).not.toContain('tool_proposed');
    expect(toolMessages).toHaveLength(1);
  });

  // The recovery above is deliberately once per turn. A model that keeps reaching for the omitted
  // tool after being told it is unavailable is the protocol violation the error code exists for.
  it('rejects a model call to a tool excluded from the latest-message model surface', async () => {
    const tenant = { org: 'acme', app: 'sales', env: 'prod' } as const;
    const scope = { level: 'env' as const, ...tenant };
    const registry = new ServerRegistry();
    await registry.configStore.setConfigValue({
      kind: 'variable',
      scope,
      name: 'ASSISTANT_MODEL_BASE_URL',
      value: 'https://models.example/v1',
    });
    await registry.configStore.setConfigValue({
      kind: 'variable',
      scope,
      name: 'ASSISTANT_MODEL',
      value: 'assistant-model',
    });
    await registry.configStore.setConfigValue({
      kind: 'secret',
      scope,
      name: 'ASSISTANT_MODEL_API_KEY',
      value: 'provider-key',
    });
    const deployed = await registry.deploy(tenant, MANIFEST, { accessMode: 'public' });
    if (!deployed.ok) throw new Error(JSON.stringify(deployed.errors));

    const modelFetch = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as {
        readonly tools?: readonly { readonly function: { readonly name: string } }[];
      };
      expect(request.tools?.map((tool) => tool.function.name)).not.toContain('capture_interest');
      return Response.json({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'hallucinated-call',
                  type: 'function',
                  function: {
                    name: 'capture_interest',
                    arguments: '{"topic":"safe pilot"}',
                  },
                },
              ],
            },
          },
        ],
      });
    });
    const publicEmbeds = new InMemoryPublicEmbedStore();
    const embed = await publicEmbeds.ensure({ ...tenant, surfaceMode: 'public', now: new Date() });
    const server = createServer(
      createServiceHandler(registry, {
        assistantStore: new InMemoryAssistantStore(),
        publicEmbeds,
        admissionCounters: {
          durable: true,
          consume: async ({ limit }: { readonly limit: number }) => ({
            allowed: true,
            used: 1,
            limit,
          }),
          peek: async () => 0,
        },
        assistantModelFetch: modelFetch,
      }),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const mint = await fetch(`${base}/v1/assistant/public-sessions`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ embedId: embed.embedId }),
    });
    const session = await mint.json();
    const turn = await fetch(session.endpoints.turns, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.token}`,
        origin: ORIGIN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message: 'What is a safe first pilot workflow?' }),
    });
    const turnBody = await turn.text();

    expect(turn.status, turnBody).toBe(200);
    expect(turnBody).toContain('event: error');
    expect(turnBody).toContain('invalid_model_tool_call');
    expect(turnBody).not.toContain('tool_proposed');
    // One recovery step, then the refusal — never a bare error on the first attempt.
    expect(modelFetch).toHaveBeenCalledTimes(2);
  });

  it('requires an eligible card once, then removes it from later turns in the session', async () => {
    const tenant = { org: 'acme', app: 'visual', env: 'prod' } as const;
    const scope = { level: 'env' as const, ...tenant };
    const registry = new ServerRegistry();
    await registry.configStore.setConfigValue({
      kind: 'variable',
      scope,
      name: 'ASSISTANT_MODEL_BASE_URL',
      value: 'https://models.example/v1',
    });
    await registry.configStore.setConfigValue({
      kind: 'variable',
      scope,
      name: 'ASSISTANT_MODEL',
      value: 'assistant-model',
    });
    await registry.configStore.setConfigValue({
      kind: 'secret',
      scope,
      name: 'ASSISTANT_MODEL_API_KEY',
      value: 'provider-key',
    });
    const deployed = await registry.deploy(tenant, REQUIRED_ONCE_MANIFEST, {
      accessMode: 'public',
    });
    if (!deployed.ok) throw new Error(JSON.stringify(deployed.errors));

    const modelFetch = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as {
        readonly tool_choice?: string;
        readonly tools?: readonly { readonly function: { readonly name: string } }[];
      };
      const call = modelFetch.mock.calls.length;
      if (call === 1) {
        expect(request.tool_choice).toBe('required');
        expect(request.tools?.map((tool) => tool.function.name)).toEqual(['show_card']);
        return Response.json({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'show-card',
                    type: 'function',
                    function: { name: 'show_card', arguments: '{}' },
                  },
                ],
              },
            },
          ],
        });
      }
      expect(request.tool_choice).toBeUndefined();
      expect(request.tools?.map((tool) => tool.function.name)).not.toContain('show_card');
      return Response.json({
        choices: [
          { message: { role: 'assistant', content: call === 2 ? 'Card shown.' : 'No repeat.' } },
        ],
      });
    });
    const publicEmbeds = new InMemoryPublicEmbedStore();
    const assistantStore = new InMemoryAssistantStore();
    const embed = await publicEmbeds.ensure({ ...tenant, surfaceMode: 'public', now: new Date() });
    const server = createServer(
      createServiceHandler(registry, {
        assistantStore,
        publicEmbeds,
        admissionCounters: {
          durable: true,
          consume: async ({ limit }: { readonly limit: number }) => ({
            allowed: true,
            used: 1,
            limit,
          }),
          peek: async () => 0,
        },
        assistantModelFetch: modelFetch,
      }),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const mint = await fetch(`${base}/v1/assistant/public-sessions`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ embedId: embed.embedId }),
    });
    const session = await mint.json();
    const headers = {
      authorization: `Bearer ${session.token}`,
      origin: ORIGIN,
      'content-type': 'application/json',
    };

    const ambiguous = await fetch(session.endpoints.turns, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: 'Please show me a card and show diagram.' }),
    });
    const ambiguousBody = await ambiguous.text();
    expect(ambiguous.status, ambiguousBody).toBe(200);
    expect(ambiguousBody).toContain('multiple_required_model_tools');
    expect(modelFetch).not.toHaveBeenCalled();

    const first = await fetch(session.endpoints.turns, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: 'Please show me a card.' }),
    });
    expect(first.status, await first.clone().text()).toBe(200);
    expect(await first.text()).toContain('Card shown.');
    expect((await assistantStore.getSession(session.token, new Date()))?.modelToolUses).toEqual([
      'show_card',
    ]);
    const second = await fetch(session.endpoints.turns, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: 'Please show me a card again.' }),
    });
    expect(second.status, await second.clone().text()).toBe(200);
    expect(await second.text()).toContain('No repeat.');
    expect(modelFetch).toHaveBeenCalledTimes(3);
  });
});
