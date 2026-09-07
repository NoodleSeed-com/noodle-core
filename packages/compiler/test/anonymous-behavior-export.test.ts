import { describe, expect, it } from 'vitest';
import { anonymousBehavior } from '../src/index.js';

/**
 * The elevation runtime needs this classification per tool call, so it has to be reachable from the
 * package surface rather than a manifest-internal module.
 *
 * It is deliberately **not** emitted into the artifact. The plan reserved a field so the gateway could
 * mark sign-in triggers "without re-deriving it", but re-deriving is a walk over one tool's fulfilment,
 * while a new `ArtifactTool` field is a Core artifact surface change under ADR 0150. The cheaper half of
 * that trade is the one that also avoids a versioned contract event.
 */

/** A parsed `${<root>.<segment>}` reference, the shape a compiled fulfilment actually carries. */
const path = (root: string, segment: string) => ({
  kind: 'path',
  root,
  segments: [{ kind: 'name', name: segment }],
});

const tool = (args: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({
    name: 'probe',
    description: 'Probe.',
    inputSchema: { type: 'object' },
    fulfilment: { kind: 'operation', connector: 'c', operation: 'o', args },
    ...extra,
  }) as never;

describe('anonymousBehavior is part of the compiler surface', () => {
  it('classifies a tool that reads no identity as public-safe', () => {
    expect(anonymousBehavior(tool({ id: path('input', 'id') }))).toBe('public-safe');
  });

  it('classifies a tool that reads ${user} as requires-identity', () => {
    expect(anonymousBehavior(tool({ id: path('user', 'id') }))).toBe('requires-identity');
  });

  it('classifies a tool that declares an authorization requirement as requires-identity', () => {
    expect(
      anonymousBehavior(
        tool({ id: path('input', 'id') }, { authorization: { requiredScopes: ['orders'] } }),
      ),
    ).toBe('requires-identity');
  });
});
