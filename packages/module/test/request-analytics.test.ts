import { describe, expect, it } from 'vitest';
import {
  isRequestSurface,
  REQUEST_EVENT_SCHEMA_VERSION,
  REQUEST_SURFACES,
  type RequestEventInput,
} from '../src/index.js';

/**
 * The surface vocabulary is an allowlist, like every other field on the analytics event. It is
 * declared once here so a reader, a filter, and an emitter cannot drift into three spellings of
 * the same surface (ADR 0220 names `webmcp`; the plan names the other three).
 */
describe('request surface vocabulary', () => {
  it('is the closed set the stream is allowed to attribute a request to', () => {
    expect([...REQUEST_SURFACES]).toEqual([
      'mcp',
      'assistant-public',
      'assistant-authenticated',
      'webmcp',
    ]);
  });

  it('recognises exactly those values and nothing adjacent to them', () => {
    for (const surface of REQUEST_SURFACES) expect(isRequestSurface(surface)).toBe(true);
    // Near-misses a caller could plausibly send: the assistant's own internal vocabulary, the
    // deployment-facing spelling, and a casing variant.
    for (const near of ['public', 'authenticated', 'assistant', 'WebMCP', 'web-mcp', '']) {
      expect(isRequestSurface(near), near).toBe(false);
    }
  });

  it('carries the surface on the event input', () => {
    const event: RequestEventInput = {
      org: 'acme',
      requestId: 'req-1',
      sessionSource: 'none',
      subjectKind: 'anonymous',
      method: 'tools/call',
      kind: 'usage',
      outcome: 'ok',
      durationMs: 1,
      surface: 'webmcp',
    };
    expect(event.surface).toBe('webmcp');
  });

  it('bumps the stored schema version, because a reader must know the column can be there', () => {
    expect(REQUEST_EVENT_SCHEMA_VERSION).toBe(3);
  });
});
