import { get } from 'node:http';
import { Window } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DevtoolsDelegatedExchangeStatus } from '../src/devtools-delegated-exchange-state.js';
import {
  DEVTOOLS_DELEGATED_EXCHANGE_CLIENT_JS,
  DEVTOOLS_DELEGATED_EXCHANGE_HTML,
} from '../src/devtools-delegated-exchange-ui.js';
import { startPreview } from '../src/devtools-preview.js';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

function status(
  overrides: Partial<DevtoolsDelegatedExchangeStatus> = {},
): DevtoolsDelegatedExchangeStatus {
  return {
    issuer: 'urn:noodleseed:devtools:test-issuer',
    jwks: {
      keys: [
        {
          kty: 'RSA',
          kid: 'local-key',
          use: 'sig',
          alg: 'RS256',
          n: 'public-modulus',
          e: 'AQAB',
        },
      ],
    },
    trustChanged: false,
    tenant: 'local/customer-auth-demo/dev',
    deployment: 'customer-auth-demo-1234abcd',
    bindings: [
      {
        bindingKey: 'sha256:binding',
        connectorId: 'customer_api',
        operation: 'read_profile',
        audience: 'api://customer-api-dev',
        verified: false,
      },
    ],
    ...overrides,
  };
}

async function capability(previewUrl: string): Promise<string> {
  const html = await (await fetch(previewUrl)).text();
  const match = html.match(/var RPC_CAPABILITY="([^"]+)"/u);
  if (!match?.[1]) throw new Error('preview did not embed its parent capability');
  return match[1];
}

async function nextReloadEvent(previewUrl: string, trigger: () => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = get(new URL('/reload', previewUrl), (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        const event = chunk.match(/data: (reload|hard)\n\n/u)?.[1];
        if (event !== undefined) {
          request.destroy();
          resolve(event);
        }
      });
      trigger();
    });
    request.on('error', reject);
  });
}

