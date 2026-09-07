import { describe, expect, it } from 'vitest';
import { InMemorySearchBudgetStore, SearchBudgetExhaustedError } from '../src/budget.js';
import { describeSearchBudgetStore } from './budget-parity.js';

describe('in-memory tenant search budget', () => {
  describeSearchBudgetStore(async (now) => new InMemorySearchBudgetStore(now));

  it('exhaustion error names the org and both counters', async () => {
    const store = new InMemorySearchBudgetStore();
    await store.consume({ org: 'acme', app: 'site' }, 90, { org: 100, app: 100 });
    const refused = await store.consume({ org: 'acme', app: 'site' }, 20, { org: 100, app: 100 });
    expect(refused.granted).toBe(false);
    const exhausted = new SearchBudgetExhaustedError(refused.state);
    expect(exhausted.message).toContain('acme');
    expect(exhausted.message).toContain('90/100');
  });
});
