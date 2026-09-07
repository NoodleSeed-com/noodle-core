/**
 * Static OAuth client setup helpers for MCP clients whose UI cannot complete MCP
 * OAuth discovery and dynamic client registration by itself.
 */

const GEMINI_ENTERPRISE_REDIRECT_URIS = [
  'https://vertexaisearch.cloud.google.com/oauth-redirect',
  'https://vertexaisearch.cloud.google.com/static/oauth/oauth.html',
] as const;

export interface GeminiEnterpriseSetup {
  readonly client: 'gemini-enterprise';
  readonly title: 'Gemini Enterprise';
  readonly mcpServerUrl: string;
  readonly authorizationUrl: string;
  readonly authorizationUrlParameters: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly clientSecretExpiresAt?: number;
  readonly scopes: '';
  readonly pkce: true;
  readonly description: string;
  readonly instructions: string;
}

interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorizationServers: readonly string[];
}

interface AuthorizationServerMetadata {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint: string;
}

interface RegisteredOAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly clientSecretExpiresAt?: number;
  readonly defaultResource?: string;
}

function geminiEnterpriseRegistrationBody(
  endpointResource: string,
  displayName: string | undefined,
): Record<string, unknown> {
  const name = displayName?.trim();
  const namePart = name === undefined || name.length === 0 ? '' : `${name} `;
  return {
    client_name: `Gemini Enterprise MCP ${namePart}${endpointResource}`.trim(),
    application_type: 'web',
    redirect_uris: [...GEMINI_ENTERPRISE_REDIRECT_URIS],
    token_endpoint_auth_method: 'client_secret_post',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  };
}

export async function connectGeminiEnterprise(input: {
  readonly endpoint: string;
  readonly name?: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<GeminiEnterpriseSetup> {
  const endpoint = normalizeUrl(input.endpoint);
  const fetchImpl = input.fetchImpl ?? fetch;
  const protectedResource = await fetchProtectedResourceMetadata(fetchImpl, endpoint);
  const authorizationServerIssuer = protectedResource.authorizationServers[0];
  if (authorizationServerIssuer === undefined) {
    throw new Error('protected-resource metadata did not include an authorization server');
  }
  const authorizationServer = await fetchAuthorizationServerMetadata(
    fetchImpl,
    authorizationServerIssuer,
  );
  const client = await registerOAuthClient(
    fetchImpl,
    authorizationServer.registrationEndpoint,
    geminiEnterpriseRegistrationBody(protectedResource.resource, input.name),
  );
  return {
    client: 'gemini-enterprise',
    title: 'Gemini Enterprise',
    mcpServerUrl: endpoint,
    authorizationUrl: authorizationServer.authorizationEndpoint,
    authorizationUrlParameters:
      client.defaultResource === protectedResource.resource
        ? ''
        : `resource=${encodeURIComponent(protectedResource.resource)}`,
    tokenUrl: authorizationServer.tokenEndpoint,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    ...(client.clientSecretExpiresAt !== undefined
      ? { clientSecretExpiresAt: client.clientSecretExpiresAt }
      : {}),
    scopes: '',
    pkce: true,
    description: defaultGeminiDescription(),
    instructions: defaultGeminiInstructions(),
  };
}

function normalizeUrl(value: string): string {
  const url = new URL(value.trim());
  url.hash = '';
  return url.href.replace(/\/+$/, '');
}

async function fetchProtectedResourceMetadata(
  fetchImpl: typeof fetch,
  endpoint: string,
): Promise<ProtectedResourceMetadata> {
  const url = protectedResourceMetadataUrl(endpoint);
  const body = await fetchJson(fetchImpl, url, {
    headers: { accept: 'application/json' },
  });
  const resource = stringField(body, 'resource');
  const authorizationServers = stringArrayField(body, 'authorization_servers');
  if (resource === undefined) {
    throw new Error('protected-resource metadata did not include a resource URL');
  }
  if (authorizationServers.length === 0) {
    throw new Error('protected-resource metadata did not include an authorization server');
  }
  return { resource: normalizeUrl(resource), authorizationServers };
}

async function fetchAuthorizationServerMetadata(
  fetchImpl: typeof fetch,
  issuer: string,
): Promise<AuthorizationServerMetadata> {
  const body = await fetchJson(fetchImpl, authorizationServerMetadataUrl(issuer), {
    headers: { accept: 'application/json' },
  });
  const authorizationEndpoint = stringField(body, 'authorization_endpoint');
  const tokenEndpoint = stringField(body, 'token_endpoint');
  const registrationEndpoint = stringField(body, 'registration_endpoint');
  if (
    authorizationEndpoint === undefined ||
    tokenEndpoint === undefined ||
    registrationEndpoint === undefined
  ) {
    throw new Error('authorization-server metadata is missing OAuth endpoint URLs');
  }
  return { authorizationEndpoint, tokenEndpoint, registrationEndpoint };
}

async function registerOAuthClient(
  fetchImpl: typeof fetch,
  registrationEndpoint: string,
  body: Record<string, unknown>,
): Promise<RegisteredOAuthClient> {
  const json = await fetchJson(fetchImpl, registrationEndpoint, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const clientId = stringField(json, 'client_id');
  const clientSecret = stringField(json, 'client_secret');
  if (clientId === undefined || clientSecret === undefined) {
    throw new Error('OAuth client registration did not return a client ID and secret');
  }
  const expiresAt = numberField(json, 'client_secret_expires_at');
  const defaultResource = stringField(json, 'default_resource');
  return {
    clientId,
    clientSecret,
    ...(expiresAt !== undefined ? { clientSecretExpiresAt: expiresAt } : {}),
    ...(defaultResource !== undefined ? { defaultResource: normalizeUrl(defaultResource) } : {}),
  };
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, init);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const message = isRecord(body) ? stringField(body, 'error') : undefined;
    throw new Error(message ?? `HTTP ${res.status} from ${url}`);
  }
  if (!isRecord(body)) throw new Error(`expected JSON object from ${url}`);
  return body;
}

function protectedResourceMetadataUrl(endpoint: string): string {
  const url = new URL(endpoint);
  const endpointPath = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `${url.origin}/.well-known/oauth-protected-resource${endpointPath}`;
}

function authorizationServerMetadataUrl(issuer: string): string {
  const url = new URL(issuer);
  const issuerPath = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `${url.origin}/.well-known/oauth-authorization-server${issuerPath}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const raw = value[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const raw = value[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

function stringArrayField(value: Record<string, unknown>, key: string): readonly string[] {
  const raw = value[key];
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
}

function defaultGeminiDescription(): string {
  return [
    'Noodle MCP server hosted on Noodle Seed Cloud.',
    'It exposes the tools, resources, and prompts declared by the app developer through the Model Context Protocol.',
    'Authentication is handled with OAuth, and access is constrained by the server access mode and any downstream system permissions.',
  ].join(' ');
}

function defaultGeminiInstructions(): string {
  return [
    'Use this MCP server when the user request matches the server tools, resources, or prompts.',
    'Discover available MCP tools from the server, call the most specific tool for the task, and reuse returned IDs in follow-up calls.',
    'Respect OAuth-authenticated user access and do not assume access to resources not returned by the tools.',
  ].join(' ');
}
