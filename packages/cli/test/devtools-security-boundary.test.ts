import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEVTOOLS_AUTH_CLIENT_JS,
  DEVTOOLS_AUTH_GATE_HTML,
  DEVTOOLS_AUTH_STYLES,
} from '../src/devtools-auth-ui.js';
import { harnessHtml, openAiShimScript, startPreview } from '../src/devtools-preview.js';
import { isAutoSafeTool, parseWidgetToolCallMessage } from '../src/devtools-tool-safety.js';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

describe('devtools credential boundary', () => {
  it('sandboxes widget frames and mediates widget tool calls through the parent host', () => {
    const html = harnessHtml({
      mcpUrl: 'http://127.0.0.1:9999/o/local/app/dev/mcp',
      theme: 'both',
      device: 'both',
      rpcCapability: 'test-capability',
      secureWidgets: true,
    });
    const shim = openAiShimScript({ hostMediated: true });

    expect(html).toContain('sandbox="allow-scripts allow-popups"');
    expect(html).toContain('setAttribute("sandbox","allow-scripts allow-popups")');
    expect(html).toContain('var RPC_CAPABILITY="test-capability"');
    expect(html).toContain('x-noodle-devtools-capability');
    expect(html).toContain('parseWidgetToolCallMessage');
    expect(html).toContain('function completeRpc');
    expect(html).toContain('inputResponses');
    expect(html).toContain('completeRpc("tools/call"');
    for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/gu)) {
      let syntaxError: string | undefined;
      try {
        new Function(script[1]);
      } catch (error) {
        syntaxError = error instanceof Error ? error.message : String(error);
      }
      expect(syntaxError).toBeUndefined();
    }
    expect(html).toContain('ev.source');
    expect(html).toContain('target.srcdoc=');
    expect(html).not.toContain('frame.src=q');
    expect(html).toContain('id="mode-design"');
    expect(html).toContain('disabled');

    expect(shim).toContain('window.parent.postMessage');
    expect(shim).toContain('noodle:tool-call');
    expect(shim).toContain('noodle:tool-result');
    expect(shim).not.toContain('fetch("/rpc"');
  });

  it('ships syntactically valid auth host JavaScript and refreshes tools only on sign-in', () => {
    expect(() => new Function(DEVTOOLS_AUTH_CLIENT_JS)).not.toThrow();
    expect(DEVTOOLS_AUTH_CLIENT_JS).toContain('becameSignedIn');
    expect(DEVTOOLS_AUTH_CLIENT_JS).not.toContain('if(signedIn&&typeof refreshTools==="function")');
  });

  it('latches the first sign-in click and shows honest progress until the popup completes', () => {
    expect(DEVTOOLS_AUTH_CLIENT_JS).toContain('var authStarting=false;');
    expect(DEVTOOLS_AUTH_CLIENT_JS).toContain('if(authSignIn.disabled)return;');
    expect(DEVTOOLS_AUTH_CLIENT_JS).toContain('if(authStarting)return;');
    expect(DEVTOOLS_AUTH_CLIENT_JS).toContain('authSignIn.classList.add("is-loading")');
    expect(DEVTOOLS_AUTH_CLIENT_JS).toContain('authSignIn.textContent="Starting sign-in…"');
    expect(DEVTOOLS_AUTH_CLIENT_JS).toContain('aria-busy');
    expect(DEVTOOLS_AUTH_STYLES).toContain('.auth-card .btn.is-loading::before');
  });

  it('renders federated issuer choices safely and submits the exact selected issuer', () => {
    expect(DEVTOOLS_AUTH_GATE_HTML).toContain('id="auth-issuer-choice"');
    expect(DEVTOOLS_AUTH_CLIENT_JS).toContain('status.issuers');
    expect(DEVTOOLS_AUTH_CLIENT_JS).toContain('option.textContent=authIssuerLabel(issuer)');
    expect(DEVTOOLS_AUTH_CLIENT_JS).toContain('encodeURIComponent(selectedIssuer)');
    expect(DEVTOOLS_AUTH_CLIENT_JS).toContain('authIssuerChoice.disabled=authBusy');
    expect(DEVTOOLS_AUTH_CLIENT_JS).not.toContain('innerHTML');
  });

  it('labels the Firebase sign-in action without putting credentials in browser status', () => {
    expect(DEVTOOLS_AUTH_CLIENT_JS).toContain('status.method==="firebase"?"Firebase"');
    expect(DEVTOOLS_AUTH_CLIENT_JS).toContain('"Sign in with "+methodLabel');
    expect(DEVTOOLS_AUTH_CLIENT_JS).not.toContain('id_token');
    expect(DEVTOOLS_AUTH_CLIENT_JS).not.toContain('refresh_token');
  });

  it('labels Microsoft and accepts only the same loopback preview port after its localhost callback', () => {
    expect(DEVTOOLS_AUTH_CLIENT_JS).toContain('status.method==="microsoft"?"Microsoft"');
    expect(DEVTOOLS_AUTH_CLIENT_JS).toContain('ev.origin!==window.location.origin');
    expect(DEVTOOLS_AUTH_CLIENT_JS).toContain('callbackUrl.port===window.location.port');
    expect(DEVTOOLS_AUTH_CLIENT_JS).toContain('callbackUrl.hostname==="localhost"');
    expect(DEVTOOLS_AUTH_CLIENT_JS).not.toContain('client_secret');
  });

  it('rejects direct RPC and widget-document requests without the parent capability', async () => {
    const calls: string[] = [];
    const mcp = await fakeMcp((body) => {
      calls.push(body.method);
      if (body.method === 'tools/list') {
        return {
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools: [
              {
                name: 'show',
                inputSchema: { type: 'object', properties: {} },
                _meta: { ui: { resourceUri: 'ui://app/show' } },
              },
            ],
          },
        };
      }
      if (body.method === 'resources/read') {
        return {
          jsonrpc: '2.0',
          id: body.id,
          result: {
            contents: [
              {
                uri: 'ui://app/show',
                mimeType: 'text/html;profile=mcp-app',
                text: '<!doctype html><main>Ready</main>',
              },
            ],
          },
        };
      }
      return {
        jsonrpc: '2.0',
        id: body.id,
        result: { content: [], structuredContent: { ok: true } },
      };
    });
    closers.push(mcp.close);
    const preview = await startPreview({
      mcpUrl: mcp.url,
      theme: 'both',
      device: 'both',
      secureWidgets: true,
    });
    closers.push(preview.close);

    const root = await fetch(preview.url);
    const html = await root.text();
    const capability = html.match(/var RPC_CAPABILITY="([^"]+)"/)?.[1];
    expect(capability).toMatch(/^[A-Za-z0-9_-]{32,}$/);

    const deniedRpc = await fetch(new URL('/rpc', preview.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const deniedWidget = await fetch(new URL('/widget?name=show', preview.url), {
      headers: { accept: 'text/html' },
    });

    expect(deniedRpc.status).toBe(403);
    expect(deniedWidget.status).toBe(403);
    expect(calls).toEqual([]);

    const allowedRpc = await fetch(new URL('/rpc', preview.url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-noodle-devtools-capability': capability ?? '',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    const allowedWidget = await fetch(new URL('/widget?name=show', preview.url), {
      headers: { 'x-noodle-devtools-capability': capability ?? '' },
    });

    expect(allowedRpc.status).toBe(200);
    expect(allowedWidget.status).toBe(200);
    expect(await allowedWidget.text()).toContain('Ready');
    expect(calls).toContain('tools/list');
  });

  it('rotates the parent capability when a reload adds an auth boundary', async () => {
    const mcp = await fakeMcp((body) => ({
      jsonrpc: '2.0',
      id: body.id,
      result: { tools: [] },
    }));
    closers.push(mcp.close);
    const preview = await startPreview({
      mcpUrl: mcp.url,
      theme: 'both',
      device: 'both',
    });
    closers.push(preview.close);

    const before = await (await fetch(preview.url)).text();
    const previousCapability = before.match(/var RPC_CAPABILITY="([^"]+)"/)?.[1] ?? '';
    preview.updateCustomerAuth({ kind: 'unsupported', method: 'federated OIDC' });
    const after = await (await fetch(preview.url)).text();
    const currentCapability = after.match(/var RPC_CAPABILITY="([^"]+)"/)?.[1] ?? '';

    expect(currentCapability).not.toBe(previousCapability);
    expect(
      await fetch(new URL('/auth/status', preview.url), {
        headers: { 'x-noodle-devtools-capability': previousCapability },
      }),
    ).toHaveProperty('status', 403);
    expect(
      await fetch(new URL('/auth/status', preview.url), {
        headers: { 'x-noodle-devtools-capability': currentCapability },
      }),
    ).toHaveProperty('status', 200);
  });

  it('keeps an unauthenticated frame unsandboxed while mediating its tool calls through the host', async () => {
    const mcp = await fakeMcp((body) => {
      if (body.method === 'tools/list') {
        return {
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools: [
              {
                name: 'show',
                inputSchema: { type: 'object', properties: {} },
                _meta: { ui: { resourceUri: 'ui://app/show' } },
              },
            ],
          },
        };
      }
      if (body.method === 'resources/read') {
        return {
          jsonrpc: '2.0',
          id: body.id,
          result: {
            contents: [{ uri: 'ui://app/show', text: '<main>Ready</main>' }],
          },
        };
      }
      return { jsonrpc: '2.0', id: body.id, result: { structuredContent: { ok: true } } };
    });
    closers.push(mcp.close);
    const preview = await startPreview({
      mcpUrl: mcp.url,
      theme: 'both',
      device: 'both',
    });
    closers.push(preview.close);

    const html = await (await fetch(preview.url)).text();
    const widget = await (await fetch(new URL('/widget?name=show', preview.url))).text();

    expect(html).not.toContain('sandbox="allow-scripts allow-popups"');
    expect(html).toContain('target.src=q');
    expect(html).toContain('if(!SECURE_WIDGETS)');
    expect(html).not.toContain('if(!SECURE_WIDGETS||!findFrameBySource');
    expect(widget).toContain('noodle:tool-call');
    expect(widget).not.toContain('fetch("/rpc"');
  });
});

