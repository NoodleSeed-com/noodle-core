import { computeSignatureHash, type RuntimeArtifact } from '@noodle-borg/compiler';
import { describe, expect, it, vi } from 'vitest';
import {
  executeToolInteractive,
  InMemoryConnector,
  InMemoryConnectorRegistry,
  isInputRequired,
  resumeTool,
  StaticServiceBroker,
} from '../src/index.js';

function artifact(): RuntimeArtifact {
  return {
    artifactSchemaVersion: '0.11.0',
    resolution: 'resolved',
    source: { manifestName: 'elicitation', manifestVersion: '1' },
    server: { name: 'elicitation', title: 'Elicitation', version: '1.0.0' },
    capabilities: { tools: ['prepare'] },
    tools: [
      {
        name: 'prepare',
        description: 'Prepare a request.',
        inputSchema: { type: 'object' },
        fulfilment: {
          kind: 'flow',
          steps: [
            {
              id: 'before',
              kind: 'map',
              value: { seed: { kind: 'literal', value: 'S1' } },
            },
            {
              id: 'choose_team',
              kind: 'elicit',
              message: 'Which team?',
              requestedSchema: {
                type: 'object',
                properties: { team: { type: 'string', enum: ['noodle', 'platform'] } },
                required: ['team'],
              },
            },
            {
              id: 'after',
              kind: 'operation',
              operationRef: {
                resolved: true,
                alias: 'work',
                connectorId: 'work',
                connectorVersion: '1.0.0',
                operation: 'after',
                signatureHash: 'sha256v2:placeholder',
              },
              args: {
                seed: {
                  kind: 'path',
                  root: 'steps',
                  segments: [
                    { kind: 'prop', name: 'before' },
                    { kind: 'prop', name: 'seed' },
                  ],
                },
                team: {
                  kind: 'path',
                  root: 'steps',
                  segments: [
                    { kind: 'prop', name: 'choose_team' },
                    { kind: 'prop', name: 'team' },
                  ],
                },
              },
            },
          ],
          output: {
            team: {
              kind: 'path',
              root: 'steps',
              segments: [
                { kind: 'prop', name: 'choose_team' },
                { kind: 'prop', name: 'team' },
              ],
            },
            done: {
              kind: 'path',
              root: 'steps',
              segments: [
                { kind: 'prop', name: 'after' },
                { kind: 'prop', name: 'done' },
              ],
            },
          },
        },
      },
    ],
  };
}

function deps(calls: string[]) {
  const after = {
    type: 'action' as const,
    input: {
      type: 'object',
      properties: { seed: { type: 'string' }, team: { type: 'string' } },
      required: ['seed', 'team'],
      additionalProperties: false,
    },
    output: {
      type: 'object',
      properties: { done: { type: 'boolean' } },
      required: ['done'],
      additionalProperties: false,
    },
  };
  const connector = new InMemoryConnector('work', '1.0.0', {
    after: {
      signature: after,
      handler: (args) => {
        calls.push(`after:${args.team}`);
        return { done: true };
      },
    },
  });
  const value = artifact();
  const flow = value.tools[0]?.fulfilment;
  if (flow?.kind !== 'flow') throw new Error('expected flow');
  for (const step of flow.steps) {
    if (step.kind !== 'operation' || !step.operationRef.resolved) continue;
    (step.operationRef as { signatureHash: string }).signatureHash = computeSignatureHash(
      step.operationRef.operation,
      after,
    );
  }
  return {
    artifact: value,
    deps: {
      connectors: new InMemoryConnectorRegistry([connector]),
      broker: new StaticServiceBroker({ token: 'svc' }),
    },
  };
}

