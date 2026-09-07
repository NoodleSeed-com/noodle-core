import type { SurfaceCapabilityRef } from './artifact-projection.js';

/**
 * The one reader of "does this deployment face the public, and on what terms".
 *
 * Three callers ask that question and must never disagree: deploy decides whether to provision an embed
 * id, minting checks the browser's origin against the surface, and the session's projection narrows the
 * artifact to the surface's capabilities. When each answered locally, a surface shape one of them
 * accepted and another rejected would silently mint sessions that could reach nothing, or provision an id
 * for a surface that refuses to serve it.
 *
 * The argument is `unknown` because the assistant block arrives as compiled artifact data rather than a
 * typed authoring value; the shape is validated here, once, rather than asserted at three call sites.
 */

export interface PublicSurface {
  readonly mode: 'public' | 'mixed';
  readonly origins: readonly string[];
  readonly capabilities: readonly SurfaceCapabilityRef[];
  readonly instructions?: string;
}

export interface AuthenticatedSurface {
  readonly origins: readonly string[];
  /** Absent means the authored intent is the whole server; a declared list narrows it. */
  readonly capabilities?: readonly SurfaceCapabilityRef[];
  readonly instructions?: string;
}

/** The deployment's one authenticated surface, read with the same shape discipline as the public one. */
export function authenticatedSurfaceOf(assistant: unknown): AuthenticatedSurface | undefined {
  const surfaces = (assistant as { surfaces?: unknown } | undefined)?.surfaces;
  if (!Array.isArray(surfaces)) return undefined;
  for (const entry of surfaces) {
    const { mode, origins, capabilities, instructions } = entry as {
      mode?: unknown;
      origins?: unknown;
      capabilities?: unknown;
      instructions?: unknown;
    };
    if (mode !== 'authenticated') continue;
    return {
      origins: Array.isArray(origins) ? (origins as readonly string[]) : [],
      // Unlike a public surface, an omitted list is the authored whole-server intent, not a hole:
      // the compiler requires the allowlist only on public-audience surfaces.
      ...(Array.isArray(capabilities)
        ? { capabilities: capabilities as readonly SurfaceCapabilityRef[] }
        : {}),
      ...(typeof instructions === 'string' ? { instructions } : {}),
    };
  }
  return undefined;
}

/**
 * Which authored surface owns this origin (ADR 0201: every session binds one exact surface).
 * `pre-surfaces` is the released artifact shape from before surfaces existed — the deployment-wide
 * origin union remains its only contract. `unowned` means surfaces exist and none lists the origin:
 * the caller must refuse, never fall back to the union.
 */
export function surfaceBindingForOrigin(
  assistant: unknown,
  origin: string,
):
  | { readonly kind: 'public' | 'authenticated' }
  | { readonly kind: 'unowned' }
  | { readonly kind: 'pre-surfaces' } {
  const surfaces = (assistant as { surfaces?: unknown } | undefined)?.surfaces;
  if (!Array.isArray(surfaces)) return { kind: 'pre-surfaces' };
  const publicSurface = publicSurfaceOf(assistant);
  if (publicSurface?.origins.includes(origin)) return { kind: 'public' };
  if (authenticatedSurfaceOf(assistant)?.origins.includes(origin)) {
    return { kind: 'authenticated' };
  }
  return { kind: 'unowned' };
}

export function publicSurfaceOf(assistant: unknown): PublicSurface | undefined {
  const surfaces = (assistant as { surfaces?: unknown } | undefined)?.surfaces;
  if (!Array.isArray(surfaces)) return undefined;
  for (const entry of surfaces) {
    const { mode, origins, capabilities, instructions } = entry as {
      mode?: unknown;
      origins?: unknown;
      capabilities?: unknown;
      instructions?: unknown;
    };
    // A mixed surface admits strangers exactly as a public one does — sign-in only widens what a visitor
    // reaches after elevation, so both provision an embed id and both project.
    if (mode !== 'public' && mode !== 'mixed') continue;
    // Both defaults fail closed rather than rejecting the surface outright: an empty origin list matches
    // no page, and an empty capability list projects to an empty artifact. Neither may ever be read as
    // "unset, therefore unrestricted" — that inversion is how a surface exposes the whole server.
    return {
      mode,
      origins: Array.isArray(origins) ? (origins as readonly string[]) : [],
      capabilities: Array.isArray(capabilities)
        ? (capabilities as readonly SurfaceCapabilityRef[])
        : [],
      ...(typeof instructions === 'string' ? { instructions } : {}),
    };
  }
  return undefined;
}
