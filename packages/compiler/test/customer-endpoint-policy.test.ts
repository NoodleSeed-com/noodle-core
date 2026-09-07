import { describe, expect, it } from 'vitest';
import {
  type CustomerEndpointPolicy,
  normalizeCustomerEndpointPolicy,
  resolveCustomerEndpointBaseUrl,
} from '../src/customer-endpoint.js';

const exactPolicy = {
  allowedHttpsOrigins: ['https://api.noodleseed.dev'],
} as const satisfies CustomerEndpointPolicy;

const suffixPolicy = {
  allowedHttpsHostSuffixes: ['noodleseed.dev'],
} as const satisfies CustomerEndpointPolicy;

describe('normalizeCustomerEndpointPolicy', () => {
  it('canonicalizes, sorts, and deduplicates exact HTTPS origins', () => {
    expect(
      normalizeCustomerEndpointPolicy({
        allowedHttpsOrigins: [
          'https://z.noodleseed.dev:443',
          'https://api.noodleseed.dev',
          'https://z.noodleseed.dev',
        ],
      }),
    ).toEqual({
      allowedHttpsOrigins: ['https://api.noodleseed.dev', 'https://z.noodleseed.dev'],
    });
  });

  it('preserves an explicitly authorized non-default exact-origin port', () => {
    expect(
      normalizeCustomerEndpointPolicy({
        allowedHttpsOrigins: ['https://api.noodleseed.dev:8443'],
      }),
    ).toEqual({
      allowedHttpsOrigins: ['https://api.noodleseed.dev:8443'],
    });
  });

  it('accepts an exact HTTPS origin with an explicit root path', () => {
    expect(
      normalizeCustomerEndpointPolicy({
        allowedHttpsOrigins: ['https://api.noodleseed.dev/'],
      }),
    ).toEqual({
      allowedHttpsOrigins: ['https://api.noodleseed.dev'],
    });
  });

  it('canonicalizes, sorts, and deduplicates registrable hostname suffixes', () => {
    expect(
      normalizeCustomerEndpointPolicy({
        allowedHttpsHostSuffixes: ['Z.NOODLESEED.DEV', 'api.noodleseed.dev', 'z.noodleseed.dev'],
      }),
    ).toEqual({
      allowedHttpsHostSuffixes: ['api.noodleseed.dev', 'z.noodleseed.dev'],
    });
  });

  it('canonicalizes internationalized suffix labels through the platform URL parser', () => {
    expect(
      normalizeCustomerEndpointPolicy({
        allowedHttpsHostSuffixes: ['BÜCHER.NOODLESEED.DEV'],
      }),
    ).toEqual({
      allowedHttpsHostSuffixes: ['xn--bcher-kva.noodleseed.dev'],
    });
  });

  it.each([
    [
      'both policy arms',
      {
        allowedHttpsOrigins: ['https://api.noodleseed.dev'],
        allowedHttpsHostSuffixes: ['noodleseed.dev'],
      },
    ],
    ['neither policy arm', {}],
    ['an empty origin list', { allowedHttpsOrigins: [] }],
    ['an empty suffix list', { allowedHttpsHostSuffixes: [] }],
    ['an unknown key', { allowedHttpsOrigins: ['https://api.noodleseed.dev'], extra: true }],
    ['an HTTP origin', { allowedHttpsOrigins: ['http://api.noodleseed.dev'] }],
    [
      'an HTTPS origin without authority slashes',
      { allowedHttpsOrigins: ['https:api.noodleseed.dev'] },
    ],
    [
      'an HTTPS origin with one authority slash',
      { allowedHttpsOrigins: ['https:/api.noodleseed.dev'] },
    ],
    ['an HTTPS origin with backslashes', { allowedHttpsOrigins: ['https:\\\\api.noodleseed.dev'] }],
    [
      'an HTTPS origin with excess authority slashes',
      { allowedHttpsOrigins: ['https:////api.noodleseed.dev'] },
    ],
    ['an origin path', { allowedHttpsOrigins: ['https://api.noodleseed.dev/v1'] }],
    [
      'an origin path normalized to root',
      { allowedHttpsOrigins: ['https://api.noodleseed.dev/a/..'] },
    ],
    [
      'a percent-encoded origin path normalized to root',
      { allowedHttpsOrigins: ['https://api.noodleseed.dev/%2e%2e'] },
    ],
    ['origin credentials', { allowedHttpsOrigins: ['https://user:pass@api.noodleseed.dev'] }],
    ['an origin query', { allowedHttpsOrigins: ['https://api.noodleseed.dev?x=1'] }],
    ['an empty origin query delimiter', { allowedHttpsOrigins: ['https://api.noodleseed.dev?'] }],
    ['an origin fragment', { allowedHttpsOrigins: ['https://api.noodleseed.dev#x'] }],
    [
      'an empty origin fragment delimiter',
      { allowedHttpsOrigins: ['https://api.noodleseed.dev#'] },
    ],
    ['empty origin userinfo', { allowedHttpsOrigins: ['https://@api.noodleseed.dev'] }],
    ['an origin IP literal', { allowedHttpsOrigins: ['https://127.0.0.1'] }],
    ['an origin trailing dot', { allowedHttpsOrigins: ['https://api.noodleseed.dev.'] }],
    ['a special-use origin', { allowedHttpsOrigins: ['https://api.example.com'] }],
    ['an unrecognized origin suffix', { allowedHttpsOrigins: ['https://tenant.unknown'] }],
    ['a bare private-suffix origin', { allowedHttpsOrigins: ['https://github.io'] }],
    ['a suffix with a scheme', { allowedHttpsHostSuffixes: ['https://noodleseed.dev'] }],
    ['a suffix with a path', { allowedHttpsHostSuffixes: ['noodleseed.dev/v1'] }],
    ['a suffix with a backslash', { allowedHttpsHostSuffixes: ['noodleseed.dev\\evil'] }],
    ['a suffix with a port', { allowedHttpsHostSuffixes: ['noodleseed.dev:8443'] }],
    ['a suffix with whitespace', { allowedHttpsHostSuffixes: [' noodleseed.dev'] }],
    ['a suffix IP literal', { allowedHttpsHostSuffixes: ['127.0.0.1'] }],
    ['a suffix trailing dot', { allowedHttpsHostSuffixes: ['noodleseed.dev.'] }],
    ['a public suffix', { allowedHttpsHostSuffixes: ['com'] }],
    ['a private suffix', { allowedHttpsHostSuffixes: ['github.io'] }],
    ['an unrecognized suffix', { allowedHttpsHostSuffixes: ['tenant.unknown'] }],
    ['a suffix with a leading dot', { allowedHttpsHostSuffixes: ['.noodleseed.dev'] }],
    ['a suffix with an empty label', { allowedHttpsHostSuffixes: ['api..noodleseed.dev'] }],
    ['a suffix with a leading label hyphen', { allowedHttpsHostSuffixes: ['-api.noodleseed.dev'] }],
    [
      'a suffix with a trailing label hyphen',
      { allowedHttpsHostSuffixes: ['api-.noodleseed.dev'] },
    ],
  ])('rejects %s', (_label, policy) => {
    expect(() => normalizeCustomerEndpointPolicy(policy)).toThrow(
      'invalid customer endpoint policy',
    );
  });

  it('accepts a registrable domain beneath a private suffix', () => {
    expect(
      normalizeCustomerEndpointPolicy({
        allowedHttpsHostSuffixes: ['tenant.github.io'],
      }),
    ).toEqual({ allowedHttpsHostSuffixes: ['tenant.github.io'] });
  });
});

