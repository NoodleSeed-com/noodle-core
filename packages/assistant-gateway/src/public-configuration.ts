import { isPublicEmbedId, type PublicEmbedRecord, type PublicEmbedStore } from './embed-store.js';
import type { PublicSurface } from './public-surface.js';

export interface PublicConfigurationRequest {
  readonly embedId: unknown;
  readonly origin: unknown;
}

export interface PublicConfigurationPorts {
  readonly embeds: Pick<PublicEmbedStore, 'lookup'>;
  resolveActiveSurface(embed: PublicEmbedRecord): Promise<PublicSurface | undefined>;
}

export type PublicConfigurationResult =
  | { readonly ok: true; readonly embed: PublicEmbedRecord }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
    };

/** Authorize a browser-safe appearance read without opening or charging for a conversation. */
export async function authorizePublicConfiguration(
  request: PublicConfigurationRequest,
  ports: PublicConfigurationPorts,
): Promise<PublicConfigurationResult> {
  if (typeof request.embedId !== 'string' || !isPublicEmbedId(request.embedId)) {
    return refuse(400, 'invalid_embed_id', 'embedId is required');
  }
  if (typeof request.origin !== 'string' || request.origin.length === 0) {
    return refuse(403, 'origin_not_allowed', 'origin is not allowed');
  }
  const embed = await ports.embeds.lookup(request.embedId);
  if (embed === undefined) return refuse(403, 'embed_not_found', 'embed is not available');
  const surface = await ports.resolveActiveSurface(embed);
  if (surface === undefined) {
    return refuse(409, 'surface_unavailable', 'assistant deployment is unavailable');
  }
  if (!surface.origins.includes(request.origin)) {
    return refuse(403, 'origin_not_allowed', 'origin is not allowed');
  }
  return { ok: true, embed };
}

function refuse(
  status: number,
  code: string,
  message: string,
): Extract<PublicConfigurationResult, { readonly ok: false }> {
  return { ok: false, status, code, message };
}
