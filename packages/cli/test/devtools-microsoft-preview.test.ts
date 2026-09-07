import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startPreview } from '../src/devtools-preview.js';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

describe('Microsoft-authenticated Devtools preview', () => {
  it('keeps the confidential credential server-side and injects only the Microsoft ID token', async () => {
    let idToken = '';
    let tokenRequest = '';
    const microsoft = await fakeServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/token') {
        res.writeHead(404).end();
        return;
      }
      tokenRequest = await requestText(req);
      writeJson(res, {
        token_type: 'Bearer',
        access_token: 'must-not-reach-mcp',
        refresh_token: 'microsoft-refresh-secret',
        id_token: idToken,
        expires_in: 3_600,
        scope: 'openid profile email offline_access',
      });
    });
    closers.push(microsoft.close);
    const mcpBearers: string[] = [];
    const mcp = await fakeServer(async (req, res) => {
      mcpBearers.push(req.headers.authorization ?? '');
      if (req.headers.authorization !== `Bearer ${idToken}` || idToken.length === 0) {
        res.writeHead(401, {
          'content-type': 'application/json',
          'www-authenticate': 'Bearer',
        });
        res.end(JSON.stringify({ error: 'authentication required' }));
        return;
      }
      const body = JSON.parse(await requestText(req)) as { id: unknown };
      writeJson(res, {
        jsonrpc: '2.0',
        id: body.id,
        result: { tools: [{ name: 'whoami', inputSchema: { type: 'object' } }] },
      });
    }, '/o/local/microsoft/dev/mcp');
    closers.push(mcp.close);
    const delegatedCredentialSink = {
      setCredential: vi.fn(async () => undefined),
      clearResource: vi.fn(() => undefined),
    };
    const preview = await startPreview({
      mcpUrl: mcp.url,
      theme: 'both',
      device: 'both',
      customerAuth: {
        kind: 'microsoft',
        tenantId: '11111111-2222-3333-4444-555555555555',
        clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        clientSecret: 'microsoft-client-secret',
        authorizeUrl: `${microsoft.origin}/authorize`,
        tokenUrl: `${microsoft.origin}/token`,
        allowInsecureLocalhost: true,
      },
      delegatedCredentialSink,
    });
    closers.push(preview.close);

    const shell = await (await fetch(preview.url)).text();
    const capability = shell.match(/var RPC_CAPABILITY="([^"]+)"/)?.[1] ?? '';
    const headers = { 'x-noodle-devtools-capability': capability };
    const before = await (await fetch(new URL('/auth/status', preview.url), { headers })).json();
    expect(before).toMatchObject({
      state: 'signed_out',
      method: 'microsoft',
      supported: true,
    });

    const start = await fetch(new URL('/auth/start', preview.url), { method: 'POST', headers });
    const startBody = (await start.json()) as { authorizationUrl: string };
    const authorize = new URL(startBody.authorizationUrl);
    const callback = new URL(authorize.searchParams.get('redirect_uri') ?? '');
    expect(callback.hostname).toBe('localhost');
    expect(callback.pathname).toBe('/auth/callback/microsoft');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{20,}$/u);
    expect(JSON.stringify(startBody)).not.toMatch(
      /microsoft-client-secret|microsoft-refresh-secret/u,
    );

    idToken = jwt({
      sub: 'microsoft-user',
      aud: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      iss: 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0',
      nonce: authorize.searchParams.get('nonce'),
      exp: Math.floor(Date.now() / 1_000) + 3_600,
    });
    callback.searchParams.set('code', 'microsoft-code');
    callback.searchParams.set('state', authorize.searchParams.get('state') ?? '');
    const callbackResponse = await fetch(callback);
    expect(callbackResponse.status).toBe(200);
    const callbackHtml = await callbackResponse.text();
    expect(callbackHtml).toContain('noodle:auth-complete');
    expect(callbackHtml).toContain(JSON.stringify(new URL(preview.url).origin));
    expect(callbackHtml).toContain('window.close()');

    const signedIn = await (await fetch(new URL('/auth/status', preview.url), { headers })).json();
    expect(signedIn).toMatchObject({ state: 'signed_in', method: 'microsoft' });
    expect(JSON.stringify(signedIn)).not.toMatch(
      /microsoft-client-secret|microsoft-refresh-secret|must-not-reach-mcp/u,
    );
    expect(delegatedCredentialSink.setCredential).toHaveBeenCalledWith({
      resource: mcp.url,
      provider: 'microsoft',
      subject: 'microsoft-user',
      refreshToken: 'microsoft-refresh-secret',
    });
    const rpc = await fetch(new URL('/rpc', preview.url), {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(rpc.status).toBe(200);
    expect(mcpBearers.at(-1)).toBe(`Bearer ${idToken}`);
    expect(mcpBearers).not.toContain('Bearer must-not-reach-mcp');

    const sent = new URLSearchParams(tokenRequest);
    expect(sent.get('client_secret')).toBe('microsoft-client-secret');
    expect(sent.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{20,}$/u);
    expect(sent.get('redirect_uri')).toBe(callback.origin + callback.pathname);
  });

  it('keeps a failed callback open, redacts provider details, and allows an immediate retry', async () => {
    const microsoft = await fakeServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/token') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'invalid_client',
          error_description:
            'AADSTS7000215: secret-provider-detail Trace ID: trace-secret Correlation ID: correlation-secret',
          error_codes: [7000215],
          trace_id: 'trace-secret',
          correlation_id: 'correlation-secret',
        }),
      );
    });
    closers.push(microsoft.close);
    const mcp = await fakeServer(async (_req, res) => {
      writeJson(res, { jsonrpc: '2.0', id: 1, result: { tools: [] } });
    }, '/o/local/microsoft/dev/mcp');
    closers.push(mcp.close);
    const preview = await startPreview({
      mcpUrl: mcp.url,
      theme: 'both',
      device: 'both',
      customerAuth: {
        kind: 'microsoft',
        tenantId: '11111111-2222-3333-4444-555555555555',
        clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        clientSecret: 'microsoft-client-secret',
        authorizeUrl: `${microsoft.origin}/authorize`,
        tokenUrl: `${microsoft.origin}/token`,
        allowInsecureLocalhost: true,
      },
    });
    closers.push(preview.close);

    const shell = await (await fetch(preview.url)).text();
    const capability = shell.match(/var RPC_CAPABILITY="([^"]+)"/)?.[1] ?? '';
    const headers = { 'x-noodle-devtools-capability': capability };
    const started = (await (
      await fetch(new URL('/auth/start', preview.url), { method: 'POST', headers })
    ).json()) as { authorizationUrl: string };
    const authorize = new URL(started.authorizationUrl);
    const callback = new URL(authorize.searchParams.get('redirect_uri') ?? '');
    callback.searchParams.set('code', 'microsoft-code');
    callback.searchParams.set('state', authorize.searchParams.get('state') ?? '');

    const response = await fetch(callback);
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('AADSTS7000215');
    expect(html).toContain(
      'Microsoft rejected the client secret. Create a fresh secret value for this app registration.',
    );
    expect(html).not.toContain('window.close()');
    expect(html).not.toMatch(
      /secret-provider-detail|trace-secret|correlation-secret|invalid_client/u,
    );

    const failed = await (await fetch(new URL('/auth/status', preview.url), { headers })).json();
    expect(failed).toMatchObject({
      state: 'error',
      method: 'microsoft',
      errorCode: 'AADSTS7000215',
    });
    expect(JSON.stringify(failed)).not.toMatch(
      /secret-provider-detail|trace-secret|correlation-secret|invalid_client/u,
    );

    const retry = await fetch(new URL('/auth/start', preview.url), { method: 'POST', headers });
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({
      authorizationUrl: expect.stringContaining('/authorize?'),
    });
    await expect(
      (await fetch(new URL('/auth/status', preview.url), { headers })).json(),
    ).resolves.toMatchObject({ state: 'authorizing', method: 'microsoft' });
  });
});

async function fakeServer(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  path = '',
): Promise<{ readonly origin: string; readonly url: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    url: `${origin}${path}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function requestText(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function writeJson(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}
