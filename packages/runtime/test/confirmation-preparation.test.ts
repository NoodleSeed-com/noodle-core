import { computeSignatureHash, type RuntimeArtifact } from '@noodle-borg/compiler';
import { describe, expect, it, vi } from 'vitest';
import {
  executePreparedTool,
  InMemoryConnector,
  InMemoryConnectorRegistry,
  isConfirmationRequired,
  isInputRequiredForConfirmation,
  prepareToolForConfirmation,
  resumeToolPreparation,
  StaticServiceBroker,
} from '../src/index.js';

const submitSignature = {
  type: 'action' as const,
  input: {
    type: 'object',
    properties: {
      days: { type: 'number' },
      reason: { type: 'string' },
      team: { type: 'string' },
    },
    required: ['days', 'reason', 'team'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: { requestId: { type: 'string' } },
    required: ['requestId'],
    additionalProperties: false,
  },
};

function path(root: 'input' | 'steps' | 'context', ...names: string[]) {
  return {
    kind: 'path' as const,
    root,
    segments: names.map((name) => ({ kind: 'prop' as const, name })),
  };
}

function artifact(): RuntimeArtifact {
  return {
    artifactSchemaVersion: '0.11.0',
    resolution: 'resolved',
    source: { manifestName: 'confirmation', manifestVersion: '1' },
    server: { name: 'confirmation', title: 'Confirmation', version: '1.0.0' },
    capabilities: { tools: ['book'] },
    tools: [
      {
        name: 'book',
        description: 'Book leave.',
        inputSchema: { type: 'object' },
        annotations: { confirm: true },
        fulfilment: {
          kind: 'flow',
          steps: [
            {
              id: 'copy_input',
              kind: 'map',
              value: { days: path('input', 'days') },
            },
            {
              id: 'choose_reason',
              kind: 'elicit',
              message: 'Why are you taking leave?',
              requestedSchema: {
                type: 'object',
                properties: { reason: { type: 'string' } },
                required: ['reason'],
                additionalProperties: false,
              },
            },
            {
              id: 'copy_reason',
              kind: 'map',
              value: { reason: path('steps', 'choose_reason', 'reason') },
            },
            {
              id: 'choose_team',
              kind: 'elicit',
              message: 'Which team?',
              requestedSchema: {
                type: 'object',
                properties: { team: { type: 'string', enum: ['noodle', 'platform'] } },
                required: ['team'],
                additionalProperties: false,
              },
            },
            {
              id: 'submit',
              kind: 'operation',
              operationRef: {
                resolved: true,
                alias: 'leave',
                connectorId: 'leave',
                connectorVersion: '1.0.0',
                operation: 'submit',
                signatureHash: computeSignatureHash('submit', submitSignature),
              },
              args: {
                days: path('steps', 'copy_input', 'days'),
                reason: path('steps', 'copy_reason', 'reason'),
                team: path('steps', 'choose_team', 'team'),
              },
            },
          ],
          output: {
            requestId: path('steps', 'submit', 'requestId'),
            team: path('steps', 'choose_team', 'team'),
          },
        },
      },
    ],
  };
}

function setup(calls: string[]) {
  let envLoads = 0;
  const connector = new InMemoryConnector('leave', '1.0.0', {
    submit: {
      signature: submitSignature,
      handler: (args) => {
        calls.push(`submit:${args.days}:${args.reason}:${args.team}`);
        return { requestId: 'request-123' };
      },
    },
  });
  return {
    artifact: artifact(),
    deps: {
      connectors: new InMemoryConnectorRegistry([connector]),
      broker: new StaticServiceBroker({ token: 'svc' }),
      env: async () => {
        envLoads += 1;
        return { REGION: 'test' };
      },
    },
    envLoads: () => envLoads,
  };
}

describe('confirmation preparation', () => {
  it('reviews and binds exact arguments resolved from input and ambient context', async () => {
    const calls: string[] = [];
    const setupValue = setup(calls);
    const flowTool = setupValue.artifact.tools[0];
    if (flowTool?.fulfilment.kind !== 'flow') throw new Error('expected flow');
    const operation = flowTool.fulfilment.steps.find((step) => step.kind === 'operation');
    if (operation?.kind !== 'operation') throw new Error('expected operation');
    const directArtifact: RuntimeArtifact = {
      ...setupValue.artifact,
      tools: [
        {
          ...flowTool,
          fulfilment: {
            kind: 'operation',
            operationRef: operation.operationRef,
            args: {
              days: path('input', 'days'),
              reason: { kind: 'literal', value: 'vacation' },
              team: path('context', 'ambient', 'defaultTeamId'),
            },
          },
        },
      ],
    };
    const deps = {
      ...setupValue.deps,
      context: {
        temporal: {
          instant: '2030-01-01T00:00:00.000Z',
          localDate: '2030-01-01',
          localTime: '00:00:00',
          utcOffset: '+00:00',
          weekday: 'Tuesday',
          timeZone: 'UTC',
          locale: 'en',
          source: { locale: 'server-default' as const, timeZone: 'server-default' as const },
        },
        ambientStatus: 'available' as const,
        ambient: { defaultTeamId: 'platform' },
      },
    };

    const prepared = await prepareToolForConfirmation(directArtifact, 'book', { days: 2 }, deps);
    if (!isConfirmationRequired(prepared)) throw new Error('expected confirmation');
    expect(prepared.review.action?.arguments).toEqual({
      days: 2,
      reason: 'vacation',
      team: 'platform',
    });
    await expect(executePreparedTool(directArtifact, prepared.continuation, deps)).resolves.toEqual(
      {
        status: 'completed',
        output: { requestId: 'request-123' },
      },
    );
    expect(calls).toEqual(['submit:2:vacation:platform']);
  });

  it('collects repeated input without operations, then executes the prepared remainder once', async () => {
    const calls: string[] = [];
    const setupValue = setup(calls);
    const originalInput = { days: 2, note: 'kept server-side' };

    const first = await prepareToolForConfirmation(
      setupValue.artifact,
      'book',
      originalInput,
      setupValue.deps,
    );
    expect(isInputRequiredForConfirmation(first)).toBe(true);
    expect(calls).toEqual([]);
    if (!isInputRequiredForConfirmation(first)) return;

    const second = await resumeToolPreparation(
      setupValue.artifact,
      first.continuation,
      { action: 'accept', content: { reason: 'family' } },
      setupValue.deps,
    );
    expect(isInputRequiredForConfirmation(second)).toBe(true);
    expect(calls).toEqual([]);
    if (!isInputRequiredForConfirmation(second)) return;

    const prepared = await resumeToolPreparation(
      setupValue.artifact,
      second.continuation,
      { action: 'accept', content: { team: 'noodle' } },
      setupValue.deps,
    );
    expect(isConfirmationRequired(prepared)).toBe(true);
    expect(calls).toEqual([]);
    expect(setupValue.envLoads()).toBe(1);
    if (!isConfirmationRequired(prepared)) return;
    expect(prepared.review).toEqual({
      input: originalInput,
      elicited: {
        choose_reason: { reason: 'family' },
        choose_team: { team: 'noodle' },
      },
      action: {
        connectorId: 'leave',
        connectorVersion: '1.0.0',
        operation: 'submit',
        arguments: { days: 2, reason: 'family', team: 'noodle' },
        inputSchema: submitSignature.input,
        additionalOperationCount: 0,
      },
    });
    expect(prepared.continuation.reviewedAction).toEqual({
      connectorId: 'leave',
      connectorVersion: '1.0.0',
      operation: 'submit',
      arguments: { days: 2, reason: 'family', team: 'noodle' },
    });

    const completed = await executePreparedTool(
      setupValue.artifact,
      prepared.continuation,
      setupValue.deps,
    );
    expect(completed).toEqual({
      status: 'completed',
      output: { requestId: 'request-123', team: 'noodle' },
    });
    expect(calls).toEqual(['submit:2:family:noodle']);
    expect(setupValue.envLoads()).toBe(1);
  });

  it('applies elicitation defaults before preparing and reviewing a confirmed action', async () => {
    const calls: string[] = [];
    const setupValue = setup(calls);
    const tool = setupValue.artifact.tools[0];
    if (tool?.fulfilment.kind !== 'flow') throw new Error('expected flow');
    const withDefaults: RuntimeArtifact = {
      ...setupValue.artifact,
      tools: [
        {
          ...tool,
          fulfilment: {
            ...tool.fulfilment,
            steps: tool.fulfilment.steps.map((step) =>
              step.kind === 'elicit' && step.id === 'choose_reason'
                ? {
                    ...step,
                    requestedSchema: {
                      type: 'object',
                      properties: {
                        reason: { type: 'string', default: 'vacation' },
                        notify: { type: 'boolean', default: false },
                        tags: {
                          type: 'array',
                          items: { type: 'string' },
                          default: ['planned'],
                        },
                        note: { type: 'string' },
                      },
                      additionalProperties: false,
                    },
                  }
                : step,
            ),
          },
        },
      ],
    };

    const first = await prepareToolForConfirmation(
      withDefaults,
      'book',
      { days: 2 },
      setupValue.deps,
    );
    if (!isInputRequiredForConfirmation(first)) throw new Error('expected reason request');
    const second = await resumeToolPreparation(
      withDefaults,
      first.continuation,
      { action: 'accept', content: {} },
      setupValue.deps,
    );
    if (!isInputRequiredForConfirmation(second)) throw new Error('expected team request');
    expect(second.continuation.elicited.choose_reason).toEqual({
      reason: 'vacation',
      notify: false,
      tags: ['planned'],
    });
    const prepared = await resumeToolPreparation(
      withDefaults,
      second.continuation,
      { action: 'accept', content: { team: 'noodle' } },
      setupValue.deps,
    );
    if (!isConfirmationRequired(prepared)) throw new Error('expected confirmation');
    expect(prepared.review.action?.arguments).toEqual({
      days: 2,
      reason: 'vacation',
      team: 'noodle',
    });
    expect(prepared.review.elicited.choose_reason).toEqual({
      reason: 'vacation',
      notify: false,
      tags: ['planned'],
    });
    expect(calls).toEqual([]);
  });

  it('rejects undeclared elicitation keys before preparing a confirmed action', async () => {
    const calls: string[] = [];
    const setupValue = setup(calls);
    const tool = setupValue.artifact.tools[0];
    if (tool?.fulfilment.kind !== 'flow') throw new Error('expected flow');
    const chooseReason = tool.fulfilment.steps.find(
      (step) => step.kind === 'elicit' && step.id === 'choose_reason',
    );
    if (chooseReason?.kind !== 'elicit') throw new Error('expected reason request');
    const permissiveArtifact: RuntimeArtifact = {
      ...setupValue.artifact,
      tools: [
        {
          ...tool,
          fulfilment: {
            ...tool.fulfilment,
            steps: tool.fulfilment.steps.map((step) =>
              step.id === chooseReason.id
                ? {
                    ...chooseReason,
                    requestedSchema: {
                      type: 'object',
                      properties: { reason: { type: 'string' } },
                      required: ['reason'],
                    },
                  }
                : step,
            ),
          },
        },
      ],
    };
    const first = await prepareToolForConfirmation(
      permissiveArtifact,
      'book',
      { days: 2 },
      setupValue.deps,
    );
    if (!isInputRequiredForConfirmation(first)) throw new Error('expected reason request');

    const result = await resumeToolPreparation(
      permissiveArtifact,
      first.continuation,
      { action: 'accept', content: { reason: 'family', hidden: 'must-not-enter-the-review' } },
      setupValue.deps,
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'arg_invalid', path: 'steps.choose_reason.hidden' },
    });
    expect(calls).toEqual([]);
  });

  it.each(['decline', 'cancel'] as const)('stops preparation on %s', async (action) => {
    const calls: string[] = [];
    const setupValue = setup(calls);
    const first = await prepareToolForConfirmation(
      setupValue.artifact,
      'book',
      { days: 2 },
      setupValue.deps,
    );
    if (!isInputRequiredForConfirmation(first)) throw new Error('expected input request');
    await expect(
      resumeToolPreparation(setupValue.artifact, first.continuation, { action }, setupValue.deps),
    ).resolves.toEqual({ status: 'stopped', action });
    expect(calls).toEqual([]);
  });

  it('fails closed before an operation when elicitation is declared after it', async () => {
    const calls: string[] = [];
    const setupValue = setup(calls);
    const tool = setupValue.artifact.tools[0];
    if (tool?.fulfilment.kind !== 'flow') throw new Error('expected flow');
    const [, chooseReason, copyReason, chooseTeam, submit] = tool.fulfilment.steps;
    if (!chooseReason || !copyReason || !chooseTeam || !submit) {
      throw new Error('expected confirmation flow steps');
    }
    const invalidArtifact: RuntimeArtifact = {
      ...setupValue.artifact,
      tools: [
        {
          ...tool,
          fulfilment: {
            ...tool.fulfilment,
            steps: [submit, chooseReason, copyReason, chooseTeam],
          },
        },
      ],
    };

    await expect(
      prepareToolForConfirmation(invalidArtifact, 'book', { days: 2 }, setupValue.deps),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'invalid_elicitation_flow' },
    });
    expect(calls).toEqual([]);
  });

  it('fails closed when a confirmable flow contains a hidden later operation', async () => {
    const calls: string[] = [];
    const setupValue = setup(calls);
    const tool = setupValue.artifact.tools[0];
    if (tool?.fulfilment.kind !== 'flow') throw new Error('expected flow');
    const submit = tool.fulfilment.steps.find((step) => step.kind === 'operation');
    if (!submit) throw new Error('expected operation');
    const invalidArtifact: RuntimeArtifact = {
      ...setupValue.artifact,
      tools: [
        {
          ...tool,
          fulfilment: {
            ...tool.fulfilment,
            steps: [...tool.fulfilment.steps, { ...submit, id: 'hidden_submit' }],
          },
        },
      ],
    };

    await expect(
      prepareToolForConfirmation(invalidArtifact, 'book', { days: 2 }, setupValue.deps),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'invalid_confirmation_flow', path: 'steps.hidden_submit' },
    });
    expect(calls).toEqual([]);
  });

  it('binds prepared continuations to the exact artifact and tool', async () => {
    const calls: string[] = [];
    const setupValue = setup(calls);
    let result = await prepareToolForConfirmation(
      setupValue.artifact,
      'book',
      { days: 2 },
      setupValue.deps,
    );
    if (!isInputRequiredForConfirmation(result)) throw new Error('expected first input');
    result = await resumeToolPreparation(
      setupValue.artifact,
      result.continuation,
      { action: 'accept', content: { reason: 'family' } },
      setupValue.deps,
    );
    if (!isInputRequiredForConfirmation(result)) throw new Error('expected second input');
    const prepared = await resumeToolPreparation(
      setupValue.artifact,
      result.continuation,
      { action: 'accept', content: { team: 'noodle' } },
      setupValue.deps,
    );
    if (!isConfirmationRequired(prepared)) throw new Error('expected confirmation');

    const differentArtifact = {
      ...setupValue.artifact,
      server: { ...setupValue.artifact.server, version: '2.0.0' },
    };
    await expect(
      executePreparedTool(differentArtifact, prepared.continuation, setupValue.deps),
    ).resolves.toMatchObject({ status: 'failed', error: { code: 'invalid_continuation' } });
    expect(calls).toEqual([]);

    const reordered = {
      ...prepared.continuation,
      reviewedAction: {
        ...prepared.continuation.reviewedAction,
        arguments: { team: 'noodle', days: 2, reason: 'family' },
      },
    };
    await expect(
      executePreparedTool(setupValue.artifact, reordered, setupValue.deps),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(calls).toEqual(['submit:2:family:noodle']);

    const tampered = {
      ...prepared.continuation,
      reviewedAction: {
        ...prepared.continuation.reviewedAction,
        arguments: { days: 99, reason: 'family', team: 'noodle' },
      },
    };
    await expect(
      executePreparedTool(setupValue.artifact, tampered, setupValue.deps),
    ).resolves.toMatchObject({ status: 'failed', error: { code: 'invalid_continuation' } });
    expect(calls).toEqual(['submit:2:family:noodle']);
  });

  it('rechecks for a later elicitation before executing any prepared operation', async () => {
    const calls: string[] = [];
    const setupValue = setup(calls);
    let result = await prepareToolForConfirmation(
      setupValue.artifact,
      'book',
      { days: 2 },
      setupValue.deps,
    );
    if (!isInputRequiredForConfirmation(result)) throw new Error('expected first input');
    result = await resumeToolPreparation(
      setupValue.artifact,
      result.continuation,
      { action: 'accept', content: { reason: 'family' } },
      setupValue.deps,
    );
    if (!isInputRequiredForConfirmation(result)) throw new Error('expected second input');
    const prepared = await resumeToolPreparation(
      setupValue.artifact,
      result.continuation,
      { action: 'accept', content: { team: 'noodle' } },
      setupValue.deps,
    );
    if (!isConfirmationRequired(prepared)) throw new Error('expected confirmation');

    const tool = setupValue.artifact.tools[0];
    if (tool?.fulfilment.kind !== 'flow') throw new Error('expected flow');
    const driftedArtifact: RuntimeArtifact = {
      ...setupValue.artifact,
      tools: [
        {
          ...tool,
          fulfilment: {
            ...tool.fulfilment,
            steps: [
              ...tool.fulfilment.steps,
              {
                id: 'too_late',
                kind: 'elicit',
                message: 'This must never run.',
                requestedSchema: { type: 'object', properties: {} },
              },
            ],
          },
        },
      ],
    };
    await expect(
      executePreparedTool(driftedArtifact, prepared.continuation, setupValue.deps),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'invalid_elicitation_flow' },
    });
    expect(calls).toEqual([]);
  });

  it('still requires confirmation when a pure flow finishes during preparation', async () => {
    const calls: string[] = [];
    const setupValue = setup(calls);
    const tool = setupValue.artifact.tools[0];
    if (tool?.fulfilment.kind !== 'flow') throw new Error('expected flow');
    const copyInput = tool.fulfilment.steps[0];
    if (!copyInput) throw new Error('expected pure prefix map');
    const pureArtifact: RuntimeArtifact = {
      ...setupValue.artifact,
      tools: [
        {
          ...tool,
          fulfilment: {
            kind: 'flow',
            steps: [copyInput],
            output: { days: path('steps', 'copy_input', 'days') },
          },
        },
      ],
    };
    const beforeDispatch = vi.fn(async () => ({ allow: true as const }));
    const executionDeps = { ...setupValue.deps, beforeDispatch };
    const prepared = await prepareToolForConfirmation(
      pureArtifact,
      'book',
      { days: 2 },
      executionDeps,
    );
    expect(isConfirmationRequired(prepared)).toBe(true);
    expect(beforeDispatch).not.toHaveBeenCalled();
    if (!isConfirmationRequired(prepared)) return;
    await expect(
      executePreparedTool(pureArtifact, prepared.continuation, executionDeps),
    ).resolves.toEqual({ status: 'completed', output: { days: 2 } });
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(beforeDispatch).toHaveBeenCalledWith({ toolName: 'book' });
    expect(calls).toEqual([]);
  });

  it.each([
    ['binding id', { bindingId: 'work' }],
    ['connection revision', { connectionConfigRevision: 'sha256:revision-2' }],
    ['credential presentation', { presentation: { kind: 'apiKey', header: 'X-API-Key' } }],
  ])('rejects prepared execution after %s drift', async (_label, drift) => {
    const calls: string[] = [];
    const setupValue = setup(calls);
    const tool = setupValue.artifact.tools[0];
    if (tool?.fulfilment.kind !== 'flow') throw new Error('expected flow');
    const steps = tool.fulfilment.steps.map((step) =>
      step.kind === 'operation' && step.operationRef.resolved
        ? {
            ...step,
            operationRef: {
              ...step.operationRef,
              credentialBinding: {
                bindingId: 'personal',
                connectionId: 'personal_mail',
                connectionConfigRevision: 'sha256:revision-1',
                profile: 'delegated',
                presentation: { kind: 'bearer' },
                requiredScopes: ['mail.write'],
              },
            },
          }
        : step,
    );
    const boundArtifact: RuntimeArtifact = {
      ...setupValue.artifact,
      tools: [{ ...tool, fulfilment: { ...tool.fulfilment, steps } }],
    };
    let result = await prepareToolForConfirmation(
      boundArtifact,
      'book',
      { days: 2 },
      setupValue.deps,
    );
    if (!isInputRequiredForConfirmation(result)) throw new Error('expected first input');
    result = await resumeToolPreparation(
      boundArtifact,
      result.continuation,
      { action: 'accept', content: { reason: 'family' } },
      setupValue.deps,
    );
    if (!isInputRequiredForConfirmation(result)) throw new Error('expected second input');
    const prepared = await resumeToolPreparation(
      boundArtifact,
      result.continuation,
      { action: 'accept', content: { team: 'noodle' } },
      setupValue.deps,
    );
    if (!isConfirmationRequired(prepared)) throw new Error('expected confirmation');
    expect(prepared.continuation.reviewedAction).toMatchObject({
      bindingId: 'personal',
      connectionId: 'personal_mail',
      connectionConfigRevision: 'sha256:revision-1',
      profile: 'delegated',
      presentation: { kind: 'bearer' },
    });

    const driftedArtifact: RuntimeArtifact = {
      ...boundArtifact,
      tools: [
        {
          ...tool,
          fulfilment: {
            ...tool.fulfilment,
            steps: steps.map((step) =>
              step.kind === 'operation' &&
              step.operationRef.resolved &&
              step.operationRef.credentialBinding !== undefined
                ? {
                    ...step,
                    operationRef: {
                      ...step.operationRef,
                      credentialBinding: { ...step.operationRef.credentialBinding, ...drift },
                    },
                  }
                : step,
            ),
          },
        },
      ],
    };
    await expect(
      executePreparedTool(driftedArtifact, prepared.continuation, setupValue.deps),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'invalid_continuation' },
    });
    expect(calls).toEqual([]);
  });
});
