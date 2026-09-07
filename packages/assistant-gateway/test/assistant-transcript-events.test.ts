import { describe, expect, it } from 'vitest';
import { assistantTranscriptEvents } from '../src/assistant-transcript-events.js';

describe('assistant transcript events', () => {
  it('replays user/assistant pairs through ordinary message events', () => {
    expect(
      assistantTranscriptEvents({
        entries: [
          { role: 'user', text: 'What can you do?' },
          { role: 'assistant', text: 'I can map your first workflow.' },
          { role: 'user', text: 'Show my onboarding status' },
        ],
      }),
    ).toEqual([
      { event: 'message_started', data: { message: 'What can you do?' } },
      { event: 'content', data: { delta: 'I can map your first workflow.' } },
      { event: 'message_completed', data: {} },
      { event: 'message_started', data: { message: 'Show my onboarding status' } },
      { event: 'message_completed', data: {} },
      { event: 'done', data: {} },
    ]);
  });

  it('replays a leading assistant row without inventing a user bubble', () => {
    expect(
      assistantTranscriptEvents({ entries: [{ role: 'assistant', text: 'Welcome back.' }] }),
    ).toEqual([
      { event: 'resume_started', data: { tool: '' } },
      { event: 'content', data: { delta: 'Welcome back.' } },
      { event: 'message_completed', data: {} },
      { event: 'done', data: {} },
    ]);
  });

  it('appends only the server-selected latest view, pending interaction, and suggestions', () => {
    const events = assistantTranscriptEvents({
      entries: [],
      latestView: {
        id: 'call_1',
        tool: 'preview',
        resourceUri: 'ui://preview/card',
        result: { ok: true },
        html: '<!doctype html><main>Preview</main>',
        replayed: true,
      },
      pendingInteraction: {
        event: 'tool_proposed',
        data: { id: 'interaction_1', tool: 'finish_setup', requiresConfirmation: true },
      },
      suggestions: { phase: 'follow_up', prompts: ['Confirm setup'] },
    });
    expect(events.map((event) => event.event)).toEqual([
      'view_available',
      'tool_proposed',
      'suggested_prompts',
      'done',
    ]);
    expect(events).not.toContainEqual(expect.objectContaining({ event: 'auth_requested' }));
  });
});
