import { describe, expect, it } from 'vitest';
import { annotations } from '../src/index.js';

describe('action confirmation annotations', () => {
  it('keeps confirmation an explicit opt-in', () => {
    expect(annotations.action()).not.toHaveProperty('confirm');
    expect(annotations.localAction()).not.toHaveProperty('confirm');
    expect(annotations.openAction()).not.toHaveProperty('confirm');
  });

  it('declares an enforced confirmation contract explicitly', () => {
    expect(annotations.action({ confirm: true })).toMatchObject({
      confirm: true,
      readOnlyHint: false,
    });
  });

  it('allows an explicit false without changing the standard MCP action hints', () => {
    expect(annotations.action({ confirm: false })).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
      confirm: false,
    });
  });

  it('does not add a confirmation annotation to read-only tools', () => {
    expect(annotations.readOnly()).not.toHaveProperty('confirm');
  });
});
