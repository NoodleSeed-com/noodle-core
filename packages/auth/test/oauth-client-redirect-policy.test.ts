import { describe, expect, it } from 'vitest';
import {
  classifyStoredOAuthRedirectPolicy,
  matchOAuthAuthorizationRedirect,
  normalizeOAuthClientMetadata,
  OAuthRedirectPolicyError,
} from '../src/index.js';

describe('OAuth client redirect metadata normalization', () => {
  it('defaults omitted application type to web and token authentication to client_secret_post', () => {
    expect(
      normalizeOAuthClientMetadata({ redirect_uris: ['https://client.example.test/callback'] }),
    ).toEqual({
      application_type: 'web',
      redirect_uris: ['https://client.example.test/callback'],
      token_endpoint_auth_method: 'client_secret_post',
      noodle_redirect_policy_version: 1,
    });
  });

  it.each([
    'none',
    'client_secret_post',
  ] as const)('accepts the supported %s token endpoint authentication method', (tokenEndpointAuthMethod) => {
    expect(
      normalizeOAuthClientMetadata({
        redirect_uris: ['https://client.example.test/callback'],
        token_endpoint_auth_method: tokenEndpointAuthMethod,
      }),
    ).toMatchObject({ token_endpoint_auth_method: tokenEndpointAuthMethod });
  });

  it('rejects unsupported token endpoint authentication methods without echoing metadata values', () => {
    expect(() =>
      normalizeOAuthClientMetadata({
        redirect_uris: ['https://client.example.test/callback'],
        token_endpoint_auth_method: 'client_secret_basic',
      }),
    ).toThrow(OAuthRedirectPolicyError);

    try {
      normalizeOAuthClientMetadata({
        redirect_uris: ['https://client.example.test/callback'],
        token_endpoint_auth_method: 'client_secret_basic',
      });
    } catch (error) {
      expect(error).toMatchObject({ reason: 'unsupported_token_endpoint_auth_method' });
      expect(error).not.toHaveProperty('metadata');
      expect(String(error)).not.toContain('client_secret_basic');
    }
  });

  it('accepts only HTTPS redirects for an explicit web client', () => {
    expect(
      normalizeOAuthClientMetadata({
        application_type: 'web',
        redirect_uris: ['https://client.example.test/callback'],
      }),
    ).toMatchObject({ application_type: 'web' });

    expectPolicyFailure({
      application_type: 'web',
      redirect_uris: ['http://127.0.0.1:49152/callback'],
    });
  });

  it('accepts HTTPS and the permitted HTTP loopback hosts for an explicit native client', () => {
    expect(
      normalizeOAuthClientMetadata({
        application_type: 'native',
        redirect_uris: [
          'https://client.example.test/callback',
          'http://127.0.0.1:49152/callback',
          'http://[::1]:49153/callback',
          'http://localhost:49154/callback',
        ],
      }),
    ).toMatchObject({ application_type: 'native' });
  });

  it('normalizes an omitted-type loopback registration to web and preserves its exact port', () => {
    const client = normalizeOAuthClientMetadata({
      redirect_uris: ['http://127.0.0.1:49152/callback'],
    });

    expect(client.application_type).toBe('web');
    expect(
      matchOAuthAuthorizationRedirect({
        client,
        requestedRedirectUri: 'http://127.0.0.1:49153/callback',
        allowLegacyLoopbackPortSubstitution: true,
      }),
    ).toEqual({
      allowed: false,
      usedLegacyLoopbackPortSubstitution: false,
      reason: 'unregistered_redirect',
    });
  });

  it('marks an omitted-type loopback registration as server-normalized despite client marker input', () => {
    const normalized = normalizeOAuthClientMetadata({
      redirect_uris: ['http://127.0.0.1:49152/callback'],
      noodle_redirect_policy_version: 99,
    });

    expect(normalized).toMatchObject({
      application_type: 'web',
      noodle_redirect_policy_version: 1,
    });
    expect(classifyStoredOAuthRedirectPolicy(normalized)).toBe('normalized');
  });

  it.each([
    'com.example.client:/callback',
    'http://client.example.test/callback',
    'https://user:password@client.example.test/callback',
    'https://client.example.test/callback#fragment',
    'https://client.example.test/callback#',
    'not a URI',
  ])('rejects an unsafe redirect channel without echoing the URI', (redirectUri) => {
    expectPolicyFailure({ redirect_uris: [redirectUri] }, redirectUri);
  });

  it.each([
    'http://127.1:49152/callback',
    'http://2130706433:49152/callback',
    'http://0x7f000001:49152/callback',
    'http://loopback-only.example.test:49152/callback',
  ])('rejects alternate or resolver-only loopback host spellings', (redirectUri) => {
    expectPolicyFailure({ application_type: 'native', redirect_uris: [redirectUri] }, redirectUri);
  });

  it.each([
    ['omitted-type', undefined, 'http://attacker.example.test\\@localhost/callback'],
    ['native IPv4', 'native', 'http://attacker.example.test\\@127.0.0.1/callback'],
    ['native IPv6 alternate', 'native', 'http://attacker.example.test\\\\@[::1]/callback'],
  ] as const)('rejects %s registrations whose raw loopback suffix disagrees with the effective URL host', (_case, applicationType, redirectUri) => {
    expectPolicyFailure(
      { application_type: applicationType, redirect_uris: [redirectUri] },
      redirectUri,
    );
  });

  it('rejects empty and mixed safe/unsafe redirect lists atomically', () => {
    expectPolicyFailure({ redirect_uris: [] });
    expectPolicyFailure({
      application_type: 'native',
      redirect_uris: [
        'https://client.example.test/callback',
        'http://client.example.test/callback',
      ],
    });
  });
});

