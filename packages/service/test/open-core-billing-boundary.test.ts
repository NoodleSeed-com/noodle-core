import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const serviceRoot = join(import.meta.dirname, '..');

describe('public service billing boundary', () => {
  it('contains no commercial billing or policy implementation clusters', () => {
    expect(existsSync(join(serviceRoot, 'src/billing'))).toBe(false);
    for (const file of [
      'src/commercial-plans.ts',
      'src/policy.ts',
      'src/policy-cache.ts',
      'src/policy-counters.ts',
      'src/policy-idempotency.ts',
    ]) {
      expect(existsSync(join(serviceRoot, file)), file).toBe(false);
    }
  });

  it('does not ship Stripe or expose hosted billing boot options', () => {
    const manifest = JSON.parse(readFileSync(join(serviceRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies).not.toHaveProperty('stripe');
    expect(readFileSync(join(serviceRoot, 'src/serve-options.ts'), 'utf8')).not.toMatch(
      /billingEnforcementMode|billingStripeConfig/,
    );
    expect(readFileSync(join(serviceRoot, 'src/options.ts'), 'utf8')).not.toMatch(
      /Billing|billing|CommercialPlan|PolicyAssignment|policyStore/,
    );
  });
});
