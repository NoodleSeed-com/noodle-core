import { expect, it } from 'vitest';
import { isIdentityAccessMode } from '../src/deployment-access-mode.js';

it('requires an HTTP deploy identity for mixed customer auth in YAML and JSON', () => {
  expect(
    isIdentityAccessMode('mixed', 'server:\n  auth:\n    issuer: https://customer.example'),
  ).toBe(true);
  expect(
    isIdentityAccessMode(
      'mixed',
      JSON.stringify({ server: { auth: { kind: 'bridge', provider: 'firebase' } } }),
    ),
  ).toBe(true);
  expect(isIdentityAccessMode('mixed', 'server:\n  name: public')).toBe(false);
  expect(isIdentityAccessMode('public', 'server:\n  auth: {}')).toBe(false);
});
