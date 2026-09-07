import type { IncomingMessage, ServerResponse } from 'node:http';
import { JSON_RPC } from '@noodle-borg/protocol';

/**
 * In-app HTTPS posture for a TLS-**proxy-terminated** deployment (Slice 28, ADR 0033). The runtime itself
 * always speaks plain HTTP behind a trusted reverse proxy (it never handles certs); this module enforces
 * the *client*-facing HTTPS expectation and emits baseline security headers. The actual cert / DNS / load
 * balancer is an out-of-repo hosting decision.
 */
export interface TlsPosture {
  /**
   * Trust `X-Forwarded-Proto` / RFC 7239 `Forwarded` from the fronting proxy. Default `false` (direct /
   * localhost), in which case forwarded headers are **ignored** so a direct client cannot spoof `https`.
   * Enable **only** behind a trusted proxy that strips client-supplied copies of these headers.
   */
  readonly trustProxy?: boolean;
  /** Reject a request the proxy marks as plaintext `http` with `426`. Default: on when `trustProxy`. */
  readonly requireHttps?: boolean;
  /**
   * Emit `Strict-Transport-Security`. Default: on when `trustProxy`. `maxAge` default 2y,
   * `includeSubDomains` default true, `preload` default **false** (preload is hard to reverse — opt in).
   */
  readonly hsts?:
    | boolean
    | { maxAgeSeconds?: number; includeSubDomains?: boolean; preload?: boolean };
}

const TWO_YEARS_SECONDS = 63_072_000;

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The effective client-facing scheme. With `trustProxy`, read `X-Forwarded-Proto` (first hop) or RFC 7239
 * `Forwarded: proto=`; otherwise the forwarded headers are ignored and the scheme is `http` (the runtime's
 * own socket). A trusted proxy that omits the header is treated as `http` (fail safe → enforcement fires).
 */
export function effectiveProto(req: IncomingMessage, trustProxy: boolean): 'http' | 'https' {
  if (!trustProxy) return 'http';
  const forwardedProto = header(req, 'x-forwarded-proto');
  if (forwardedProto) {
    const first = forwardedProto.split(',')[0]?.trim().toLowerCase();
    if (first === 'https') return 'https';
    if (first === 'http') return 'http';
  }
  const forwarded = header(req, 'forwarded');
  if (forwarded) {
    const match = /proto=("?)(https?)\1/i.exec(forwarded);
    if (match) return match[2]?.toLowerCase() === 'https' ? 'https' : 'http';
  }
  return 'http';
}

/**
 * Enforce the HTTPS posture. When `requireHttps` (default = `trustProxy`) and the effective scheme is
 * plaintext `http`, write a `426 Upgrade Required` (with an `Upgrade` header + transport-level JSON-RPC
 * error) and return `true` (request handled). Otherwise return `false`.
 */
export function enforceHttps(
  req: IncomingMessage,
  res: ServerResponse,
  posture: TlsPosture,
): boolean {
  const trustProxy = posture.trustProxy ?? false;
  const requireHttps = posture.requireHttps ?? trustProxy;
  if (!requireHttps) return false;
  if (effectiveProto(req, trustProxy) === 'https') return false;
  res.writeHead(426, {
    'content-type': 'application/json; charset=utf-8',
    upgrade: 'TLS/1.2, HTTP/1.1',
  });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code: JSON_RPC.INVALID_REQUEST, message: 'HTTPS required' },
    }),
  );
  return true;
}

/**
 * Host-agnostic baseline security headers for every response (set via `setHeader`, before the body is
 * written, so they ride along with whatever status follows): `X-Content-Type-Options: nosniff`,
 * `Referrer-Policy: no-referrer`, `Cache-Control: no-store` (responses carry tokens/JSON), and
 * `Strict-Transport-Security` when the posture calls for it.
 */
export function applySecurityHeaders(res: ServerResponse, posture: TlsPosture): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  const hsts = posture.hsts ?? posture.trustProxy ?? false;
  if (!hsts) return;
  const opts = typeof hsts === 'object' ? hsts : {};
  const parts = [`max-age=${opts.maxAgeSeconds ?? TWO_YEARS_SECONDS}`];
  if (opts.includeSubDomains ?? true) parts.push('includeSubDomains');
  if (opts.preload ?? false) parts.push('preload');
  res.setHeader('Strict-Transport-Security', parts.join('; '));
}
