import type { Request } from 'express';
import type { TenantBridgeAuthConfig } from '../store.js';
import { renderOAuthPage } from './branding.js';

const FIREBASE_AUTHORIZE_PATH = '/oauth/customer/firebase/authorize';
const FIREBASE_CALLBACK_PATH = '/oauth/customer/firebase/callback';
const MICROSOFT_CALLBACK_PATH = '/oauth/customer/microsoft/callback';
const MICROSOFT_REQUIRED_SCOPES = ['openid', 'profile', 'email', 'offline_access'] as const;

export function bridgeAuthorizeUrl(
  auth: TenantBridgeAuthConfig,
  input: { issuer: string; state: string; resource: string; clientId: string },
): string | undefined {
  const issuer = trimTrailingSlash(input.issuer);
  if (auth.provider === 'microsoft') {
    return microsoftAuthorizeUrl(auth, {
      state: input.state,
      redirectUri: microsoftCallbackUrl(issuer),
    });
  }
  if (auth.provider !== 'firebase') return undefined;
  if (auth.authorizeUrl === undefined && !hasHostedFirebaseConfig(auth)) return undefined;
  const url = new URL(auth.authorizeUrl ?? `${issuer}${FIREBASE_AUTHORIZE_PATH}`);
  url.searchParams.set('state', input.state);
  url.searchParams.set('redirect_uri', firebaseCallbackUrl(issuer));
  url.searchParams.set('resource', input.resource);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('provider', auth.provider);
  if (auth.projectId !== undefined) url.searchParams.set('project_id', auth.projectId);
  if (auth.tenantId !== undefined) url.searchParams.set('tenant_id', auth.tenantId);
  return url.href;
}

export function customerBridgeAuthorizeFields(req: Request): {
  readonly state?: string;
  readonly redirect_uri?: string;
  readonly resource?: string;
  readonly client_id?: string;
} {
  return {
    ...(typeof req.query.state === 'string' ? { state: req.query.state } : {}),
    ...(typeof req.query.redirect_uri === 'string' ? { redirect_uri: req.query.redirect_uri } : {}),
    ...(typeof req.query.resource === 'string' ? { resource: req.query.resource } : {}),
    ...(typeof req.query.client_id === 'string' ? { client_id: req.query.client_id } : {}),
  };
}

export function customerBridgeCallbackFields(req: Request): {
  readonly state?: string;
  readonly code?: string;
  readonly id_token?: string;
  readonly refresh_token?: string;
  readonly error?: string;
} {
  const body = (req.body ?? {}) as Record<string, unknown>;
  return {
    ...(typeof body.state === 'string'
      ? { state: body.state }
      : typeof req.query.state === 'string'
        ? { state: req.query.state }
        : {}),
    ...(typeof body.code === 'string'
      ? { code: body.code }
      : typeof req.query.code === 'string'
        ? { code: req.query.code }
        : {}),
    ...(typeof body.id_token === 'string'
      ? { id_token: body.id_token }
      : typeof req.query.id_token === 'string'
        ? { id_token: req.query.id_token }
        : {}),
    ...(typeof body.refresh_token === 'string'
      ? { refresh_token: body.refresh_token }
      : typeof req.query.refresh_token === 'string'
        ? { refresh_token: req.query.refresh_token }
        : {}),
    ...(typeof body.error === 'string'
      ? { error: body.error }
      : typeof req.query.error === 'string'
        ? { error: req.query.error }
        : {}),
  };
}

export function renderFirebaseAuthorizePage(input: {
  readonly issuer: string;
  readonly auth?: TenantBridgeAuthConfig | undefined;
  readonly state?: string | undefined;
  readonly redirectUri?: string | undefined;
  readonly resource?: string | undefined;
  readonly clientId?: string | undefined;
}): { readonly status: number; readonly html: string } {
  const issuer = trimTrailingSlash(input.issuer);
  const expectedRedirectUri = firebaseCallbackUrl(issuer);
  const error = firebaseAuthorizeError(input, expectedRedirectUri);
  const config =
    input.auth !== undefined && input.auth.provider === 'firebase'
      ? firebaseWebConfig(input.auth)
      : undefined;
  const disabled = error !== undefined;
  const title = disabled ? 'Customer sign-in unavailable' : 'Continue to sign in';
  const details = disabled
    ? error
    : 'Sign in with the account you use for this app. Noodle Cloud will verify your identity and return you to your MCP client.';
  return {
    status: disabled ? 400 : 200,
    html: htmlPage({
      title,
      details,
      expectedRedirectUri,
      state: input.state ?? '',
      config,
      tenantId: input.auth?.tenantId,
      disabled,
    }),
  };
}

function firebaseAuthorizeError(
  input: {
    readonly auth?: TenantBridgeAuthConfig | undefined;
    readonly state?: string | undefined;
    readonly redirectUri?: string | undefined;
    readonly resource?: string | undefined;
  },
  expectedRedirectUri: string,
): string | undefined {
  if (!input.state) return 'Missing authorization state.';
  if (!input.resource) return 'Missing resource.';
  if (input.redirectUri !== expectedRedirectUri) {
    return 'This authorization request did not come from Noodle Cloud.';
  }
  if (input.auth === undefined || input.auth.provider !== 'firebase') {
    return 'Customer Firebase authentication is not configured for this resource.';
  }
  if (!hasHostedFirebaseConfig(input.auth)) {
    return 'Customer Firebase authentication is missing Firebase Web configuration.';
  }
  return undefined;
}

