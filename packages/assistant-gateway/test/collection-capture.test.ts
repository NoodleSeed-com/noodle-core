import { describe, expect, it } from 'vitest';
import { capture } from '../src/collection-capture.js';
import { applyCapture, cancelCollection, rejectField } from '../src/collection-ledger.js';
import {
  binding,
  jsonFetcher,
  leadSpec,
  messageText,
  NOW,
  openLead,
} from './collection-fixture.js';

describe('natural collection capture', () => {
  it('captures a typed email by parser and the rest through one bounded model call', async () => {
    const { fetcher, requests } = jsonFetcher([
      {
        name: 'Maya Chen',
        company: 'Maple Labs',
        website: null,
        size: null,
        workflow: 'add WhatsApp to our website assistant',
      },
    ]);
    const ledger = await capture(
      leadSpec,
      openLead(),
      "Hi, I'm Maya Chen from Maple Labs, Maya@Example.com. We want to add WhatsApp to our website assistant.",
      { binding, fetcher },
      NOW + 1,
    );
    expect(ledger.values).toEqual({
      name: 'Maya Chen',
      email: 'Maya@example.com',
      company: 'Maple Labs',
      workflow: 'add WhatsApp to our website assistant',
    });
    expect(ledger.fields.email).toEqual({ status: 'captured', attempts: 1 });
    expect(ledger.fields.website?.status).toBe('missing');
    expect(ledger.phase).toBe('awaiting_consent');
    expect(fetcher).toHaveBeenCalledOnce();
    const [request] = requests;
    expect(request?.body).toMatchObject({ response_format: { type: 'json_object' }, tools: [] });
    expect(request?.messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(request?.messages[1]?.content).toBe(
      "Hi, I'm Maya Chen from Maple Labs, [email captured]. We want to add WhatsApp to our website assistant.",
    );
    expect(request?.messages[0]?.content).toContain('"name"');
    expect(request?.messages[0]?.content).toContain('"1-10"');
    expect(request?.messages[0]?.content).not.toContain('"email"');
    expect(messageText(requests)).not.toContain('Example.com');
  });
  it('makes no model call when the utterance is only a parsed value', async () => {
    const { fetcher } = jsonFetcher([]);
    const ledger = await capture(
      leadSpec,
      openLead(),
      ' maya@example.com ',
      { binding, fetcher },
      NOW,
    );
    expect(ledger.values).toEqual({ email: 'maya@example.com' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('marks a field ambiguous when two candidates compete and withholds both from the model', async () => {
    const { fetcher, requests } = jsonFetcher([{ name: 'Maya' }]);
    const ledger = await capture(
      leadSpec,
      openLead(),
      'I am Maya, use maya@example.com or m.chen@example.org',
      { binding, fetcher },
      NOW,
    );
    expect(ledger.fields.email).toEqual({
      status: 'ambiguous',
      reason: 'multiple_candidates',
      attempts: 1,
    });
    expect(ledger.values).toEqual({ name: 'Maya' });
    expect(requests[0]?.messages[1]?.content).toBe(
      'I am Maya, use [email withheld] or [email withheld]',
    );
    expect(messageText(requests)).not.toMatch(/example\.(com|org)/);
  });
  it('sends the current value of a rejected field so a partial correction can be applied', async () => {
    const stored = applyCapture(
      leadSpec,
      openLead(),
      {
        name: { status: 'captured', value: 'Maya Chen' },
        email: { status: 'captured', value: 'mia@example.com' },
        company: { status: 'captured', value: 'Maple Labs' },
        workflow: { status: 'captured', value: 'WhatsApp' },
      },
      NOW,
    );
    const rejected = rejectField(leadSpec, stored, 'email', NOW + 1);
    const { fetcher, requests } = jsonFetcher([{ email: 'maya@example.com' }]);
    const ledger = await capture(
      leadSpec,
      rejected,
      'maya with a y',
      { binding, fetcher },
      NOW + 2,
    );
    expect(requests[0]?.messages[0]?.content).toContain('mia@example.com');
    expect(requests[0]?.messages[0]?.content).not.toContain('Maya Chen');
    expect(ledger.values.email).toBe('maya@example.com');
    expect(ledger.fields.email).toEqual({ status: 'captured', attempts: 2 });
    expect(ledger.phase).toBe('awaiting_consent');
  });
  it('records a malformed model value as invalid with a reason code, never the value', async () => {
    const { fetcher } = jsonFetcher([{ email: 'maya@example', size: 'huge', name: '' }]);
    const ledger = await capture(
      leadSpec,
      openLead(),
      'maya@example, we are huge',
      { binding, fetcher },
      NOW,
    );
    expect(ledger.fields.email).toEqual({ status: 'invalid', reason: 'format', attempts: 1 });
    expect(ledger.fields.size).toEqual({ status: 'invalid', reason: 'option', attempts: 1 });
    expect(ledger.fields.name).toEqual({ status: 'invalid', reason: 'schema', attempts: 1 });
    expect(ledger.values).toEqual({});
  });
  it('accepts a select option case-insensitively and ignores keys it did not ask for', async () => {
    const { fetcher } = jsonFetcher([{ size: '11-50', consent: true, unknown: 'x', website: 42 }]);
    const ledger = await capture(
      leadSpec,
      openLead(),
      'about forty people',
      { binding, fetcher },
      NOW,
    );
    expect(ledger.values).toEqual({ size: '11-50' });
    expect(ledger.fields.website).toEqual({ status: 'invalid', reason: 'format', attempts: 1 });
    expect(ledger.fields.consent?.status).toBe('missing');
  });
  it('treats unparseable model output as no extraction', async () => {
    const { fetcher } = jsonFetcher(['not json']);
    const ledger = await capture(leadSpec, openLead(), 'hello there', { binding, fetcher }, NOW);
    expect(ledger.values).toEqual({});
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('refuses to capture into a closed collection', async () => {
    const { fetcher } = jsonFetcher([]);
    await expect(
      capture(
        leadSpec,
        cancelCollection(openLead(), NOW),
        'maya@example.com',
        { binding, fetcher },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'phase_invalid' });
  });
});