describe('OAuth authorization redirect matching', () => {
  it('requires an exact match for web redirects, including their port', () => {
    const client = {
      application_type: 'web',
      redirect_uris: ['https://client.example.test:9443/callback?flow=login'],
    };

    expect(
      matchOAuthAuthorizationRedirect({
        client,
        requestedRedirectUri: 'https://client.example.test:9444/callback?flow=login',
        allowLegacyLoopbackPortSubstitution: true,
      }),
    ).toMatchObject({ allowed: false, reason: 'unregistered_redirect' });
  });

  it.each([
    'https://client.example.test:9443/other?flow=login',
    'https://client.example.test:9443/callback?flow=logout',
    'https://client.example.test:9443/callback/?flow=login',
  ])('requires web redirect path, query, and trailing slash exactness', (requestedRedirectUri) => {
    expect(
      matchOAuthAuthorizationRedirect({
        client: {
          application_type: 'web',
          redirect_uris: ['https://client.example.test:9443/callback?flow=login'],
        },
        requestedRedirectUri,
        allowLegacyLoopbackPortSubstitution: true,
      }),
    ).toMatchObject({ allowed: false, reason: 'unregistered_redirect' });
  });

  it('allows an explicit native client to vary only the permitted loopback port', () => {
    const client = {
      application_type: 'native',
      redirect_uris: ['http://[::1]:49152/callback?flow=login'],
    };

    expect(
      matchOAuthAuthorizationRedirect({
        client,
        requestedRedirectUri: 'http://[::1]:49153/callback?flow=login',
        allowLegacyLoopbackPortSubstitution: false,
      }),
    ).toEqual({
      allowed: true,
      usedLegacyLoopbackPortSubstitution: false,
      reason: 'native_loopback_port_match',
    });
    expect(
      matchOAuthAuthorizationRedirect({
        client,
        requestedRedirectUri: 'http://[::1]:49153/other?flow=login',
        allowLegacyLoopbackPortSubstitution: false,
      }),
    ).toMatchObject({ allowed: false, reason: 'unregistered_redirect' });
    expect(
      matchOAuthAuthorizationRedirect({
        client,
        requestedRedirectUri: 'http://localhost:49153/callback?flow=login',
        allowLegacyLoopbackPortSubstitution: false,
      }),
    ).toMatchObject({ allowed: false, reason: 'unregistered_redirect' });
    expect(
      matchOAuthAuthorizationRedirect({
        client,
        requestedRedirectUri: 'http://[::1]:49153/callback?flow=logout',
        allowLegacyLoopbackPortSubstitution: false,
      }),
    ).toMatchObject({ allowed: false, reason: 'unregistered_redirect' });
    expect(
      matchOAuthAuthorizationRedirect({
        client,
        requestedRedirectUri: 'https://[::1]:49153/callback?flow=login',
        allowLegacyLoopbackPortSubstitution: false,
      }),
    ).toMatchObject({ allowed: false, reason: 'unregistered_redirect' });
  });

  it('requires exact matching for a native HTTPS redirect', () => {
    const client = {
      application_type: 'native',
      redirect_uris: ['https://client.example.test:9443/callback?flow=login'],
    };

    expect(
      matchOAuthAuthorizationRedirect({
        client,
        requestedRedirectUri: 'https://client.example.test:9443/callback?flow=login',
        allowLegacyLoopbackPortSubstitution: false,
      }),
    ).toMatchObject({ allowed: true, reason: 'exact_match' });
    expect(
      matchOAuthAuthorizationRedirect({
        client,
        requestedRedirectUri: 'https://client.example.test:9444/callback?flow=login',
        allowLegacyLoopbackPortSubstitution: false,
      }),
    ).toMatchObject({ allowed: false, reason: 'unregistered_redirect' });
  });

  it('classifies valid explicit-type records as normalized and does not use a legacy relaxation', () => {
    const client = {
      application_type: 'native',
      redirect_uris: ['http://localhost:49152/callback'],
    };

    expect(classifyStoredOAuthRedirectPolicy(client)).toBe('normalized');
    expect(
      matchOAuthAuthorizationRedirect({
        client,
        requestedRedirectUri: 'http://localhost:49153/callback',
        allowLegacyLoopbackPortSubstitution: true,
      }),
    ).toEqual({
      allowed: true,
      usedLegacyLoopbackPortSubstitution: false,
      reason: 'native_loopback_port_match',
    });
  });
});

