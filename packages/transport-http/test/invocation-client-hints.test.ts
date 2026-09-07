import { describe, expect, it } from 'vitest';
import { invocationClientHint } from '../src/invocation-client-hints.js';

function toolCall(location: unknown) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'nearby',
      arguments: {},
      _meta: { 'openai/userLocation': location },
    },
  };
}

describe('invocation client hints', () => {
  it.each([
    { latitude: 91, longitude: 0 },
    { latitude: 0, longitude: -181 },
    { latitude: Number.NaN, longitude: 0 },
    { latitude: 43.6 },
    { longitude: -79.3 },
    { latitude: '43.6', longitude: '-79.3' },
    null,
  ])('drops malformed or partial coordinates without rejecting the request', (location) => {
    expect(invocationClientHint(toolCall(location))).toBeUndefined();
  });

  it('drops a location hint when executable calls in one batch disagree', () => {
    expect(
      invocationClientHint([
        toolCall({ latitude: 43.6532, longitude: -79.3832 }),
        { ...toolCall({ latitude: 49.2827, longitude: -123.1207 }), id: 2 },
      ]),
    ).toBeUndefined();
  });

  it('does not copy a hint across another executable call that omitted it', () => {
    expect(
      invocationClientHint([
        toolCall({ latitude: 43.6532, longitude: -79.3832 }),
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'nearby', arguments: {} },
        },
      ]),
    ).toBeUndefined();
  });
});
