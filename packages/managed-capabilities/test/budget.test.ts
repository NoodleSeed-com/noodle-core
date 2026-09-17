import { describe, expect, it } from 'vitest';
import { CapabilityBudget } from '../src/budget.js';

describe('trusted continuation budget', () => {
  it('retains spent limits and opaque URL identity across server-held suspension', () => {
    const budget = new CapabilityBudget();
    budget.reserve(['https://example.com/private-path'], { maxCalls: 1 });
    budget.beforeRequest();
    budget.text('Evidence', 256);
    const snapshot = budget.snapshot();
    expect(JSON.stringify(snapshot)).not.toContain('example.com');
    expect(JSON.stringify(snapshot)).not.toContain('Evidence');
    const resumed = new CapabilityBudget(JSON.parse(JSON.stringify(snapshot)));
    expect(() => resumed.reserve(['https://example.com/private-path'], {})).toThrow(
      'capability_budget_exhausted',
    );
    expect(resumed.snapshot()).toMatchObject({ attempts: 1, bytes: 8, calls: 1 });
  });
  it('cannot restart the deadline after a human pause', () => {
    const budget = new CapabilityBudget();
    budget.reserve(['https://example.com/'], {});
    const resumed = new CapabilityBudget({ ...budget.snapshot(), startedAt: Date.now() - 31_000 });
    expect(() => resumed.reserve(['https://example.com/'], {})).toThrow(
      'capability_budget_exhausted',
    );
  });
});
