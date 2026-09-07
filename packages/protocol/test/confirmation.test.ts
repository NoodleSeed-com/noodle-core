import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ElicitRequestSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { compileManifest, InMemoryCatalog } from '@noodle-borg/compiler';
import {
  InMemoryConnector,
  InMemoryConnectorRegistry,
  StaticServiceBroker,
} from '@noodle-borg/runtime';
import { describe, expect, it, vi } from 'vitest';
import { confirmationElicitationRequest } from '../src/confirmation-elicitation.js';
import { buildMcpServer, type ProtocolRequestContext } from '../src/index.js';

const submitSignature = {
  type: 'action' as const,
  input: {
    type: 'object',
    properties: {
      days: { type: 'number' },
      reason: { type: 'string' },
    },
    required: ['days', 'reason'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: { requestId: { type: 'string' } },
    required: ['requestId'],
    additionalProperties: false,
  },
};

const readSignature = {
  type: 'read' as const,
  input: { type: 'object' as const, properties: {}, additionalProperties: false },
  output: {
    type: 'object' as const,
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
};

const openPayloadSignature = {
  type: 'action' as const,
  input: {
    type: 'object' as const,
    properties: { payload: { type: 'object' as const } },
    required: ['payload'],
    additionalProperties: false,
  },
  output: submitSignature.output,
};

function setup(options: {
  readonly confirm?: boolean;
  readonly elicit?: boolean;
  readonly confirmationFallback?: 'host';
  readonly openActionPayload?: boolean;
}) {
  let calls = 0;
  const actionSignature = options.openActionPayload ? openPayloadSignature : submitSignature;
  const compiled = compileManifest(
    {
      manifestVersion: '1',
      server: {
        name: 'confirmation',
        title: 'Confirmation',
        version: '1.0.0',
        ...(options.confirmationFallback
          ? { interactions: { confirmationFallback: options.confirmationFallback } }
          : {}),
      },
      connectors: { actions: { id: 'actions', version: '1.0.0' } },
      tools: [
        {
          name: 'book_leave',
          description: 'Book the requested leave.',
          ...(options.confirm === undefined ? {} : { annotations: { confirm: options.confirm } }),
          inputSchema: {
            type: 'object',
            properties: {
              days: { type: 'number' },
              ...(options.elicit ? {} : { reason: { type: 'string' } }),
              apiToken: { type: 'string', 'x-sensitive': true },
            },
            required: options.elicit ? ['days'] : ['days', 'reason'],
            additionalProperties: false,
          },
          fulfilment: options.elicit
            ? {
                steps: [
                  {
                    id: 'reason',
                    elicit: {
                      message: 'Why are you taking leave?',
                      requestedSchema: {
                        type: 'object',
                        properties: { reason: { type: 'string' } },
                        required: ['reason'],
                      },
                    },
                  },
                  {
                    id: 'submit',
                    use: 'actions.submit',
                    args: {
                      days: '${input.days}',
                      reason: '${steps.reason.reason}',
                    },
                  },
                ],
                output: { requestId: '${steps.submit.requestId}' },
              }
            : options.openActionPayload
              ? {
                  use: 'actions.submit',
                  args: { payload: { lastReference: '${input.reason}' } },
                }
              : {
                  use: 'actions.submit',
                  args: { days: '${input.days}', reason: '${input.reason}' },
                },
        },
      ],
    },
    {
      catalog: new InMemoryCatalog([
        {
          id: 'actions',
          version: '1.0.0',
          kind: 'catalog',
          operations: { submit: actionSignature },
        },
      ]),
    },
  );
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
  const connector = new InMemoryConnector('actions', '1.0.0', {
    submit: {
      signature: actionSignature,
      handler: () => {
        calls += 1;
        return { requestId: `request-${calls}` };
      },
    },
  });
  return {
    artifact: compiled.artifact,
    deps: {
      connectors: new InMemoryConnectorRegistry([connector]),
      broker: new StaticServiceBroker({ token: 'service-token' }),
    },
    calls: () => calls,
  };
}

function setupConditionalHostFallback() {
  let calls = 0;
  const compiled = compileManifest(
    {
      manifestVersion: '2',
      server: {
        name: 'conditional_confirmation',
        title: 'Conditional confirmation',
        version: '1.0.0',
        interactions: { confirmationFallback: 'host' },
      },
      connectors: { actions: { id: 'actions', version: '1.0.0' } },
      tools: [
        {
          name: 'route_action',
          description: 'Route exactly one eligible action.',
          annotations: { confirm: true },
          inputSchema: {
            type: 'object',
            properties: { first: { type: 'boolean' }, second: { type: 'boolean' } },
            required: ['first', 'second'],
            additionalProperties: false,
          },
          fulfilment: {
            steps: [
              {
                id: 'first',
                if: '${input.first}',
                use: 'actions.submit',
                args: { days: 1, reason: 'first' },
              },
              {
                id: 'second',
                if: '${input.second}',
                use: 'actions.submit',
                args: { days: 1, reason: 'second' },
              },
              { id: 'read_after', use: 'actions.read_after' },
            ],
            output: { ok: true },
          },
        },
      ],
    },
    {
      catalog: new InMemoryCatalog([
        {
          id: 'actions',
          version: '1.0.0',
          kind: 'catalog',
          operations: { submit: submitSignature, read_after: readSignature },
        },
      ]),
    },
  );
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
  const connector = new InMemoryConnector('actions', '1.0.0', {
    submit: {
      signature: submitSignature,
      handler: () => {
        calls += 1;
        return { requestId: `request-${calls}` };
      },
    },
    read_after: { signature: readSignature, handler: () => ({ value: 'done' }) },
  });
  return {
    artifact: compiled.artifact,
    deps: {
      connectors: new InMemoryConnectorRegistry([connector]),
      broker: new StaticServiceBroker({ token: 'service-token' }),
    },
    calls: () => calls,
  };
}

async function connect(
  setupValue: ReturnType<typeof setup>,
  responses: readonly ElicitResult[],
  context: ProtocolRequestContext = {},
) {
  const server = buildMcpServer(setupValue, context);
  const client = new Client(
    { name: 'confirmation-client', version: '1.0.0' },
    { capabilities: { elicitation: { form: {} } } },
  );
  const requests: unknown[] = [];
  let responseIndex = 0;
  client.setRequestHandler(ElicitRequestSchema, (request) => {
    requests.push(request);
    const response = responses[responseIndex];
    responseIndex += 1;
    if (response === undefined) throw new Error('unexpected elicitation request');
    return response;
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport as Transport),
    client.connect(clientTransport as Transport),
  ]);
  return { client, requests };
}

describe('portable MCP confirmation gate', () => {
  it('fails closed with a model-readable result when form elicitation was not negotiated', async () => {
    const setupValue = setup({ confirm: true });
    const server = buildMcpServer(setupValue);
    const client = new Client({ name: 'plain-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport as Transport),
      client.connect(clientTransport as Transport),
    ]);

    await expect(
      client.callTool({ name: 'book_leave', arguments: { days: 2, reason: 'family' } }),
    ).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        code: 'interaction_unavailable',
        interaction: 'confirmation',
        executed: false,
      },
    });
    expect(setupValue.calls()).toBe(0);
  });

  it('treats a bare elicitation capability as legacy form support', async () => {
    const setupValue = setup({ confirm: true });
    const server = buildMcpServer(setupValue);
    const client = new Client(
      { name: 'bare-elicitation-client', version: '1.0.0' },
      { capabilities: { elicitation: {} } },
    );
    client.setRequestHandler(ElicitRequestSchema, () => ({
      action: 'accept',
      content: { confirm: true },
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport as Transport),
      client.connect(clientTransport as Transport),
    ]);

    await expect(
      client.callTool({ name: 'book_leave', arguments: { days: 2, reason: 'family' } }),
    ).resolves.toMatchObject({ structuredContent: { requestId: 'request-1' } });
    expect(setupValue.calls()).toBe(1);
  });

  it('executes a prepared action exactly once after explicit affirmative confirmation', async () => {
    const setupValue = setup({ confirm: true });
    const { client, requests } = await connect(setupValue, [
      { action: 'accept', content: { confirm: true } },
    ]);

    const result = await client.callTool({
      name: 'book_leave',
      arguments: { days: 2, reason: 'family', apiToken: 'must-not-leak' },
    });

    expect(result).toMatchObject({ isError: false, structuredContent: { requestId: 'request-1' } });
    expect(setupValue.calls()).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'elicitation/create',
      params: {
        mode: 'form',
        requestedSchema: {
          type: 'object',
          properties: { confirm: { type: 'boolean', default: false } },
          required: ['confirm'],
        },
      },
    });
    expect(JSON.stringify(requests[0])).toContain('family');
    expect(JSON.stringify(requests[0])).toContain('actions@1.0.0');
    expect(JSON.stringify(requests[0])).toContain('submit');
    expect(JSON.stringify(requests[0])).not.toContain('must-not-leak');
    expect(JSON.stringify(requests[0])).not.toContain('continuation');
  });

  it('presents all bounded values from an open-object action payload', async () => {
    const setupValue = setup({ confirm: true, openActionPayload: true });
    const { client, requests } = await connect(setupValue, [
      { action: 'accept', content: { confirm: true } },
    ]);

    await expect(
      client.callTool({
        name: 'book_leave',
        arguments: { days: 2, reason: 'legacy-open-payload' },
      }),
    ).resolves.toMatchObject({ structuredContent: { requestId: 'request-1' } });
    expect(JSON.stringify(requests[0])).toContain('legacy-open-payload');
    expect(setupValue.calls()).toBe(1);
  });

  it('redacts a prepared-only value governed by a sensitive pattern property', () => {
    const setupValue = setup({ confirm: true });
    const privateValue = 'ordinary-private-value';

    const plan = confirmationElicitationRequest(setupValue.artifact.tools[0], {
      input: { days: 2, reason: 'public input' },
      elicited: {},
      action: {
        connectorId: 'actions',
        connectorVersion: '1.0.0',
        operation: 'submit',
        arguments: { pin: privateValue },
        inputSchema: {
          type: 'object',
          patternProperties: { '^pin$': { type: 'string', 'x-sensitive': true } },
          additionalProperties: true,
        },
        additionalOperationCount: 0,
      },
    });

    expect(plan.ok).toBe(true);
    expect(JSON.stringify(plan)).toContain('[REDACTED]');
    expect(JSON.stringify(plan)).not.toContain(privateValue);
  });

  it('redacts a prepared-only value governed by sensitive additional properties', () => {
    const setupValue = setup({ confirm: true });
    const privateValue = 'another-private-value';

    const plan = confirmationElicitationRequest(setupValue.artifact.tools[0], {
      input: { days: 2, reason: 'public input' },
      elicited: {},
      action: {
        connectorId: 'actions',
        connectorVersion: '1.0.0',
        operation: 'submit',
        arguments: { dynamicField: privateValue },
        inputSchema: {
          type: 'object',
          additionalProperties: { type: 'string', 'x-sensitive': true },
        },
        additionalOperationCount: 0,
      },
    });

    expect(plan.ok).toBe(true);
    expect(JSON.stringify(plan)).toContain('[REDACTED]');
    expect(JSON.stringify(plan)).not.toContain(privateValue);
  });

  it('fails closed when an unsupported applicator could govern a prepared-only value', () => {
    const setupValue = setup({ confirm: true });
    const privateValue = 'applicator-private-value';

    const plan = confirmationElicitationRequest(setupValue.artifact.tools[0], {
      input: { days: 2, reason: 'public input' },
      elicited: {},
      action: {
        connectorId: 'actions',
        connectorVersion: '1.0.0',
        operation: 'submit',
        arguments: { pin: privateValue },
        inputSchema: {
          type: 'object',
          allOf: [
            {
              properties: { pin: { type: 'string', 'x-sensitive': true } },
            },
          ],
          additionalProperties: true,
        },
        additionalOperationCount: 0,
      },
    });

    expect(plan).toEqual({ ok: false, reason: 'review_not_presentable' });
    expect(JSON.stringify(plan)).not.toContain(privateValue);
  });

  it('keeps ordinary opaque identifiers reviewable', async () => {
    const setupValue = setup({ confirm: true });
    const identifier = '123e4567-e89b-12d3-a456-426614174000';
    const { client, requests } = await connect(setupValue, [
      { action: 'accept', content: { confirm: true } },
    ]);

    await client.callTool({ name: 'book_leave', arguments: { days: 2, reason: identifier } });

    expect(JSON.stringify(requests[0])).toContain(identifier);
    expect(setupValue.calls()).toBe(1);
  });

  it('fails closed when an undeclared credential-shaped value would make review inexact', async () => {
    const setupValue = setup({ confirm: true });
    const { client, requests } = await connect(setupValue, [
      { action: 'accept', content: { confirm: true } },
    ]);

    await expect(
      client.callTool({
        name: 'book_leave',
        arguments: { days: 2, reason: 'Bearer abcdefghijklmnopqrstuvwxyz012345' },
      }),
    ).rejects.toMatchObject({ code: -32603 });
    expect(requests).toEqual([]);
    expect(setupValue.calls()).toBe(0);
  });

  it('fails closed when the complete prepared action cannot fit in the confirmation review', async () => {
    const setupValue = setup({ confirm: true });
    const { client, requests } = await connect(setupValue, [
      { action: 'accept', content: { confirm: true } },
    ]);

    await expect(
      client.callTool({
        name: 'book_leave',
        arguments: { days: 2, reason: 'x'.repeat(5_000) },
      }),
    ).rejects.toMatchObject({ code: -32603 });
    expect(requests).toEqual([]);
    expect(setupValue.calls()).toBe(0);
  });

  it.each([
    'decline',
    'cancel',
  ] as const)('does not execute after the user chooses %s', async (action) => {
    const setupValue = setup({ confirm: true });
    const beforeToolDispatch = vi.fn(async () => ({ allow: true as const }));
    const { client } = await connect(setupValue, [{ action }], { beforeToolDispatch });

    const result = await client.callTool({
      name: 'book_leave',
      arguments: { days: 2, reason: 'family' },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(action);
    expect(setupValue.calls()).toBe(0);
    expect(beforeToolDispatch).not.toHaveBeenCalled();
  });

  it('treats accept without an affirmative field as a decline', async () => {
    const setupValue = setup({ confirm: true });
    const { client } = await connect(setupValue, [
      { action: 'accept', content: { confirm: false } },
    ]);

    const result = await client.callTool({
      name: 'book_leave',
      arguments: { days: 2, reason: 'family' },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('declined');
    expect(setupValue.calls()).toBe(0);
  });

  it('collects missing input before presenting the final prepared action', async () => {
    const setupValue = setup({ confirm: true, elicit: true });
    const { client, requests } = await connect(setupValue, [
      { action: 'accept', content: { reason: 'family' } },
      { action: 'accept', content: { confirm: true } },
    ]);

    const result = await client.callTool({ name: 'book_leave', arguments: { days: 2 } });

    expect(result).toMatchObject({ structuredContent: { requestId: 'request-1' } });
    expect(setupValue.calls()).toBe(1);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      params: { message: 'Why are you taking leave?' },
    });
    expect(requests[1]).toMatchObject({
      params: {
        message: expect.stringContaining('"days": 2'),
        requestedSchema: { required: ['confirm'] },
      },
    });
    expect(JSON.stringify(requests[1])).toContain('family');
    expect(JSON.stringify(requests[1])).toContain('actions@1.0.0');
  });

  it('preserves confirm:false direct execution without an elicitation capability', async () => {
    const setupValue = setup({ confirm: false });
    const server = buildMcpServer(setupValue);
    const client = new Client({ name: 'plain-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport as Transport),
      client.connect(clientTransport as Transport),
    ]);

    await expect(
      client.callTool({ name: 'book_leave', arguments: { days: 2, reason: 'family' } }),
    ).resolves.toMatchObject({ structuredContent: { requestId: 'request-1' } });
    expect(setupValue.calls()).toBe(1);
  });

  it('preserves direct execution for a legacy manifest with no confirmation annotation', async () => {
    const setupValue = setup({});
    const server = buildMcpServer(setupValue);
    const client = new Client({ name: 'legacy-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport as Transport),
      client.connect(clientTransport as Transport),
    ]);

    await expect(
      client.callTool({ name: 'book_leave', arguments: { days: 2, reason: 'legacy' } }),
    ).resolves.toMatchObject({ structuredContent: { requestId: 'request-1' } });
    expect(setupValue.calls()).toBe(1);
  });

  it('keeps an app-owned confirm:false action callable on the stateless interaction lane', async () => {
    const setupValue = setup({ confirm: false });
    const { client, requests } = await connect(setupValue, [], {
      formElicitationTransport: 'unavailable',
    });

    await expect(
      client.callTool({ name: 'book_leave', arguments: { days: 2, reason: 'widget-reviewed' } }),
    ).resolves.toMatchObject({ structuredContent: { requestId: 'request-1' } });
    expect(requests).toEqual([]);
    expect(setupValue.calls()).toBe(1);
  });

  it('fails closed intelligibly on a transport that cannot carry server-initiated form requests', async () => {
    const setupValue = setup({ confirm: true });
    const { client, requests } = await connect(
      setupValue,
      [{ action: 'accept', content: { confirm: true } }],
      { formElicitationTransport: 'unavailable' },
    );

    await expect(
      client.callTool({ name: 'book_leave', arguments: { days: 2, reason: 'family' } }),
    ).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        code: 'interaction_unavailable',
        interaction: 'confirmation',
        executed: false,
      },
    });
    expect(requests).toEqual([]);
    expect(setupValue.calls()).toBe(0);
  });

  it('uses an explicit host confirmation fallback on an unavailable transport', async () => {
    const setupValue = setup({ confirm: true, confirmationFallback: 'host' });
    const { client, requests } = await connect(setupValue, [], {
      formElicitationTransport: 'unavailable',
    });

    await expect(
      client.callTool({ name: 'book_leave', arguments: { days: 2, reason: 'family' } }),
    ).resolves.toMatchObject({ structuredContent: { requestId: 'request-1' } });
    expect(requests).toEqual([]);
    expect(setupValue.calls()).toBe(1);
  });

  it.each([
    ['zero', false, false, true, 0],
    ['one', true, false, false, 1],
    ['two', true, true, true, 0],
  ] as const)('routes a host-confirmed conditional flow with %s eligible actions through preparation', async (_label, first, second, isError, expectedCalls) => {
    const setupValue = setupConditionalHostFallback();
    const { client, requests } = await connect(setupValue, [], {
      formElicitationTransport: 'unavailable',
    });

    const call = client.callTool({
      name: 'route_action',
      arguments: { first, second },
    });

    if (isError) {
      await expect(call).rejects.toThrow('exactly one eligible action');
    } else {
      await expect(call).resolves.toMatchObject({ structuredContent: { ok: true } });
    }
    expect(requests).toEqual([]);
    expect(setupValue.calls()).toBe(expectedCalls);
  });

  it('presents the exact trailing operation count in the protocol confirmation review', async () => {
    const setupValue = setupConditionalHostFallback();
    const { client, requests } = await connect(setupValue, [
      { action: 'accept', content: { confirm: true } },
    ]);

    await client.callTool({
      name: 'route_action',
      arguments: { first: true, second: false },
    });

    const request = requests[0] as { readonly params: { readonly message: string } };
    expect(request.params.message).toContain('"additionalOperationCount": 1');
    expect(setupValue.calls()).toBe(1);
  });

  it('does not use host confirmation fallback to bypass missing elicited input', async () => {
    const setupValue = setup({ confirm: true, elicit: true, confirmationFallback: 'host' });
    const { client, requests } = await connect(setupValue, [], {
      formElicitationTransport: 'unavailable',
    });

    await expect(
      client.callTool({ name: 'book_leave', arguments: { days: 2 } }),
    ).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        code: 'interaction_unavailable',
        interaction: 'input',
        executed: false,
      },
    });
    expect(requests).toEqual([]);
    expect(setupValue.calls()).toBe(0);
  });

  it('uses host approval only after an Apps continuation supplies every elicited field', async () => {
    const setupValue = setup({ confirm: true, elicit: true, confirmationFallback: 'host' });
    const { client, requests } = await connect(setupValue, [], {
      formElicitationTransport: 'unavailable',
    });

    await expect(
      client.callTool({
        name: 'book_leave',
        arguments: {
          days: 2,
          __noodleInteraction: {
            responses: { reason: { action: 'accept', content: { reason: 'family' } } },
          },
        },
      }),
    ).resolves.toMatchObject({ structuredContent: { requestId: 'request-1' } });
    expect(requests).toEqual([]);
    expect(setupValue.calls()).toBe(1);
  });

  it('never lets Apps continuation metadata bypass strict confirmation', async () => {
    const setupValue = setup({ confirm: true, elicit: true });
    const { client } = await connect(setupValue, [], {
      formElicitationTransport: 'unavailable',
    });

    await expect(
      client.callTool({
        name: 'book_leave',
        arguments: {
          days: 2,
          __noodleInteraction: {
            confirmed: true,
            responses: { reason: { action: 'accept', content: { reason: 'family' } } },
          },
        },
      }),
    ).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        code: 'interaction_unavailable',
        interaction: 'confirmation',
        executed: false,
      },
    });
    expect(setupValue.calls()).toBe(0);
  });
});