describe('stored OAuth redirect policy classification', () => {
  it('classifies omitted-type HTTPS records as safe_https', () => {
    expect(
      classifyStoredOAuthRedirectPolicy({
        redirect_uris: ['https://client.example.test/callback'],
      }),
    ).toBe('safe_https');
  });

  it('classifies omitted-type permitted loopback records as safe_loopback_legacy', () => {
    expect(
      classifyStoredOAuthRedirectPolicy({
        redirect_uris: ['http://127.0.0.1:49152/callback'],
      }),
    ).toBe('safe_loopback_legacy');
  });

  it.each([
    [
      'web loopback',
      { application_type: 'web', redirect_uris: ['http://127.0.0.1:49152/callback'] },
    ],
    [
      'web mixed HTTPS and loopback',
      {
        application_type: 'web',
        redirect_uris: ['https://client.example.test/callback', 'http://127.0.0.1:49152/callback'],
      },
    ],
  ])('classifies an explicit %s record with loopback HTTP as unsafe_legacy', (_label, client) => {
    expect(classifyStoredOAuthRedirectPolicy(client)).toBe('unsafe_legacy');
  });

  it.each([
    {
      application_type: 'web',
      redirect_uris: ['http://127.0.0.1:49152/callback'],
      noodle_redirect_policy_version: 2,
    },
    {
      application_type: 'web',
      redirect_uris: ['http://client.example.test/callback'],
      noodle_redirect_policy_version: 1,
    },
    {
      application_type: 'web',
      redirect_uris: ['https://user:password@client.example.test/callback'],
      noodle_redirect_policy_version: 1,
    },
    {
      application_type: 'web',
      redirect_uris: ['https://client.example.test/callback#'],
      noodle_redirect_policy_version: 1,
    },
  ])('does not trust an unknown or unsafe redirect-policy marker', (client) => {
    expect(classifyStoredOAuthRedirectPolicy(client)).toBe('unsafe_legacy');
  });

  it('does not let a marker normalize malformed metadata', () => {
    expect(
      classifyStoredOAuthRedirectPolicy({
        application_type: 'web',
        redirect_uris: ['not a URI'],
        noodle_redirect_policy_version: 1,
      }),
    ).toBe('malformed_legacy');
  });

  it('classifies other parseable legacy records as unsafe_legacy', () => {
    expect(
      classifyStoredOAuthRedirectPolicy({
        redirect_uris: ['http://client.example.test/callback'],
      }),
    ).toBe('unsafe_legacy');
  });

  it('classifies empty and unparseable legacy records as malformed_legacy', () => {
    expect(classifyStoredOAuthRedirectPolicy({ redirect_uris: [] })).toBe('malformed_legacy');
    expect(classifyStoredOAuthRedirectPolicy({ redirect_uris: ['not a URI'] })).toBe(
      'malformed_legacy',
    );
  });
});

