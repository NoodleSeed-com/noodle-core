import { compileManifest, InMemoryCatalog } from '@noodle-borg/compiler';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProtocolObservation } from '../src/observation.js';
import { RequestStateManager, requestStateSecretBox } from '../src/request-state.js';
import { createDualEraMcpHandler } from '../src/v2/handler.js';
import { goldenManifest, goldenTarget } from './golden-target.js';
import { modernRpc } from './v2-harness.js';

const handlers: Array<ReturnType<typeof createDualEraMcpHandler>> = [];
const clientCapabilities = { elicitation: { form: {} } };

function handler(
  options: {
    multiRound?: boolean;
    customerIssuer?: string;
    observations?: ProtocolObservation[];
  } = {},
) {
  const target = goldenTarget();
  if (options.multiRound) {
    const compiled = compileManifest(
      {
        ...goldenManifest,
        tools: goldenManifest.tools.map((tool) =>
          tool.name !== 'choose_team'
            ? tool
            : {
                ...tool,
                fulfilment: {
                  steps: [
                    {
                      id: 'team',
                      elicit: {
                        message: 'Which team?',
                        requestedSchema: {
                          type: 'object',
                          properties: { team: { type: 'string' } },
                          required: ['team'],
                        },
                      },
                    },
                    {
                      id: 'priority',
                      elicit: {
                        message: 'Which priority?',
                        requestedSchema: {
                          type: 'object',
                          properties: { priority: { type: 'string' } },
                          required: ['priority'],
                        },
                      },
                    },
                  ],
                  output: {
                    team: '${steps.team.team}',
                    priority: '${steps.priority.priority}',
                  },
                },
              },
        ),
      },
      { catalog: new InMemoryCatalog([]) },
    );
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
    target.artifact = compiled.artifact;
  }
  const value = createDualEraMcpHandler(target, {
    deploymentId: 'dep_golden',
    ...(options.customerIssuer === undefined
      ? {}
      : {
          caller: { subject: 'shared-subject', identityKind: 'customer' as const },
          customerIssuer: options.customerIssuer,
        }),
    requestState: new RequestStateManager(requestStateSecretBox(Buffer.alloc(32, 7)), {
      now: () => 10_000,
    }),
    ...(options.observations === undefined
      ? {}
      : { observe: (observation: ProtocolObservation) => options.observations?.push(observation) }),
  });
  handlers.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(handlers.splice(0).map((item) => item.close()));
});

function inputRequiredResult(response: Awaited<ReturnType<typeof modernRpc>>) {
  const result = response.json.result;
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new Error('expected input_required result');
  }
  return result as Record<string, unknown>;
}

