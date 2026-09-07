import { describe, expect, it } from 'vitest';
import type { AssistantClientEvent } from '../src/client.js';
import { toAssistantClientEvent } from '../src/events.js';

describe('typed assistant client events', () => {
  it('validates known server payloads and narrows their data by event name', () => {
    const events = [
      toAssistantClientEvent({ event: 'content', data: { delta: 'hello' } }),
      toAssistantClientEvent({
        event: 'tool_started',
        data: { id: 'call_1', tool: 'list_leave' },
      }),
      toAssistantClientEvent({
        event: 'tool_proposed',
        data: { id: 'int_1', tool: 'book_leave', arguments: { start: '2030-01-03' } },
      }),
      toAssistantClientEvent({
        event: 'input_requested',
        data: {
          id: 'int_2',
          message: 'Choose a team',
          requestedSchema: { type: 'object' },
          expiresAt: '2030-01-01T00:10:00Z',
        },
      }),
      toAssistantClientEvent({
        event: 'interaction_resolved',
        data: { id: 'int_1', action: 'accept' },
      }),
      toAssistantClientEvent({
        event: 'tool_completed',
        data: { id: 'int_1', tool: 'book_leave', result: { ok: true }, replayed: true },
      }),
      toAssistantClientEvent({
        event: 'view_available',
        data: {
          id: 'int_1',
          tool: 'book_leave',
          resourceUri: 'ui://leave/request',
          result: { ok: true },
        },
      }),
      toAssistantClientEvent({
        event: 'error',
        data: { code: 'temporarily_unavailable', status: 503, retryable: true },
      }),
      toAssistantClientEvent({ event: 'done', data: { turnId: 'turn_1' } }),
    ];

    expect(events.map(summarizeKnownEvent)).toEqual([
      'hello',
      'call_1:list_leave',
      'book_leave',
      'Choose a team',
      'accept',
      'book_leave:true:replayed',
      'ui://leave/request',
      'temporarily_unavailable:503:true',
      'turn_1',
    ]);
  });

  it('maps malformed known payloads and unknown future event names to unrecognized', () => {
    expect(toAssistantClientEvent({ event: 'content', data: { delta: 42 } })).toEqual({
      event: 'unrecognized',
      data: { name: 'content', payload: { delta: 42 } },
    });
    expect(toAssistantClientEvent({ event: 'future_event', data: { additive: true } })).toEqual({
      event: 'unrecognized',
      data: { name: 'future_event', payload: { additive: true } },
    });
  });
});

function summarizeKnownEvent(event: AssistantClientEvent): string {
  switch (event.event) {
    case 'content':
      return event.data.delta;
    case 'tool_started':
      return `${event.data.id}:${event.data.tool}`;
    case 'tool_proposed':
      return event.data.tool;
    case 'input_requested':
      return event.data.message;
    case 'interaction_resolved':
      return event.data.action ?? 'accept';
    case 'tool_completed':
      return `${event.data.tool}:${String(
        typeof event.data.result === 'object' &&
          event.data.result !== null &&
          'ok' in event.data.result &&
          event.data.result.ok,
      )}${event.data.replayed ? ':replayed' : ''}`;
    case 'view_available':
      return event.data.resourceUri;
    case 'error':
      return `${event.data.code}:${event.data.status}:${event.data.retryable}`;
    case 'done':
      return event.data.turnId ?? '';
    default:
      return event.event;
  }
}