describe('resolveCustomerEndpointBaseUrl', () => {
  it.each([
    ['non-string claim', 42],
    ['leading whitespace', ' https://api.noodleseed.dev'],
    ['trailing whitespace', 'https://api.noodleseed.dev '],
    ['C0 control', 'https://api.noodleseed.dev/\u0000'],
    ['C1 control', 'https://api.noodleseed.dev/\u0085'],
    ['HTTP URL', 'http://api.noodleseed.dev'],
    ['HTTPS URL without authority slashes', 'https:api.noodleseed.dev'],
    ['HTTPS URL with one authority slash', 'https:/api.noodleseed.dev'],
    ['HTTPS URL with backslashes', 'https:\\\\api.noodleseed.dev'],
    ['HTTPS URL with excess authority slashes', 'https:////api.noodleseed.dev'],
    ['HTTPS URL with a raw path backslash', 'https://api.noodleseed.dev\\v1'],
    ['raw parent path segment', 'https://api.noodleseed.dev/v1/../private'],
    ['encoded parent path segment', 'https://api.noodleseed.dev/v1/%2e%2e/private'],
    ['encoded path slash', 'https://api.noodleseed.dev/v1/%2Fprivate'],
    ['encoded path backslash', 'https://api.noodleseed.dev/v1/%5cprivate'],
    ['encoded percent', 'https://api.noodleseed.dev/v1/%25private'],
    ['double-encoded parent path segment', 'https://api.noodleseed.dev/v1/%252e%252e/private'],
    ['double-encoded path slash', 'https://api.noodleseed.dev/v1/%252Fprivate'],
    ['double-encoded path backslash', 'https://api.noodleseed.dev/v1/%255cprivate'],
    ['multiply encoded path slash', 'https://api.noodleseed.dev/v1/%25252fprivate'],
    ['relative URL', '/v1'],
    ['userinfo', 'https://user:pass@api.noodleseed.dev'],
    ['empty userinfo', 'https://@api.noodleseed.dev'],
    ['query', 'https://api.noodleseed.dev?x=1'],
    ['empty query delimiter', 'https://api.noodleseed.dev?'],
    ['fragment', 'https://api.noodleseed.dev#x'],
    ['empty fragment delimiter', 'https://api.noodleseed.dev#'],
    ['IPv4 literal', 'https://127.0.0.1'],
    ['normalized exotic IPv4 literal', 'https://2130706433'],
    ['IPv6 literal', 'https://[::1]'],
    ['IPv4-mapped IPv6 literal', 'https://[::ffff:127.0.0.1]'],
    ['trailing-dot hostname', 'https://api.noodleseed.dev.'],
    ['special-use hostname', 'https://api.example.com'],
    ['nonregistrable hostname', 'https://internal'],
  ])('rejects a %s with a safe failure', (_label, raw) => {
    const result = resolveCustomerEndpointBaseUrl(raw, exactPolicy);
    expect(result).toEqual({ ok: false });
    expect(JSON.stringify(result)).not.toContain(String(raw));
  });

  it('rejects a claim longer than 2,048 UTF-8 bytes', () => {
    const raw = `https://api.noodleseed.dev/${'é'.repeat(1_100)}`;
    expect(new TextEncoder().encode(raw).byteLength).toBeGreaterThan(2_048);
    expect(resolveCustomerEndpointBaseUrl(raw, exactPolicy)).toEqual({ ok: false });
  });

  it('accepts exactly 2,048 UTF-8 bytes and rejects 2,049', () => {
    const prefix = 'https://api.noodleseed.dev/';
    const prefixBytes = new TextEncoder().encode(prefix).byteLength;
    const exact = `${prefix}${'a'.repeat(2_048 - prefixBytes)}`;
    const over = `${exact}a`;
    expect(new TextEncoder().encode(exact).byteLength).toBe(2_048);
    expect(new TextEncoder().encode(over).byteLength).toBe(2_049);
    expect(resolveCustomerEndpointBaseUrl(exact, exactPolicy)).toEqual({
      ok: true,
      baseUrl: exact,
    });
    expect(resolveCustomerEndpointBaseUrl(over, exactPolicy)).toEqual({ ok: false });
  });

  it('authorizes a canonical exact origin and preserves a canonical base path', () => {
    expect(
      resolveCustomerEndpointBaseUrl('https://API.NOODLESEED.DEV:443/customer/v1///', exactPolicy),
    ).toEqual({
      ok: true,
      baseUrl: 'https://api.noodleseed.dev/customer/v1',
    });
  });

  it('preserves safe percent-encoded content in a canonical base path', () => {
    expect(
      resolveCustomerEndpointBaseUrl(
        'https://API.NOODLESEED.DEV:443/customer%20records/v1///',
        exactPolicy,
      ),
    ).toEqual({
      ok: true,
      baseUrl: 'https://api.noodleseed.dev/customer%20records/v1',
    });
  });

  it('canonicalizes a root path to no base path', () => {
    expect(resolveCustomerEndpointBaseUrl('https://api.noodleseed.dev/', exactPolicy)).toEqual({
      ok: true,
      baseUrl: 'https://api.noodleseed.dev',
    });
  });

  it('accepts a non-default port only when the exact-origin policy authorizes it', () => {
    expect(
      resolveCustomerEndpointBaseUrl('https://api.noodleseed.dev:8443/v1', {
        allowedHttpsOrigins: ['https://api.noodleseed.dev:8443'],
      }),
    ).toEqual({ ok: true, baseUrl: 'https://api.noodleseed.dev:8443/v1' });
    expect(
      resolveCustomerEndpointBaseUrl('https://api.noodleseed.dev:8443/v1', exactPolicy),
    ).toEqual({ ok: false });
  });

  it('matches a suffix on the exact hostname and a dot-boundary subdomain', () => {
    expect(resolveCustomerEndpointBaseUrl('https://noodleseed.dev', suffixPolicy)).toEqual({
      ok: true,
      baseUrl: 'https://noodleseed.dev',
    });
    expect(
      resolveCustomerEndpointBaseUrl('https://tenant.api.noodleseed.dev/v1/', suffixPolicy),
    ).toEqual({ ok: true, baseUrl: 'https://tenant.api.noodleseed.dev/v1' });
  });

  it('rejects a false suffix boundary', () => {
    expect(resolveCustomerEndpointBaseUrl('https://notnoodleseed.dev', suffixPolicy)).toEqual({
      ok: false,
    });
  });

  it('permits only the canonical HTTPS default port for suffix policies', () => {
    expect(
      resolveCustomerEndpointBaseUrl('https://api.noodleseed.dev:443/v1', suffixPolicy),
    ).toEqual({ ok: true, baseUrl: 'https://api.noodleseed.dev/v1' });
    expect(
      resolveCustomerEndpointBaseUrl('https://api.noodleseed.dev:8443/v1', suffixPolicy),
    ).toEqual({ ok: false });
  });
});
