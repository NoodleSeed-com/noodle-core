import type { RequestEvent } from '@noodle-borg/module';
import { describe, expect, it } from 'vitest';
import {
  aggregateAssistantUsage,
  assistantRefusedSessionUsageRequestEvent,
  assistantRefusedTurnUsageRequestEvent,
  assistantSessionUsageRequestEvent,
  assistantTurnNumber,
  assistantTurnUsageRequestEvent,
  assistantUsageRequestEvent,
  captureAssistantUsage,
} from '../src/assistant-usage.js';

let sequence = 0;

function persisted(input: ReturnType<typeof assistantUsageRequestEvent>): RequestEvent {
  sequence += 1;
  return {
    ...input,
    id: `event-${sequence}`,
    schemaVersion: 1,
    createdAt: `2026-08-24T12:${String(sequence).padStart(2, '0')}:00.000Z`,
    details: input.details as RequestEvent['details'],
  };
}

const tenant = { org: 'acme', app: 'support', env: 'prod', deploymentId: 'dep-1' } as const;

describe('assistant usage telemetry', () => {
  it('projects session records without exposing conversation content', () => {
    const session = {
      id: 'session-public',
      tenant: { org: 'acme', app: 'support', env: 'prod' },
      deploymentId: 'dep-1',
      publicEmbedId: 'embed-1',
      modelSource: 'noodle-managed' as const,
      turnCount: 4,
      history: [{ role: 'user' as const }, { role: 'assistant' as const }],
    };

    expect(assistantSessionUsageRequestEvent(session, 12)).toEqual(
      expect.objectContaining({
        method: 'assistant',
        sessionId: 'session-public',
        subjectKind: 'anonymous',
        details: expect.objectContaining({
          eventKind: 'session',
          surface: 'public',
          modelSource: 'noodle-managed',
        }),
      }),
    );
    expect(assistantRefusedTurnUsageRequestEvent(session, 'daily_limit', 20)).toEqual(
      expect.objectContaining({
        errorKind: 'daily_limit',
        details: expect.objectContaining({
          assistantOutcome: 'refused',
          turnNumber: 4,
          modelRequests: 0,
          totalTokens: 0,
        }),
      }),
    );
    expect(assistantTurnNumber(session)).toBe(5);

    expect(() =>
      captureAssistantUsage(
        () => {
          throw new Error('telemetry unavailable');
        },
        assistantSessionUsageRequestEvent(session, 1),
      ),
    ).not.toThrow();
  });

  it('aggregates useful beta engagement without retaining conversation content', () => {
    const events = [
      persisted(
        assistantUsageRequestEvent({
          ...tenant,
          eventKind: 'session',
          sessionId: 'session-a',
          surface: 'public',
          modelSource: 'noodle-managed',
          durationMs: 12,
        }),
      ),
      persisted(
        assistantUsageRequestEvent({
          ...tenant,
          eventKind: 'turn',
          sessionId: 'session-a',
          surface: 'public',
          modelSource: 'noodle-managed',
          outcome: 'delivered',
          turnNumber: 1,
          durationMs: 240,
          modelRequests: 1,
          toolCalls: 0,
          interactionCount: 0,
          promptTokens: 100,
          completionTokens: 40,
          totalTokens: 140,
          reasoningTokens: 5,
        }),
      ),
      persisted(
        assistantUsageRequestEvent({
          ...tenant,
          eventKind: 'turn',
          sessionId: 'session-a',
          surface: 'public',
          modelSource: 'noodle-managed',
          outcome: 'delivered',
          turnNumber: 20,
          durationMs: 600,
          modelRequests: 2,
          toolCalls: 1,
          interactionCount: 1,
          promptTokens: 300,
          completionTokens: 80,
          totalTokens: 380,
        }),
      ),
      persisted(
        assistantUsageRequestEvent({
          ...tenant,
          eventKind: 'turn',
          sessionId: 'session-b',
          surface: 'authenticated',
          modelSource: 'operator',
          outcome: 'failed',
          turnNumber: 1,
          durationMs: 900,
          modelRequests: 1,
          toolCalls: 0,
          interactionCount: 0,
          promptTokens: 50,
          completionTokens: 0,
          totalTokens: 50,
        }),
      ),
    ];

    const metrics = aggregateAssistantUsage(events);
    expect(metrics.sessions).toEqual({ minted: 1, public: 1, authenticated: 0, refused: 0 });
    expect(metrics.turns).toEqual({ attempted: 3, delivered: 2, failed: 1, refused: 0 });
    expect(metrics.depth).toEqual({
      p50: 1,
      p90: 20,
      max: 20,
      atLeast10: 1,
      atLeast20: 1,
      atLeast30: 0,
      atLeast40: 0,
    });
    expect(metrics.engagement).toEqual({ modelRequests: 4, toolTurns: 1, interactionTurns: 1 });
    expect(metrics.tokens).toEqual({ prompt: 450, completion: 120, reasoning: 5, total: 570 });
    expect(metrics.latency).toEqual({ p50Ms: 600, p95Ms: 900 });
    expect(JSON.stringify(events)).not.toContain('conversation content');
  });

  /**
   * A refused mint used to leave no trace at all: the route returned before the usage capture ran,
   * so an operator whose surface was throttling visitors saw a healthy-looking usage page. Refusals
   * are also indistinguishable from each other without the code — "we are over budget" and "one
   * address is hammering us" want opposite responses.
   */
  it('separates refused mints from minted sessions and breaks refusals down by code', () => {
    const events = [
      persisted(
        assistantUsageRequestEvent({
          ...tenant,
          eventKind: 'session',
          sessionId: 'session-a',
          surface: 'public',
          durationMs: 5,
        }),
      ),
      persisted(
        assistantRefusedSessionUsageRequestEvent({
          tenant,
          deploymentId: tenant.deploymentId,
          code: 'daily_session_budget_exhausted',
          durationMs: 3,
        }),
      ),
      persisted(
        assistantRefusedSessionUsageRequestEvent({
          tenant,
          deploymentId: tenant.deploymentId,
          code: 'address_session_budget_exhausted',
          durationMs: 2,
        }),
      ),
      persisted(
        assistantRefusedSessionUsageRequestEvent({
          tenant,
          deploymentId: tenant.deploymentId,
          code: 'address_session_budget_exhausted',
          durationMs: 2,
        }),
      ),
      persisted(
        assistantUsageRequestEvent({
          ...tenant,
          eventKind: 'turn',
          sessionId: 'session-a',
          surface: 'public',
          outcome: 'refused',
          turnNumber: 1,
          durationMs: 4,
          modelRequests: 0,
          toolCalls: 0,
          interactionCount: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          errorKind: 'daily_turn_budget_exhausted',
        }),
      ),
    ];

    const metrics = aggregateAssistantUsage(events);
    // A refused mint is not a minted session, and it never was one.
    expect(metrics.sessions).toEqual({ minted: 1, public: 1, authenticated: 0, refused: 3 });
    expect(metrics.turns.refused).toBe(1);
    expect(metrics.refusalsByCode).toEqual({
      address_session_budget_exhausted: 2,
      daily_session_budget_exhausted: 1,
      daily_turn_budget_exhausted: 1,
    });
    // Still scalar-only: a refusal carries a code and a tenant, never an address or an origin.
    expect(JSON.stringify(events)).not.toContain('ip_');
  });

  it('ignores non-assistant request events and malformed scalar details', () => {
    const unrelated = {
      ...persisted(
        assistantUsageRequestEvent({
          ...tenant,
          eventKind: 'session',
          sessionId: 'session-a',
          surface: 'public',
          modelSource: 'noodle-managed',
          durationMs: 1,
        }),
      ),
      method: 'tools/call',
    };
    expect(aggregateAssistantUsage([unrelated])).toEqual(
      expect.objectContaining({ sessions: expect.objectContaining({ minted: 0 }) }),
    );
  });
});

