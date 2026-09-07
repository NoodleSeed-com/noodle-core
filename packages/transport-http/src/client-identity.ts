import { CLIENT_FAMILY_OTHER, CLIENT_FAMILY_UNKNOWN } from '@noodle-borg/module';

/**
 * Safe client attribution for request analytics (issue #1309): bounded projections of MCP
 * `clientInfo` and of the transport user agent, plus the best-effort session→clientInfo memo that
 * lets legacy-era requests after `initialize` keep their client identity. Nothing here ever retains
 * a raw user-agent string, and every retained value is length-bounded and control-character free.
 */

const MAX_CLIENT_NAME = 128;
const MAX_CLIENT_VERSION = 64;
const MAX_FAMILY = 32;

/**
 * Known HTTP client user agents, matched case-insensitively against the user-agent prefix tokens.
 * A closed table keeps the retained cardinality bounded: anything else becomes `other`, an absent
 * user agent becomes `unknown`. Order matters — first match wins.
 */
const KNOWN_UA_FAMILIES: readonly (readonly [pattern: RegExp, family: string])[] = [
  [/claude/i, 'claude'],
  [/anthropic/i, 'anthropic-sdk'],
  [/openai/i, 'openai'],
  [/mcp-inspector|inspector/i, 'mcp-inspector'],
  [/undici/i, 'undici'],
  [/node-fetch/i, 'node-fetch'],
  [/\bnode\b|nodejs/i, 'node'],
  [/\bbun\b/i, 'bun'],
  [/\bdeno\b/i, 'deno'],
  [/python-httpx|\bhttpx\b/i, 'python-httpx'],
  [/python-requests/i, 'python-requests'],
  [/python-urllib|python/i, 'python'],
  [/axios/i, 'axios'],
  [/\bgot\b/i, 'got'],
  [/curl/i, 'curl'],
  [/wget/i, 'wget'],
  [/postman/i, 'postman'],
  [/insomnia/i, 'insomnia'],
  [/go-http-client/i, 'go-http-client'],
  [/okhttp/i, 'okhttp'],
  [/java/i, 'java'],
  [/mozilla|chrome|safari|firefox|edg/i, 'browser'],
];

/** Bound a wire-supplied client identity scalar: printable, trimmed, and length-capped. */
function boundedClientScalar(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  let cleaned = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) cleaned += char; // strip C0 controls and DEL
  }
  cleaned = cleaned.trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

export function boundedClientName(value: string | undefined): string | undefined {
  return boundedClientScalar(value, MAX_CLIENT_NAME);
}

export function boundedClientVersion(value: string | undefined): string | undefined {
  return boundedClientScalar(value, MAX_CLIENT_VERSION);
}

/**
 * The bounded client family for one request. `clientInfo.name` wins (its sanitized token — the name
 * itself is already retained, so the family adds no cardinality); otherwise the user agent maps
 * through the closed table above; `other` for an unmatched agent, `unknown` for none at all.
 */
export function clientFamily(
  clientName: string | undefined,
  userAgent: string | undefined,
): string {
  if (clientName !== undefined) {
    const token = clientName
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_FAMILY);
    if (token.length > 0) return token;
  }
  if (userAgent === undefined || userAgent.trim().length === 0) return CLIENT_FAMILY_UNKNOWN;
  for (const [pattern, family] of KNOWN_UA_FAMILIES) {
    if (pattern.test(userAgent)) return family;
  }
  return CLIENT_FAMILY_OTHER;
}

export interface MemoizedClientIdentity {
  readonly clientName?: string;
  readonly clientVersion?: string;
}

/**
 * Bounded, best-effort LRU memo from an analytics session id to the `initialize` client identity,
 * keyed per tenant so one tenant's session ids can never resolve another's client names. Purely an
 * attribution aid: entries are non-authoritative, evicted oldest-first, and never required.
 */
export class SessionClientMemo {
  readonly #entries = new Map<string, MemoizedClientIdentity>();
  readonly #cap: number;

  constructor(cap = 2048) {
    this.#cap = cap;
  }

  remember(key: string, identity: MemoizedClientIdentity): void {
    if (identity.clientName === undefined && identity.clientVersion === undefined) return;
    if (this.#entries.has(key)) this.#entries.delete(key);
    this.#entries.set(key, identity);
    if (this.#entries.size > this.#cap) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
  }

  recall(key: string): MemoizedClientIdentity | undefined {
    const found = this.#entries.get(key);
    if (found !== undefined) {
      // Refresh recency so active sessions survive eviction pressure.
      this.#entries.delete(key);
      this.#entries.set(key, found);
    }
    return found;
  }

  get size(): number {
    return this.#entries.size;
  }
}

/** Tenant-scoped memo key; the org always participates so keys cannot collide across tenants. */
export function sessionClientKey(
  org: string,
  app: string | undefined,
  env: string | undefined,
  sessionId: string,
): string {
  return `${org}/${app ?? ''}/${env ?? ''}#${sessionId}`;
}
