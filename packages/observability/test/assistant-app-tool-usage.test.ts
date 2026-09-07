import type { RequestEvent } from '@noodle-borg/module';
import { describe, expect, it } from 'vitest';
import { assistantAppToolCallRequestEvent } from '../src/assistant-app-tool-usage.js';
import { aggregateAssistantUsage } from '../src/assistant-usage.js';

const publicSession = {
  id: 'session-public',
  tenant: { org: 'acme', app: 'site', env: 'prod' },
  deploymentId: 'dep-1',
  publicEmbedId: 'embed-1',
  turnCount: 3,
  history: [],
} as const;

const authenticatedSession = {
  id: 'session-auth',
  tenant: { org: 'acme', app: 'ops', env: 'prod' },
  deploymentId: 'dep-2',
  turnCount: 1,
  history: [],
} as const;

describe('apps-bridge tool call telemetry', () => {
  it('separates a browser agent from the panel it borrows authority from', () => {
    const panel = assistantAppToolCallRequestEvent(publicSession, {
      toolName: 'ask',
      bridged: false,
      outcome: 'ok',
      durationMs: 12,
    });
    const agent = assistantAppToolCallRequestEvent(publicSession, {
      toolName: 'ask',
      bridged: true,
      outcome: 'ok',
      durationMs: 12,
    });

    expect(panel.surface).toBe('assistant-public');
    expect(agent.surface).toBe('webmcp');
    // The marker moves the label and nothing else: both rows are the same session, the same
    // anonymous subject, and the same public access mode, because both had the same authority.
    expect(agent.sessionId).toBe(panel.sessionId);
    expect(agent.subjectKind).toBe(panel.subjectKind);
    expect(agent.accessMode).toBe(panel.accessMode);
  });

  it('attributes an unmarked call on a signed-in surface to that surface', () => {
    const event = assistantAppToolCallRequestEvent(authenticatedSession, {
      toolName: 'close_ticket',
      bridged: false,
      outcome: 'ok',
      durationMs: 4,
    });
    expect(event).toMatchObject({
      surface: 'assistant-authenticated',
      subjectKind: 'authenticated',
      accessMode: 'authenticated',
      method: 'tools/call',
      kind: 'usage',
      toolName: 'close_ticket',
      outcome: 'ok',
    });
  });

  it('keeps a refusal and a failure apart, because they want different responses', () => {
    const refused = assistantAppToolCallRequestEvent(publicSession, {
      toolName: 'ask',
      bridged: true,
      outcome: 'refused',
      errorKind: 'app_tool_not_found',
      durationMs: 1,
    });
    const failed = assistantAppToolCallRequestEvent(publicSession, {
      toolName: 'ask',
      bridged: true,
      outcome: 'failed',
      errorKind: 'connector_unavailable',
      durationMs: 90,
    });
    expect(refused.outcome).toBe('tool_error');
    expect(refused.errorKind).toBe('app_tool_not_found');
    expect(failed.outcome).toBe('mcp_error');
    expect(failed.errorKind).toBe('connector_unavailable');
  });

  it('carries no field a tool argument or result could enter through', () => {
    const event = assistantAppToolCallRequestEvent(publicSession, {
      toolName: 'ask',
      bridged: true,
      outcome: 'ok',
      durationMs: 7,
    });
    expect(event.details).toEqual({ eventKind: 'appToolCall', bridged: true });
  });

  it('stays out of the conversation aggregates, because a bridge call is not a turn', () => {
    const event = assistantAppToolCallRequestEvent(publicSession, {
      toolName: 'ask',
      bridged: true,
      outcome: 'ok',
      durationMs: 7,
    });
    const metrics = aggregateAssistantUsage([
      {
        ...event,
        id: 'e1',
        schemaVersion: 3,
        createdAt: '2026-09-01T00:00:00.000Z',
      } as RequestEvent,
    ]);
    expect(metrics.turns.attempted).toBe(0);
    expect(metrics.sessions.minted).toBe(0);
  });

  it('refuses to report a negative or non-finite duration', () => {
    for (const durationMs of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const event = assistantAppToolCallRequestEvent(publicSession, {
        toolName: 'ask',
        bridged: false,
        outcome: 'ok',
        durationMs,
      });
      expect(event.durationMs).toBe(0);
    }
  });
});