describe('modern multi round-trip tool input', () => {
  it('returns input_required and completes after a new-id retry with verbatim requestState', async () => {
    const target = handler();
    const first = await modernRpc(
      target,
      'tools/call',
      { name: 'choose_team', arguments: {} },
      { clientCapabilities },
    );
    const firstResult = inputRequiredResult(first);

    expect(first.status).toBe(200);
    expect(firstResult).toMatchObject({
      resultType: 'input_required',
      inputRequests: {
        team: {
          method: 'elicitation/create',
          params: {
            message: 'Which team?',
          },
        },
      },
    });
    expect(firstResult.requestState).toEqual(expect.any(String));
    expect(firstResult).not.toHaveProperty('ttlMs');
    expect(firstResult).not.toHaveProperty('cacheScope');

    const second = await modernRpc(
      target,
      'tools/call',
      {
        name: 'choose_team',
        arguments: {},
        requestState: firstResult.requestState,
        inputResponses: {
          team: { action: 'accept', content: { team: 'support' } },
        },
      },
      { id: 2, clientCapabilities },
    );

    expect(second.json).toMatchObject({
      id: 2,
      result: {
        resultType: 'complete',
        structuredContent: { team: 'support' },
        isError: false,
      },
    });
    expect(second.json).not.toHaveProperty('result.ttlMs');
    expect(second.json).not.toHaveProperty('result.cacheScope');
  });

  it('supports multiple rounds while retaining accumulated answers', async () => {
    const target = handler({ multiRound: true });
    const first = inputRequiredResult(
      await modernRpc(
        target,
        'tools/call',
        { name: 'choose_team', arguments: {} },
        { clientCapabilities },
      ),
    );
    const second = inputRequiredResult(
      await modernRpc(
        target,
        'tools/call',
        {
          name: 'choose_team',
          arguments: {},
          requestState: first.requestState,
          inputResponses: {
            team: { action: 'accept', content: { team: 'platform' } },
          },
        },
        { id: 2, clientCapabilities },
      ),
    );

    expect(second).toMatchObject({
      resultType: 'input_required',
      inputRequests: {
        priority: {
          method: 'elicitation/create',
          params: { message: 'Which priority?' },
        },
      },
    });
    expect(second.requestState).not.toBe(first.requestState);

    const complete = await modernRpc(
      target,
      'tools/call',
      {
        name: 'choose_team',
        arguments: {},
        requestState: second.requestState,
        inputResponses: {
          priority: { action: 'accept', content: { priority: 'urgent' } },
        },
      },
      { id: 3, clientCapabilities },
    );
    expect(complete.json).toMatchObject({
      result: {
        resultType: 'complete',
        structuredContent: { team: 'platform', priority: 'urgent' },
      },
    });
  });

  it.each(['decline', 'cancel'] as const)('preserves the stopped result for %s', async (action) => {
    const target = handler();
    const first = inputRequiredResult(
      await modernRpc(
        target,
        'tools/call',
        { name: 'choose_team', arguments: {} },
        { clientCapabilities },
      ),
    );
    const stopped = await modernRpc(
      target,
      'tools/call',
      {
        name: 'choose_team',
        arguments: {},
        requestState: first.requestState,
        inputResponses: { team: { action } },
      },
      { id: 2, clientCapabilities },
    );

    expect(stopped.json).toMatchObject({
      result: {
        resultType: 'complete',
        isError: true,
        content: [
          {
            type: 'text',
            text:
              action === 'decline'
                ? 'User declined the requested input.'
                : 'User cancelled the requested input.',
          },
        ],
      },
    });
  });

  it('rejects undeclared elicitation and tampered state', async () => {
    const observations: ProtocolObservation[] = [];
    const target = handler({ observations });
    const undeclared = await modernRpc(target, 'tools/call', {
      name: 'choose_team',
      arguments: {},
    });
    expect(undeclared.status).toBe(400);
    expect(undeclared.json).toMatchObject({
      error: {
        code: -32021,
        data: { requiredCapabilities: { elicitation: { form: {} } } },
      },
    });

    const first = inputRequiredResult(
      await modernRpc(
        target,
        'tools/call',
        { name: 'choose_team', arguments: {} },
        { clientCapabilities },
      ),
    );
    const state = String(first.requestState);
    const tampered = await modernRpc(
      target,
      'tools/call',
      {
        name: 'choose_team',
        arguments: {},
        requestState: `${state.slice(0, -2)}xx`,
        inputResponses: {
          team: { action: 'accept', content: { team: 'support' } },
        },
      },
      { id: 2, clientCapabilities },
    );
    expect(tampered.status).toBe(200);
    expect(tampered.json).toMatchObject({
      error: { code: -32602, data: { reason: 'invalid_request_state' } },
    });
    expect(observations.at(-1)?.errorKind).toBe('request_state_verification_failed');
  });

  it('rejects state replayed by the same subject from a different verified issuer', async () => {
    const observations: ProtocolObservation[] = [];
    const issuerA = handler({ customerIssuer: 'https://issuer-a.example' });
    const issuerB = handler({
      customerIssuer: 'https://issuer-b.example',
      observations,
    });
    const first = inputRequiredResult(
      await modernRpc(
        issuerA,
        'tools/call',
        { name: 'choose_team', arguments: {} },
        { clientCapabilities },
      ),
    );

    const replayed = await modernRpc(
      issuerB,
      'tools/call',
      {
        name: 'choose_team',
        arguments: {},
        requestState: first.requestState,
        inputResponses: {
          team: { action: 'accept', content: { team: 'support' } },
        },
      },
      { id: 2, clientCapabilities },
    );

    expect(replayed.json).toMatchObject({
      error: { code: -32602, data: { reason: 'invalid_request_state' } },
    });
    expect(observations.at(-1)?.errorKind).toBe('request_state_binding_mismatch');
  });

  it('classifies missing state, unexpected keys, and invalid bare response shapes safely', async () => {
    const observations: ProtocolObservation[] = [];
    const target = handler({ observations });
    const withoutState = await modernRpc(
      target,
      'tools/call',
      {
        name: 'choose_team',
        arguments: {},
        inputResponses: { team: { action: 'accept', content: { team: 'support' } } },
      },
      { clientCapabilities },
    );
    expect(withoutState.json).toMatchObject({
      error: { code: -32602, data: { reason: 'invalid_request_state' } },
    });

    const first = inputRequiredResult(
      await modernRpc(
        target,
        'tools/call',
        { name: 'choose_team', arguments: {} },
        { id: 2, clientCapabilities },
      ),
    );
    const wrongKey = await modernRpc(
      target,
      'tools/call',
      {
        name: 'choose_team',
        arguments: {},
        requestState: first.requestState,
        inputResponses: { other: { action: 'accept', content: { team: 'support' } } },
      },
      { id: 3, clientCapabilities },
    );
    const invalidShape = await modernRpc(
      target,
      'tools/call',
      {
        name: 'choose_team',
        arguments: {},
        requestState: first.requestState,
        inputResponses: { team: { action: 'approve', content: { team: 'support' } } },
      },
      { id: 4, clientCapabilities },
    );
    const extraKey = await modernRpc(
      target,
      'tools/call',
      {
        name: 'choose_team',
        arguments: {},
        requestState: first.requestState,
        inputResponses: {
          team: { action: 'accept', content: { team: 'support' } },
          other: { action: 'accept', content: { team: 'platform' } },
        },
      },
      { id: 5, clientCapabilities },
    );
    for (const response of [wrongKey, invalidShape, extraKey]) {
      expect(response.json).toMatchObject({
        error: { code: -32602, data: { reason: 'invalid_request_state' } },
      });
    }
    expect(observations.map((observation) => observation.errorKind)).toEqual([
      'missing_request_state',
      'unexpected_input_response_key',
      'invalid_input_response_shape',
      'unexpected_input_response_key',
    ]);
  });
});
