import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { compileManifest, InMemoryCatalog } from '@noodle-borg/compiler';
import {
  InMemoryConnector,
  InMemoryConnectorRegistry,
  StaticServiceBroker,
} from '@noodle-borg/runtime';
import { describe, expect, it } from 'vitest';
import { buildMcpServer } from '../src/index.js';
import { buildDeps } from './harness.js';

function elicitingArtifact() {
  const compiled = compileManifest(
    {
      manifestVersion: '1',
      server: { name: 'eliciting', title: 'Eliciting', version: '1.0.0' },
      tools: [
        {
          name: 'choose_team',
          description: 'Choose a team.',
          annotations: { confirm: false },
          inputSchema: { type: 'object', properties: {} },
          fulfilment: {
            steps: [
              {
                id: 'team',
                elicit: {
                  message: 'Which team?',
                  requestedSchema: {
                    type: 'object',
                    properties: { team: { type: 'string', enum: ['noodle', 'platform'] } },
                    required: ['team'],
                  },
                },
              },
            ],
            output: { team: '${steps.team.team}' },
          },
        },
      ],
    },
    { catalog: new InMemoryCatalog([]) },
  );
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
  return compiled.artifact;
}

function multiStepElicitingArtifact() {
  const compiled = compileManifest(
    {
      manifestVersion: '1',
      server: { name: 'multi_eliciting', title: 'Multi eliciting', version: '1.0.0' },
      tools: [
        {
          name: 'plan_visit',
          description: 'Plan a visit.',
          inputSchema: { type: 'object', properties: {} },
          fulfilment: {
            steps: [
              {
                id: 'city',
                elicit: {
                  message: 'Which city?',
                  requestedSchema: {
                    type: 'object',
                    properties: { city: { type: 'string' } },
                    required: ['city'],
                  },
                },
              },
              {
                id: 'date',
                elicit: {
                  message: 'Which date?',
                  requestedSchema: {
                    type: 'object',
                    properties: { date: { type: 'string', format: 'date' } },
                    required: ['date'],
                  },
                },
              },
            ],
            output: { city: '${steps.city.city}', date: '${steps.date.date}' },
          },
        },
      ],
    },
    { catalog: new InMemoryCatalog([]) },
  );
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
  return compiled.artifact;
}

async function connect(
  response:
    | { readonly action: 'accept'; readonly content: { readonly team: string } }
    | {
        readonly action: 'decline' | 'cancel';
      },
) {
  const server = buildMcpServer({ artifact: elicitingArtifact(), deps: buildDeps() });
  const client = new Client(
    { name: 'elicitation-client', version: '1.0.0' },
    { capabilities: { elicitation: { form: {} } } },
  );
  let request: unknown;
  client.setRequestHandler(ElicitRequestSchema, async (value) => {
    request = value;
    return response;
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport as Transport),
    client.connect(clientTransport as Transport),
  ]);
  return { client, request: () => request };
}

