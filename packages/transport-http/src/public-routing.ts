import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import {
  type PublicMcpRouteRef,
  type PublicOrgWellKnownRef,
  parsePublicMcpUrl,
  parsePublicOrgWellKnownUrl,
  type TenantRouteRef,
} from '@noodle-borg/module';

export interface TrustedPublicRouting {
  readonly allowedBaseDomains: readonly string[];
  readonly edgeToken: string;
}

export type TrustedPublicRef<T> =
  | { readonly status: 'none' }
  | { readonly status: 'ok'; readonly ref: T; readonly resourceUrl: string }
  | { readonly status: 403 | 404 };

export type TrustedTenantMcpResource =
  | { readonly status: 'none' }
  | {
      readonly status: 'ok';
      readonly ok: true;
      readonly tenant: TenantRouteRef;
      readonly resourceUrl: string;
    }
  | { readonly status: 403 | 404; readonly ok: false };

export type TrustedPublicOrg =
  | { readonly status: 'none' }
  | { readonly status: 'ok'; readonly ok: true; readonly org: string }
  | { readonly status: 403 | 404; readonly ok: false };

export function edgeTokenMatches(actual: string | undefined, expected: string): boolean {
  if (actual === undefined || expected.length === 0) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function canonicalPublicResourceUrl(input: string): string {
  const url = new URL(input);
  return `${url.origin}${url.pathname}`;
}

export function trustedPublicMcpRef(
  req: IncomingMessage,
  routing: TrustedPublicRouting | undefined,
): TrustedPublicRef<PublicMcpRouteRef> {
  return trustedPublicRef(req, routing, (forwarded, allowedBaseDomains) =>
    parsePublicMcpUrl(forwarded, allowedBaseDomains),
  );
}

export function trustedPublicOrgWellKnownRef(
  req: IncomingMessage,
  routing: TrustedPublicRouting | undefined,
  expectedPath: string,
): TrustedPublicRef<PublicOrgWellKnownRef> {
  return trustedPublicRef(req, routing, (forwarded, allowedBaseDomains) =>
    parsePublicOrgWellKnownUrl(forwarded, allowedBaseDomains, expectedPath),
  );
}

export async function resolveTrustedTenantMcpResource(
  req: IncomingMessage,
  routing:
    | (TrustedPublicRouting & {
        readonly resolveTenant: (ref: PublicMcpRouteRef) => Promise<TenantRouteRef | undefined>;
      })
    | undefined,
): Promise<TrustedTenantMcpResource> {
  const trusted = trustedPublicMcpRef(req, routing);
  if (trusted.status === 'none') return trusted;
  if (trusted.status !== 'ok') return { status: trusted.status, ok: false };
  const tenant = await routing?.resolveTenant(trusted.ref);
  return tenant === undefined
    ? { status: 404, ok: false }
    : { status: 'ok', ok: true, tenant, resourceUrl: trusted.resourceUrl };
}

export async function resolveTrustedPublicOrg(
  req: IncomingMessage,
  routing: TrustedPublicRouting | undefined,
  expectedPath: string,
  resolveOrg: (mcpSubdomain: string) => Promise<string | undefined>,
): Promise<TrustedPublicOrg> {
  const trusted = trustedPublicOrgWellKnownRef(req, routing, expectedPath);
  if (trusted.status === 'none') return trusted;
  if (trusted.status !== 'ok') return { status: trusted.status, ok: false };
  const org = await resolveOrg(trusted.ref.mcpSubdomain);
  return org === undefined ? { status: 404, ok: false } : { status: 'ok', ok: true, org };
}

function trustedPublicRef<T>(
  req: IncomingMessage,
  routing: TrustedPublicRouting | undefined,
  parse: (forwarded: string, allowedBaseDomains: readonly string[]) => T | undefined,
): TrustedPublicRef<T> {
  const forwarded = requestHeader(req, 'x-app-host');
  if (forwarded === undefined) return { status: 'none' };
  if (
    routing === undefined ||
    !edgeTokenMatches(requestHeader(req, 'x-noodle-edge-token'), routing.edgeToken)
  ) {
    return { status: 403 };
  }
  const ref = parse(forwarded, routing.allowedBaseDomains);
  if (ref === undefined) return { status: 404 };
  try {
    return { status: 'ok', ref, resourceUrl: canonicalPublicResourceUrl(forwarded) };
  } catch {
    return { status: 404 };
  }
}

function requestHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}
