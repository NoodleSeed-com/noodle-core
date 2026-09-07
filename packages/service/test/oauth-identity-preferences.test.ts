import { describe, expect, it } from 'vitest';
import { isConsentClaims } from '../src/oauth/consent-claims.js';
import {
  canonicalOAuthIdentityPreferences,
  storedOAuthOwnerPreferences,
} from '../src/oauth/identity-preferences.js';

const REQUIRED_CONSENT = {
  kind: 'consent',
  clientId: 'client-1',
  redirectUri: 'https://client.example/callback',
  codeChallenge: 'challenge',
  resource: 'https://cloud.example/o/acme/app/mcp',
  ownerSubject: 'owner-1',
} as const;

describe('OAuth identity preferences', () => {
  it.each([
    {
      input: { locale: 'not a locale', timeZone: 'europe/london' },
      expected: { timeZone: 'Europe/London' },
    },
    {
      input: { locale: 'EN-gb', timeZone: 'Mars/Olympus' },
      expected: { locale: 'en-GB' },
    },
  ])('canonicalizes optional members independently', ({ input, expected }) => {
    expect(canonicalOAuthIdentityPreferences(input)).toEqual(expected);
  });

  it('maps only canonical preferences into durable owner fields', () => {
    expect(storedOAuthOwnerPreferences({ locale: 'fr-fr', timeZone: 'europe/paris' })).toEqual({
      ownerLocale: 'fr-FR',
      ownerTimeZone: 'Europe/Paris',
    });
  });

  it('fails closed on malformed or noncanonical preference claims in signed consent state', () => {
    expect(
      isConsentClaims({
        ...REQUIRED_CONSENT,
        ownerLocale: 'en-GB',
        ownerTimeZone: 'Europe/London',
      }),
    ).toBe(true);
    expect(isConsentClaims({ ...REQUIRED_CONSENT, ownerLocale: 'EN-gb' })).toBe(false);
    expect(isConsentClaims({ ...REQUIRED_CONSENT, ownerTimeZone: 'Mars/Olympus' })).toBe(false);
    expect(isConsentClaims({ ...REQUIRED_CONSENT, ownerLocale: 42 })).toBe(false);
  });

  it.each([
    [undefined, true],
    ['google', true],
    ['workos', true],
    ['github', false],
    ['customer', false],
    [[], false],
    [42, false],
  ])('validates rolling-compatible upstream provider provenance %j', (upstreamProvider, valid) => {
    expect(
      isConsentClaims({
        ...REQUIRED_CONSENT,
        ...(upstreamProvider === undefined ? {} : { upstreamProvider }),
      }),
    ).toBe(valid);
  });
});
