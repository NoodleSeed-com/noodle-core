import type { IncomingMessage } from 'node:http';
import type { ControlPlaneIdentity } from './contracts.js';

export type ControlPlaneAuthResult =
  | { readonly ok: true; readonly identity?: ControlPlaneIdentity }
  | { readonly ok: false; readonly status: 401 | 403; readonly message: string };

export interface DeployAuthGate {
  authorize(req: IncomingMessage): Promise<ControlPlaneAuthResult> | ControlPlaneAuthResult;
}

/** Extract a bearer token from the Authorization header, or null. */
export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

/** Allows every deploy; callers must restrict this gate to a loopback bind. */
export function allowAllGate(): DeployAuthGate {
  return { authorize: () => ({ ok: true }) };
}
