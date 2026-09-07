import { describe, expect, it } from 'vitest';
import { visibleTranscript } from '../src/assistant-transcript.js';

describe('the bounded visible-transcript projection', () => {
  it('projects only rows explicitly tagged visible, in order', () => {
    const entries = visibleTranscript([
      { role: 'user', content: 'What can you do?', kind: 'visible' },
      { role: 'assistant', content: 'I can map your first workflow.', kind: 'visible' },
      // Model-facing scaffolding, carrying tool output the panel never saw.
      { role: 'assistant', content: 'Completed submit_lead: {"crmId":"c_1"}', kind: 'narration' },
      // The [platform] resume prompt the visitor never typed.
      { role: 'user', content: '[platform] The visitor has just signed in…', kind: 'narration' },
      { role: 'assistant', content: 'Here are your orders.', kind: 'visible' },
    ]);

    expect(entries).toEqual([
      { role: 'user', text: 'What can you do?' },
      { role: 'assistant', text: 'I can map your first workflow.' },
      { role: 'assistant', text: 'Here are your orders.' },
    ]);
  });

  it('fails closed on untagged legacy rows: they cannot prove they were visible', () => {
    expect(
      visibleTranscript([
        { role: 'user', content: 'typed before the tagging existed' },
        { role: 'assistant', content: 'Completed tool: {"secretish":"output"}' },
      ]),
    ).toEqual([]);
  });
});
