import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OperationSignature } from '@noodle-borg/compiler';
import { InMemoryConnector } from '@noodle-borg/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createServiceHandler,
  InMemoryAssistantStore,
  InMemoryAuditStore,
  ServerRegistry,
} from '../src/index.js';

const ORIGIN = 'https://app.example.com';
const SUBMIT_TIME_OFF_SIGNATURE: OperationSignature = {
  type: 'action',
  input: {
    type: 'object',
    properties: {
      team: { type: 'string' },
      start: { type: 'string', format: 'date' },
      end: { type: 'string', format: 'date' },
    },
    required: ['team', 'start', 'end'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: { requestId: { type: 'string' } },
    required: ['requestId'],
    additionalProperties: false,
  },
};
const MANIFEST = `
manifestVersion: "1"
server:
  name: assistant_elicitation
  version: 1.0.0
  title: Assistant elicitation
  assistant:
    model:
      kind: openai-compatible
      baseUrl: \${env.ASSISTANT_MODEL_BASE_URL}
      model: \${env.ASSISTANT_MODEL}
      apiKey: ASSISTANT_MODEL_API_KEY
    allowedOrigins: [${ORIGIN}]
    behavior: { showConfirmationDetails: false }
tools:
  - name: collect_time_off
    description: Collect the team and dates for a time-off request.
    annotations:
      readOnlyHint: true
      destructiveHint: false
      openWorldHint: false
    inputSchema:
      type: object
      additionalProperties: false
    fulfilment:
      steps:
        - id: choose_team
          elicit:
            message: Which team should receive this request?
            requestedSchema:
              type: object
              properties:
                team:
                  type: string
                  enum: [noodle, platform]
              required: [team]
              additionalProperties: false
        - id: choose_dates
          elicit:
            message: Which dates should I request?
            requestedSchema:
              type: object
              properties:
                start: { type: string, format: date }
                end: { type: string, format: date }
              required: [start, end]
              additionalProperties: false
      output:
        team: \${steps.choose_team.team}
        start: \${steps.choose_dates.start}
        end: \${steps.choose_dates.end}
  - name: book_time_off
    description: Book time off after collecting a team.
    annotations:
      readOnlyHint: false
      destructiveHint: false
      openWorldHint: false
      confirm: true
    inputSchema:
      type: object
      additionalProperties: false
    fulfilment:
      steps:
        - id: choose_team
          elicit:
            message: Which team should receive this request?
            requestedSchema:
              type: object
              properties:
                team:
                  type: string
                  enum: [noodle, platform]
              required: [team]
              additionalProperties: false
      output:
        booked: true
        team: \${steps.choose_team.team}
  - name: book_time_off_durable
    description: Collect a team and dates, then book through a write connector after confirmation.
    annotations:
      readOnlyHint: false
      destructiveHint: false
      openWorldHint: false
      confirm: true
    inputSchema:
      type: object
      additionalProperties: false
    fulfilment:
      steps:
        - id: choose_team
          elicit:
            message: Which team should receive this request?
            requestedSchema:
              type: object
              properties:
                team:
                  type: string
                  enum: [noodle, platform]
              required: [team]
              additionalProperties: false
        - id: choose_dates
          elicit:
            message: Which dates should I request?
            requestedSchema:
              type: object
              properties:
                start: { type: string, format: date }
                end: { type: string, format: date }
              required: [start, end]
              additionalProperties: false
        - id: submit
          use: leave.submit_time_off
          args:
            team: \${steps.choose_team.team}
            start: \${steps.choose_dates.start}
            end: \${steps.choose_dates.end}
      output:
        requestId: \${steps.submit.requestId}
        team: \${steps.choose_team.team}
        start: \${steps.choose_dates.start}
        end: \${steps.choose_dates.end}
connectors:
  leave: { id: leave, version: 1.0.0 }
`;

interface NamedEvent {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

describe('embedded assistant form elicitation', () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  async function start(initialNow = new Date('2030-01-01T00:00:00.000Z')) {
    let currentNow = initialNow;
    const actionCalls: Array<Record<string, unknown>> = [];
    const leave = new InMemoryConnector('leave', '1.0.0', {
      submit_time_off: {
        signature: SUBMIT_TIME_OFF_SIGNATURE,
        handler: (args) => {
          actionCalls.push({ ...args });
          return { requestId: 'request-123' };
        },
      },
    });
    const registry = new ServerRegistry(undefined, undefined, undefined, {
      platformCatalog: [
        {
          id: 'leave',
          version: '1.0.0',
          kind: 'builtin',
          operations: { submit_time_off: SUBMIT_TIME_OFF_SIGNATURE },
        },
      ],
      platformConnectors: [leave],
    });
    const tenant = { org: 'acme', app: 'leave', env: 'prod' };
    const scope = { level: 'env' as const, ...tenant };
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
    const modelFetch = vi.fn<typeof fetch>();
    const audit = new InMemoryAuditStore({ now: () => currentNow });
    const assistantStore = new InMemoryAssistantStore();
    const server = createServer(
      createServiceHandler(registry, {
        assistantStore,
        assistantModelFetch: modelFetch,
        audit,
        clock: () => currentNow,
      }),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const clientResponse = await fetch(
      `${base}/v1/orgs/acme/apps/leave/envs/prod/assistant/clients`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"name":"web"}',
      },
    );
    const client = await clientResponse.json();
    const basic = Buffer.from(`${client.id}:${client.clientSecret}`).toString('base64');
    const sessionResponse = await fetch(`${base}/v1/assistant/sessions`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' },
      body: JSON.stringify({ origin: ORIGIN, user: { id: 'customer-1' } }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = (await sessionResponse.json()) as {
      token: string;
      endpoints: { turns: string; interactions: string };
    };
    return {
      actionCalls,
      assistantStore,
      audit,
      modelFetch,
      session,
      setNow: (value: Date) => {
        currentNow = value;
      },
    };
  }

  function toolCallResponse(tool = 'collect_time_off'): Response {
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'model-call-1',
                  type: 'function',
                  function: { name: tool, arguments: '{}' },
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  function narrationResponse(content: string): Response {
    return new Response(
      JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  function headers(token: string) {
    return {
      authorization: `Bearer ${token}`,
      origin: ORIGIN,
      'content-type': 'application/json',
    };
  }

  async function begin(
    session: { token: string; endpoints: { turns: string } },
    modelFetch: ReturnType<typeof vi.fn<typeof fetch>>,
    tool = 'collect_time_off',
  ): Promise<NamedEvent[]> {
    modelFetch.mockReset().mockResolvedValue(toolCallResponse(tool));
    const response = await fetch(session.endpoints.turns, {
      method: 'POST',
      headers: headers(session.token),
      body: JSON.stringify({ message: 'Help me request time off' }),
    });
    expect(response.status).toBe(200);
    return parseEvents(await response.text());
  }

  async function resolve(
    session: { token: string; endpoints: { interactions: string } },
    body: unknown,
  ): Promise<{ response: Response; text: string; events: NamedEvent[] }> {
    const response = await fetch(session.endpoints.interactions, {
      method: 'POST',
      headers: headers(session.token),
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { response, text, events: parseEvents(text) };
  }

  async function collectDurableActionInput(
    session: {
      token: string;
      endpoints: { turns: string; interactions: string };
    },
    modelFetch: ReturnType<typeof vi.fn<typeof fetch>>,
  ) {
    const team = event(
      await begin(session, modelFetch, 'book_time_off_durable'),
      'input_requested',
    );
    const datesResponse = await resolve(session, {
      id: team.data.id,
      action: 'accept',
      content: { team: 'noodle' },
    });
    const dates = event(datesResponse.events, 'input_requested');
    const proposalResponse = await resolve(session, {
      id: dates.data.id,
      action: 'accept',
      content: { start: '2030-01-10', end: '2030-01-11' },
    });
    return {
      dates,
      proposal: event(proposalResponse.events, 'tool_proposed'),
      proposalResponse,
      team,
    };
  }

  it('keeps continuations server-side and chains structured input requests until completion', async () => {
    const { audit, modelFetch, session } = await start();
    const firstEvents = await begin(session, modelFetch);
    const first = event(firstEvents, 'input_requested');
    expect(first.data).toEqual({
      id: expect.any(String),
      message: 'Which team should receive this request?',
      requestedSchema: {
        type: 'object',
        properties: { team: { type: 'string', enum: ['noodle', 'platform'] } },
        required: ['team'],
      },
      expiresAt: '2030-01-01T00:10:00.000Z',
    });
    expect(JSON.stringify(firstEvents)).not.toContain('continuation');
    expect(JSON.stringify(firstEvents)).not.toContain('completedSteps');

    const secondResponse = await resolve(session, {
      id: first.data.id,
      action: 'accept',
      content: { team: 'noodle' },
    });
    expect(secondResponse.response.status).toBe(200);
    expect(event(secondResponse.events, 'interaction_resolved').data).toMatchObject({
      id: first.data.id,
      action: 'accept',
    });
    expect(secondResponse.events.some((entry) => entry.event === 'tool_completed')).toBe(false);
    const second = event(secondResponse.events, 'input_requested');
    expect(second.data).toMatchObject({
      id: expect.any(String),
      message: 'Which dates should I request?',
      requestedSchema: {
        type: 'object',
        properties: {
          start: { type: 'string', format: 'date' },
          end: { type: 'string', format: 'date' },
        },
        required: ['start', 'end'],
      },
    });
    expect(second.data.id).not.toBe(first.data.id);
    expect(secondResponse.text).not.toContain('continuation');

    modelFetch.mockResolvedValue(narrationResponse('Your request details are ready.'));
    const completed = await resolve(session, {
      id: second.data.id,
      action: 'accept',
      content: { start: '2030-01-10', end: '2030-01-11' },
    });
    expect(completed.response.status).toBe(200);
    expect(event(completed.events, 'interaction_resolved').data).toMatchObject({
      id: second.data.id,
      action: 'accept',
    });
    expect(event(completed.events, 'tool_completed').data).toMatchObject({
      id: second.data.id,
      tool: 'collect_time_off',
      result: {
        team: 'noodle',
        start: '2030-01-10',
        end: '2030-01-11',
      },
    });
    expect(completed.text).toContain('Your request details are ready.');

    const proposals = await audit.list({
      org: 'acme',
      eventType: 'assistant.interaction.proposed',
    });
    expect(proposals).toHaveLength(2);
    expect(proposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: '201',
          details: expect.objectContaining({
            kind: 'input',
            tool: 'collect_time_off',
            status: 'input_requested',
          }),
        }),
      ]),
    );
    const executions = await audit.list({
      org: 'acme',
      eventType: 'assistant.interaction.execution',
    });
    expect(executions.map((entry) => entry.details?.status)).toEqual([
      'succeeded',
      'input_requested',
    ]);
    const serializedAudit = JSON.stringify(await audit.list({ org: 'acme' }));
    expect(serializedAudit).not.toContain('continuation');
    expect(serializedAudit).not.toContain('2030-01-10');
    expect(serializedAudit).not.toContain('noodle');

    const modelCalls = modelFetch.mock.calls.length;
    const replay = await resolve(session, {
      id: second.data.id,
      action: 'accept',
      content: { start: '2030-01-10', end: '2030-01-11' },
    });
    expect(replay.response.status).toBe(200);
    expect(event(replay.events, 'tool_completed').data).toMatchObject({
      id: second.data.id,
      replayed: true,
      result: { team: 'noodle', start: '2030-01-10', end: '2030-01-11' },
    });

    const rootReplay = await resolve(session, {
      id: first.data.id,
      action: 'accept',
      content: { team: 'noodle' },
    });
    expect(event(rootReplay.events, 'tool_completed').data).toMatchObject({
      id: second.data.id,
      tool: 'collect_time_off',
      replayed: true,
      result: { team: 'noodle', start: '2030-01-10', end: '2030-01-11' },
    });
    expect(rootReplay.events.some((entry) => entry.event === 'input_requested')).toBe(false);
    expect(modelFetch).toHaveBeenCalledTimes(modelCalls);
  });

  it.each([
    'decline',
    'cancel',
  ] as const)('%s stops a suspended tool without completing it', async (action) => {
    const { modelFetch, session } = await start();
    const requested = event(await begin(session, modelFetch), 'input_requested');
    modelFetch.mockResolvedValue(narrationResponse(`The request was ${action}led.`));

    const resolved = await resolve(session, { id: requested.data.id, action });

    expect(resolved.response.status).toBe(200);
    expect(event(resolved.events, 'interaction_resolved').data).toMatchObject({
      id: requested.data.id,
      action,
    });
    expect(resolved.events.some((entry) => entry.event === 'tool_completed')).toBe(false);

    const conflicting = await resolve(session, {
      id: requested.data.id,
      action: 'accept',
      content: { team: 'noodle' },
    });
    expect(conflicting.response.status).toBe(409);
  });

  it('rejects invalid content before claiming so the same form can be corrected', async () => {
    const { modelFetch, session } = await start();
    const requested = event(await begin(session, modelFetch), 'input_requested');

    const resolved = await resolve(session, {
      id: requested.data.id,
      action: 'accept',
      content: { team: 'unknown' },
    });

    expect(resolved.response.status).toBe(400);
    expect(JSON.parse(resolved.text)).toMatchObject({ code: 'arg_invalid' });
    expect(resolved.events).toEqual([]);

    const corrected = await resolve(session, {
      id: requested.data.id,
      action: 'accept',
      content: { team: 'noodle' },
    });
    expect(corrected.response.status).toBe(200);
    expect(event(corrected.events, 'interaction_resolved').data).toMatchObject({
      id: requested.data.id,
      action: 'accept',
    });
    expect(event(corrected.events, 'input_requested').data).toMatchObject({
      message: 'Which dates should I request?',
    });
  });

  it('collects action input before presenting the final confirmation', async () => {
    const { modelFetch, session } = await start();
    const requested = event(await begin(session, modelFetch, 'book_time_off'), 'input_requested');
    expect(requested.data).toMatchObject({
      message: 'Which team should receive this request?',
    });

    const collected = await resolve(session, {
      id: requested.data.id,
      action: 'accept',
      content: { team: 'noodle' },
    });

    expect(collected.response.status).toBe(200);
    expect(event(collected.events, 'interaction_resolved').data).toMatchObject({
      id: requested.data.id,
      action: 'accept',
    });
    const proposed = event(collected.events, 'tool_proposed');
    expect(proposed.data).toMatchObject({
      id: expect.any(String),
      tool: 'book_time_off',
      arguments: {
        toolInput: {},
        elicited: { choose_team: { team: 'noodle' } },
      },
      requiresConfirmation: true,
    });
    expect(collected.events.some((entry) => entry.event === 'tool_completed')).toBe(false);

    modelFetch.mockResolvedValue(narrationResponse('Your Noodle time off was booked.'));
    const completed = await resolve(session, { id: proposed.data.id, action: 'accept' });
    expect(completed.response.status).toBe(200);
    expect(event(completed.events, 'tool_completed').data).toMatchObject({
      id: proposed.data.id,
      tool: 'book_time_off',
      result: { booked: true, team: 'noodle' },
    });
  });

  it('collects repeated input, executes once only after confirmation, and replays the result', async () => {
    const { actionCalls, modelFetch, session } = await start();
    const { proposal, proposalResponse } = await collectDurableActionInput(session, modelFetch);

    expect(actionCalls).toEqual([]);
    expect(proposalResponse.events.some((entry) => entry.event === 'tool_completed')).toBe(false);
    expect(proposal.data).toMatchObject({
      tool: 'book_time_off_durable',
      arguments: {
        toolInput: {},
        elicited: {
          choose_team: { team: 'noodle' },
          choose_dates: { start: '2030-01-10', end: '2030-01-11' },
        },
      },
      requiresConfirmation: true,
    });

    modelFetch.mockResolvedValue(narrationResponse('Request 123 was booked.'));
    const completed = await resolve(session, { id: proposal.data.id, action: 'accept' });
    expect(event(completed.events, 'tool_completed').data).toMatchObject({
      id: proposal.data.id,
      tool: 'book_time_off_durable',
      result: {
        requestId: 'request-123',
        team: 'noodle',
        start: '2030-01-10',
        end: '2030-01-11',
      },
    });
    expect(actionCalls).toEqual([{ team: 'noodle', start: '2030-01-10', end: '2030-01-11' }]);

    const replay = await resolve(session, { id: proposal.data.id, action: 'accept' });
    expect(event(replay.events, 'tool_completed').data).toMatchObject({
      id: proposal.data.id,
      replayed: true,
      result: {
        requestId: 'request-123',
        team: 'noodle',
        start: '2030-01-10',
        end: '2030-01-11',
      },
    });
    expect(actionCalls).toHaveLength(1);
  });

  it.each([
    'decline',
    'cancel',
  ] as const)('%s at the final prepared confirmation never executes the connector', async (action) => {
    const { actionCalls, modelFetch, session } = await start();
    const { proposal } = await collectDurableActionInput(session, modelFetch);
    modelFetch.mockResolvedValue(narrationResponse(`The prepared request was ${action}led.`));

    const stopped = await resolve(session, { id: proposal.data.id, action });

    expect(stopped.response.status).toBe(200);
    expect(event(stopped.events, 'interaction_resolved').data).toMatchObject({
      id: proposal.data.id,
      action,
    });
    expect(stopped.events.some((entry) => entry.event === 'tool_completed')).toBe(false);
    expect(actionCalls).toEqual([]);

    const conflicting = await resolve(session, { id: proposal.data.id, action: 'accept' });
    expect(conflicting.response.status).toBe(409);
    expect(actionCalls).toEqual([]);
  });

  it.each([
    {
      name: 'input',
      tool: 'collect_time_off',
      accept: (id: unknown) => ({ id, action: 'accept', content: { team: 'noodle' } }),
      nextMessage: 'Which dates should I request?',
    },
    {
      name: 'confirmation',
      tool: 'book_time_off',
      accept: (id: unknown) => ({ id, action: 'accept', content: { team: 'noodle' } }),
      nextMessage: undefined,
    },
  ])('re-emits the existing next interaction when a resolved $name input response is lost', async ({
    tool,
    accept,
    nextMessage,
  }) => {
    const { audit, modelFetch, session } = await start();
    const initialEvents = await begin(session, modelFetch, tool);
    const initial = event(initialEvents, 'input_requested');

    const accepted = await resolve(session, accept(initial.data.id));
    expect(accepted.response.status).toBe(200);
    const nextEvent = tool === 'book_time_off' ? 'tool_proposed' : 'input_requested';
    const next = event(accepted.events, nextEvent);
    expect(next.data).toMatchObject(
      nextMessage === undefined
        ? {
            id: expect.any(String),
            tool: 'book_time_off',
            arguments: {
              toolInput: {},
              elicited: { choose_team: { team: 'noodle' } },
            },
          }
        : {
            id: expect.any(String),
            message: nextMessage,
            requestedSchema: expect.any(Object),
          },
    );

    // Simulate a client that lost the first SSE body and retries its exact decision. The old
    // interaction must point back to the already-created request, not resume the flow again.
    const replay = await resolve(session, accept(initial.data.id));

    expect(replay.response.status).toBe(200);
    expect(event(replay.events, 'interaction_resolved').data).toMatchObject({
      id: initial.data.id,
      action: 'accept',
    });
    expect(event(replay.events, nextEvent).data).toEqual(next.data);
    expect(replay.events.some((entry) => entry.event === 'tool_completed')).toBe(false);
    expect(modelFetch).toHaveBeenCalledTimes(1);
    expect(
      await audit.list({ org: 'acme', eventType: 'assistant.interaction.proposed' }),
    ).toHaveLength(2);
  });

  it('follows repeated handoffs to the current confirmation and its terminal outcome', async () => {
    const { actionCalls, modelFetch, session } = await start();
    const { proposal, team } = await collectDurableActionInput(session, modelFetch);

    const pendingReplay = await resolve(session, {
      id: team.data.id,
      action: 'accept',
      content: { team: 'noodle' },
    });
    expect(pendingReplay.response.status).toBe(200);
    expect(event(pendingReplay.events, 'tool_proposed').data).toEqual(proposal.data);
    expect(pendingReplay.events.some((entry) => entry.event === 'input_requested')).toBe(false);

    modelFetch.mockResolvedValue(narrationResponse('Request 123 was booked.'));
    await resolve(session, { id: proposal.data.id, action: 'accept' });
    const terminalReplay = await resolve(session, {
      id: team.data.id,
      action: 'accept',
      content: { team: 'noodle' },
    });

    expect(terminalReplay.response.status).toBe(200);
    expect(event(terminalReplay.events, 'tool_completed').data).toMatchObject({
      id: proposal.data.id,
      tool: 'book_time_off_durable',
      replayed: true,
      result: { requestId: 'request-123', team: 'noodle' },
    });
    expect(
      terminalReplay.events.some(
        (entry) => entry.event === 'input_requested' || entry.event === 'tool_proposed',
      ),
    ).toBe(false);
    expect(actionCalls).toHaveLength(1);
  });

  it('reports an executing descendant as an unknown outcome instead of re-emitting stale input', async () => {
    const startedAt = new Date('2030-01-01T00:00:00.000Z');
    const { assistantStore, modelFetch, session } = await start(startedAt);
    const team = event(
      await begin(session, modelFetch, 'book_time_off_durable'),
      'input_requested',
    );
    const datesResponse = await resolve(session, {
      id: team.data.id,
      action: 'accept',
      content: { team: 'noodle' },
    });
    const dates = event(datesResponse.events, 'input_requested');
    const sessionRecord = await assistantStore.getSession(session.token, startedAt);
    if (!sessionRecord) throw new Error('expected assistant session');
    await assistantStore.claimInteraction({
      id: String(dates.data.id),
      sessionId: sessionRecord.id,
      deploymentId: sessionRecord.deploymentId,
      now: startedAt,
    });

    const replay = await resolve(session, {
      id: team.data.id,
      action: 'accept',
      content: { team: 'noodle' },
    });

    expect(replay.response.status).toBe(409);
    expect(JSON.parse(replay.text)).toMatchObject({ code: 'interaction_outcome_unknown' });
    expect(replay.events).toEqual([]);
  });

  it('reports an expired descendant as unavailable instead of re-emitting its stale form', async () => {
    const startedAt = new Date('2030-01-01T00:00:00.000Z');
    const { modelFetch, session, setNow } = await start(startedAt);
    const team = event(
      await begin(session, modelFetch, 'book_time_off_durable'),
      'input_requested',
    );
    await resolve(session, {
      id: team.data.id,
      action: 'accept',
      content: { team: 'noodle' },
    });
    setNow(new Date(startedAt.getTime() + 11 * 60_000));

    const replay = await resolve(session, {
      id: team.data.id,
      action: 'accept',
      content: { team: 'noodle' },
    });

    expect(replay.response.status).toBe(200);
    expect(event(replay.events, 'error').data).toEqual({
      code: 'next_interaction_unavailable',
      retryable: false,
    });
    expect(replay.events.some((entry) => entry.event === 'input_requested')).toBe(false);
  });
});

function parseEvents(text: string): NamedEvent[] {
  return text
    .split('\n\n')
    .map((block) => {
      const name = /^event: ([^\n]+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      return name && data
        ? { event: name, data: JSON.parse(data) as Record<string, unknown> }
        : undefined;
    })
    .filter((entry): entry is NamedEvent => entry !== undefined);
}

function event(events: readonly NamedEvent[], name: string): NamedEvent {
  const found = events.find((entry) => entry.event === name);
  expect(found, `expected ${name} in ${JSON.stringify(events)}`).toBeDefined();
  if (!found) throw new Error(`missing ${name}`);
  return found;
}