/**
 * The assistant already had a `surface` inside its redacted `details` bag, spelled in its own
 * vocabulary (`public` / `authenticated`). The top-level field is the shared one every stream uses,
 * so the two are deliberately not the same string: a reader grouping the whole request stream by
 * surface must not have to know which emitter wrote the row.
 */
describe('assistant usage surface attribution', () => {
  const publicSession = {
    id: 'session-public',
    tenant: { org: 'acme', app: 'support', env: 'prod' },
    deploymentId: 'dep-1',
    publicEmbedId: 'embed-1',
    turnCount: 1,
    history: [],
  };
  const authenticatedSession = { ...publicSession, id: 'session-auth', publicEmbedId: undefined };

  it('attributes an anonymous embed session to the public assistant surface', () => {
    const event = assistantSessionUsageRequestEvent(publicSession, 12);
    expect(event.surface).toBe('assistant-public');
    expect(event.details?.surface).toBe('public');
  });

  it('attributes a customer-minted session to the authenticated assistant surface', () => {
    const event = assistantSessionUsageRequestEvent(authenticatedSession, 12);
    expect(event.surface).toBe('assistant-authenticated');
    expect(event.details?.surface).toBe('authenticated');
  });

  it('carries the surface on turns and refusals, not only on the session record', () => {
    const turn = assistantTurnUsageRequestEvent(publicSession, {
      outcome: 'delivered',
      turnNumber: 1,
      durationMs: 30,
    });
    const refused = assistantRefusedTurnUsageRequestEvent(
      authenticatedSession,
      'daily_turn_budget_exhausted',
      1,
    );
    expect(turn.surface).toBe('assistant-public');
    expect(refused.surface).toBe('assistant-authenticated');
  });
});
