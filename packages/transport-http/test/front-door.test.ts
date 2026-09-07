import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { applySecurityHeaders, effectiveProto, enforceHttps } from '../src/index.js';

const reqWith = (headers: Record<string, string>): IncomingMessage =>
  ({ headers, method: 'POST' }) as unknown as IncomingMessage;

function mockRes(): { res: ServerResponse; headers: Record<string, string>; status: () => number } {
  const headers: Record<string, string> = {};
  let statusCode = 0;
  const res = {
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    writeHead(code: number, extra?: Record<string, string>) {
      statusCode = code;
      if (extra)
        for (const [key, value] of Object.entries(extra)) headers[key.toLowerCase()] = value;
    },
    end() {
      /* discard body */
    },
  };
  return { res: res as unknown as ServerResponse, headers, status: () => statusCode };
}

describe('effectiveProto', () => {
  it('reads X-Forwarded-Proto (first hop) only when trustProxy', () => {
    expect(effectiveProto(reqWith({ 'x-forwarded-proto': 'https' }), true)).toBe('https');
    expect(effectiveProto(reqWith({ 'x-forwarded-proto': 'https, http' }), true)).toBe('https');
  });

  it('ignores forwarded headers when not trusting the proxy (anti-spoof)', () => {
    expect(effectiveProto(reqWith({ 'x-forwarded-proto': 'https' }), false)).toBe('http');
  });

  it('falls back to http when the trusted proxy sends no proto header', () => {
    expect(effectiveProto(reqWith({}), true)).toBe('http');
  });

  it('parses RFC 7239 Forwarded: proto=', () => {
    expect(effectiveProto(reqWith({ forwarded: 'proto=https;for=1.2.3.4' }), true)).toBe('https');
  });
});

describe('enforceHttps', () => {
  it('426s a plaintext request when requireHttps (default = trustProxy)', () => {
    const { res, headers, status } = mockRes();
    const handled = enforceHttps(reqWith({ 'x-forwarded-proto': 'http' }), res, {
      trustProxy: true,
    });
    expect(handled).toBe(true);
    expect(status()).toBe(426);
    expect(headers.upgrade).toMatch(/TLS/);
  });

  it('passes an https request through', () => {
    const { res } = mockRes();
    expect(enforceHttps(reqWith({ 'x-forwarded-proto': 'https' }), res, { trustProxy: true })).toBe(
      false,
    );
  });

  it('is a no-op by default (no trustProxy / no enforcement)', () => {
    const { res } = mockRes();
    expect(enforceHttps(reqWith({}), res, {})).toBe(false);
  });
});

describe('applySecurityHeaders', () => {
  it('always sets nosniff / no-referrer / no-store; HSTS only when the posture calls for it', () => {
    const direct = mockRes();
    applySecurityHeaders(direct.res, {});
    expect(direct.headers['x-content-type-options']).toBe('nosniff');
    expect(direct.headers['referrer-policy']).toBe('no-referrer');
    expect(direct.headers['cache-control']).toBe('no-store');
    expect(direct.headers['strict-transport-security']).toBeUndefined();

    const proxied = mockRes();
    applySecurityHeaders(proxied.res, { trustProxy: true });
    expect(proxied.headers['strict-transport-security']).toContain('max-age=63072000');
    expect(proxied.headers['strict-transport-security']).toContain('includeSubDomains');
    expect(proxied.headers['strict-transport-security']).not.toContain('preload');
  });

  it('includes preload only when explicitly enabled', () => {
    const { res, headers } = mockRes();
    applySecurityHeaders(res, { hsts: { preload: true } });
    expect(headers['strict-transport-security']).toContain('preload');
  });
});
