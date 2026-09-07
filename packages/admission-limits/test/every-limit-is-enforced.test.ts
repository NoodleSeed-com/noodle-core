import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADMISSION_DEFAULTS } from '../src/envelope.js';

/**
 * Every limit this envelope declares must have something that reads it.
 *
 * `envelope.ts` calls itself the single owner of the limits table, and an operator lowering a bound is
 * entitled to assume that means something. It did not: an audit found `toolCallsPerTurn` and
 * `turnsPerAddressHour` with no reader at all, `modelStepsPerTurn` and `confirmationTtlMs` enforced by
 * constants that happened to match, and `pendingInteractions` declaring 1 while the runtime allowed 8.
 * A declared bound nobody reads is worse than no bound, because it reads as protection in review.
 *
 * So each field names the file that enforces it, and the test checks that file actually mentions it.
 * Adding a field without wiring it fails here rather than in production.
 */

const repoRoot = join(import.meta.dirname, '..', '..', '..');

/** field -> the source file that consumes it. */
const ENFORCED_BY: Readonly<Record<keyof typeof ADMISSION_DEFAULTS, string>> = {
  messageCharacters: 'packages/assistant-gateway/src/public-turn.ts',
  turnsPerSession: 'packages/assistant-gateway/src/public-turn.ts',
  modelStepsPerTurn: 'packages/service/src/routes/assistant-agent.ts',
  toolCallsPerTurn: 'packages/service/src/routes/assistant-agent.ts',
  pendingInteractions: 'packages/assistant-gateway/src/postgres-assistant-interaction-writes.ts',
  confirmationTtlMs: 'packages/assistant-gateway/src/assistant-interactive.ts',
  sessionIdleMs: 'packages/service/src/routes/assistant-public-session.ts',
  sessionAbsoluteMs: 'packages/service/src/routes/assistant-public-session.ts',
  turnsPerDay: 'packages/assistant-gateway/src/public-turn.ts',
  mintsPerDay: 'packages/assistant-gateway/src/public-session.ts',
  mintsPerAddressHour: 'packages/assistant-gateway/src/public-session.ts',
  turnsPerAddressHour: 'packages/assistant-gateway/src/public-turn.ts',
  mintsPerVisitorHour: 'packages/assistant-gateway/src/public-session.ts',
  bridgeToolCallsPerSession: 'packages/assistant-gateway/src/public-turn.ts',
  bridgeToolCallsPerDay: 'packages/assistant-gateway/src/public-turn.ts',
};

describe('the admission envelope is the single owner of the limits table', () => {
  it('names an enforcer for every field it declares', () => {
    // A field added to the envelope and forgotten everywhere else fails here.
    expect(Object.keys(ENFORCED_BY).sort()).toEqual(Object.keys(ADMISSION_DEFAULTS).sort());
  });

  it('has an enforcer that actually reads each field', () => {
    const unread = Object.entries(ENFORCED_BY).filter(([field, file]) => {
      const source = readFileSync(join(repoRoot, file), 'utf8');
      return !source.includes(field);
    });

    expect(
      unread.map(([field, file]) => `${field} is not read by ${file}`),
      'a declared limit with no reader is not a limit',
    ).toEqual([]);
  });
});
