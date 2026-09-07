/**
 * Where a client gets its session, and on whose authority.
 *
 * Two transports for one access model (ADR 0201). An in-app embed exchanges through the customer's own
 * backend, which holds the embed secret and vouches for a signed-in person. A public page has neither a
 * backend nor a secret, so it presents a non-secret embed id straight to the service and receives an
 * anonymous session. Everything after the first hop — turns, tools, interactions — is identical.
 *
 * Exclusive rather than merged: an embed id left beside a backend endpoint is a copy-paste mistake, and
 * silently preferring one would pick a transport the developer did not intend.
 */

/** The hosted service a published page reaches by default, so a snippet needs no origin. */
export const NOODLE_CLOUD_URL = 'https://cloud.noodleseed.dev';

const PUBLIC_SESSION_PATH = '/v1/assistant/public-sessions';
const PUBLIC_CONFIGURATION_PATH = '/v1/assistant/public-configurations';

export function publicConfigurationUrl(serviceUrl: string | undefined, embedId: string): string {
  const base = (serviceUrl || NOODLE_CLOUD_URL).replace(/\/+$/, '');
  return `${base}${PUBLIC_CONFIGURATION_PATH}/${encodeURIComponent(embedId)}`;
}

export type AssistantSessionSource =
  | { readonly kind: 'exchange'; readonly url: string }
  | { readonly kind: 'public'; readonly url: string; readonly embedId: string };

/** The exclusive choice, expressed so the wrong pair does not typecheck in the first place. */
export type AssistantSessionSourceOptions =
  | {
      /** The customer backend route that exchanges an embed secret for a session. */
      readonly sessionEndpoint: string;
      readonly embedId?: undefined;
      readonly serviceUrl?: undefined;
    }
  | {
      /** The non-secret public embed id `noodle deploy` printed. Safe in page source. */
      readonly embedId: string;
      /** Defaults to the hosted service; set it for a dev or self-hosted deployment. */
      readonly serviceUrl?: string | undefined;
      readonly sessionEndpoint?: undefined;
    };

export function resolveSessionSource(
  options: Partial<{
    sessionEndpoint: string | undefined;
    embedId: string | undefined;
    serviceUrl: string | undefined;
  }>,
): AssistantSessionSource {
  const { sessionEndpoint, embedId, serviceUrl } = options;
  if (Boolean(embedId) === Boolean(sessionEndpoint)) {
    throw new Error('pass either embedId or sessionEndpoint, not both and not neither');
  }
  if (embedId) {
    const base = (serviceUrl ?? NOODLE_CLOUD_URL).replace(/\/+$/, '');
    return { kind: 'public', url: `${base}${PUBLIC_SESSION_PATH}`, embedId };
  }
  return { kind: 'exchange', url: sessionEndpoint as string };
}

/**
 * A stable identity for a source, so a mounted client can be cached by it and discarded when the host
 * repoints the element. Keyed on all three fields: switching a page from an in-app endpoint to a public
 * embed id must invalidate the client, not silently keep the old transport.
 */
export function sessionSourceKey(options: {
  readonly sessionEndpoint?: string | undefined;
  readonly embedId?: string | undefined;
  readonly serviceUrl?: string | undefined;
}): string {
  return `${options.embedId ?? ''}|${options.serviceUrl ?? ''}|${options.sessionEndpoint ?? ''}`;
}
