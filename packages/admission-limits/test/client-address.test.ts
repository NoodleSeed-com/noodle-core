import { describe, expect, it } from 'vitest';
import { clientAddressBucket } from '../src/client-address.js';

/**
 * The address parse, before any counting.
 *
 * Production traffic to this service is about a fifth IPv6 (measured 2026-08-14: 43 of 200 requests),
 * and the idiom everyone writes for `IPv4:port` — `value.split(',')[0].split(':')[0]` — truncates
 * `2001:8a0:6763:d500:…` to `2001`. Every IPv6 visitor then shares one bucket, so a single abuser
 * throttles all of them: a fairness tier that destroys fairness, failing open for IPv4 and closed for
 * everyone else, and only under real traffic. Hence a table of real shapes as the first test.
 */

const distinct = (...values: readonly (string | undefined)[]) =>
  new Set(values.map((value) => clientAddressBucket(value)));

describe('clientAddressBucket', () => {
  it('separates IPv6 addresses that share a prefix', () => {
    // These differ only past the first group. A naive colon split maps them to one bucket.
    const a = '2001:8a0:6763:d500:4cd6:68dd:91f3:f238';
    const b = '2001:8a0:6763:d500:1111:2222:3333:4444';
    const c = '2001:db8::1';
    expect(distinct(a, b, c).size).toBe(3);
  });

  it('reads only the client hop of a forwarded chain', () => {
    // Cloud Run appends its own hops. The client is the first entry; trusting the last would bucket
    // every visitor behind the front end together.
    expect(clientAddressBucket('203.0.113.7, 130.211.0.1, 35.191.0.2')).toBe(
      clientAddressBucket('203.0.113.7'),
    );
    expect(clientAddressBucket('2001:db8::1, 130.211.0.1')).toBe(
      clientAddressBucket('2001:db8::1'),
    );
  });

  it('treats an address and the same address with a port as one visitor', () => {
    expect(clientAddressBucket('203.0.113.7:51234')).toBe(clientAddressBucket('203.0.113.7'));
    expect(clientAddressBucket('[2001:db8::1]:51234')).toBe(clientAddressBucket('2001:db8::1'));
  });

  it('treats an IPv4-mapped IPv6 address as the IPv4 visitor it is', () => {
    // `::ffff:203.0.113.7` and `203.0.113.7` are the same machine; two buckets would double its budget.
    expect(clientAddressBucket('::ffff:203.0.113.7')).toBe(clientAddressBucket('203.0.113.7'));
  });

  it('normalises case and zero-compression so one address is one bucket', () => {
    expect(clientAddressBucket('2001:0DB8:0000:0000:0000:0000:0000:0001')).toBe(
      clientAddressBucket('2001:db8::1'),
    );
  });

  it('never returns the address itself', () => {
    // Package rule: no IP may reach a key, a log, or an audit payload from here.
    const address = '203.0.113.7';
    const bucket = clientAddressBucket(address);
    expect(bucket).not.toContain(address);
    expect(bucket).not.toContain('203');
    expect(bucket).toMatch(/^ip_[0-9a-f]{32}$/);
  });

  it('refuses to bucket what it cannot parse, rather than inventing one', () => {
    // A shared bucket for every unparseable value is a free-for-all *and* a shared throttle. Returning
    // undefined lets the caller decide, which for a public mint is to fall back to the surface tier.
    for (const value of [undefined, '', '   ', 'not-an-address', '999.999.999.999', ',,,']) {
      expect(clientAddressBucket(value), `parsed ${String(value)}`).toBeUndefined();
    }
  });
});