describe('interactive runtime elicitation', () => {
  it('suspends, validates accepted input, and resumes without rerunning completed steps', async () => {
    const calls: string[] = [];
    const setup = await deps(calls);
    const pending = await executeToolInteractive(setup.artifact, 'prepare', {}, setup.deps);
    expect(isInputRequired(pending)).toBe(true);
    if (!isInputRequired(pending)) return;
    expect(pending.request).toEqual({
      id: 'choose_team',
      message: 'Which team?',
      requestedSchema: expect.objectContaining({ type: 'object' }),
    });
    expect(calls).toEqual([]);

    const completed = await resumeTool(
      setup.artifact,
      pending.continuation,
      { action: 'accept', content: { team: 'noodle' } },
      setup.deps,
    );
    expect(completed).toEqual({ status: 'completed', output: { team: 'noodle', done: true } });
    expect(calls).toEqual(['after:noodle']);
  });

  it('applies schema defaults once in the shared continuation kernel and preserves absent optionals', async () => {
    const calls: string[] = [];
    const setup = await deps(calls);
    const tool = setup.artifact.tools[0];
    if (tool?.fulfilment.kind !== 'flow') throw new Error('expected flow');
    const withDefaults: RuntimeArtifact = {
      ...setup.artifact,
      tools: [
        {
          ...tool,
          fulfilment: {
            ...tool.fulfilment,
            steps: tool.fulfilment.steps.map((step) =>
              step.kind === 'elicit'
                ? {
                    ...step,
                    requestedSchema: {
                      type: 'object',
                      properties: {
                        team: { type: 'string', default: 'platform' },
                        notify: { type: 'boolean', default: false },
                        extras: {
                          type: 'array',
                          items: { type: 'string' },
                          default: ['napkins'],
                        },
                        note: { type: 'string' },
                      },
                      additionalProperties: false,
                    },
                  }
                : step,
            ),
            output: {
              ...tool.fulfilment.output,
              notify: {
                kind: 'path',
                root: 'steps',
                segments: [
                  { kind: 'prop', name: 'choose_team' },
                  { kind: 'prop', name: 'notify' },
                ],
              },
              extras: {
                kind: 'path',
                root: 'steps',
                segments: [
                  { kind: 'prop', name: 'choose_team' },
                  { kind: 'prop', name: 'extras' },
                ],
              },
              note: {
                kind: 'path',
                root: 'steps',
                segments: [
                  { kind: 'prop', name: 'choose_team' },
                  { kind: 'prop', name: 'note' },
                ],
              },
            },
          },
        },
      ],
    };

    const pending = await executeToolInteractive(withDefaults, 'prepare', {}, setup.deps);
    if (!isInputRequired(pending)) throw new Error('expected input request');
    await expect(
      resumeTool(withDefaults, pending.continuation, { action: 'accept', content: {} }, setup.deps),
    ).resolves.toEqual({
      status: 'completed',
      output: { team: 'platform', done: true, notify: false, extras: ['napkins'] },
    });
    expect(calls).toEqual(['after:platform']);
  });

  it('rejects invalid accepted content without running later steps', async () => {
    const calls: string[] = [];
    const setup = await deps(calls);
    const pending = await executeToolInteractive(setup.artifact, 'prepare', {}, setup.deps);
    if (!isInputRequired(pending)) throw new Error('expected input request');
    const result = await resumeTool(
      setup.artifact,
      pending.continuation,
      { action: 'accept', content: { team: 'unknown' } },
      setup.deps,
    );
    expect(result).toMatchObject({ status: 'failed', error: { code: 'arg_invalid' } });
    expect(calls).toEqual([]);
  });

  it('rejects accepted content keys not declared by the requested schema', async () => {
    const calls: string[] = [];
    const setup = await deps(calls);
    const pending = await executeToolInteractive(setup.artifact, 'prepare', {}, setup.deps);
    if (!isInputRequired(pending)) throw new Error('expected input request');

    const result = await resumeTool(
      setup.artifact,
      pending.continuation,
      { action: 'accept', content: { team: 'noodle', hidden: 'must-not-enter-the-flow' } },
      setup.deps,
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'arg_invalid', path: 'steps.choose_team.hidden' },
    });
    expect(calls).toEqual([]);
  });

  it('meters a connector-free tool only after its elicited input completes', async () => {
    const calls: string[] = [];
    const setup = await deps(calls);
    const tool = setup.artifact.tools[0];
    if (tool?.fulfilment.kind !== 'flow') throw new Error('expected flow');
    const chooseTeam = tool.fulfilment.steps.find((step) => step.kind === 'elicit');
    if (chooseTeam?.kind !== 'elicit') throw new Error('expected elicitation step');
    const pureArtifact: RuntimeArtifact = {
      ...setup.artifact,
      tools: [
        {
          ...tool,
          fulfilment: {
            kind: 'flow',
            steps: [chooseTeam],
            output: {
              team: {
                kind: 'path',
                root: 'steps',
                segments: [
                  { kind: 'prop', name: 'choose_team' },
                  { kind: 'prop', name: 'team' },
                ],
              },
            },
          },
        },
      ],
    };
    const beforeDispatch = vi.fn(async () => ({ allow: true as const }));
    const executionDeps = { ...setup.deps, beforeDispatch };

    const pending = await executeToolInteractive(pureArtifact, 'prepare', {}, executionDeps);
    expect(isInputRequired(pending)).toBe(true);
    expect(beforeDispatch).not.toHaveBeenCalled();
    if (!isInputRequired(pending)) return;

    await expect(
      resumeTool(
        pureArtifact,
        pending.continuation,
        { action: 'accept', content: { team: 'noodle' } },
        executionDeps,
      ),
    ).resolves.toEqual({ status: 'completed', output: { team: 'noodle' } });
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(beforeDispatch).toHaveBeenCalledWith({ toolName: 'prepare' });
    expect(calls).toEqual([]);
  });

  it.each(['decline', 'cancel'] as const)('stops cleanly on %s', async (action) => {
    const calls: string[] = [];
    const setup = await deps(calls);
    const pending = await executeToolInteractive(setup.artifact, 'prepare', {}, setup.deps);
    if (!isInputRequired(pending)) throw new Error('expected input request');
    await expect(
      resumeTool(setup.artifact, pending.continuation, { action }, setup.deps),
    ).resolves.toEqual({ status: 'stopped', action });
    expect(calls).toEqual([]);
  });

  it('fails before an operation that appears ahead of a later elicitation boundary', async () => {
    const calls: string[] = [];
    const setup = await deps(calls);
    const tool = setup.artifact.tools[0];
    if (tool?.fulfilment.kind !== 'flow') throw new Error('expected flow');
    const choose = tool.fulfilment.steps.find((step) => step.kind === 'elicit');
    const operation = tool.fulfilment.steps.find((step) => step.kind === 'operation');
    if (!choose || !operation) throw new Error('expected elicitation and operation');
    const invalid: RuntimeArtifact = {
      ...setup.artifact,
      tools: [
        {
          ...tool,
          fulfilment: { ...tool.fulfilment, steps: [operation, choose] },
        },
      ],
    };

    await expect(executeToolInteractive(invalid, 'prepare', {}, setup.deps)).resolves.toMatchObject(
      {
        status: 'failed',
        error: { code: 'invalid_elicitation_flow' },
      },
    );
    expect(calls).toEqual([]);
  });
});