function hasHostedFirebaseConfig(auth: TenantBridgeAuthConfig): boolean {
  return Boolean(auth.projectId && auth.apiKey);
}

function firebaseWebConfig(auth: TenantBridgeAuthConfig): Record<string, string> {
  const config: Record<string, string> = {
    apiKey: auth.apiKey ?? '',
    authDomain: auth.authDomain ?? `${auth.projectId}.firebaseapp.com`,
    projectId: auth.projectId ?? '',
  };
  if (auth.appId !== undefined) config.appId = auth.appId;
  return config;
}

function htmlPage(input: {
  readonly title: string;
  readonly details: string;
  readonly expectedRedirectUri: string;
  readonly state: string;
  readonly config?: Record<string, string> | undefined;
  readonly tenantId?: string | undefined;
  readonly disabled: boolean;
}): string {
  const configJson = safeScriptJson(input.config ?? {});
  const tenantJson = safeScriptJson(input.tenantId ?? null);
  const contentHtml = `<p class="ns-lede ${input.disabled ? 'ns-error' : ''}" id="status">${escapeHtml(input.details)}</p>
    <form id="firebase-auth-form" method="post" action="${escapeAttribute(input.expectedRedirectUri)}">
      <input type="hidden" name="state" value="${escapeAttribute(input.state)}">
      <input type="hidden" name="id_token" id="id-token">
      <input type="hidden" name="refresh_token" id="refresh-token">
      <div class="ns-row"><span class="btn-glow"><button type="button" id="firebase-sign-in" class="btn btn-primary" ${input.disabled ? 'disabled' : ''}><svg width="18" height="18" viewBox="0 0 18 18" style="flex:none" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.997 8.997 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/></svg>Continue with Google</button></span></div>
    </form>`;
  const scriptHtml = `<script type="module">
    const firebaseConfig = ${configJson};
    const tenantId = ${tenantJson};
    const disabled = ${JSON.stringify(input.disabled)};
    const status = document.getElementById('status');
    const button = document.getElementById('firebase-sign-in');
    const tokenInput = document.getElementById('id-token');
    const refreshInput = document.getElementById('refresh-token');
    const form = document.getElementById('firebase-auth-form');
    if (!disabled) {
      const [{ initializeApp }, { getAuth, GoogleAuthProvider, signInWithPopup }] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js'),
      ]);
      const app = initializeApp(firebaseConfig);
      const auth = getAuth(app);
      if (tenantId) auth.tenantId = tenantId;
      button.addEventListener('click', async () => {
        button.disabled = true;
        status.textContent = 'Opening sign-in...';
        try {
          const credential = await signInWithPopup(auth, new GoogleAuthProvider());
          tokenInput.value = await credential.user.getIdToken();
          refreshInput.value = credential.user.refreshToken || '';
          form.submit();
        } catch {
          status.textContent = 'Firebase sign-in failed. Please try again.';
          button.disabled = false;
        }
      });
    }
  </script>`;
  return renderOAuthPage({
    title: input.title,
    kicker: 'Sign in',
    heading: input.title,
    contentHtml,
    scriptHtml,
  });
}

function firebaseCallbackUrl(issuer: string): string {
  return `${issuer}${FIREBASE_CALLBACK_PATH}`;
}

export function microsoftCallbackUrl(issuer: string): string {
  return `${issuer}${MICROSOFT_CALLBACK_PATH}`;
}

export function microsoftTokenUrl(auth: TenantBridgeAuthConfig): string | undefined {
  if (auth.tokenUrl !== undefined) return auth.tokenUrl;
  if (auth.tenantId === undefined) return undefined;
  return `https://login.microsoftonline.com/${encodeURIComponent(auth.tenantId)}/oauth2/v2.0/token`;
}

export function microsoftIssuer(auth: TenantBridgeAuthConfig): string | undefined {
  return auth.provider === 'microsoft' ? bridgeCustomerIssuer(auth) : undefined;
}

/** Canonical upstream issuer bound to an identity after this resolved bridge verifies it. */
export function bridgeCustomerIssuer(auth: TenantBridgeAuthConfig): string | undefined {
  if (auth.provider === 'firebase') {
    return auth.projectId === undefined
      ? undefined
      : `https://securetoken.google.com/${encodeURIComponent(auth.projectId)}`;
  }
  if (auth.provider === 'microsoft') {
    return auth.tenantId === undefined
      ? undefined
      : `https://login.microsoftonline.com/${encodeURIComponent(auth.tenantId)}/v2.0`;
  }
  return undefined;
}

export function microsoftScopes(auth: TenantBridgeAuthConfig): readonly string[] {
  return unique([...MICROSOFT_REQUIRED_SCOPES, ...(auth.scopes ?? [])]);
}

function microsoftAuthorizeUrl(
  auth: TenantBridgeAuthConfig,
  input: { readonly state: string; readonly redirectUri: string },
): string | undefined {
  if (auth.clientId === undefined || auth.tenantId === undefined) return undefined;
  const url = new URL(
    auth.authorizeUrl ??
      `https://login.microsoftonline.com/${encodeURIComponent(auth.tenantId)}/oauth2/v2.0/authorize`,
  );
  url.searchParams.set('client_id', auth.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', microsoftScopes(auth).join(' '));
  url.searchParams.set('state', input.state);
  return url.href;
}

function unique(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function safeScriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}