describe('Stage A legacy loopback matching', () => {
  const client = { redirect_uris: ['http://127.0.0.1:49152/callback'] };

  it('permits a safe legacy loopback port change only while the rollout flag is enabled', () => {
    expect(
      matchOAuthAuthorizationRedirect({
        client,
        requestedRedirectUri: 'http://127.0.0.1:49153/callback',
        allowLegacyLoopbackPortSubstitution: true,
      }),
    ).toEqual({
      allowed: true,
      usedLegacyLoopbackPortSubstitution: true,
      reason: 'legacy_loopback_port_match',
    });
    expect(
      matchOAuthAuthorizationRedirect({
        client,
        requestedRedirectUri: 'http://127.0.0.1:49153/callback',
        allowLegacyLoopbackPortSubstitution: false,
      }),
    ).toMatchObject({ allowed: false, reason: 'unregistered_redirect' });
  });

  it('does not count a legacy port substitution when the registered redirect is exact', () => {
    expect(
      matchOAuthAuthorizationRedirect({
        client,
        requestedRedirectUri: 'http://127.0.0.1:49152/callback',
        allowLegacyLoopbackPortSubstitution: true,
      }),
    ).toEqual({
      allowed: true,
      usedLegacyLoopbackPortSubstitution: false,
      reason: 'exact_match',
    });
  });

  it('keeps unsafe and malformed legacy records distinguishable when no exact redirect matches', () => {
    expect(
      matchOAuthAuthorizationRedirect({
        client: { redirect_uris: ['http://client.example.test/callback'] },
        requestedRedirectUri: 'http://client.example.test/other-callback',
        allowLegacyLoopbackPortSubstitution: true,
      }),
    ).toMatchObject({ allowed: false, reason: 'unsafe_legacy_redirect' });
    expect(
      matchOAuthAuthorizationRedirect({
        client: { redirect_uris: [] },
        requestedRedirectUri: 'https://client.example.test/callback',
        allowLegacyLoopbackPortSubstitution: true,
      }),
    ).toMatchObject({ allowed: false, reason: 'malformed_client_metadata' });
  });
});

function expectPolicyFailure(
  metadata: { readonly application_type?: unknown; readonly redirect_uris: unknown },
  omittedValue = '',
): void {
  expect(() => normalizeOAuthClientMetadata(metadata)).toThrow(OAuthRedirectPolicyError);

  try {
    normalizeOAuthClientMetadata(metadata);
  } catch (error) {
    expect(error).toHaveProperty('reason');
    if (omittedValue !== '') expect(String(error)).not.toContain(omittedValue);
  }
}
