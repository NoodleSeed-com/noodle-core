// @vitest-environment happy-dom
/// <reference lib="dom" />
import { beforeEach, describe, expect, it } from 'vitest';
import { globalToolResult, type ToolResult } from '../src/react/bridge.js';

describe('React tool result fallback', () => {
  beforeEach(() => {
    const globals = globalThis as Record<string, unknown>;
    delete globals.__noodleToolResult;
    delete globals.__noodleData;
  });

  it('reports an empty envelope before a canonical result exists', () => {
    expect(globalToolResult()).toEqual({});
  });

  it('returns the complete canonical result unchanged', () => {
    const result: ToolResult = {
      content: [{ type: 'text', text: 'Unable to load the order' }],
      structuredContent: {},
      _meta: { retryable: true },
      isError: true,
    };
    (globalThis as { __noodleToolResult?: ToolResult }).__noodleToolResult = result;

    expect(globalToolResult()).toBe(result);
  });
});
