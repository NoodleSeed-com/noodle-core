import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DevtoolsAuthSession } from './devtools-auth-session.js';

const FIREBASE_CALLBACK_MAX_BYTES = 192 * 1_024;

export function handleDevtoolsAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  session: DevtoolsAuthSession | undefined,
  previewOrigin: string,
  callbackPath: string,
): boolean {
  if (session === undefined || !url.pathname.startsWith('/auth/')) return false;
  if (req.method === 'GET' && url.pathname === '/auth/status') {
    writeJson(res, 200, session.status());
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/auth/start') {
    session
      .start(url.searchParams.get('issuer') ?? undefined)
      .then((authorizationUrl) => {
        const status = session.status();
        writeJson(res, 200, {
          authorizationUrl,
          issuer: status.issuer,
          ...(status.method !== undefined ? { method: status.method } : {}),
          ...(status.issuers !== undefined ? { issuers: status.issuers } : {}),
          scopes: status.scopes,
        });
      })
      .catch((error: unknown) => {
        writeJson(res, 400, {
          error: {
            code: 'auth_start_failed',
            message: safeMessage(error, 'Could not start sign-in'),
          },
        });
      });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/auth/logout') {
    session.clear();
    writeJson(res, 200, { ok: true });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/auth/firebase/authorize') {
    const page = session.firebaseAuthorizationPage(
      new URL(`${url.pathname}${url.search}`, previewOrigin),
    );
    if (page === undefined) return false;
    writeHtml(res, page.status, page.html, firebasePageCsp());
    return true;
  }
  if (url.pathname === callbackPath && session.callbackTransport() === 'form_post') {
    if (req.method !== 'POST') {
      writePlain(res, 405, 'method not allowed');
      return true;
    }
    readFirebaseCallback(req)
      .then((callback) => session.completeFirebase(callback))
      .then(() => writeCallback(res, true, previewOrigin, session.status()))
      .catch((error: unknown) => {
        if (error instanceof FirebaseCallbackRequestError) {
          writePlain(res, error.status, error.message);
          return;
        }
        writeCallback(res, false, previewOrigin, session.status());
      });
    return true;
  }
  if (url.pathname === callbackPath && session.callbackTransport() === 'query') {
    if (req.method !== 'GET') {
      writePlain(res, 405, 'method not allowed');
      return true;
    }
    const callbackUrl = new URL(`${url.pathname}${url.search}`, previewOrigin).href;
    session
      .complete(callbackUrl)
      .then(() => writeCallback(res, true, previewOrigin, session.status()))
      .catch(() => writeCallback(res, false, previewOrigin, session.status()));
    return true;
  }
  return false;
}

function writeCallback(
  res: ServerResponse,
  ok: boolean,
  previewOrigin: string,
  status: ReturnType<DevtoolsAuthSession['status']>,
): void {
  const title = ok ? 'Signed in' : 'Sign-in failed';
  const detail = ok
    ? 'You can close this window and continue testing.'
    : (status.message ?? 'Return to Devtools and try signing in again.');
  const code = !ok && status.errorCode ? `<p class="code">${escapeHtml(status.errorCode)}</p>` : '';
  const closeScript = ok ? 'setTimeout(function(){window.close();},250);' : '';
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${title} · Noodle Seed Devtools</title>` +
    '<style>body{margin:0;display:grid;min-height:100vh;place-items:center;background:#09090b;color:#f7f7f8;font:14px system-ui,sans-serif}.card{max-width:420px;padding:28px;text-align:center}h1{font-size:22px}p{color:#a1a1aa;line-height:1.6}.code{display:inline-block;margin:4px 0 0;padding:5px 8px;border:1px solid #3f3f46;border-radius:7px;color:#fca5a5;font:12px ui-monospace,monospace}</style>' +
    `</head><body><main class="card"><h1>${title}</h1>${code}<p>${escapeHtml(detail)}</p></main>` +
    `<script>try{if(window.opener){window.opener.postMessage({type:"noodle:auth-complete",ok:${ok ? 'true' : 'false'}},${JSON.stringify(previewOrigin)});${closeScript}}}catch(e){}</script>` +
    '</body></html>';
  writeHtml(
    res,
    ok ? 200 : 400,
    html,
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0
    ? error.message.slice(0, 240)
    : fallback;
}

class FirebaseCallbackRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readFirebaseCallback(req: IncomingMessage): Promise<{
  readonly state: string;
  readonly idToken?: string;
  readonly refreshToken?: string;
  readonly expiresIn?: number;
  readonly error?: string;
}> {
  const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/x-www-form-urlencoded') {
    return Promise.reject(new FirebaseCallbackRequestError(415, 'unsupported content type'));
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > FIREBASE_CALLBACK_MAX_BYTES) {
    req.resume();
    return Promise.reject(
      new FirebaseCallbackRequestError(413, 'authorization response too large'),
    );
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > FIREBASE_CALLBACK_MAX_BYTES) {
        settled = true;
        reject(new FirebaseCallbackRequestError(413, 'authorization response too large'));
        req.resume();
        return;
      }
      chunks.push(bytes);
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const fields = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const state = fields.get('state') ?? '';
      const idToken = fields.get('id_token') ?? undefined;
      const refreshToken = fields.get('refresh_token') || undefined;
      const error = fields.get('error') ?? undefined;
      const expiresRaw = fields.get('expires_in');
      const expiresIn = expiresRaw === null || expiresRaw === '' ? undefined : Number(expiresRaw);
      resolve({
        state,
        ...(idToken === undefined ? {} : { idToken }),
        ...(refreshToken === undefined ? {} : { refreshToken }),
        ...(expiresIn === undefined ? {} : { expiresIn }),
        ...(error === undefined ? {} : { error }),
      });
    });
  });
}

function writeHtml(res: ServerResponse, status: number, html: string, csp: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': csp,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  res.end(html);
}

function writePlain(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  res.end(message);
}

function firebasePageCsp(): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline' https://www.gstatic.com https://apis.google.com",
    "connect-src 'self' https: wss:",
    'frame-src https:',
    'img-src data: https:',
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ');
}
