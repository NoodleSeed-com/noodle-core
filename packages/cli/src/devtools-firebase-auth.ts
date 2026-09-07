import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { McpOAuthTokens } from '@noodle-borg/auth';

const FIREBASE_PENDING_TTL_MS = 10 * 60 * 1_000;
const FIREBASE_MAX_TOKEN_BYTES = 64 * 1_024;
const FIREBASE_MAX_RESPONSE_BYTES = 64 * 1_024;
const FIREBASE_REFRESH_URL = 'https://securetoken.googleapis.com/v1/token';

export interface DevtoolsFirebaseAuthConfig {
  readonly kind: 'firebase';
  readonly projectId: string;
  /** Firebase Web API keys are public client configuration, not service credentials. */
  readonly apiKey: string;
  readonly authDomain?: string;
  readonly appId?: string;
  readonly tenantId?: string;
  /** Optional customer-owned Firebase sign-in UI. It must form-post tokens to `redirect_uri`. */
  readonly authorizeUrl?: string;
  /** Opaque local-only revision used to clear credentials when verification configuration changes. */
  readonly configurationKey?: string;
  /** Test/self-host seam. Customer-owned authorization pages must otherwise use HTTPS. */
  readonly allowInsecureLocalhost?: boolean;
}

export interface DevtoolsFirebasePendingAuthorization {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly expiresAt: number;
}

export interface DevtoolsFirebaseCallback {
  readonly state: string;
  readonly idToken?: string;
  readonly refreshToken?: string;
  readonly expiresIn?: number;
  readonly error?: string;
}

export interface DevtoolsFirebaseAuthorizationPage {
  readonly status: number;
  readonly html: string;
}

export interface DevtoolsFirebaseDriver {
  beginAuthorization(): DevtoolsFirebasePendingAuthorization;
  completeAuthorization(
    pending: DevtoolsFirebasePendingAuthorization,
    callback: DevtoolsFirebaseCallback,
  ): Promise<McpOAuthTokens>;
  refresh(current: McpOAuthTokens): Promise<McpOAuthTokens>;
  renderAuthorizationPage(
    url: URL,
    pending: DevtoolsFirebasePendingAuthorization,
  ): DevtoolsFirebaseAuthorizationPage | undefined;
}

/** Local Firebase adapter. ID/refresh tokens never leave the loopback process after callback receipt. */
export class FirebaseDevtoolsAuthDriver implements DevtoolsFirebaseDriver {
  readonly #auth: DevtoolsFirebaseAuthConfig;
  readonly #resource: string;
  readonly #redirectUri: string;
  readonly #localAuthorizeUrl: string;
  readonly #fetchFn: typeof fetch;
  readonly #now: () => number;
  readonly #stateFactory: () => string;

  constructor(options: {
    readonly auth: DevtoolsFirebaseAuthConfig;
    readonly resource: string;
    readonly redirectUri: string;
    readonly fetchFn?: typeof fetch;
    readonly now?: () => number;
    readonly stateFactory?: () => string;
  }) {
    this.#auth = options.auth;
    this.#resource = options.resource;
    this.#redirectUri = options.redirectUri;
    this.#localAuthorizeUrl = new URL('/auth/firebase/authorize', options.redirectUri).href;
    this.#fetchFn = options.fetchFn ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#stateFactory = options.stateFactory ?? (() => randomBytes(32).toString('base64url'));
  }