describe('stable MCP form elicitation adapter', () => {
  it('uses elicitation/create and resumes the original tool call after acceptance', async () => {
    const connected = await connect({ action: 'accept', content: { team: 'noodle' } });
    const result = await connected.client.callTool({ name: 'choose_team', arguments: {} });
    expect(result).toMatchObject({ isError: false, structuredContent: { team: 'noodle' } });
    expect(connected.request()).toMatchObject({
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message: 'Which team?',
        requestedSchema: expect.objectContaining({ type: 'object' }),
      },
    });
    expect(JSON.stringify(connected.request())).not.toContain('continuation');
    expect(JSON.stringify(connected.request())).not.toContain('requestState');
  });

  it.each([
    'decline',
    'cancel',
  ] as const)('returns a model-actionable stop on %s', async (action) => {
    const { client } = await connect({ action });
    const result = await client.callTool({ name: 'choose_team', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(action);
  });

  it('returns a structured failure without sending an unnegotiated request when the client lacks elicitation', async () => {
    const server = buildMcpServer({ artifact: elicitingArtifact(), deps: buildDeps() });
    const client = new Client({ name: 'plain-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport as Transport),
      client.connect(clientTransport as Transport),
    ]);
    await expect(client.callTool({ name: 'choose_team', arguments: {} })).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        code: 'interaction_unavailable',
        interaction: 'input',
        executed: false,
        recoverable: true,
        request: {
          id: 'team',
          message: 'Which team?',
          requestedSchema: {
            type: 'object',
            properties: { team: { type: 'string', enum: ['noodle', 'platform'] } },
            required: ['team'],
          },
        },
      },
    });
  });

  it('replays the input-only prefix from schema-validated Apps answers without exposing a continuation', async () => {
    const server = buildMcpServer({ artifact: elicitingArtifact(), deps: buildDeps() });
    const client = new Client({ name: 'apps-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport as Transport),
      client.connect(clientTransport as Transport),
    ]);

    const result = await client.callTool({
      name: 'choose_team',
      arguments: {
        __noodleInteraction: {
          responses: { team: { action: 'accept', content: { team: 'noodle' } } },
        },
      },
    });

    expect(result).toMatchObject({ isError: false, structuredContent: { team: 'noodle' } });
    expect(JSON.stringify(result)).not.toContain('continuation');
  });

  it('accepts Apps replay answers in standard tools/call request metadata', async () => {
    const server = buildMcpServer({ artifact: elicitingArtifact(), deps: buildDeps() });
    const client = new Client({ name: 'apps-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport as Transport),
      client.connect(clientTransport as Transport),
    ]);

    const result = await client.callTool({
      name: 'choose_team',
      arguments: {},
      _meta: {
        noodle: {
          interaction: {
            responses: { team: { action: 'accept', content: { team: 'noodle' } } },
          },
        },
      },
    });

    expect(result).toMatchObject({ isError: false, structuredContent: { team: 'noodle' } });
  });

  it('rejects invalid Apps answers through the elicitation schema and never treats them as tool input', async () => {
    const server = buildMcpServer({ artifact: elicitingArtifact(), deps: buildDeps() });
    const client = new Client({ name: 'apps-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport as Transport),
      client.connect(clientTransport as Transport),
    ]);

    const result = await client.callTool({
      name: 'choose_team',
      arguments: {
        __noodleInteraction: {
          responses: { team: { action: 'accept', content: { team: 'forged' } } },
        },
      },
    });

    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result.content)).toContain('elicitation field');
  });

  it('accumulates multiple Apps form steps by replaying only the operation-free input prefix', async () => {
    const server = buildMcpServer({ artifact: multiStepElicitingArtifact(), deps: buildDeps() });
    const client = new Client({ name: 'apps-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport as Transport),
      client.connect(clientTransport as Transport),
    ]);
    const first = await client.callTool({
      name: 'plan_visit',
      arguments: {
        __noodleInteraction: {
          responses: { city: { action: 'accept', content: { city: 'Lahore' } } },
        },
      },
    });
    expect(first).toMatchObject({
      structuredContent: { request: { id: 'date' } },
      _meta: {
        noodle: {
          interaction: {
            responses: { city: { action: 'accept', content: { city: 'Lahore' } } },
          },
        },
      },
    });

    const completed = await client.callTool({
      name: 'plan_visit',
      arguments: {
        __noodleInteraction: {
          responses: {
            city: { action: 'accept', content: { city: 'Lahore' } },
            date: { action: 'accept', content: { date: '2026-07-20' } },
          },
        },
      },
    });
    expect(completed).toMatchObject({
      isError: false,
      structuredContent: { city: 'Lahore', date: '2026-07-20' },
    });
  });

  it('rejects before an operation when elicitation is unsupported', async () => {
    let operationCalls = 0;
    const signature = {
      type: 'action' as const,
      input: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
    };
    const compiled = compileManifest(
      {
        manifestVersion: '1',
        server: { name: 'late_input', title: 'Late input', version: '1.0.0' },
        connectors: { effects: { id: 'effects', version: '1.0.0' } },
        tools: [
          {
            name: 'write_then_ask',
            description: 'A deliberately late input request.',
            annotations: { confirm: false },
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            fulfilment: {
              steps: [
                {
                  id: 'reason',
                  elicit: {
                    message: 'Why?',
                    requestedSchema: {
                      type: 'object',
                      properties: { reason: { type: 'string' } },
                      required: ['reason'],
                    },
                  },
                },
                { id: 'write', use: 'effects.write', args: {} },
              ],
              output: { ok: '${steps.write.ok}', reason: '${steps.reason.reason}' },
            },
          },
        ],
      },
      {
        catalog: new InMemoryCatalog([
          { id: 'effects', version: '1.0.0', kind: 'catalog', operations: { write: signature } },
        ]),
      },
    );
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
    const connector = new InMemoryConnector('effects', '1.0.0', {
      write: {
        signature,
        handler: () => {
          operationCalls += 1;
          return { ok: true };
        },
      },
    });
    const server = buildMcpServer({
      artifact: compiled.artifact,
      deps: {
        connectors: new InMemoryConnectorRegistry([connector]),
        broker: new StaticServiceBroker({ token: 'service-token' }),
      },
    });
    const client = new Client({ name: 'plain-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport as Transport),
      client.connect(clientTransport as Transport),
    ]);

    await expect(client.callTool({ name: 'write_then_ask', arguments: {} })).resolves.toMatchObject(
      {
        isError: true,
        structuredContent: {
          code: 'interaction_unavailable',
          interaction: 'input',
          executed: false,
        },
      },
    );
    expect(operationCalls).toBe(0);
  });
});
