import { describe, expect, it } from 'vitest';
import {
  extractIntentCapture,
  INTENT_ARGUMENT_NAME,
  projectIntentCaptureInput,
} from '../src/intent-capture.js';

describe('intent capture protocol adapter', () => {
  const inputSchema = {
    type: 'object',
    properties: { order_id: { type: 'string' } },
    required: ['order_id'],
    additionalProperties: false,
  } as const;

  it('projects an optional, closed intent envelope without mutating the authored schema', () => {
    const projected = projectIntentCaptureInput(inputSchema, true);

    expect(projected).not.toBe(inputSchema);
    expect(projected.required).toEqual(['order_id']);
    expect(projected.properties).toHaveProperty(INTENT_ARGUMENT_NAME);
    expect(inputSchema.properties).not.toHaveProperty(INTENT_ARGUMENT_NAME);
  });

  it('strips valid intent before customer validation and returns a bounded normalized value', () => {
    const extracted = extractIntentCapture(
      {
        order_id: 'A1',
        [INTENT_ARGUMENT_NAME]: {
          category: 'support',
          match: 'partial',
          goal: '  Find out why my order has not arrived.  ',
        },
      },
      { enabled: true, eligible: true },
    );

    expect(extracted.arguments).toEqual({ order_id: 'A1' });
    expect(extracted.intent).toEqual({
      category: 'support',
      match: 'partial',
      goal: 'Find out why my order has not arrived.',
    });
  });

  it('still strips a stale host envelope when capture has been disabled', () => {
    const extracted = extractIntentCapture(
      { order_id: 'A1', [INTENT_ARGUMENT_NAME]: { category: 'support' } },
      { enabled: false, eligible: true },
    );

    expect(extracted).toEqual({ arguments: { order_id: 'A1' } });
  });

  it('discards malformed or sensitive envelopes without blocking the tool call', () => {
    for (const intent of [
      { category: 'invented', match: 'direct', goal: 'A normal goal' },
      { category: 'support', match: 'direct', goal: 'Email me at person@example.com' },
      { category: 'support', match: 'direct', goal: 'x'.repeat(161) },
    ]) {
      expect(
        extractIntentCapture(
          { order_id: 'A1', [INTENT_ARGUMENT_NAME]: intent },
          { enabled: true, eligible: true },
        ),
      ).toEqual({ arguments: { order_id: 'A1' } });
    }
  });

  it('preserves developer-owned collisions instead of interpreting them as platform metadata', () => {
    const collidingSchema = {
      ...inputSchema,
      properties: {
        ...inputSchema.properties,
        [INTENT_ARGUMENT_NAME]: { type: 'string' },
      },
    };

    expect(projectIntentCaptureInput(collidingSchema, true)).toBe(collidingSchema);
    expect(
      extractIntentCapture(
        { order_id: 'A1', [INTENT_ARGUMENT_NAME]: 'developer value' },
        { enabled: true, eligible: false },
      ),
    ).toEqual({
      arguments: { order_id: 'A1', [INTENT_ARGUMENT_NAME]: 'developer value' },
    });
  });
});
