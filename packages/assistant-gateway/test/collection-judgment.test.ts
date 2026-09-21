import { describe, expect, it } from 'vitest';
import {
  CONFIRM_THRESHOLD,
  CONSENT_THRESHOLD,
  confirmationReply,
  consentReply,
  normaliseReply,
} from '../src/collection-judgment.js';
import { binding, jsonFetcher, leadSpec, messageText } from './collection-fixture.js';

const values = ['Maya Chen', 'maya@example.com', 'Maple Labs', 'Add WhatsApp'];

describe('consent replies', () => {
  it('exports the two thresholds with confirmation stricter than consent', () => {
    expect(CONSENT_THRESHOLD).toBe(0.85);
    expect(CONFIRM_THRESHOLD).toBe(0.95);
    expect(CONFIRM_THRESHOLD).toBeGreaterThan(CONSENT_THRESHOLD);
  });
  it('normalises case, whitespace and trailing punctuation', () => {
    expect(normaliseReply('  Yes!! ')).toBe('yes');
    expect(normaliseReply('Never   mind...')).toBe('never mind');
    expect(normaliseReply('Don’t')).toBe("don't");
  });
  it('matches exact yes and no without a model call', async () => {
    const { fetcher } = jsonFetcher([]);
    expect(await consentReply('Yes.', leadSpec, { binding, fetcher })).toBe('given');
    expect(await consentReply('no', leadSpec, { binding, fetcher })).toBe('declined');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('accepts an affirmative judgment at or above the consent threshold', async () => {
    const { fetcher, requests } = jsonFetcher([{ affirmative: true, confidence: 0.97 }]);
    expect(await consentReply('sure, go ahead', leadSpec, { binding, fetcher })).toBe('given');
    expect(fetcher).toHaveBeenCalledOnce();
    const [request] = requests;
    expect(request?.body).toMatchObject({ response_format: { type: 'json_object' }, tools: [] });
    expect(request?.messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(request?.messages[0]?.content).toContain(leadSpec.consentQuestion);
    expect(request?.messages[1]?.content).toBe('sure, go ahead');
  });
  it('returns unclear below the threshold and declined on a confident negative', async () => {
    const low = jsonFetcher([{ affirmative: true, confidence: 0.6 }]);
    expect(
      await consentReply('I guess, depends', leadSpec, { binding, fetcher: low.fetcher }),
    ).toBe('unclear');
    const negative = jsonFetcher([{ affirmative: false, confidence: 0.9 }]);
    expect(
      await consentReply("I'd rather you didn't", leadSpec, { binding, fetcher: negative.fetcher }),
    ).toBe('declined');
    const malformed = jsonFetcher(['{"affirmative":"yes"}']);
    expect(await consentReply('maybe', leadSpec, { binding, fetcher: malformed.fetcher })).toBe(
      'unclear',
    );
  });
});

describe('confirmation replies', () => {
  it('confirms exact affirmatives and cancels exact negatives without a model call', async () => {
    const { fetcher } = jsonFetcher([]);
    for (const text of ['okay', 'Yes', 'Send it!', 'go ahead', 'looks good', 'y'])
      expect(await confirmationReply(text, leadSpec, { binding, fetcher })).toBe('confirm');
    for (const text of ['no', 'Never mind', "don't", 'cancel', 'forget it'])
      expect(await confirmationReply(text, leadSpec, { binding, fetcher })).toBe('cancel');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('treats any reply carrying a value or a correction as an edit, never a confirmation', async () => {
    const { fetcher } = jsonFetcher([]);
    expect(
      await confirmationReply('yes but change the company to Maple Labs Ltd', leadSpec, {
        binding,
        fetcher,
      }),
    ).toBe('edit');
    expect(await confirmationReply('yes, maya@other.com', leadSpec, { binding, fetcher })).toBe(
      'edit',
    );
    expect(
      await confirmationReply('ok, my website is maplelabs.example', leadSpec, {
        binding,
        fetcher,
      }),
    ).toBe('edit');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('confirms a judged affirmative only above the confirmation threshold', async () => {
    const high = jsonFetcher([{ affirmative: true, confidence: 0.97 }]);
    expect(
      await confirmationReply('I think so', leadSpec, { binding, fetcher: high.fetcher }),
    ).toBe('confirm');
    const [request] = high.requests;
    expect(request?.messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(request?.messages[1]?.content).toBe('I think so');
    for (const value of values) expect(messageText(high.requests)).not.toContain(value);
    const mid = jsonFetcher([{ affirmative: true, confidence: 0.9 }]);
    expect(await confirmationReply('I think so', leadSpec, { binding, fetcher: mid.fetcher })).toBe(
      'unclear',
    );
    const negative = jsonFetcher([{ affirmative: false, confidence: 0.99 }]);
    expect(
      await confirmationReply('hmm not really', leadSpec, { binding, fetcher: negative.fetcher }),
    ).toBe('unclear');
  });
  it('never places a field value in a judgment request', async () => {
    const { fetcher, requests } = jsonFetcher([
      { affirmative: true, confidence: 0.99 },
      { affirmative: true, confidence: 0.99 },
    ]);
    await consentReply('absolutely', leadSpec, { binding, fetcher });
    await confirmationReply('absolutely', leadSpec, { binding, fetcher });
    const text = messageText(requests);
    for (const value of values) expect(text).not.toContain(value);
    expect(text).not.toContain('Name:');
  });
});