  beginAuthorization(): DevtoolsFirebasePendingAuthorization {
    const state = this.#stateFactory();
    if (state.length < 16 || state.length > 256) throw new Error('Could not create Firebase state');
    const configuredAuthorizeUrl = this.#auth.authorizeUrl;
    if (configuredAuthorizeUrl !== undefined) {
      assertTrustedAuthorizeUrl(configuredAuthorizeUrl, this.#auth.allowInsecureLocalhost === true);
    }
    const authorizationUrl = new URL(configuredAuthorizeUrl ?? this.#localAuthorizeUrl);
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('redirect_uri', this.#redirectUri);
    authorizationUrl.searchParams.set('resource', this.#resource);
    authorizationUrl.searchParams.set('provider', 'firebase');
    authorizationUrl.searchParams.set('project_id', this.#auth.projectId);
    if (this.#auth.tenantId !== undefined) {
      authorizationUrl.searchParams.set('tenant_id', this.#auth.tenantId);
    }
    return {
      authorizationUrl: authorizationUrl.href,
      state,
      expiresAt: this.#now() + FIREBASE_PENDING_TTL_MS,
    };
  }

  async completeAuthorization(
    pending: DevtoolsFirebasePendingAuthorization,
    callback: DevtoolsFirebaseCallback,
  ): Promise<McpOAuthTokens> {
    if (pending.expiresAt <= this.#now()) throw new Error('Firebase authorization request expired');
    if (!constantTimeStringEqual(callback.state, pending.state)) {
      throw new Error('Firebase callback does not match the active sign-in');
    }
    if (callback.error !== undefined) throw new Error('Firebase sign-in was cancelled or denied');
    const idToken = requireBoundedToken(callback.idToken, 'Firebase ID token');
    const refreshToken = optionalBoundedToken(callback.refreshToken, 'Firebase refresh token');
    const expiresIn = positiveExpiresIn(callback.expiresIn);
    return {
      accessToken: idToken,
      ...(refreshToken === undefined ? {} : { refreshToken }),
      tokenType: 'Bearer',
      ...(expiresIn === undefined ? {} : { expiresAt: this.#now() + expiresIn * 1_000 }),
      scope: [],
    };
  }

  async refresh(current: McpOAuthTokens): Promise<McpOAuthTokens> {
    const refreshToken = requireBoundedToken(current.refreshToken, 'Firebase refresh token');
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    const endpoint = new URL(FIREBASE_REFRESH_URL);
    endpoint.searchParams.set('key', this.#auth.apiKey);
    const response = await this.#fetchFn(endpoint.href, {
      method: 'POST',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'noodleseed-devtools/firebase',
      },
      body: params.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await boundedResponseText(response, FIREBASE_MAX_RESPONSE_BYTES);
    if (!response.ok) throw new Error(`Firebase refresh failed with status ${response.status}`);
    const body = parseJsonRecord(text);
    const idToken = requireBoundedToken(body.id_token, 'Firebase refresh ID token');
    const rotatedRefresh = requireBoundedToken(
      body.refresh_token,
      'Firebase rotated refresh token',
    );
    const expiresIn = positiveExpiresIn(
      typeof body.expires_in === 'string' ? Number(body.expires_in) : body.expires_in,
    );
    return {
      accessToken: idToken,
      refreshToken: rotatedRefresh,
      tokenType: 'Bearer',
      expiresAt: this.#now() + (expiresIn ?? 3_600) * 1_000,
      scope: [],
    };
  }

  renderAuthorizationPage(
    url: URL,
    pending: DevtoolsFirebasePendingAuthorization,
  ): DevtoolsFirebaseAuthorizationPage | undefined {
    if (this.#auth.authorizeUrl !== undefined) return undefined;
    const expected = new URL(this.#localAuthorizeUrl);
    if (url.origin !== expected.origin || url.pathname !== expected.pathname) return undefined;
    const valid =
      pending.expiresAt > this.#now() &&
      constantTimeStringEqual(url.searchParams.get('state') ?? '', pending.state) &&
      url.searchParams.get('redirect_uri') === this.#redirectUri &&
      url.searchParams.get('resource') === this.#resource &&
      url.searchParams.get('provider') === 'firebase' &&
      url.searchParams.get('project_id') === this.#auth.projectId;
    return valid
      ? { status: 200, html: renderFirebasePage(this.#auth, pending.state, this.#redirectUri) }
      : { status: 400, html: renderFirebaseErrorPage() };
  }
}

function renderFirebasePage(
  auth: DevtoolsFirebaseAuthConfig,
  state: string,
  redirectUri: string,
): string {
  const nonce = randomBytes(18).toString('base64url');
  const config = {
    apiKey: auth.apiKey,
    authDomain: auth.authDomain ?? `${auth.projectId}.firebaseapp.com`,
    projectId: auth.projectId,
    ...(auth.appId === undefined ? {} : { appId: auth.appId }),
  };
  const authOrigin = firebaseAuthOrigin(config.authDomain);
  const redirectOrigin = new URL(redirectUri).origin;
  const contentSecurityPolicy = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' https://www.gstatic.com https://apis.google.com`,
    `style-src 'nonce-${nonce}'`,
    `connect-src https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com https://accounts.google.com ${authOrigin}`,
    `frame-src ${authOrigin} https://accounts.google.com`,
    `form-action ${redirectOrigin}`,
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(contentSecurityPolicy)}"><title>Firebase sign-in · Noodle Seed Devtools</title><style nonce="${nonce}">${FIREBASE_PAGE_STYLES}</style></head><body><main><p class="eyebrow">Local Devtools</p><h1>Sign in to your app</h1><p id="status">Continue with the Firebase account you use for this app. The resulting token stays in this local process.</p><form id="firebase-form" method="post" action="${escapeHtml(redirectUri)}"><input type="hidden" name="state" value="${escapeHtml(state)}"><input type="hidden" id="id-token" name="id_token"><input type="hidden" id="refresh-token" name="refresh_token"><input type="hidden" id="expires-in" name="expires_in"><button id="firebase-sign-in" type="button">Continue with Google</button></form><p class="note">Using another Firebase sign-in method? Configure <code>authorizeUrl</code> with your app's existing auth UI.</p></main><script nonce="${nonce}" type="module">const firebaseConfig=${safeScriptJson(config)};const tenantId=${safeScriptJson(auth.tenantId ?? null)};const status=document.getElementById("status");const button=document.getElementById("firebase-sign-in");const form=document.getElementById("firebase-form");try{const [{initializeApp},{getAuth,GoogleAuthProvider,signInWithPopup}]=await Promise.all([import("https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js"),import("https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js")]);const firebaseAuth=getAuth(initializeApp(firebaseConfig));if(tenantId)firebaseAuth.tenantId=tenantId;button.addEventListener("click",async()=>{button.disabled=true;button.textContent="Waiting for sign-in…";status.textContent="Finish signing in in the new window.";try{const credential=await signInWithPopup(firebaseAuth,new GoogleAuthProvider());document.getElementById("id-token").value=await credential.user.getIdToken();document.getElementById("refresh-token").value=credential.user.refreshToken||"";const result=await credential.user.getIdTokenResult();document.getElementById("expires-in").value=String(Math.max(1,Math.floor((Date.parse(result.expirationTime)-Date.now())/1000)));form.submit();}catch(error){status.textContent="Firebase sign-in failed. Please try again.";button.disabled=false;button.textContent="Continue with Google";}});}catch(error){status.textContent="Could not load Firebase sign-in. Check your network and Firebase Web configuration.";button.disabled=true;}</script></body></html>`;
}

function renderFirebaseErrorPage(): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Authorization expired</title><style>' +
    FIREBASE_PAGE_STYLES +
    '</style></head><body><main><h1>Authorization request expired</h1><p>Return to Devtools and start a fresh sign-in.</p></main></body></html>'
  );
}

const FIREBASE_PAGE_STYLES =
  ':root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#09090b;color:#fafafa;font:14px system-ui,sans-serif}main{width:min(420px,100%);padding:30px;border:1px solid #27272a;border-radius:22px;background:#111113;box-shadow:0 24px 80px #0008}h1{margin:4px 0 10px;font-size:24px}p{color:#a1a1aa;line-height:1.6}.eyebrow{margin:0;color:#f97316;font-size:11px;text-transform:uppercase;letter-spacing:.14em}button{width:100%;margin-top:18px;padding:12px 16px;border:0;border-radius:999px;background:#fafafa;color:#09090b;font:600 14px system-ui;cursor:pointer}button:disabled{cursor:wait;opacity:.65}.note{margin:18px 0 0;padding-top:16px;border-top:1px solid #27272a;font-size:12px}code{color:#d4d4d8}';

function firebaseAuthOrigin(value: string): string {
  const url = new URL(value.includes('://') ? value : `https://${value}`);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('Firebase authDomain must be an HTTPS origin or hostname');
  }
  return url.origin;
}

function assertTrustedAuthorizeUrl(value: string, allowInsecureLocalhost: boolean): void {
  const url = new URL(value);
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && allowInsecureLocalhost && isLoopbackHostname(url.hostname))
    return;
  throw new Error('Firebase authorizeUrl must use HTTPS');
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function requireBoundedToken(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is missing`);
  if (Buffer.byteLength(value, 'utf8') > FIREBASE_MAX_TOKEN_BYTES) {
    throw new Error(`${name} is too large`);
  }
  return value;
}

function optionalBoundedToken(value: unknown, name: string): string | undefined {
  return value === undefined || value === '' ? undefined : requireBoundedToken(value, name);
}

function positiveExpiresIn(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 86_400) {
    throw new Error('Firebase token lifetime is invalid');
  }
  return Math.floor(value);
}

async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new Error('Firebase response is too large');
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error('Firebase response is too large');
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to a stable, credential-free error.
  }
  throw new Error('Firebase returned an invalid refresh response');
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeScriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}