describe('automatic tool safety', () => {
  it('requires an explicitly read-only, non-destructive, closed-world tool', () => {
    expect(
      isAutoSafeTool({
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
      }),
    ).toBe(true);
    expect(isAutoSafeTool({ annotations: { readOnlyHint: true } })).toBe(false);
    expect(
      isAutoSafeTool({
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
      }),
    ).toBe(false);
  });

  it('accepts only bounded plain-object widget call messages', () => {
    expect(
      parseWidgetToolCallMessage({
        type: 'noodle:tool-call',
        requestId: 'request-1',
        name: 'read_order',
        arguments: { id: 'ord_1' },
      }),
    ).toEqual({
      requestId: 'request-1',
      name: 'read_order',
      arguments: { id: 'ord_1' },
    });
    expect(
      parseWidgetToolCallMessage({
        type: 'noodle:tool-call',
        requestId: 'request-1',
        name: 'read_order',
        arguments: [],
      }),
    ).toBeUndefined();
    expect(
      parseWidgetToolCallMessage({
        type: 'noodle:tool-call',
        requestId: 'x'.repeat(200),
        name: 'read_order',
        arguments: {},
      }),
    ).toBeUndefined();
  });
});

async function fakeMcp(
  handler: (body: { method: string; id: unknown; params?: Record<string, unknown> }) => unknown,
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        method: string;
        id: unknown;
        params?: Record<string, unknown>;
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(handler(body)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/o/local/app/dev/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
