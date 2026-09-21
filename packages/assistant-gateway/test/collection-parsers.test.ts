import { describe, expect, it } from 'vitest';
import { normaliseTypedValue, redactSpans, scanTypedValues } from '../src/collection-parsers.js';

describe('deterministic typed-control parsers', () => {
  it('finds one email, keeps the local part and lowercases only the domain', () => {
    const found = scanTypedValues('reach me at Maya.Chen@Example.COM please', ['email']);
    expect(found).toEqual([
      { control: 'email', value: 'Maya.Chen@example.com', start: 12, end: 33 },
    ]);
  });
  it('does not treat a cut-off address as an email', () => {
    expect(scanTypedValues('maya@example', ['email'])).toEqual([]);
  });
  it('reports every email candidate so the caller can mark ambiguity', () => {
    const found = scanTypedValues('either maya@example.com or m.chen@example.org', ['email']);
    expect(found.map((candidate) => candidate.value)).toEqual([
      'maya@example.com',
      'm.chen@example.org',
    ]);
  });
  it('normalises phones to + and digits, keeping a leading + only when typed', () => {
    expect(scanTypedValues('call (415) 555-0134 or +44 20 7946 0958', ['phone'])).toEqual([
      { control: 'phone', value: '4155550134', start: 5, end: 19 },
      { control: 'phone', value: '+442079460958', start: 23, end: 39 },
    ]);
    expect(scanTypedValues('we have 12 seats', ['phone'])).toEqual([]);
  });
  it('never reads digits inside an email or URL as a phone', () => {
    const found = scanTypedValues(
      'mail 20260920@example.com or see https://example.com/8005551234',
      ['email', 'url', 'phone'],
    );
    expect(found.map((candidate) => candidate.control)).toEqual(['email', 'url']);
  });
  it('normalises bare hosts to https and trims trailing punctuation from URLs', () => {
    expect(scanTypedValues('our site is maplelabs.example.', ['url'])).toEqual([
      { control: 'url', value: 'https://maplelabs.example', start: 12, end: 29 },
    ]);
    expect(scanTypedValues('see http://Maple.example/Path?x=1, thanks', ['url'])).toEqual([
      { control: 'url', value: 'http://maple.example/Path?x=1', start: 4, end: 33 },
    ]);
    expect(scanTypedValues('attached report.pdf and notes.docx', ['url'])).toEqual([]);
  });
  it('scans only the controls the spec declares', () => {
    expect(scanTypedValues('maplelabs.example and +1 415 555 0134', ['email'])).toEqual([]);
  });
  it('validates and normalises a whole model-returned value with the same rules', () => {
    expect(normaliseTypedValue('email', ' Maya@Example.com ')).toBe('Maya@example.com');
    expect(normaliseTypedValue('email', 'maya@example')).toBeUndefined();
    expect(normaliseTypedValue('email', 'a@b.co and c@d.co')).toBeUndefined();
    expect(normaliseTypedValue('phone', '+1 (415) 555-0134')).toBe('+14155550134');
    expect(normaliseTypedValue('phone', '12345')).toBeUndefined();
    expect(normaliseTypedValue('url', 'maplelabs.example/pricing')).toBe(
      'https://maplelabs.example/pricing',
    );
    expect(normaliseTypedValue('url', 'not a url')).toBeUndefined();
  });
  it('replaces spans with placeholders without touching the rest of the text', () => {
    const text = 'I am Maya, maya@example.com, site maplelabs.example';
    const spans = scanTypedValues(text, ['email', 'url']);
    expect(redactSpans(text, spans, (span) => `[${span.control} captured]`)).toBe(
      'I am Maya, [email captured], site [url captured]',
    );
  });
});
