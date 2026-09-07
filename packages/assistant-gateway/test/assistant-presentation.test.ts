import { describe, expect, it } from 'vitest';
import {
  assistantArgumentReview,
  assistantConfirmationProposal,
  assistantConfirmationReview,
  assistantPreparedArgumentReview,
  assistantSafeOutput,
} from '../src/assistant-presentation.js';

const OBJECT_SCHEMA = {
  type: 'object',
  properties: {
    visible: { type: 'string' },
    privateNote: { type: 'string', writeOnly: true },
  },
} as const;

describe('assistant interaction presentation', () => {
  it.each([
    ['long strings', { visible: 'x'.repeat(2_049) }],
    [
      'too many properties',
      Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`key${index}`, index])),
    ],
    [
      'too many bytes',
      Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [`field_${index}`, 'x'.repeat(1_500)]),
      ),
    ],
    [
      'excessive nesting',
      { visible: { a: { b: { c: { d: { e: { f: { g: { h: 'hidden' } } } } } } } } },
    ],
  ])('rejects %s instead of presenting a lossy confirmation review', (_name, value) => {
    expect(assistantArgumentReview(OBJECT_SCHEMA, value)).toEqual({
      ok: false,
      code: 'arguments_not_presentable',
    });
  });

  it('allows deliberate schema redaction when the remainder is fully presentable', () => {
    expect(
      assistantArgumentReview(OBJECT_SCHEMA, {
        visible: 'review me',
        privateNote: 'server-side',
      }),
    ).toMatchObject({
      ok: true,
      value: { visible: 'review me', privateNote: '[REDACTED]' },
    });
  });

  it('keeps write-only and credential-shaped sentinels out of every browser review', () => {
    const writeOnlySentinel = 'WRITE_ONLY_CART_PAYLOAD_SENTINEL_7e4a';
    const schema = {
      type: 'object',
      properties: {
        cartName: { type: 'string' },
        cart_payload: { type: 'string', writeOnly: true },
      },
    } as const;
    const review = assistantArgumentReview(schema, {
      cartName: 'August order',
      cart_payload: writeOnlySentinel,
    });

    expect(review).toMatchObject({
      ok: true,
      value: { cartName: 'August order', cart_payload: '[REDACTED]' },
    });
    expect(JSON.stringify(review)).not.toContain(writeOnlySentinel);

    const credentialSentinel = 'Bearer abcdefghijklmnopqrstuvwxyz012345';
    expect(assistantArgumentReview(schema, { cartName: credentialSentinel })).toEqual({
      ok: false,
      code: 'arguments_not_presentable',
    });
    expect(
      assistantPreparedArgumentReview(schema, {
        input: { cartName: 'August order', cart_payload: writeOnlySentinel },
        action: {
          connectorId: 'shop',
          connectorVersion: '1.0.0',
          operation: 'create_cart',
          arguments: { cartName: credentialSentinel, cart_payload: writeOnlySentinel },
          inputSchema: schema,
          additionalOperationCount: 0,
        },
      }),
    ).toEqual({ ok: false, code: 'arguments_not_presentable' });
  });

  it('fails closed when an undeclared credential-shaped value would make the review inexact', () => {
    expect(
      assistantArgumentReview(OBJECT_SCHEMA, {
        visible: 'Bearer abcdefghijklmnopqrstuvwxyz012345',
      }),
    ).toEqual({ ok: false, code: 'arguments_not_presentable' });
  });

  it('preserves nested own __proto__ fields without mutating projection prototypes', () => {
    const schema = JSON.parse(`{
      "type": "object",
      "properties": {
        "payload": {
          "type": "object",
          "properties": {
            "__proto__": {
              "type": "object",
              "properties": { "approved": { "type": "boolean" } }
            }
          }
        }
      }
    }`) as Readonly<Record<string, unknown>>;
    const exactArguments = JSON.parse('{"payload":{"__proto__":{"approved":true}}}') as Readonly<
      Record<string, unknown>
    >;

    const review = assistantArgumentReview(schema, exactArguments);

    expect(review.ok).toBe(true);
    if (!review.ok) return;
    const root = review.value as Record<string, unknown>;
    const payload = root.payload as Record<string, unknown>;
    expect(Object.getPrototypeOf(root)).toBeNull();
    expect(Object.getPrototypeOf(payload)).toBeNull();
    expect(Object.hasOwn(payload, '__proto__')).toBe(true);
    expect(JSON.parse(JSON.stringify(root))).toEqual(exactArguments);
  });

  it('presents exact resolved connector arguments with tool and elicited context', () => {
    expect(
      assistantPreparedArgumentReview(OBJECT_SCHEMA, {
        input: { visible: 'next Thursday', privateNote: 'server-side' },
        elicited: { chooseTeam: { team: 'platform' } },
        action: {
          connectorId: 'leave',
          connectorVersion: '1.0.0',
          operation: 'submit',
          arguments: { visible: '2030-01-03', privateNote: 'server-side' },
          inputSchema: OBJECT_SCHEMA,
          additionalOperationCount: 1,
        },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        action: {
          connector: 'leave@1.0.0',
          operation: 'submit',
          arguments: { visible: '2030-01-03', privateNote: '[REDACTED]' },
          additionalOperationCount: 1,
        },
        toolInput: { visible: 'next Thursday', privateNote: '[REDACTED]' },
        elicited: { chooseTeam: { team: 'platform' } },
      },
    });
  });

  it('adds portable display metadata while preserving legacy proposal arguments', () => {
    const review = assistantArgumentReview(
      { type: 'object', properties: { visible: { type: 'string', title: 'Visible value' } } },
      { visible: 'review me' },
    );
    expect(review.ok).toBe(true);
    if (!review.ok) return;
    const stored = assistantConfirmationReview({
      title: 'Review change',
      description: 'This will update the visible value.',
      review,
    });
    expect(assistantConfirmationProposal(stored)).toEqual({
      title: 'Review change',
      description: 'This will update the visible value.',
      arguments: { visible: 'review me' },
      reviewSchema: {
        type: 'object',
        properties: { visible: { type: 'string', title: 'Visible value' } },
      },
    });
    expect(assistantConfirmationProposal({ visible: 'legacy' })).toEqual({
      arguments: { visible: 'legacy' },
    });
  });

  it('may safely truncate output because output is not an approval surface', () => {
    expect(assistantSafeOutput(OBJECT_SCHEMA, { visible: 'x'.repeat(2_049) })).toEqual({
      visible: `${'x'.repeat(2_048)}…[TRUNCATED]`,
    });
  });

  it('preserves the reported 156-item app result without truncation', () => {
    const markets = Array.from({ length: 156 }, (_, index) => ({
      id: `market-${index}`,
      label: `Market ${index}`,
    }));

    expect(
      assistantSafeOutput(
        {
          type: 'object',
          properties: {
            markets: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  label: { type: 'string' },
                },
              },
            },
          },
        },
        { markets },
      ),
    ).toEqual({ markets });
  });

  it('preserves 500 compact entries within the temporary presentation ceiling', () => {
    const entries = Array.from({ length: 500 }, (_, index) => ({ id: index }));

    expect(assistantSafeOutput(undefined, { entries })).toEqual({ entries });
  });

  it('preserves output larger than the previous 16 KiB presentation ceiling', () => {
    const output = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`field_${index}`, 'x'.repeat(1_500)]),
    );

    expect(assistantSafeOutput(undefined, output)).toEqual(output);
  });

  it('continues to omit output beyond the temporary 64 KiB ceiling', () => {
    const output = Object.fromEntries(
      Array.from({ length: 45 }, (_, index) => [`field_${index}`, 'x'.repeat(1_500)]),
    );

    expect(assistantSafeOutput(undefined, output)).toEqual({
      notice: '[OUTPUT OMITTED: exceeds 64 KiB]',
    });
  });

  it('removes widget-only result metadata before every model-visible projection', () => {
    expect(
      assistantSafeOutput(OBJECT_SCHEMA, {
        visible: 'safe result',
        __noodleResultMeta: { opaque: 'must-stay-widget-only' },
      }),
    ).toEqual({ visible: 'safe result' });
  });

  it.each([
    'Bearer abcdefghijklmnopqrstuvwxyz012345',
    'eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnop.qrstuvwxyz012345',
    ['sk', 'abcdefghijklmnopqrstuvwxyz012345'].join('-'),
  ])('redacts credential-shaped output under an innocuous key', (credential) => {
    expect(assistantSafeOutput(OBJECT_SCHEMA, { visible: credential })).toEqual({
      visible: '[REDACTED]',
    });
  });
});