describe('devtools preview — local delegated exchange', () => {
  it('omits the panel and returns 404 with the exact capability when no binding is active', async () => {
    const preview = await startPreview({
      mcpUrl: 'http://127.0.0.1:9/o/local/app/dev/mcp',
      theme: 'both',
      device: 'both',
      localDelegatedExchange: () => undefined,
    });
    closers.push(preview.close);

    const html = await (await fetch(preview.url)).text();
    expect(html).not.toContain('id="local-delegated-exchange"');

    const forbidden = await fetch(new URL('/delegated-exchange/status', preview.url));
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get('cache-control')).toBe('no-store');
    const response = await fetch(new URL('/delegated-exchange/status', preview.url), {
      headers: { 'x-noodle-devtools-capability': await capability(preview.url) },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('always protects the status route and projects only browser-safe public status', async () => {
    const unsafeInput = status({
      jwks: {
        keys: [
          {
            kty: 'RSA',
            kid: 'local-key',
            use: 'sig',
            alg: 'RS256',
            n: 'public-modulus',
            e: 'AQAB',
            d: 'private-exponent-must-not-leak',
          },
        ],
      },
    });
    const callbackValue = {
      ...unsafeInput,
      credential: 'credential-must-not-leak',
      exchangeConfig: { tokenUrl: 'https://private.example/token' },
    } as DevtoolsDelegatedExchangeStatus;
    expect('customerSignedIn' in unsafeInput).toBe(false);
    const preview = await startPreview({
      mcpUrl: 'http://127.0.0.1:9/o/local/app/dev/mcp',
      theme: 'both',
      device: 'both',
      secureWidgets: false,
      localDelegatedExchange: () => callbackValue,
    });
    closers.push(preview.close);

    const url = new URL('/delegated-exchange/status', preview.url);
    const missingCapability = await fetch(url);
    expect(missingCapability.status).toBe(403);
    expect(missingCapability.headers.get('cache-control')).toBe('no-store');
    const wrongCapability = await fetch(url, {
      headers: { 'x-noodle-devtools-capability': 'wrong-parent-capability' },
    });
    expect(wrongCapability.status).toBe(403);
    expect(wrongCapability.headers.get('cache-control')).toBe('no-store');

    const response = await fetch(url, {
      headers: { 'x-noodle-devtools-capability': await capability(preview.url) },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      issuer: 'urn:noodleseed:devtools:test-issuer',
      jwks: {
        keys: [
          {
            kty: 'RSA',
            kid: 'local-key',
            use: 'sig',
            alg: 'RS256',
            n: 'public-modulus',
            e: 'AQAB',
          },
        ],
      },
      tenant: 'local/customer-auth-demo/dev',
      deployment: 'customer-auth-demo-1234abcd',
      customerSignedIn: false,
      trustChanged: false,
      bindings: [
        {
          bindingKey: 'sha256:binding',
          connectorId: 'customer_api',
          operation: 'read_profile',
          audience: 'api://customer-api-dev',
          verified: false,
        },
      ],
    });
    expect(JSON.stringify(body)).not.toMatch(
      /private-exponent|credential-must-not-leak|private\.example|exchangeConfig/u,
    );
  });

  it('reads the callback at request time and includes the panel only while a binding is active', async () => {
    let current: DevtoolsDelegatedExchangeStatus | undefined = status();
    const preview = await startPreview({
      mcpUrl: 'http://127.0.0.1:9/o/local/app/dev/mcp',
      theme: 'both',
      device: 'both',
      localDelegatedExchange: () => current,
    });
    closers.push(preview.close);

    const firstHtml = await (await fetch(preview.url)).text();
    expect(firstHtml).toContain('id="local-delegated-exchange"');
    const parentCapability = await capability(preview.url);

    current = status({ issuer: 'urn:noodleseed:devtools:rotated', trustChanged: true });
    const rotated = await fetch(new URL('/delegated-exchange/status', preview.url), {
      headers: { 'x-noodle-devtools-capability': parentCapability },
    });
    expect(await rotated.json()).toMatchObject({
      issuer: 'urn:noodleseed:devtools:rotated',
      trustChanged: true,
    });

    current = undefined;
    expect(
      (
        await fetch(new URL('/delegated-exchange/status', preview.url), {
          headers: { 'x-noodle-devtools-capability': parentCapability },
        })
      ).status,
    ).toBe(404);
    expect(await (await fetch(preview.url)).text()).not.toContain('id="local-delegated-exchange"');
  });

  it('soft reloads while delegated bindings remain present and hard reloads only on presence changes', async () => {
    let current: DevtoolsDelegatedExchangeStatus | undefined = status();
    const preview = await startPreview({
      mcpUrl: 'http://127.0.0.1:9/o/local/app/dev/mcp',
      theme: 'both',
      device: 'both',
      localDelegatedExchange: () => current,
    });
    closers.push(preview.close);

    expect(await nextReloadEvent(preview.url, preview.signalReload)).toBe('reload');

    current = undefined;
    expect(await nextReloadEvent(preview.url, preview.signalReload)).toBe('hard');
    expect(await nextReloadEvent(preview.url, preview.signalReload)).toBe('reload');

    current = status();
    expect(await nextReloadEvent(preview.url, preview.signalReload)).toBe('hard');
    expect(await nextReloadEvent(preview.url, preview.signalReload)).toBe('reload');
  });

  it('renders the honest three-state setup, assertion context, rotation guidance, bounded polling, and setup copy', async () => {
    const preview = await startPreview({
      mcpUrl: 'http://127.0.0.1:9/o/local/app/dev/mcp',
      theme: 'both',
      device: 'both',
      localDelegatedExchange: () => status(),
    });
    closers.push(preview.close);

    const html = await (await fetch(preview.url)).text();
    expect(html).toContain('Local delegated exchange');
    expect(html).toContain('Customer sign-in required');
    expect(html).toContain('Local assertion ready');
    expect(html).toContain('Exchange verified');
    expect(html).toContain('Development only');
    expect(html).toContain('Never trust this issuer in production');
    expect(html).toContain('Your OIDC IdP needs no additional signing-key change');
    expect(html).toContain('Update development endpoint trust');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain(
      'id="local-delegated-exchange-summary" class="local-delegated-exchange__summary" aria-live="polite" aria-atomic="true"',
    );
    expect(html).toContain('setInterval(refreshLocalDelegatedExchangeStatus,2000)');
    expect(html).toContain('headers:{"x-noodle-devtools-capability":RPC_CAPABILITY}');
    expect(html).toContain('Assertion context');
    expect(html).toContain('Copy setup JSON');
    expect(html).toContain(
      'if(ev.data==="hard"){window.location.reload();return;} refreshTools(); if(current) loadWidget(current, currentArgs, currentResourceUri);',
    );
    expect(html).not.toContain('||LOCAL_DELEGATED_EXCHANGE_REQUIRED');
  });

  it('paints signed-out, ready, verified, and rotated states and copies one safe setup document', async () => {
    const browser = new Window({ url: 'http://127.0.0.1:1234/' });
    const signedOut = { ...status(), customerSignedIn: false };
    const copyText = vi.fn(() => Promise.resolve());
    const globals = browser as unknown as Record<string, unknown>;
    browser.document.body.innerHTML = `${DEVTOOLS_DELEGATED_EXCHANGE_HTML}<span id="copy-status"></span>`;
    globals.RPC_CAPABILITY = 'parent-capability';
    globals.copyText = copyText;
    browser.fetch = vi.fn(() => new Promise(() => {})) as typeof browser.fetch;
    browser.setInterval = vi.fn(() => 1) as unknown as typeof browser.setInterval;

    browser.eval(DEVTOOLS_DELEGATED_EXCHANGE_CLIENT_JS);
    const paint = globals.paintLocalDelegatedExchangeStatus as (next: typeof signedOut) => void;
    paint(signedOut);

    const bindingStates = () =>
      Array.from(
        browser.document.querySelectorAll('.local-delegated-exchange__state'),
        (element) => element.textContent,
      );
    expect(bindingStates()).toEqual(['Customer sign-in required']);

    paint({ ...signedOut, customerSignedIn: true });
    expect(bindingStates()).toEqual(['Local assertion ready']);

    paint({ ...signedOut, customerSignedIn: true, trustChanged: true });
    expect(bindingStates()).toEqual(['Local assertion ready']);
    expect(
      (browser.document.getElementById('local-delegated-exchange-rotation') as HTMLElement).hidden,
    ).toBe(false);

    browser.document.getElementById('local-delegated-exchange-copy')?.click();
    expect(copyText).toHaveBeenCalledOnce();
    const copied = JSON.parse(copyText.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(copied).toEqual({
      issuer: 'urn:noodleseed:devtools:test-issuer',
      jwks: signedOut.jwks,
      assertion: {
        tenant: 'local/customer-auth-demo/dev',
        deployment: 'customer-auth-demo-1234abcd',
        bindings: [
          {
            connectorId: 'customer_api',
            operation: 'read_profile',
            audience: 'api://customer-api-dev',
          },
        ],
      },
    });
    expect(JSON.stringify(copied)).not.toMatch(
      /bindingKey|verified|customerSignedIn|"d"|"p"|"q"|"dp"|"dq"|"qi"|token|secret|assertion-must-not-leak/u,
    );

    paint({
      ...signedOut,
      bindings: [
        {
          bindingKey: 'sha256:no-operation-binding',
          connectorId: 'calendar_api',
          audience: 'api://calendar-api-dev',
          verified: false,
        },
      ],
    });
    browser.document.getElementById('local-delegated-exchange-copy')?.click();
    const withoutOperation = JSON.parse(copyText.mock.calls[1]?.[0] as string) as {
      assertion: { bindings: Array<Record<string, unknown>> };
    };
    expect(withoutOperation.assertion.bindings[0]).toEqual({
      connectorId: 'calendar_api',
      audience: 'api://calendar-api-dev',
    });
    expect(withoutOperation.assertion.bindings[0]).not.toHaveProperty('operation');
    await browser.close();
  });
});
