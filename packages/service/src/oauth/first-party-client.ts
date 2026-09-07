import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthStore } from './store.js';

const CLIENT_ID_PATTERN = /^[A-Za-z0-9._~-]{1,200}$/;

export type FirstPartyOAuthClientOwner = 'console' | 'portal';

const CLIENT_PRODUCTS: Readonly<
  Record<FirstPartyOAuthClientOwner, { readonly name: string; readonly callbackPath: string }>
> = {
  console: { name: 'Noodle Console', callbackPath: '/api/console/auth/callback' },
  portal: { name: 'Noodle Business Portal', callbackPath: '/api/portal/auth/callback' },
};

export interface FirstPartyOAuthClientInput {
  readonly owner: FirstPartyOAuthClientOwner;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly resource: string;
}

/** Build one exact server-owned public client for a first-party browser application's PKCE flow. */
export function resolveFirstPartyOAuthClient(
  input: FirstPartyOAuthClientInput,
): OAuthClientInformationFull {
  const clientId = input.clientId.trim();
  const product = CLIENT_PRODUCTS[input.owner];
  if (!CLIENT_ID_PATTERN.test(clientId)) throw invalidClient(product.name);
  const redirect = safeUrl(input.redirectUri, true, product.name);
  const resource = safeUrl(input.resource, false, product.name);
  if (
    redirect.pathname !== product.callbackPath ||
    resource.pathname !== '/' ||
    redirect.search !== '' ||
    redirect.hash !== '' ||
    resource.search !== '' ||
    resource.hash !== ''
  ) {
    throw invalidClient(product.name);
  }
  return {
    client_id: clientId,
    client_name: product.name,
    application_type: 'web',
    redirect_uris: [redirect.href],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    default_resource: resource.href,
  } as OAuthClientInformationFull;
}

/** Idempotently reconcile server-owned browser clients without taking over a DCR registration. */
export async function reconcileFirstPartyOAuthClient(
  store: Pick<OAuthStore, 'putFirstPartyClient'>,
  input: FirstPartyOAuthClientInput,
): Promise<OAuthClientInformationFull> {
  const client = resolveFirstPartyOAuthClient(input);
  return store.putFirstPartyClient(input.owner, client);
}

export async function reconcileConfiguredFirstPartyOAuthClients(
  store: Pick<OAuthStore, 'putFirstPartyClient'>,
  clients: Readonly<
    Partial<
      Record<
        FirstPartyOAuthClientOwner,
        { readonly clientId: string; readonly redirectUri: string }
      >
    >
  >,
  resource: string,
): Promise<void> {
  for (const owner of ['console', 'portal'] as const) {
    const client = clients[owner];
    if (client !== undefined) {
      await reconcileFirstPartyOAuthClient(store, { owner, ...client, resource });
    }
  }
}

function safeUrl(value: string, callback: boolean, productName: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidClient(productName);
  }
  const loopback = isLoopback(url.hostname);
  if (
    url.username !== '' ||
    url.password !== '' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    (!callback && url.pathname !== '/')
  ) {
    throw invalidClient(productName);
  }
  return url;
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.');
}

function invalidClient(productName: string): Error {
  return new Error(`${productName} OAuth client configuration is invalid`);
}
