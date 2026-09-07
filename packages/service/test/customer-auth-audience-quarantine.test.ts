import { noopLogger } from '@noodle-borg/transport-http';
import { describe, expect, it } from 'vitest';
import { warnCustomerAuthAudienceQuarantine } from '../src/customer-auth-audience-quarantine.js';

describe('customer auth audience quarantine observability', () => {
  it('does not warn when reconciliation found no quarantined boundaries', () => {
    const warnings: unknown[] = [];

    warnCustomerAuthAudienceQuarantine(
      { ...noopLogger, warn: (event, fields) => warnings.push({ event, fields }) },
      { invalidBoundaries: 0, conflictingBindings: 0, conflictingBoundaries: 0 },
    );

    expect(warnings).toEqual([]);
  });

  it('warns with aggregate counts and no customer identifiers', () => {
    const warnings: unknown[] = [];

    warnCustomerAuthAudienceQuarantine(
      { ...noopLogger, warn: (event, fields) => warnings.push({ event, fields }) },
      { invalidBoundaries: 3, conflictingBindings: 2, conflictingBoundaries: 4 },
    );

    expect(warnings).toEqual([
      {
        event: 'customer_auth.audience_quarantine',
        fields: {
          invalidBoundaries: 3,
          conflictingBindings: 2,
          conflictingBoundaries: 4,
        },
      },
    ]);
  });
});
