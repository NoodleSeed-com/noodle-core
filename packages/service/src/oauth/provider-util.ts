import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

export function defaultResourceFromClient(client: OAuthClientInformationFull): string | undefined {
  const resource = (client as { default_resource?: unknown }).default_resource;
  if (typeof resource !== 'string') return undefined;
  return normalizeResource(resource);
}

export function normalizeResource(resource: string | undefined): string | undefined {
  if (resource === undefined) return undefined;
  try {
    return new URL(resource).href;
  } catch {
    return undefined;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

export function resourcePath(resource: string): string {
  try {
    return new URL(resource).pathname;
  } catch {
    return '';
  }
}
