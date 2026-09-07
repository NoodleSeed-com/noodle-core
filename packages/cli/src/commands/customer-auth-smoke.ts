import { MODERN_MCP_PROTOCOL_VERSION } from '@noodle-borg/protocol';

const MAX_METADATA_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

type CustomerAuthSmokeFailureReason =
  | 'request_failed'
  | 'expected_unauthorized'
  | 'resource_metadata_missing'
  | 'resource_metadata_mismatch'
  | 'metadata_request_failed'
  | 'metadata_invalid'
  | 'resource_mismatch'
  | 'authorization_server_missing'
  | 'authorization_server_mismatch';

export type CustomerAuthSmokeResult =
  | {
      readonly ok: true;
      readonly resource: string;
      readonly resourceMetadataUrl: string;
      readonly authorizationServers: readonly string[];
      readonly scopesSupported: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: CustomerAuthSmokeFailureReason;
      readonly message: string;
      readonly status?: number;
    };

/**
 * Prove that a local customer-auth app fails closed and publishes exact protected-resource metadata.
 * This deliberately does not mint a token, register a client, or follow a challenge-selected URL.
 */
export async function probeLocalCustomerAuthBoundary(
  endpoint: string,
  options: {
    readonly fetchFn?: typeof fetch;
    readonly expectedAuthorizationServers?: readonly string[];
  } = {},
): Promise<CustomerAuthSmokeResult> {
  const fetchFn = options.fetchFn ?? fetch;
  let resource: URL;
  try {
    resource = new URL(endpoint);
  } catch {
    return failure('request_failed', 'The local MCP endpoint is not a valid URL.');
  }
  const resourceMetadataUrl = `${resource.origin}/.well-known/oauth-protected-resource${resource.pathname}`;

  let challenge: Response;
  try {
    challenge = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': MODERN_MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'noodle-customer-auth-smoke',
        method: 'initialize',
        params: {
          protocolVersion: MODERN_MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'noodle-customer-auth-smoke', version: '1.0.0' },
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return failure(
      'request_failed',
      'The local MCP protection probe could not reach the endpoint.',
    );
  }

  if (challenge.status !== 401) {
    await challenge.body?.cancel().catch(() => {});
    return failure(
      'expected_unauthorized',
      'The customer-auth endpoint did not reject an anonymous MCP request.',
      challenge.status,
    );
  }
  const advertisedMetadata = bearerParameter(
    challenge.headers.get('www-authenticate'),
    'resource_metadata',
  );
  await challenge.body?.cancel().catch(() => {});
  if (advertisedMetadata === undefined) {
    return failure(
      'resource_metadata_missing',
      'The unauthorized response did not advertise protected-resource metadata.',
      challenge.status,
    );
  }
  if (advertisedMetadata !== resourceMetadataUrl) {
    return failure(
      'resource_metadata_mismatch',
      'The unauthorized response did not advertise the exact local protected-resource metadata URL.',
      challenge.status,
    );
  }

  let metadataResponse: Response;
  try {
    metadataResponse = await fetchFn(resourceMetadataUrl, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return failure(
      'metadata_request_failed',
      'The local protected-resource metadata could not be loaded.',
    );
  }
  if (!metadataResponse.ok) {
    await metadataResponse.body?.cancel().catch(() => {});
    return failure(
      'metadata_request_failed',
      'The local protected-resource metadata did not return HTTP 200.',
      metadataResponse.status,
    );
  }
  const metadata = await boundedJsonObject(metadataResponse);
  if (metadata === undefined) {
    return failure(
      'metadata_invalid',
      'The local protected-resource metadata was not a bounded JSON object.',
      metadataResponse.status,
    );
  }
  if (metadata.resource !== endpoint) {
    return failure(
      'resource_mismatch',
      'The protected-resource metadata did not bind the exact local MCP endpoint.',
      metadataResponse.status,
    );
  }
  const authorizationServers = absoluteUrls(metadata.authorization_servers);
  if (authorizationServers === undefined) {
    return failure(
      'metadata_invalid',
      'The protected-resource metadata contained an invalid authorization server.',
      metadataResponse.status,
    );
  }
  if (options.expectedAuthorizationServers !== undefined && authorizationServers.length === 0) {
    return failure(
      'authorization_server_missing',
      'The protected-resource metadata did not advertise an authorization server.',
      metadataResponse.status,
    );
  }
  if (
    options.expectedAuthorizationServers !== undefined &&
    !sameStrings(authorizationServers, options.expectedAuthorizationServers)
  ) {
    return failure(
      'authorization_server_mismatch',
      'The protected-resource metadata did not advertise the configured authorization servers exactly.',
      metadataResponse.status,
    );
  }

  return {
    ok: true,
    resource: endpoint,
    resourceMetadataUrl,
    authorizationServers,
    scopesSupported: stringArray(metadata.scopes_supported),
  };
}

function failure(
  reason: CustomerAuthSmokeFailureReason,
  message: string,
  status?: number,
): CustomerAuthSmokeResult {
  return { ok: false, reason, message, ...(status === undefined ? {} : { status }) };
}

function bearerParameter(header: string | null, requestedName: string): string | undefined {
  if (header === null || !/^Bearer(?:\s|$)/iu.test(header)) return undefined;
  const raw = header.replace(/^Bearer\s*/iu, '');
  const pattern = /([A-Za-z][A-Za-z0-9_-]*)=(?:"((?:\\.|[^"])*)"|([^,\s]+))/gu;
  for (const match of raw.matchAll(pattern)) {
    if (match[1]?.toLowerCase() !== requestedName) continue;
    return match[2]?.replace(/\\(["\\])/gu, '$1') ?? match[3];
  }
  return undefined;
}

async function boundedJsonObject(response: Response): Promise<Record<string, unknown> | undefined> {
  const body = response.body;
  if (body === null) return undefined;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_METADATA_BYTES) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const raw = new TextDecoder().decode(bytes);
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function absoluteUrls(value: unknown): readonly string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const urls: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string' || candidate.length === 0) return undefined;
    try {
      const url = new URL(candidate);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    } catch {
      return undefined;
    }
    urls.push(candidate);
  }
  return urls;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0)),
  ];
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
