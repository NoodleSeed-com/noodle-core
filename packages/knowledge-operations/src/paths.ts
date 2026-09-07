/**
 * Knowledge route path parsing, owned here so the service keeps only a thin dispatch.
 */
import type { KnowledgeTenantRef } from './routes.js';

export type KnowledgeRouteRef =
  | { readonly kind: 'preflight'; readonly tenant: KnowledgeTenantRef }
  | { readonly kind: 'document'; readonly tenant: KnowledgeTenantRef; readonly sha256: string }
  | { readonly kind: 'list'; readonly tenant: KnowledgeTenantRef }
  | { readonly kind: 'status'; readonly tenant: KnowledgeTenantRef; readonly component: string }
  | { readonly kind: 'refresh'; readonly tenant: KnowledgeTenantRef; readonly component: string };

const PREFLIGHT = /^\/v1\/orgs\/([^/]+)\/apps\/([^/]+)\/envs\/([^/]+)\/knowledge\/preflight$/;
const DOCUMENT =
  /^\/v1\/orgs\/([^/]+)\/apps\/([^/]+)\/envs\/([^/]+)\/knowledge\/documents\/([^/]+)$/;
const LIST = /^\/v1\/orgs\/([^/]+)\/apps\/([^/]+)\/envs\/([^/]+)\/knowledge$/;
const STATUS = /^\/v1\/orgs\/([^/]+)\/apps\/([^/]+)\/envs\/([^/]+)\/knowledge\/([^/]+)\/status$/;
const REFRESH = /^\/v1\/orgs\/([^/]+)\/apps\/([^/]+)\/envs\/([^/]+)\/knowledge\/([^/]+)\/refresh$/;

export function parseKnowledgePath(pathname: string): KnowledgeRouteRef | undefined {
  const preflight = PREFLIGHT.exec(pathname);
  if (preflight !== null) {
    const [, org, app, env] = preflight as unknown as [string, string, string, string];
    return { kind: 'preflight', tenant: { org, app, env } };
  }
  const list = LIST.exec(pathname);
  if (list !== null) {
    const [, org, app, env] = list as unknown as [string, string, string, string];
    return { kind: 'list', tenant: { org, app, env } };
  }
  const status = STATUS.exec(pathname);
  if (status !== null) {
    const [, org, app, env, component] = status as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    return { kind: 'status', tenant: { org, app, env }, component };
  }
  const refresh = REFRESH.exec(pathname);
  if (refresh !== null) {
    const [, org, app, env, component] = refresh as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    return { kind: 'refresh', tenant: { org, app, env }, component };
  }
  const document = DOCUMENT.exec(pathname);
  if (document !== null) {
    const [, org, app, env, sha256] = document as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    return { kind: 'document', tenant: { org, app, env }, sha256 };
  }
  return undefined;
}
