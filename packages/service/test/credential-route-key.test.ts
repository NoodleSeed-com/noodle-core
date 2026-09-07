import { describe, expect, it } from 'vitest';
import { copyCustomerRouteBinding, routeBoundCredentialKey } from '../src/credential-route-key.js';

const fingerprintA = `sha256:${'a'.repeat(64)}`;
const fingerprintB = `sha256:${'b'.repeat(64)}`;

describe('credential route cache identities', () => {
  it('isolates endpoint keys and fingerprints while excluding extra route fields', () => {
    const base = 'tenant\u0000connector\u0000operation';
    const routeWithUrl = {
      key: 'customer_api',
      fingerprint: fingerprintA,
      baseUrl: 'https://tenant.example/private',
    };
    const keyA = routeBoundCredentialKey(base, routeWithUrl);
    const keyB = routeBoundCredentialKey(base, {
      key: 'billing_api',
      fingerprint: fingerprintA,
    });
    const fingerprintKey = routeBoundCredentialKey(base, {
      key: 'customer_api',
      fingerprint: fingerprintB,
    });

    expect(keyA).not.toBe(keyB);
    expect(keyA).not.toBe(fingerprintKey);
    expect(keyB).not.toBe(fingerprintKey);
    expect(keyA).not.toContain('tenant.example');
  });

  it('copies only the URL-blind route binding fields', () => {
    const copied = copyCustomerRouteBinding({
      key: 'customer_api',
      fingerprint: fingerprintA,
      baseUrl: 'https://tenant.example/private',
    });

    expect(copied).toEqual({ key: 'customer_api', fingerprint: fingerprintA });
    expect(copied).not.toHaveProperty('baseUrl');
    expect(Object.isFrozen(copied)).toBe(true);
  });
});
