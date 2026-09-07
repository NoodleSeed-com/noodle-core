import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OperationSignature } from '@noodle-borg/compiler';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpConnector } from '../src/http-connector.js';
import {
  type DnsLookup,
  guardedFetch,
  isPublicUnicast,
  needsGuard,
  pinnedLookup,
} from '../src/ssrf.js';

describe('isPublicUnicast', () => {
  it('accepts public unicast addresses', () => {
    for (const ip of [
      '93.184.216.34',
      '8.8.8.8',
      '1.1.1.1',
      '2606:2800:220:1:248:1893:25c8:1946',
    ]) {
      expect(isPublicUnicast(ip)).toBe(true);
    }
  });

  it('rejects loopback / private / link-local / CGNAT / reserved / metadata', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
      '255.255.255.255',
      '::1',
      'fe80::1',
      'fc00::1',
      '::ffff:169.254.169.254', // IPv4-mapped metadata
    ]) {
      expect(isPublicUnicast(ip)).toBe(false);
    }
  });

  it('fails closed on unparseable input', () => {
    expect(isPublicUnicast('not-an-ip')).toBe(false);
    expect(isPublicUnicast('')).toBe(false);
  });
});

describe('needsGuard', () => {
  it('guards DNS-name hosts and skips literal-IP hosts', () => {
    expect(needsGuard(new URL('https://api.example.com/x'))).toBe(true);
    expect(needsGuard(new URL('http://127.0.0.1:8080/x'))).toBe(false);
    expect(needsGuard(new URL('http://[::1]:8080/x'))).toBe(false);
  });
});

describe('pinnedLookup', () => {
  const fake =
    (addrs: ReadonlyArray<{ address: string; family: number }>): DnsLookup =>
    (_hostname, _options, cb) =>
      cb(null, addrs);

  const resolve = (lk: DnsLookup, opts: Record<string, unknown> = {}) =>
    new Promise<unknown>((res, rej) =>
      lk('host', opts, (err, address, family) =>
        err ? rej(err) : res(opts.all === true ? address : { address, family }),
      ),
    );

  it('passes through a single public resolution', async () => {
    await expect(
      resolve(pinnedLookup(fake([{ address: '93.184.216.34', family: 4 }]))),
    ).resolves.toEqual({ address: '93.184.216.34', family: 4 });
  });

  it('returns the full list when options.all is set', async () => {
    const lk = pinnedLookup(
      fake([
        { address: '93.184.216.34', family: 4 },
        { address: '1.1.1.1', family: 4 },
      ]),
    );
    await expect(resolve(lk, { all: true })).resolves.toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '1.1.1.1', family: 4 },
    ]);
  });

  it('filters non-public addresses out of the result', async () => {
    const lk = pinnedLookup(
      fake([
        { address: '10.0.0.5', family: 4 },
        { address: '93.184.216.34', family: 4 },
      ]),
    );
    await expect(resolve(lk)).resolves.toEqual({ address: '93.184.216.34', family: 4 });
  });

  it('fails closed when every resolution is non-public (anti-rebinding)', async () => {
    const lk = pinnedLookup(fake([{ address: '169.254.169.254', family: 4 }]));
    await expect(resolve(lk)).rejects.toThrow(/egress blocked/);
  });
});

describe('guardedFetch', () => {
  let server: Server | undefined;

  afterEach(async () => {
    const current = server;
    server = undefined;
    if (current === undefined) return;
    await new Promise<void>((resolve, reject) =>
      current.close((error) => (error ? reject(error) : resolve())),
    );
  });

  async function listen(handler: Parameters<typeof createServer>[0]) {
    server = createServer(handler);
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    return server.address() as AddressInfo;
  }

  it('blocks a DNS-name request that resolves to a private address before sending HTTP', async () => {
    let requests = 0;
    const address = await listen((_req, res) => {
      requests += 1;
      res.end('should not be reached');
    });
    const lookup: DnsLookup = (_hostname, _options, cb) =>
      cb(null, [{ address: '127.0.0.1', family: 4 }]);

    await expect(
      guardedFetch(new URL(`http://private.example.test:${address.port}/`), {}, { lookup }),
    ).rejects.toThrow(/egress blocked|non-public/);
    expect(requests).toBe(0);
  });

  it('does not guard literal-IP requests after the caller has explicitly allowed them', async () => {
    const address = await listen((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });

    const response = await guardedFetch(new URL(`http://127.0.0.1:${address.port}/`));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});

describe('HttpConnector SSRF guard (integration)', () => {
  const sig: OperationSignature = { type: 'read', input: {}, output: {} };

  it('blocks a DNS host that resolves to a private/metadata IP', async () => {
    const conn = new HttpConnector({
      id: 'meta',
      version: '1',
      baseUrl: 'http://metadata.example.test/',
      operations: { get: { path: '/latest/meta-data', signature: sig } },
      // Inject a resolver that rebinds the public-looking host to the cloud-metadata IP.
      lookup: (_hostname, _options, cb) => cb(null, [{ address: '169.254.169.254', family: 4 }]),
    });

    const err = await conn.invoke({ operation: 'get', args: {}, credential: { token: '' } }).then(
      () => null,
      (e: unknown) => e as { message?: string; cause?: { message?: string } },
    );

    expect(err).toBeTruthy();
    const msg = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`;
    expect(msg).toMatch(/egress blocked|non-public/);
  });
});
