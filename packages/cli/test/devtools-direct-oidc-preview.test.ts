import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/client';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startPreview } from '../src/devtools-preview.js';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  while (closers.length > 0) await closers.pop()?.();
});

describe('authenticated Devtools preview', () => {
  it('bounds pending browser tool sign-ins and expires them before a later unrelated sign-in', async () => {
    const issuer = await fakeIssuer();
    closers.push(issuer.close);
    const mcp = await fakeProtectedMcp(issuer.issuer, false, ['Bearer access-secret'], true);
    closers.push(mcp.close);
    const preview = await startPreview({
      mcpUrl: mcp.url,
      theme: 'dark',
      device: 'both',
      accessMode: 'mixed',
      customerAuth: { kind: 'oidc', issuer: issuer.issuer, allowInsecureLocalhost: true },
    });
    closers.push(preview.close);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.clock.install();
      await page.goto(preview.url);
      await page.waitForFunction(() => document.querySelector('.tool__name'));
      await page.evaluate(() => {
        const client = globalThis as typeof globalThis & {
          completeRpc(method: string, params: unknown): Promise<{ error?: unknown }>;
          completedSignIns: number;
        };
        client.completedSignIns = 0;
        for (let index = 0; index < 33; index += 1) {
          void client
            .completeRpc('tools/call', { name: 'read_order', arguments: {} })
            .then((result) => {
              if (result.error) client.completedSignIns += 1;
            });
        }
      });
      const completed = () =>
        page.evaluate(
          () => (globalThis as typeof globalThis & { completedSignIns: number }).completedSignIns,
        );
      await expect.poll(completed, { timeout: 2_000 }).toBe(1);
      await page.clock.fastForward(300_001);
      await expect.poll(completed).toBe(33);
      expect(mcp.bearers).toEqual([]);
      const next = page.evaluate(async () => {
        const client = globalThis as typeof globalThis & {
          completeRpc(method: string, params: unknown): Promise<unknown>;
        };
        return client.completeRpc('tools/call', { name: 'read_order', arguments: {} });
      });
      await page.locator('#auth-sign-in').waitFor({ state: 'visible' });
      await page.locator('#auth-sign-in').click();
      expect(await next).toMatchObject({
        result: { structuredContent: { message: 'Customer order' } },
      });
      expect(await completed()).toBe(33);
    } finally {
      await browser.close();
    }
  });

  it('keeps mixed discovery anonymous before sign-in, after cancellation and after logout', async () => {
    const issuer = await fakeIssuer();
    closers.push(issuer.close);
    const mcp = await fakeProtectedMcp(issuer.issuer, false);
    closers.push(mcp.close);
    const preview = await startPreview({
      mcpUrl: mcp.url,
      theme: 'both',
      device: 'both',
      accessMode: 'mixed',
      customerAuth: { kind: 'oidc', issuer: issuer.issuer, allowInsecureLocalhost: true },
    });
    closers.push(preview.close);
    const shell = await (await fetch(preview.url)).text();
    const capability = shell.match(/var RPC_CAPABILITY="([^"]+)"/)?.[1] ?? '';
    expect(shell).not.toContain('class="auth-required auth-locked"');
    expect(shell).toContain('auth-optional');
    expect(await rpc(preview.url, capability)).toHaveProperty('status', 200);
    const start = await fetch(new URL('/auth/start', preview.url), {
      method: 'POST',
      headers: { 'x-noodle-devtools-capability': capability },
    });
    const authorize = new URL(
      ((await start.json()) as { authorizationUrl: string }).authorizationUrl,
    );
    const callback = new URL(issuer.registeredRedirect());
    callback.searchParams.set('state', authorize.searchParams.get('state') ?? '');
    callback.searchParams.set('error', 'access_denied');
    callback.searchParams.set('iss', issuer.issuer);
    expect(await fetch(callback)).toHaveProperty('status', 400);
    expect(await rpc(preview.url, capability)).toHaveProperty('status', 200);
    await fetch(new URL('/auth/logout', preview.url), {
      method: 'POST',
      headers: { 'x-noodle-devtools-capability': capability },
    });
    expect(await rpc(preview.url, capability)).toHaveProperty('status', 200);
    expect(mcp.bearers).toEqual([]);
  });

  it('keeps anonymous requests available after expiry without refreshing or sending an expired credential', async () => {
    const issuer = await fakeIssuer({ expiresIn: 1, noRefresh: true });
    closers.push(issuer.close);
    const mcp = await fakeProtectedMcp(issuer.issuer, false);
    closers.push(mcp.close);
    const preview = await startPreview({
      mcpUrl: mcp.url,
      theme: 'both',
      device: 'both',
      accessMode: 'mixed',
      customerAuth: { kind: 'oidc', issuer: issuer.issuer, allowInsecureLocalhost: true },
    });
    closers.push(preview.close);
    const shell = await (await fetch(preview.url)).text();
    const capability = shell.match(/var RPC_CAPABILITY="([^"]+)"/)?.[1] ?? '';
    const start = await fetch(new URL('/auth/start', preview.url), {
      method: 'POST',
      headers: { 'x-noodle-devtools-capability': capability },
    });
    const authorize = new URL(
      ((await start.json()) as { authorizationUrl: string }).authorizationUrl,
    );
    const callback = new URL(issuer.registeredRedirect());
    callback.searchParams.set('code', issuer.code);
    callback.searchParams.set('state', authorize.searchParams.get('state') ?? '');
    callback.searchParams.set('iss', issuer.issuer);
    expect(await fetch(callback)).toHaveProperty('status', 200);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 2_000);
    try {
      expect(await rpc(preview.url, capability)).toHaveProperty('status', 200);
    } finally {
      clock.mockRestore();
    }
    expect(await authStatus(preview.url, capability)).toMatchObject({
      required: false,
      state: 'signed_out',
    });
    expect(mcp.bearers).toEqual([]);
  });

  it.each([
    1600, 720,
  ])('completes optional OIDC sign-in and protected retry without blocking Help at width %s', async (width) => {
    const issuer = await fakeIssuer();
    closers.push(issuer.close);
    const mcp = await fakeProtectedMcp(issuer.issuer, false, ['Bearer access-secret'], true);
    closers.push(mcp.close);
    const preview = await startPreview({
      mcpUrl: mcp.url,
      theme: 'dark',
      device: 'both',
      accessMode: 'mixed',
      customerAuth: { kind: 'oidc', issuer: issuer.issuer, allowInsecureLocalhost: true },
    });
    closers.push(preview.close);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(preview.url);
      await page.waitForFunction(() => document.querySelector('.tool__name'));
      expect(await page.locator('body').getAttribute('class')).not.toContain('auth-locked');
      const call = (name: string) =>
        page.evaluate(async (toolName) => {
          const client = globalThis as typeof globalThis & {
            completeRpc(method: string, params: unknown): Promise<unknown>;
          };
          return client.completeRpc('tools/call', { name: toolName, arguments: {} });
        }, name);
      expect(await call('help')).toMatchObject({
        result: { structuredContent: { message: 'Help is available' } },
      });
      await page.evaluate(() => {
        const client = globalThis as typeof globalThis & {
          loadWidget(name: string, args: unknown): void;
        };
        client.loadWidget('help', {});
      });
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll('iframe')).some((frame) =>
          frame.srcdoc.includes('Help preview'),
        ),
      );
      const cancelled = call('read_order');
      await page.locator('#auth-cancel').waitFor({ state: 'visible' });
      expect(await page.locator('body').getAttribute('class')).not.toContain('auth-locked');
      await page.locator('#auth-cancel').click();
      expect(await cancelled).toMatchObject({ error: { code: -32001 } });
      expect(await call('help')).toMatchObject({
        result: { structuredContent: { message: 'Help is available' } },
      });
      const protectedCall = call('read_order');
      await page.locator('#auth-sign-in').waitFor({ state: 'visible' });
      await page.screenshot({ path: `/tmp/mixed-auth-cli-optional-${width}.png` });
      await page.locator('#auth-sign-in').click();
      expect(await protectedCall).toMatchObject({
        result: { structuredContent: { message: 'Customer order' } },
      });
      expect(await page.locator('body').getAttribute('class')).not.toContain('auth-locked');
      await page.locator('#auth-logout').click();
      await page.waitForFunction(
        () =>
          document.getElementById('auth-session-label')?.textContent === 'Using anonymous tools',
      );
      expect(await call('help')).toMatchObject({
        result: { structuredContent: { message: 'Help is available' } },
      });
      await page.evaluate(() => {
        const client = globalThis as typeof globalThis & {
          loadWidget(name: string, args: unknown): void;
        };
        client.loadWidget('help', {});
      });
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll('iframe')).some((frame) =>
          frame.srcdoc.includes('Help preview'),
        ),
      );
      expect(await page.content()).not.toMatch(/access-secret|direct-refresh/);
    } finally {
      await browser.close();
    }
  });

  it.each([
    true,
    false,
  ])('pauses only the protected chat call and resumes or cancels sign-in: %s', async (signIn) => {
    const issuer = await fakeIssuer();
    closers.push(issuer.close);
    const mcp = await fakeProtectedMcp(issuer.issuer, false, ['Bearer access-secret'], true);
    closers.push(mcp.close);
    let modelCalls = 0;
    const model = createServer((_req, res) => {
      modelCalls++;
      writeJson(res, {
        choices: [
          {
            message:
              modelCalls === 1
                ? {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'call-1',
                        type: 'function',
                        function: { name: 'read_order', arguments: '{}' },
                      },
                    ],
                  }
                : { role: 'assistant', content: 'Finished' },
          },
        ],
      });
    });
    await listen(model);
    closers.push(() => close(model));
    vi.stubEnv('OPENAI_BASE_URL', serverOrigin(model));
    const preview = await startPreview({
      mcpUrl: mcp.url,
      theme: 'both',
      device: 'both',
      accessMode: 'mixed',
      customerAuth: { kind: 'oidc', issuer: issuer.issuer, allowInsecureLocalhost: true },
    });
    closers.push(preview.close);
    const shell = await (await fetch(preview.url)).text();
    const capability = shell.match(/var RPC_CAPABILITY="([^"]+)"/)?.[1] ?? '';
    const headers = {
      'content-type': 'application/json',
      'x-noodle-devtools-capability': capability,
    };
    await fetch(new URL('/chat/key', preview.url), {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: 'local-test-model-key' }),
    });
    const response = fetch(new URL('/chat', preview.url), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider: 'openai',
        messages: [{ role: 'user', content: 'Get my order' }],
      }),
    });
    await vi.waitFor(async () =>
      expect(await authStatus(preview.url, capability)).toMatchObject({ signInRequested: true }),
    );
    expect(modelCalls).toBe(1);
    expect(await rpc(preview.url, capability)).toHaveProperty('status', 200);
    if (signIn) {
      const start = await fetch(new URL('/auth/start', preview.url), { method: 'POST', headers });
      const authorize = new URL(
        ((await start.json()) as { authorizationUrl: string }).authorizationUrl,
      );
      const callback = new URL(issuer.registeredRedirect());
      callback.searchParams.set('code', issuer.code);
      callback.searchParams.set('state', authorize.searchParams.get('state') ?? '');
      callback.searchParams.set('iss', issuer.issuer);
      expect(await fetch(callback)).toHaveProperty('status', 200);
    } else {
      await fetch(new URL('/auth/logout', preview.url), { method: 'POST', headers });
    }
    expect(await response).toHaveProperty('status', 200);
    const result = await (await response).json();
    expect(result.toolCalls[0].isError).toBe(!signIn);
    expect(modelCalls).toBe(2);
    expect(JSON.stringify(result)).not.toMatch(/access-secret|direct-refresh/);
  });

  it('signs in through direct OIDC and injects the bearer only from the loopback host', async () => {
    const issuer = await fakeIssuer();
    closers.push(issuer.close);
    const mcp = await fakeProtectedMcp(issuer.issuer);
    closers.push(mcp.close);
    const preview = await startPreview({
      mcpUrl: mcp.url,
      theme: 'both',
      device: 'both',
      customerAuth: {
        kind: 'oidc',
        issuer: issuer.issuer,
        allowInsecureLocalhost: true,
      },
    });
    closers.push(preview.close);

    const shell = await (await fetch(preview.url)).text();
    const capability = shell.match(/var RPC_CAPABILITY="([^"]+)"/)?.[1] ?? '';
    expect(shell).toContain('Sign in to test');
    expect(capability).toMatch(/^[A-Za-z0-9_-]{32,}$/);

    const deniedStart = await fetch(new URL('/auth/start', preview.url), { method: 'POST' });
    expect(deniedStart.status).toBe(403);

    const beforeAuth = await rpc(preview.url, capability);
    expect(beforeAuth.status).toBe(401);
    expect(mcp.bearers).toEqual([]);

    const start = await fetch(new URL('/auth/start', preview.url), {
      method: 'POST',
      headers: { 'x-noodle-devtools-capability': capability },
    });
    const startBody = (await start.json()) as { authorizationUrl: string };
    const authorize = new URL(startBody.authorizationUrl);
    expect(authorize.origin).toBe(new URL(issuer.issuer).origin);
    expect(authorize.searchParams.get('resource')).toBe(mcp.url);
    expect(issuer.registration).toMatchObject({
      application_type: 'native',
      token_endpoint_auth_method: 'none',
    });
    const registeredRedirect = String(
      (issuer.registration.redirect_uris as readonly string[] | undefined)?.[0],
    );
    expect(registeredRedirect).toMatch(
      new RegExp(`^${escapeRegExp(preview.url)}auth/callback/[A-Za-z0-9_-]{20,}$`),
    );

    const predictableCallback = await fetch(new URL('/auth/callback', preview.url));
    expect(predictableCallback.status).toBe(404);

    const callback = new URL(registeredRedirect);
    callback.searchParams.set('code', issuer.code);
    callback.searchParams.set('state', authorize.searchParams.get('state') ?? '');
    callback.searchParams.set('iss', issuer.issuer);
    const callbackResponse = await fetch(callback);
    const callbackHtml = await callbackResponse.text();
    expect(callbackResponse.status).toBe(200);
    expect(callbackHtml).toContain('noodle:auth-complete');
    expect(callbackHtml).not.toContain('access-secret');

    const status = await authStatus(preview.url, capability);
    expect(status).toMatchObject({
      required: true,
      supported: true,
      state: 'signed_in',
      issuer: issuer.issuer,
      scopes: ['tools:read'],
    });
    expect(JSON.stringify(status)).not.toMatch(
      /access-secret|direct-refresh|direct-client|direct-code/u,
    );

    const afterAuth = await rpc(preview.url, capability);
    expect(afterAuth.status).toBe(200);
    expect(await afterAuth.json()).toMatchObject({
      result: { tools: [{ name: 'read_order' }] },
    });
    expect(mcp.bearers).toEqual(['Bearer access-secret', 'Bearer access-secret']);
    expect(mcp.requests).toEqual([
      {
        method: 'server/discover',
        protocolVersion: '2026-07-28',
        routedMethod: 'server/discover',
        metadataVersion: '2026-07-28',
      },
      {
        method: 'tools/list',
        protocolVersion: '2026-07-28',
        routedMethod: 'tools/list',
        metadataVersion: '2026-07-28',
      },
    ]);

    const logout = await fetch(new URL('/auth/logout', preview.url), {
      method: 'POST',
      headers: { 'x-noodle-devtools-capability': capability },
    });
    expect(logout.status).toBe(200);
    expect((await authStatus(preview.url, capability)).state).toBe('signed_out');
  });

  it.each([
    'customers',
    'mixed',
  ] as const)('reports a rejected issued token safely without anonymous downgrade in %s and permits a fresh sign-in attempt', async (accessMode) => {
    const issuer = await fakeIssuer({ accessToken: 'wrong-audience-access-secret' });
    closers.push(issuer.close);
    const mcp = await fakeProtectedMcp(issuer.issuer, accessMode !== 'mixed', []);
    closers.push(mcp.close);
    const preview = await startPreview({
      mcpUrl: mcp.url,
      accessMode,
      theme: 'both',
      device: 'both',
      customerAuth: {
        kind: 'oidc',
        issuer: issuer.issuer,
        allowInsecureLocalhost: true,
      },
    });
    closers.push(preview.close);

    const shell = await (await fetch(preview.url)).text();
    const capability = shell.match(/var RPC_CAPABILITY="([^"]+)"/)?.[1] ?? '';
    const start = await fetch(new URL('/auth/start', preview.url), {
      method: 'POST',
      headers: { 'x-noodle-devtools-capability': capability },
    });
    const authorize = new URL(
      ((await start.json()) as { authorizationUrl: string }).authorizationUrl,
    );
    const callback = new URL(issuer.registeredRedirect());
    callback.searchParams.set('code', issuer.code);
    callback.searchParams.set('state', authorize.searchParams.get('state') ?? '');
    callback.searchParams.set('iss', issuer.issuer);
    expect(await fetch(callback)).toHaveProperty('status', 200);
    expect(await authStatus(preview.url, capability)).toMatchObject({ state: 'signed_in' });

    expect(await rpc(preview.url, capability)).toHaveProperty('status', 401);
    const rejected = await authStatus(preview.url, capability);
    expect(rejected).toMatchObject({
      state: 'error',
      errorCode: 'oauth_token_rejected',
      message:
        'The MCP server rejected the issued token. Verify its issuer, signing key, and configured audience, then sign in again.',
    });
    expect(JSON.stringify(rejected)).not.toMatch(
      /wrong-audience-access-secret|direct-refresh|direct-client/u,
    );

    const retry = await fetch(new URL('/auth/start', preview.url), {
      method: 'POST',
      headers: { 'x-noodle-devtools-capability': capability },
    });
    expect(retry.status).toBe(200);
    expect(await authStatus(preview.url, capability)).toMatchObject({ state: 'authorizing' });
  });

  it('selects one federated issuer at a time and clears the prior issuer credential on switch', async () => {
    const workforce = await fakeIssuer({
      name: 'workforce',
      accessToken: 'workforce-access',
    });
    const customers = await fakeIssuer({
      name: 'customers',
      accessToken: 'customer-access',
    });
    closers.push(customers.close, workforce.close);
    const mcp = await fakeProtectedMcp([workforce.issuer, customers.issuer], true, [
      'Bearer workforce-access',
      'Bearer customer-access',
    ]);
    closers.push(mcp.close);
    const preview = await startPreview({
      mcpUrl: mcp.url,
      theme: 'both',
      device: 'both',
      customerAuth: {
        kind: 'federatedOidc',
        issuers: [workforce.issuer, customers.issuer],
        allowInsecureLocalhost: true,
      },
    });
    closers.push(preview.close);

    const shell = await (await fetch(preview.url)).text();
    const capability = shell.match(/var RPC_CAPABILITY="([^"]+)"/)?.[1] ?? '';
    expect(await authStatus(preview.url, capability)).toMatchObject({
      state: 'signed_out',
      issuers: [workforce.issuer, customers.issuer],
    });

    const rejectedIssuer = new URL('/auth/start', preview.url);
    rejectedIssuer.searchParams.set('issuer', 'https://attacker.example.test');
    const rejectedStart = await fetch(rejectedIssuer, {
      method: 'POST',
      headers: { 'x-noodle-devtools-capability': capability },
    });
    expect(rejectedStart.status).toBe(400);
    expect(workforce.registration).toEqual({});
    expect(customers.registration).toEqual({});

    const customerStartUrl = new URL('/auth/start', preview.url);
    customerStartUrl.searchParams.set('issuer', customers.issuer);
    const customerStart = await fetch(customerStartUrl, {
      method: 'POST',
      headers: { 'x-noodle-devtools-capability': capability },
    });
    const customerStartBody = (await customerStart.json()) as {
      authorizationUrl: string;
      issuer: string;
    };
    const customerAuthorize = new URL(customerStartBody.authorizationUrl);
    expect(customerStartBody.issuer).toBe(customers.issuer);
    expect(customerAuthorize.origin).toBe(customers.issuer);
    expect(workforce.registration).toEqual({});
    expect(customers.registration).not.toEqual({});

    const customerCallback = new URL(customers.registeredRedirect());
    customerCallback.searchParams.set('code', customers.code);
    customerCallback.searchParams.set('state', customerAuthorize.searchParams.get('state') ?? '');
    customerCallback.searchParams.set('iss', customers.issuer);
    expect(await fetch(customerCallback)).toHaveProperty('status', 200);
    expect(await rpc(preview.url, capability)).toHaveProperty('status', 200);
    expect(mcp.bearers).toEqual(['Bearer customer-access', 'Bearer customer-access']);

    const workforceStartUrl = new URL('/auth/start', preview.url);
    workforceStartUrl.searchParams.set('issuer', workforce.issuer);
    const workforceStart = await fetch(workforceStartUrl, {
      method: 'POST',
      headers: { 'x-noodle-devtools-capability': capability },
    });
    const workforceStartBody = (await workforceStart.json()) as {
      authorizationUrl: string;
      issuer: string;
    };
    const workforceAuthorize = new URL(workforceStartBody.authorizationUrl);
    expect(workforceStartBody.issuer).toBe(workforce.issuer);
    expect((await authStatus(preview.url, capability)).state).toBe('authorizing');
    expect(await rpc(preview.url, capability)).toHaveProperty('status', 401);

    const workforceCallback = new URL(workforce.registeredRedirect());
    workforceCallback.searchParams.set('code', workforce.code);
    workforceCallback.searchParams.set('state', workforceAuthorize.searchParams.get('state') ?? '');
    workforceCallback.searchParams.set('iss', workforce.issuer);
    expect(await fetch(workforceCallback)).toHaveProperty('status', 200);
    expect(await rpc(preview.url, capability)).toHaveProperty('status', 200);
    expect(mcp.bearers).toEqual([
      'Bearer customer-access',
      'Bearer customer-access',
      'Bearer workforce-access',
    ]);
    expect(await authStatus(preview.url, capability)).toMatchObject({
      state: 'signed_in',
      issuer: workforce.issuer,
      issuers: [workforce.issuer, customers.issuer],
    });
  });

  it('accepts Firebase credentials only by single-use form post and injects only the ID token', async () => {
    const mcp = await fakeProtectedMcp('https://unused.example.test', true, [
      'Bearer firebase-id-token',
    ]);
    closers.push(mcp.close);
    const preview = await startPreview({
      mcpUrl: mcp.url,
      theme: 'both',
      device: 'both',
      customerAuth: {
        kind: 'firebase',
        projectId: 'firebase-project',
        apiKey: 'public-web-key',
        authDomain: 'firebase-project.firebaseapp.com',
        authorizeUrl: 'https://auth.example.test/firebase',
      },
    });
    closers.push(preview.close);

    const shell = await (await fetch(preview.url)).text();
    const capability = shell.match(/var RPC_CAPABILITY="([^"]+)"/)?.[1] ?? '';
    const start = await fetch(new URL('/auth/start', preview.url), {
      method: 'POST',
      headers: { 'x-noodle-devtools-capability': capability },
    });
    const startBody = (await start.json()) as { authorizationUrl: string };
    const authorize = new URL(startBody.authorizationUrl);
    const callback = new URL(authorize.searchParams.get('redirect_uri') ?? '');
    const state = authorize.searchParams.get('state') ?? '';

    expect(authorize.origin + authorize.pathname).toBe('https://auth.example.test/firebase');
    expect(callback.pathname).toMatch(/^\/auth\/callback\/[A-Za-z0-9_-]{20,}$/u);
    const queryCredential = new URL(callback);
    queryCredential.searchParams.set('state', state);
    queryCredential.searchParams.set('id_token', 'must-not-accept-from-url');
    expect(await fetch(queryCredential)).toHaveProperty('status', 405);
    expect(
      await fetch(callback, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state, id_token: 'must-not-accept-from-json' }),
      }),
    ).toHaveProperty('status', 415);
    expect(
      await fetch(callback, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ state, id_token: 'x'.repeat(200_000) }),
      }),
    ).toHaveProperty('status', 413);

    const callbackResponse = await fetch(callback, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        state,
        id_token: 'firebase-id-token',
        refresh_token: 'firebase-refresh-token',
        expires_in: '3600',
      }),
    });
    const callbackHtml = await callbackResponse.text();
    expect(callbackResponse.status).toBe(200);
    expect(callbackHtml).toContain('noodle:auth-complete');
    expect(callbackHtml).not.toMatch(/firebase-id-token|firebase-refresh-token/u);

    const status = await authStatus(preview.url, capability);
    expect(status).toMatchObject({
      state: 'signed_in',
      method: 'firebase',
      issuer: 'firebase-project.firebaseapp.com',
    });
    expect(JSON.stringify(status)).not.toMatch(/firebase-id-token|firebase-refresh-token/u);
    expect(await rpc(preview.url, capability)).toHaveProperty('status', 200);
    expect(mcp.bearers).toEqual(['Bearer firebase-id-token', 'Bearer firebase-id-token']);

    const replay = await fetch(callback, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ state, id_token: 'replayed-id-token' }),
    });
    expect(replay.status).toBe(400);
  });

  it('serves a safe local Firebase sign-in page when no custom auth UI is configured', async () => {
    const mcp = await fakeProtectedMcp('https://unused.example.test');
    closers.push(mcp.close);
    const preview = await startPreview({
      mcpUrl: mcp.url,
      theme: 'both',
      device: 'both',
      customerAuth: {
        kind: 'firebase',
        projectId: 'firebase-project',
        apiKey: 'public-web-key',
        authDomain: 'firebase-project.firebaseapp.com',
        appId: 'firebase-app-id',
      },
    });
    closers.push(preview.close);

    const shell = await (await fetch(preview.url)).text();
    const capability = shell.match(/var RPC_CAPABILITY="([^"]+)"/)?.[1] ?? '';
    const start = await fetch(new URL('/auth/start', preview.url), {
      method: 'POST',
      headers: { 'x-noodle-devtools-capability': capability },
    });
    const startBody = (await start.json()) as { authorizationUrl: string };
    const authorize = new URL(startBody.authorizationUrl);
    expect(authorize.origin).toBe(new URL(preview.url).origin);
    expect(authorize.pathname).toBe('/auth/firebase/authorize');

    const pageResponse = await fetch(authorize);
    const page = await pageResponse.text();
    const csp = pageResponse.headers.get('content-security-policy') ?? '';
    expect(pageResponse.status).toBe(200);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('https://apis.google.com');
    expect(csp).toContain("connect-src 'self' https: wss:");
    expect(page).toContain('Continue with Google');
    expect(page).toContain('public-web-key');
    expect(page).toContain('firebase-project.firebaseapp.com');
    expect(page).toContain('firebase-app-id');
    expect(page).not.toMatch(/access_token|refresh-secret/u);
  });

  it('keeps an unauthenticated app account-free and does not add auth routes to its shell', async () => {
    const mcp = await fakeProtectedMcp('https://unused.example.test', false);
    closers.push(mcp.close);
    const preview = await startPreview({ mcpUrl: mcp.url, theme: 'both', device: 'both' });
    closers.push(preview.close);

    const shell = await (await fetch(preview.url)).text();
    expect(shell).not.toContain('Sign in to test');
    expect(await rpc(preview.url, '')).toHaveProperty('status', 200);
  });
});

