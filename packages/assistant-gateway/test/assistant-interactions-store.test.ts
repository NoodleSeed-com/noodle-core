import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_INTERACTION_EXECUTION_LIMIT_MS,
  ASSISTANT_INTERACTION_OUTCOME_RETENTION_MS,
  AssistantInteractionCapacityError,
  InMemoryAssistantStore,
} from '../src/assistant-store.js';

const invocationContext = {
  temporal: {
    instant: '2030-01-01T18:59:00.000Z',
    localDate: '2030-01-01',
    localTime: '23:59:00',
    utcOffset: '+05:00',
    weekday: 'Tuesday',
    timeZone: 'Asia/Karachi',
    locale: 'en-GB',
    source: { locale: 'server-default' as const, timeZone: 'server-default' as const },
  },
  ambientStatus: 'available' as const,
  ambient: { defaultTeamId: 'team-1' },
};

const now = new Date('2030-01-01T00:00:00.000Z');
const later = new Date('2030-01-01T00:00:01.000Z');

function confirmationInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    kind: 'confirmation' as const,
    sessionId: 'session-1',
    deploymentId: 'deployment-1',
    tool: 'update_account',
    arguments: { name: 'New name' },
    context: invocationContext,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    ...overrides,
  };
}

describe('in-memory assistant interaction state machine', () => {
  it('claims once, returns replay state, and preserves scoped exact server payloads', async () => {
    const store = new InMemoryAssistantStore();
    const exactArguments = { name: 'New name', nested: { approved: true } };
    const interaction = await store.createInteraction(
      confirmationInput({ arguments: exactArguments }),
    );

    exactArguments.nested.approved = false;
    expect(interaction).toMatchObject({
      kind: 'confirmation',
      status: 'pending',
      createdAt: now.toISOString(),
      arguments: { name: 'New name', nested: { approved: true } },
      context: invocationContext,
    });
    await expect(
      store.claimInteraction({
        id: interaction.id,
        sessionId: 'other-session',
        deploymentId: 'deployment-1',
        now,
      }),
    ).resolves.toEqual({ disposition: 'unavailable' });
    await expect(
      store.claimInteraction({
        id: interaction.id,
        sessionId: 'session-1',
        deploymentId: 'other-deployment',
        now,
      }),
    ).resolves.toEqual({ disposition: 'unavailable' });

    const first = await store.claimInteraction({
      id: interaction.id,
      sessionId: 'session-1',
      deploymentId: 'deployment-1',
      now,
    });
    expect(first).toMatchObject({
      disposition: 'claimed',
      interaction: {
        id: interaction.id,
        status: 'executing',
        claimedAt: now.toISOString(),
        arguments: { name: 'New name', nested: { approved: true } },
      },
    });

    const replay = await store.claimInteraction({
      id: interaction.id,
      sessionId: 'session-1',
      deploymentId: 'deployment-1',
      now: later,
    });
    expect(replay).toMatchObject({
      disposition: 'replay',
      interaction: { status: 'executing', claimedAt: now.toISOString() },
    });
  });

  it('completes execution once and replays only the bounded redacted public outcome', async () => {
    const store = new InMemoryAssistantStore();
    const credentialShapedValue = ['sk', 'this-must-not-be-persisted'].join('-');
    const interaction = await store.createInteraction(
      confirmationInput({
        continuation: { privateState: 'erase-on-completion' },
        review: { privateProjection: 'erase-on-completion' },
      }),
    );
    await store.claimInteraction({
      id: interaction.id,
      sessionId: interaction.sessionId,
      deploymentId: interaction.deploymentId,
      now,
    });

    const completed = await store.completeInteraction({
      id: interaction.id,
      sessionId: interaction.sessionId,
      deploymentId: interaction.deploymentId,
      now: later,
      completion: {
        status: 'succeeded',
        publicOutcome: {
          code: 'request_created',
          summary: `Created request with Bearer ${'x'.repeat(32)}`,
          result: {
            requestId: 'request-123',
            apiToken: credentialShapedValue,
            nested: { status: 'pending' },
          },
          details: {
            requestId: 'request-123',
            apiKey: credentialShapedValue,
            nested: { raw: 'tool result' },
            long: 'x'.repeat(400),
          } as never,
        },
      },
    });
    expect(completed).toMatchObject({
      disposition: 'completed',
      interaction: {
        status: 'succeeded',
        completedAt: later.toISOString(),
        arguments: null,
        payloadScrubbedAt: later.toISOString(),
        publicOutcome: {
          code: 'request_created',
          summary: '[redacted]',
          details: {
            requestId: 'request-123',
            apiKey: '[redacted]',
            nested: '[redacted]',
          },
          result: {
            requestId: 'request-123',
            apiToken: '[redacted]',
            nested: { status: 'pending' },
          },
        },
      },
    });
    if (completed.disposition !== 'completed') throw new Error('expected completion');
    expect(completed.interaction.publicOutcome.details?.long).toHaveLength(240);
    expect(completed.interaction).not.toHaveProperty('result');
    expect(completed.interaction).not.toHaveProperty('error');
    expect(completed.interaction).not.toHaveProperty('context');
    expect(completed.interaction).not.toHaveProperty('continuation');
    expect(completed.interaction).not.toHaveProperty('review');

    const replay = await store.completeInteraction({
      id: interaction.id,
      sessionId: interaction.sessionId,
      deploymentId: interaction.deploymentId,
      now: later,
      completion: {
        status: 'failed',
        publicOutcome: { code: 'different', summary: 'must not overwrite' },
      },
    });
    expect(replay).toEqual({ disposition: 'replay', interaction: completed.interaction });
  });

  it('atomically declines or cancels pending interactions without an executing state', async () => {
    const store = new InMemoryAssistantStore();
    const declined = await store.createInteraction(confirmationInput());
    const resolved = await store.completeInteraction({
      id: declined.id,
      sessionId: declined.sessionId,
      deploymentId: declined.deploymentId,
      now,
      completion: { status: 'declined' },
    });
    expect(resolved).toMatchObject({
      disposition: 'completed',
      interaction: {
        status: 'declined',
        arguments: null,
        payloadScrubbedAt: now.toISOString(),
        publicOutcome: { code: 'interaction_declined' },
      },
    });
    if (resolved.disposition !== 'completed') throw new Error('expected decline');
    expect(resolved.interaction).not.toHaveProperty('context');

    const executionFromPending = await store.createInteraction(confirmationInput());
    await expect(
      store.completeInteraction({
        id: executionFromPending.id,
        sessionId: executionFromPending.sessionId,
        deploymentId: executionFromPending.deploymentId,
        now,
        completion: {
          status: 'succeeded',
          publicOutcome: { code: 'impossible', summary: 'not claimed' },
        },
      }),
    ).resolves.toMatchObject({ disposition: 'conflict', interaction: { status: 'pending' } });
  });

  it('stores input continuations as a distinct server-only interaction payload', async () => {
    const store = new InMemoryAssistantStore();
    const continuation = { flow: 'book_leave', step: 2, secretState: { teamIds: ['team-1'] } };
    const interaction = await store.createInteraction({
      kind: 'input',
      sessionId: 'session-1',
      deploymentId: 'deployment-1',
      tool: 'submit_time_off',
      message: 'Which team should receive the request?',
      requestedSchema: {
        type: 'object',
        properties: { team: { type: 'string' } },
        required: ['team'],
      },
      continuation,
      context: invocationContext,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    continuation.secretState.teamIds[0] = 'mutated';

    expect(interaction).toMatchObject({
      kind: 'input',
      status: 'pending',
      tool: 'submit_time_off',
      continuation: { flow: 'book_leave', step: 2, secretState: { teamIds: ['team-1'] } },
    });
    expect(interaction).not.toHaveProperty('arguments');
  });

  it('atomically completes an execution and creates exactly one replay-linked next interaction', async () => {
    const store = new InMemoryAssistantStore({ maxPendingInteractionsPerSession: 1 });
    const parent = await store.createInteraction(confirmationInput());
    await store.claimInteraction({
      id: parent.id,
      sessionId: parent.sessionId,
      deploymentId: parent.deploymentId,
      now,
    });
    const transition = {
      id: parent.id,
      sessionId: parent.sessionId,
      deploymentId: parent.deploymentId,
      now: later,
      publicOutcome: {
        code: 'input_requested',
        summary: 'Tool interaction completed.',
        details: { tool: parent.tool },
      },
      next: {
        kind: 'input' as const,
        tool: parent.tool,
        message: 'Which team?',
        requestedSchema: { type: 'object', properties: { team: { type: 'string' } } },
        continuation: { kind: 'confirmation_preparation', privateValue: 'server-only' },
        context: invocationContext,
        expiresAt: new Date(later.getTime() + 60_000).toISOString(),
      },
    };

    const completed = await store.transitionInteraction(transition);
    expect(completed).toMatchObject({
      disposition: 'transitioned',
      interaction: {
        status: 'succeeded',
        arguments: null,
        payloadScrubbedAt: later.toISOString(),
        publicOutcome: {
          code: 'input_requested',
          details: { tool: parent.tool, nextInteractionId: expect.any(String) },
        },
      },
      next: {
        kind: 'input',
        status: 'pending',
        continuation: { kind: 'confirmation_preparation', privateValue: 'server-only' },
      },
    });
    if (completed.disposition !== 'transitioned') throw new Error('expected transition');
    expect(completed.interaction).not.toHaveProperty('context');
    expect(completed.interaction.publicOutcome.details?.nextInteractionId).toBe(completed.next.id);

    await expect(store.transitionInteraction(transition)).resolves.toEqual({
      disposition: 'replay',
      interaction: completed.interaction,
    });
    await expect(
      store.getInteraction({
        id: completed.next.id,
        sessionId: parent.sessionId,
        deploymentId: parent.deploymentId,
        now: later,
      }),
    ).resolves.toEqual(completed.next);
  });

  it('rolls back the parent handoff when the next pending interaction exceeds capacity', async () => {
    const store = new InMemoryAssistantStore({ maxPendingInteractionsPerSession: 1 });
    const parent = await store.createInteraction(confirmationInput());
    await store.claimInteraction({
      id: parent.id,
      sessionId: parent.sessionId,
      deploymentId: parent.deploymentId,
      now,
    });
    const blocker = await store.createInteraction(
      confirmationInput({ tool: 'other_pending_action' }),
    );
    const handoff = {
      id: parent.id,
      sessionId: parent.sessionId,
      deploymentId: parent.deploymentId,
      now: later,
      publicOutcome: { code: 'input_requested', summary: 'Input required.' },
      next: {
        kind: 'input' as const,
        tool: parent.tool,
        message: 'Which team?',
        requestedSchema: { type: 'object', properties: { team: { type: 'string' } } },
        continuation: { privateValue: 'must-not-be-orphaned' },
        expiresAt: new Date(later.getTime() + 60_000).toISOString(),
      },
    };

    await expect(store.transitionInteraction(handoff)).rejects.toBeInstanceOf(
      AssistantInteractionCapacityError,
    );
    await expect(
      store.getInteraction({
        id: parent.id,
        sessionId: parent.sessionId,
        deploymentId: parent.deploymentId,
        now: later,
      }),
    ).resolves.toMatchObject({ status: 'executing' });

    await store.completeInteraction({
      id: blocker.id,
      sessionId: blocker.sessionId,
      deploymentId: blocker.deploymentId,
      now: later,
      completion: { status: 'cancelled' },
    });
    await expect(store.transitionInteraction(handoff)).resolves.toMatchObject({
      disposition: 'transitioned',
      next: { status: 'pending', continuation: { privateValue: 'must-not-be-orphaned' } },
    });
  });

  it('retains executing/unknown work past proposal expiry and replays its terminal outcome', async () => {
    const store = new InMemoryAssistantStore();
    const pending = await store.createInteraction(
      confirmationInput({ expiresAt: new Date(now.getTime() + 500).toISOString() }),
    );
    await store.claimInteraction({
      id: pending.id,
      sessionId: pending.sessionId,
      deploymentId: pending.deploymentId,
      now,
    });
    const afterExpiry = new Date(now.getTime() + 1_000);
    await expect(
      store.getInteraction({
        id: pending.id,
        sessionId: pending.sessionId,
        deploymentId: pending.deploymentId,
        now: afterExpiry,
      }),
    ).resolves.toMatchObject({ status: 'executing' });

    const completed = await store.completeInteraction({
      id: pending.id,
      sessionId: pending.sessionId,
      deploymentId: pending.deploymentId,
      now: afterExpiry,
      completion: {
        status: 'succeeded',
        publicOutcome: { code: 'done', summary: 'Completed after the decision deadline.' },
      },
    });
    expect(completed).toMatchObject({
      disposition: 'completed',
      interaction: { status: 'succeeded' },
    });
    await expect(
      store.claimInteraction({
        id: pending.id,
        sessionId: pending.sessionId,
        deploymentId: pending.deploymentId,
        now: new Date(afterExpiry.getTime() + 60_000),
      }),
    ).resolves.toMatchObject({ disposition: 'replay', interaction: { status: 'succeeded' } });
    await expect(
      store.getInteraction({
        id: pending.id,
        sessionId: pending.sessionId,
        deploymentId: pending.deploymentId,
        now: new Date(afterExpiry.getTime() + 24 * 60 * 60 * 1000),
      }),
    ).resolves.toBeUndefined();
  });

  it('hands exact inputs only to the winning executor and removes durable input custody before dispatch', async () => {
    const store = new InMemoryAssistantStore();
    const pending = await store.createInteraction(
      confirmationInput({
        arguments: { note: 'private-once' },
        continuation: { value: 'private-once' },
        review: { value: 'private-once' },
      }),
    );
    const scope = {
      id: pending.id,
      sessionId: pending.sessionId,
      deploymentId: pending.deploymentId,
      now,
    };
    const winner = await store.claimInteraction(scope);
    expect(winner).toMatchObject({
      disposition: 'claimed',
      interaction: { arguments: { note: 'private-once' } },
    });
    const persisted = await store.getInteraction(scope);
    expect(persisted).toMatchObject({ status: 'executing', arguments: null });
    expect(JSON.stringify(persisted)).not.toContain('private-once');
    const repeated = await store.claimInteraction(scope);
    expect(repeated.disposition).toBe('replay');
    expect(JSON.stringify(repeated)).not.toContain('private-once');
  });

  it('expires stranded executions into scrubbed, bounded unknown-outcome tombstones', async () => {
    const store = new InMemoryAssistantStore();
    const confirmation = await store.createInteraction(
      confirmationInput({
        arguments: { privateNote: 'erase-me' },
        continuation: { privateContinuation: 'erase-me' },
        review: { privateProjection: 'erase-me' },
      }),
    );
    const input = await store.createInteraction({
      kind: 'input',
      sessionId: 'session-1',
      deploymentId: 'deployment-1',
      tool: 'update_account',
      message: 'Choose a team',
      requestedSchema: {
        type: 'object',
        properties: { team: { type: 'string' } },
        required: ['team'],
      },
      continuation: { completedSteps: { privateValue: 'erase-me-too' } },
      context: invocationContext,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    await Promise.all(
      [confirmation, input].map((interaction) =>
        store.claimInteraction({
          id: interaction.id,
          sessionId: interaction.sessionId,
          deploymentId: interaction.deploymentId,
          now,
        }),
      ),
    );

    const scrubbedAt = new Date(now.getTime() + ASSISTANT_INTERACTION_EXECUTION_LIMIT_MS);
    await expect(
      store.getInteraction({
        id: confirmation.id,
        sessionId: confirmation.sessionId,
        deploymentId: confirmation.deploymentId,
        now: scrubbedAt,
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      arguments: null,
      payloadScrubbedAt: scrubbedAt.toISOString(),
      publicOutcome: { code: 'interaction_outcome_unknown' },
    });
    await expect(
      store.claimInteraction({
        id: input.id,
        sessionId: input.sessionId,
        deploymentId: input.deploymentId,
        now: scrubbedAt,
      }),
    ).resolves.toMatchObject({
      disposition: 'replay',
      interaction: {
        status: 'failed',
        continuation: null,
        payloadScrubbedAt: scrubbedAt.toISOString(),
        publicOutcome: { code: 'interaction_outcome_unknown' },
      },
    });
    const confirmationRecord = await store.getInteraction({
      id: confirmation.id,
      sessionId: confirmation.sessionId,
      deploymentId: confirmation.deploymentId,
      now: scrubbedAt,
    });
    const inputRecord = await store.getInteraction({
      id: input.id,
      sessionId: input.sessionId,
      deploymentId: input.deploymentId,
      now: scrubbedAt,
    });
    expect(confirmationRecord).not.toHaveProperty('context');
    expect(confirmationRecord).not.toHaveProperty('continuation');
    expect(confirmationRecord).not.toHaveProperty('review');
    expect(inputRecord).not.toHaveProperty('context');

    await expect(
      store.getInteraction({
        id: confirmation.id,
        sessionId: confirmation.sessionId,
        deploymentId: confirmation.deploymentId,
        now: new Date(scrubbedAt.getTime() + ASSISTANT_INTERACTION_OUTCOME_RETENTION_MS),
      }),
    ).resolves.toBeUndefined();
  });

  it('prunes expired records and enforces a per-session pending cap', async () => {
    const store = new InMemoryAssistantStore({ maxPendingInteractionsPerSession: 1 });
    const expired = await store.createInteraction(
      confirmationInput({
        createdAt: new Date(now.getTime() - 120_000).toISOString(),
        expiresAt: new Date(now.getTime() - 60_000).toISOString(),
      }),
    );
    await expect(
      store.getInteraction({
        id: expired.id,
        sessionId: expired.sessionId,
        deploymentId: expired.deploymentId,
        now,
      }),
    ).resolves.toBeUndefined();

    const pending = await store.createInteraction(confirmationInput());
    await expect(store.createInteraction(confirmationInput())).rejects.toBeInstanceOf(
      AssistantInteractionCapacityError,
    );
    await store.completeInteraction({
      id: pending.id,
      sessionId: pending.sessionId,
      deploymentId: pending.deploymentId,
      now,
      completion: { status: 'cancelled' },
    });
    await expect(store.createInteraction(confirmationInput())).resolves.toMatchObject({
      status: 'pending',
    });
  });
});
