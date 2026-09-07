import { describe, expect, it } from 'vitest';
import { serviceFailure } from '../src/commands/shared.js';
import { ServiceRequestError } from '../src/control-plane.js';

describe('production-capacity service failures', () => {
  it.each([
    'production_app_limit_exceeded',
    'billing_enforcement_unavailable',
  ] as const)('preserves the machine-readable %s code', (code) => {
    const failure = serviceFailure(
      'restore',
      new ServiceRequestError({
        status: code === 'production_app_limit_exceeded' ? 409 : 503,
        code,
        message: code,
      }),
      'noodle billing org inspect acme',
    );

    expect(failure.code).toBe(code);
    expect(failure.exitCode).toBe(1);
    expect(failure.next).toBe('noodle billing org inspect acme');
    if (code === 'billing_enforcement_unavailable') {
      expect(failure.fix).toContain('do not bypass');
    }
  });
});