async function rpc(previewUrl: string, capability: string): Promise<Response> {
  return fetch(new URL('/rpc', previewUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(capability ? { 'x-noodle-devtools-capability': capability } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
}

async function authStatus(
  previewUrl: string,
  capability: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(new URL('/auth/status', previewUrl), {
    headers: { 'x-noodle-devtools-capability': capability },
  });
  return (await response.json()) as Record<string, unknown>;
}

async function fakeIssuer(
  options: {
    readonly name?: string;
    readonly accessToken?: string;
    readonly expiresIn?: number;
    readonly noRefresh?: boolean;
  } = {},
): Promise<{
  readonly issuer: string;
  readonly code: string;
  readonly registration: Record<string, unknown>;
  registeredRedirect(): string;
  close(): Promise<void>;
}> {
  const name = options.name ?? 'direct';
  const authorizationCode = `${name}-code`;
  const accessToken = options.accessToken ?? 'access-secret';
  let origin = '';
  const registration: Record<string, unknown> = {};
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', origin || 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      writeJson(res, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        authorization_response_iss_parameter_supported: true,
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const callback = new URL(url.searchParams.get('redirect_uri') ?? '');
      callback.searchParams.set('code', authorizationCode);
      callback.searchParams.set('state', url.searchParams.get('state') ?? '');
      callback.searchParams.set('iss', origin);
      res.writeHead(302, { location: callback.href }).end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/register') {
      readBody(req).then((raw) => {
        Object.assign(registration, JSON.parse(raw) as Record<string, unknown>);
        writeJson(res, {
          client_id: `${name}-client`,
          token_endpoint_auth_method: 'none',
        });
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      readBody(req).then((raw) => {
        const body = new URLSearchParams(raw);
        if (body.get('grant_type') === 'refresh_token') {
          if (body.get('refresh_token') !== `${name}-refresh` || body.get('resource') === null) {
            writeJson(res, { error: 'invalid_grant' }, 400);
            return;
          }
          writeJson(res, {
            access_token: accessToken,
            ...(options.noRefresh ? {} : { refresh_token: `${name}-refresh` }),
            token_type: 'Bearer',
            expires_in: options.expiresIn ?? 300,
            scope: 'tools:read',
          });
          return;
        }
        if (
          body.get('code') !== authorizationCode ||
          body.get('resource') === null ||
          body.get('code_verifier') === null
        ) {
          writeJson(res, { error: 'invalid_grant' }, 400);
          return;
        }
        writeJson(res, {
          access_token: accessToken,
          ...(options.noRefresh ? {} : { refresh_token: `${name}-refresh` }),
          token_type: 'Bearer',
          expires_in: options.expiresIn ?? 300,
          scope: 'tools:read',
        });
      });
      return;
    }
    res.writeHead(404).end();
  });
  await listen(server);
  origin = serverOrigin(server);
  return {
    issuer: origin,
    code: authorizationCode,
    registration,
    registeredRedirect: () =>
      String((registration.redirect_uris as readonly string[] | undefined)?.[0] ?? ''),
    close: () => close(server),
  };
}

async function fakeProtectedMcp(
  issuer: string | readonly string[],
  requireAuth = true,
  allowedBearers: readonly string[] = ['Bearer access-secret'],
  mixed = false,
): Promise<{
  readonly url: string;
  readonly bearers: string[];
  readonly requests: Array<{
    readonly method: string;
    readonly protocolVersion: string;
    readonly routedMethod: string;
    readonly metadataVersion: string;
  }>;
  close(): Promise<void>;
}> {
  let origin = '';
  const bearers: string[] = [];
  const requests: Array<{
    method: string;
    protocolVersion: string;
    routedMethod: string;
    metadataVersion: string;
  }> = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', origin || 'http://127.0.0.1');
    if (
      req.method === 'GET' &&
      url.pathname === '/.well-known/oauth-protected-resource/o/local/app/dev/mcp'
    ) {
      writeJson(res, {
        resource: `${origin}/o/local/app/dev/mcp`,
        authorization_servers: typeof issuer === 'string' ? [issuer] : issuer,
        scopes_supported: ['tools:read'],
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/o/local/app/dev/mcp') {
      const bearer = req.headers.authorization;
      if (
        (requireAuth && bearer === undefined) ||
        (bearer !== undefined && !allowedBearers.includes(bearer))
      ) {
        res.writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/o/local/app/dev/mcp"`,
        });
        res.end();
        return;
      }
      if (bearer) bearers.push(bearer);
      readBody(req).then((raw) => {
        const body = JSON.parse(raw) as {
          id: unknown;
          method: string;
          params?: { _meta?: Record<string, unknown>; name?: string };
        };
        requests.push({
          method: body.method,
          protocolVersion: String(req.headers['mcp-protocol-version'] ?? ''),
          routedMethod: String(req.headers['mcp-method'] ?? ''),
          metadataVersion: String(body.params?._meta?.[PROTOCOL_VERSION_META_KEY] ?? ''),
        });
        if (mixed && body.method === 'resources/read') {
          writeJson(res, {
            jsonrpc: '2.0',
            id: body.id,
            result: {
              contents: [
                {
                  uri: 'ui://help',
                  mimeType: 'text/html',
                  text: '<!doctype html><html><body><h1>Help preview</h1><p>Help is available without sign-in.</p></body></html>',
                },
              ],
            },
          });
          return;
        }
        if (mixed && body.method === 'tools/call') {
          if (body.params?.name !== 'help' && bearer === undefined) {
            writeJson(
              res,
              { jsonrpc: '2.0', id: body.id, error: { code: -32001, message: 'Sign in required' } },
              401,
            );
            return;
          }
          writeJson(res, {
            jsonrpc: '2.0',
            id: body.id,
            result: {
              structuredContent: {
                message: body.params?.name === 'help' ? 'Help is available' : 'Customer order',
              },
            },
          });
          return;
        }
        if (body.method === 'server/discover') {
          writeJson(res, {
            jsonrpc: '2.0',
            id: body.id,
            result: { supportedVersions: ['2025-11-25', '2026-07-28'] },
          });
          return;
        }
        writeJson(res, {
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools: [
              ...(mixed
                ? [
                    {
                      name: 'help',
                      inputSchema: { type: 'object' },
                      _meta: { ui: { resourceUri: 'ui://help' } },
                    },
                  ]
                : []),
              {
                name: 'read_order',
                annotations: {
                  readOnlyHint: true,
                  destructiveHint: false,
                  openWorldHint: false,
                },
                inputSchema: { type: 'object' },
              },
            ],
          },
        });
      });
      return;
    }
    res.writeHead(404).end();
  });
  await listen(server);
  origin = serverOrigin(server);
  return {
    url: `${origin}/o/local/app/dev/mcp`,
    bearers,
    requests,
    close: () => close(server),
  };
}

function writeJson(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function serverOrigin(server: Server): string {
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
