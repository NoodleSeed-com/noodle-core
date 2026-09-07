import {
  createServer,
  get,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { DEVTOOLS_FAVICON_SVG } from '../src/devtools-brand.js';
import {
  calculateRangeProgress,
  harnessHtml,
  openAiShimScript,
  startPreview,
  wrapWidgetHtml,
} from '../src/devtools-preview.js';

// A minimal fake MCP dev endpoint: responds to JSON-RPC POSTs with whatever `handler` returns.
async function fakeMcp(
  handler: (body: { method: string; id: unknown; params?: Record<string, unknown> }) => unknown,
): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      // Enforce a well-formed JSON-RPC envelope like the real MCP server does — guards the regression where
      // internal preview calls omitted `jsonrpc: "2.0"` and got "Invalid JSON-RPC message".
      if ((body as { jsonrpc?: string }).jsonrpc !== '2.0') {
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id ?? null,
            error: { code: -32600, message: 'Invalid JSON-RPC message' },
          }),
        );
        return;
      }
      res.end(JSON.stringify(handler(body)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/o/local/app/dev/mcp`,
    close: () => new Promise((r) => server.close(() => r())),
  };
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

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

describe('devtools preview — pure builders', () => {
  it('marks the private adapter and bakes the complete canonical tool result', () => {
    const toolResult = {
      content: [{ type: 'text', text: 'Could not load order' }],
      structuredContent: {},
      _meta: { retryable: true },
      isError: true,
    };
    const script = openAiShimScript({ toolResult });

    expect(script).toContain('"__noodleDevtools":true');
    expect(script).toContain(`"__noodleToolResult":${JSON.stringify(toolResult)}`);
  });

  it('shim bakes initial tool data + theme and routes callTool through /rpc', () => {
    const s = openAiShimScript({ toolInput: { a: 1 }, toolOutput: { b: 2 }, theme: 'dark' });
    expect(s).toContain('window.openai');
    expect(s).toContain('"b":2');
    expect(s).toContain('"theme":"dark"');
    expect(s).toContain('/rpc');
    expect(s).toContain('tools/call');
  });

  it('escapes </script> in tool data so it cannot break out of the shim script', () => {
    const s = openAiShimScript({ toolOutput: { x: '</script><img src=x onerror=alert(1)>' } });
    // The data's markup must be neutralized (no raw </script> from the payload; escaped as <).
    expect(s).not.toContain('</script><img');
    expect(s).toContain('\\u003c/script');
  });

  it('wraps widget HTML with the shim BEFORE the ext-apps bridge module', () => {
    const widget =
      '<!doctype html><html><head></head><body><main></main>' +
      '<script type="module">globalThis.ExtApps</script></body></html>';
    const wrapped = wrapWidgetHtml(widget, '<script>window.openai={}</script>');
    expect(wrapped.indexOf('window.openai')).toBeGreaterThan(-1);
    expect(wrapped.indexOf('window.openai')).toBeLessThan(wrapped.indexOf('globalThis.ExtApps'));
  });

  it('renders a three-pane harness shell', () => {
    const html = harnessHtml({ mcpUrl: 'http://x/mcp', theme: 'both', device: 'both' });
    expect(html).toContain('Noodle Seed');
    expect(html).toContain('id="tools"');
    expect(html).toContain('id="stage"');
    expect(html).toContain('id="log"');
  });

  it('uses the official wordmark and three floating workspace regions', () => {
    const html = harnessHtml({ mcpUrl: 'http://x/mcp', theme: 'both', device: 'both' });
    expect(html).toContain('viewBox="0 0 250 39"');
    expect(html).toContain('aria-label="Noodle Seed"');
    expect(html).toContain('id="ns-canvas"');
    expect(html).toContain('class="workspace"');
    expect(html).toContain('aria-label="Tools"');
    expect(html).toContain('aria-label="MCP calls"');
    expect(html).not.toContain('brand__name');
  });

  it('uses the branded Noodle Seed SVG favicon and flat activity chrome', () => {
    const html = harnessHtml({ mcpUrl: 'http://x/mcp', theme: 'both', device: 'both' });
    expect(html).toContain('rel="icon" type="image/svg+xml"');
    expect(html).toContain('seed-gradient');
    expect(html).toContain('%23F59E0B');
    expect(html).toContain('%23F43F5E');
    expect(DEVTOOLS_FAVICON_SVG).toContain(
      'M21.7542 38.4096C12.7805 38.401 5.5093 31.2553 5.54057 22.4521',
    );
    expect(DEVTOOLS_FAVICON_SVG).not.toContain('fill="#050505"');
    expect(DEVTOOLS_FAVICON_SVG).not.toContain('<rect');
    expect(html).not.toContain('brand__label">Devtools');
    expect(html).not.toContain('>Live</span>');
    expect(html).not.toContain('mix-blend-mode:screen');
    expect(html).not.toMatch(/\.pane\{[^}]*backdrop-filter:blur/s);
    expect(html).not.toMatch(/\.pane\{[^}]*outline:2px solid/s);
    expect(html).toContain('.pane{\n  position:relative;\n  z-index:3;');
    expect(html).not.toContain(
      '.pane{\n  position:relative;\n  z-index:3;\n  min-width:0;\n  min-height:0;\n  overflow:hidden;\n  border:1px',
    );
  });

  it('provides explicit rail controls for narrow layouts', () => {
    const html = harnessHtml({ mcpUrl: 'http://x/mcp', theme: 'both', device: 'both' });
    expect(html).toContain('id="toggle-tools"');
    expect(html).toContain('id="toggle-activity"');
    expect(html).toContain('aria-label="Open tools"');
    expect(html).toContain('aria-label="Open MCP calls"');
    expect(html).toContain('aria-controls="tools"');
    expect(html).toContain('aria-controls="log"');
    expect(html).toContain('aria-expanded="false"');
  });

  it('ships the console dark palette, floating rails, and reduced-motion fallback', () => {
    const html = harnessHtml({ mcpUrl: 'http://x/mcp', theme: 'both', device: 'both' });
    expect(html).toContain('--nd-bg:#000');
    expect(html).toContain('--nd-success:#5CF59B');
    expect(html).toContain('gl_FragColor');
    expect(html).toContain('#ns-canvas{\n  z-index:1;\n  opacity:.42;');
    expect(html).toContain('border-radius:28px');
    expect(html).toContain('@media (prefers-reduced-motion:reduce)');
    expect(html).toContain('@media (max-width:');
    expect(html).not.toContain('--nd-panel:#1c1917');
    expect(html).not.toContain('--nd-raised:#292524');
  });

  it('keeps inactive stage views hidden and bounds active views as flex columns', () => {
    const html = harnessHtml({ mcpUrl: 'http://x/mcp', theme: 'both', device: 'both' });
    expect(html).toContain(
      '#preview-view,#chat-view{display:flex;flex:1;min-height:0;flex-direction:column}',
    );
    expect(html).toContain(
      '#frame.hidden,#chat-view.hidden,#chat-body.hidden,#design-view.hidden{display:none}',
    );
  });

  it('composites the shader through translucent panes instead of exposing it only in gutters', () => {
    const html = harnessHtml({ mcpUrl: 'http://x/mcp', theme: 'both', device: 'both' });
    expect(html).toContain('background:rgba(13,13,15,.94)');
    expect(html).toContain('.pane--stage{background:rgba(8,8,10,.82)}');
    expect(html).toContain('#ns-canvas{\n  z-index:1;\n  opacity:.42;');
    expect(html).toContain('.ambient-fallback{\n  z-index:0;');
    expect(html).toContain('.ambient-scrim{\n  z-index:2;');
    expect(html).not.toContain('.pane--stage{background:#08080a}');
    expect(html).toContain('distance(uv,vec2(0.68,0.56))');
    expect(html).not.toContain('distance(uv,vec2(0.80,0.86))');
  });

  it('keeps responsive drawers above the blur scrim', () => {
    const html = harnessHtml({ mcpUrl: 'http://x/mcp', theme: 'both', device: 'both' });
    expect(html).toContain('.pane{\n  position:relative;\n  z-index:3;');
    expect(html).toContain('z-index:20;');
    expect(html).toContain('z-index:15;');
    expect(html).not.toContain('.workspace{\n  position:relative;\n  z-index:2;');
  });

  it('uses the shared primary action treatment for run, key, and chat actions', () => {
    const html = harnessHtml({ mcpUrl: 'http://x/mcp', theme: 'both', device: 'both' });
    expect(html).toContain('class="btn primary-action" type="submit">Start chatting');
    expect(html).toContain('id="chat-send" class="btn primary-action"');
    expect(html).toContain('run.className="btn primary-action"');
    expect(html).toContain('@keyframes glow-shift');
  });

  it('composes one stylesheet before the harness client', () => {
    const html = harnessHtml({ mcpUrl: 'http://x/mcp', theme: 'both', device: 'both' });
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html.indexOf('<style>')).toBeLessThan(html.indexOf('<script>'));
    expect(html).toContain('--nd-bg:#000');
  });

  it('renders readable syntax-coloured JSON without interpreting tool output as markup', () => {
    const html = harnessHtml({ mcpUrl: 'http://x/mcp', theme: 'both', device: 'both' });
    expect(html).toContain('function renderJson');
    expect(html).toContain('json-key');
    expect(html).toContain('json-string');
    expect(html).toContain('json-number');
    expect(html).toContain('json-literal');
    expect(html).toContain('json-punctuation');
    expect(html).toContain('document.createTextNode');
    expect(html).toContain('renderJson(resultPre,v)');
    expect(html).toContain('renderJson(pre,value)');
    expect(html).not.toContain('pre.innerHTML');
  });

  it('lets developers copy the visible response as plain text', () => {
    const html = harnessHtml({ mcpUrl: 'http://x/mcp', theme: 'both', device: 'both' });
    expect(html).toContain('id="copy-result"');
    expect(html).toContain('aria-label="Copy response"');
    expect(html).toContain('id="copy-status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('navigator.clipboard.writeText');
    expect(html).toContain('document.execCommand("copy")');
    expect(html).toContain('currentResultSource=jsonSource(v)');
    expect(html).toContain('copyText(currentResultSource,copyResult,"response")');
    expect(html).toContain('.result__bar{');
    expect(html).toContain('position:sticky');
    expect(html).toContain('.copy-action.is-copied');
  });

  it('uses the Noodle Seed warm brand palette for JSON syntax', () => {
    const html = harnessHtml({ mcpUrl: 'http://x/mcp', theme: 'both', device: 'both' });
    expect(html).toContain('.json-key{color:#F97316}');
    expect(html).toContain('.json-string{color:#F5C0A8}');
    expect(html).toContain('.json-number{color:#F59E0B}');
    expect(html).toContain('.json-literal{color:#F43F5E}');
    expect(html).not.toContain('.json-key{color:#7DD3FC}');
    expect(html).not.toContain('.json-string{color:#86EFAC}');
  });

  it('offers the live Design annotation mode without a coming-soon badge', () => {
    const html = harnessHtml({ mcpUrl: 'http://x/mcp', theme: 'both', device: 'both' });
    expect(html).toContain('id="mode-design" class="mode mode--design" type="button" role="tab"');
    expect(html).toContain('aria-controls="design-view"');
    expect(html).not.toContain('mode__soon');
    expect(html).toContain(
      'id="design-view" class="design-view hidden" role="tabpanel" aria-labelledby="mode-design"',
    );
    expect(html).toContain('aria-label="Design inspector"');
    expect(html).toContain('Select an element in the widget');
    expect(html).toContain('Send to agent');
    expect(html).toContain('m==="design"');
    expect(html).not.toContain('Coming soon');
  });

  it('uses green and red activity backgrounds for successful and failed MCP calls', () => {
    const html = harnessHtml({ mcpUrl: 'http://x/mcp', theme: 'both', device: 'both' });
    expect(html).toContain('li.className="log log--"+(e.status==="error"?"error":"ok")');
    expect(html).toContain('.log--ok{background:rgba(92,245,155,.055)}');
    expect(html).toContain('.log--ok.open{background:rgba(7,24,14,.9)}');
    expect(html).toContain('.log--error{background:rgba(251,113,133,.075)}');
    expect(html).toContain('.log--error.open{background:rgba(35,7,12,.92)}');
    expect(html).toContain('.log__detail pre{background:#09090b}');
    expect(html).not.toContain('.log--error .log__detail pre');
  });

  it('renders widget badges as transparent warm outlines', () => {
    const html = harnessHtml({ mcpUrl: 'http://x/mcp', theme: 'both', device: 'both' });
    expect(html).toContain('border:1px solid currentColor;');
    expect(html).toContain('background:transparent;');
    expect(html).toContain('color:#fdba74;');
    expect(html).not.toContain('background:rgba(249,115,22,.07);');
  });

  it('uses one seamless filled surface for expanded tools without a gradient rail', () => {
    const html = harnessHtml({ mcpUrl: 'http://x/mcp', theme: 'both', device: 'both' });
    expect(html).toContain('.tool.open{background:rgba(255,255,255,.04)}');
    expect(html).toContain('.tool.open .tool__head{background:rgba(255,255,255,.035)}');
    expect(html).not.toContain('.tool::before');
    expect(html).not.toContain('.tool.open::before');
  });

  it('harness has expandable tool cards (schema fields + Run) and expandable log input/output', () => {
    const html = harnessHtml({ mcpUrl: 'http://x/mcp', theme: 'both', device: 'both' });
    // Tool-card detail rendered from the tool inputSchema, with a Run action.
    expect(html).toContain('buildDetail');
    expect(html).toContain('inputSchema');
    expect(html).toContain('required');
    expect(html).toContain('Run');
    // Log entries expand to show request (input) + response (output).
    expect(html).toContain('section("input"');
    expect(html).toContain('section("output"');
  });
});

describe('devtools preview — server', () => {
  it('proxies /rpc to the dev endpoint and records a log entry', async () => {
    const upstream = await fakeMcp((body) => ({
      jsonrpc: '2.0',
      id: body.id,
      result: { structuredContent: { password: 'x' }, content: [{ type: 'text', text: 'x' }] },
    }));
    closers.push(upstream.close);
    const preview = await startPreview({ mcpUrl: upstream.url, theme: 'both', device: 'both' });
    closers.push(preview.close);

    const res = await fetch(new URL('/rpc', preview.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'new_strong', arguments: {} },
      }),
    });
    const json = (await res.json()) as { result: { structuredContent: { password: string } } };
    expect(json.result.structuredContent.password).toBe('x');
    expect(
      preview.log.some(
        (e) => e.method === 'tools/call' && e.name === 'new_strong' && e.status === 'ok',
      ),
    ).toBe(true);
  });

  it('captures request params (input) and response (output) in the log entry', async () => {
    const upstream = await fakeMcp((body) => ({
      jsonrpc: '2.0',
      id: body.id,
      result: { structuredContent: { password: 'z' } },
    }));
    closers.push(upstream.close);
    const preview = await startPreview({ mcpUrl: upstream.url, theme: 'both', device: 'both' });
    closers.push(preview.close);

    await fetch(new URL('/rpc', preview.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'new_simple', arguments: { length: 8 } },
      }),
    });
    const entry = preview.log.find((e) => e.method === 'tools/call');
    expect(entry?.request).toEqual({ name: 'new_simple', arguments: { length: 8 } });
    expect(entry?.response).toEqual({ structuredContent: { password: 'z' } });
  });

  it('serves /widget wrapping the resource HTML with the shim + baked initial output', async () => {
    const widgetHtml =
      '<!doctype html><html><head></head><body><main id="noodle-react-root"></main>' +
      '<script type="module">globalThis.ExtApps</script></body></html>';
    const upstream = await fakeMcp((body) => {
      if (body.method === 'tools/list') {
        return {
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools: [
              {
                name: 'generate_password',
                _meta: { ui: { resourceUri: 'ui://app/generate_password_widget' } },
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
                uri: (body.params as { uri: string }).uri,
                mimeType: 'text/html;profile=mcp-app',
                text: widgetHtml,
              },
            ],
          },
        };
      }
      return {
        jsonrpc: '2.0',
        id: body.id,
        result: { structuredContent: { simple: 'a', strong: 'b' }, content: [] },
      };
    });
    closers.push(upstream.close);
    const preview = await startPreview({ mcpUrl: upstream.url, theme: 'both', device: 'both' });
    closers.push(preview.close);

    const html = await (await fetch(new URL('/widget?name=generate_password', preview.url))).text();
    expect(html).toContain('window.openai');
    expect(html.indexOf('window.openai')).toBeLessThan(html.indexOf('globalThis.ExtApps'));
    expect(html).toContain('"strong":"b"');
  });

  it('broadcasts a reload event to /reload subscribers when signalReload() is called', async () => {
    const upstream = await fakeMcp((body) => ({ jsonrpc: '2.0', id: body.id, result: {} }));
    closers.push(upstream.close);
    const preview = await startPreview({ mcpUrl: upstream.url, theme: 'both', device: 'both' });
    closers.push(preview.close);

    expect(await nextReloadEvent(preview.url, preview.signalReload)).toBe('reload');
  });

  it('broadcasts a hard reload event when the customer auth boundary changes', async () => {
    const upstream = await fakeMcp((body) => ({ jsonrpc: '2.0', id: body.id, result: {} }));
    closers.push(upstream.close);
    const preview = await startPreview({ mcpUrl: upstream.url, theme: 'both', device: 'both' });
    closers.push(preview.close);

    expect(
      await nextReloadEvent(preview.url, () =>
        preview.updateCustomerAuth({ kind: 'unsupported', method: 'federated OIDC' }),
      ),
    ).toBe('hard');
  });

  it('exposes reload wiring on the harness client (EventSource + reload handler)', () => {
    const html = harnessHtml({ mcpUrl: 'http://x/mcp', theme: 'both', device: 'both' });
    expect(html).toContain('/reload');
    expect(html).toContain('EventSource');
  });

  it('threads widget args (toolInput) and result _meta into the shim', async () => {
    const widgetHtml =
      '<!doctype html><html><head></head><body><main></main>' +
      '<script type="module">globalThis.ExtApps</script></body></html>';
    const upstream = await fakeMcp((body) => {
      if (body.method === 'tools/list') {
        return {
          jsonrpc: '2.0',
          id: body.id,
          result: { tools: [{ name: 'w', _meta: { ui: { resourceUri: 'ui://a/w' } } }] },
        };
      }
      if (body.method === 'resources/read') {
        return {
          jsonrpc: '2.0',
          id: body.id,
          result: {
            contents: [
              {
                uri: (body.params as { uri: string }).uri,
                mimeType: 'text/html;profile=mcp-app',
                text: widgetHtml,
              },
            ],
          },
        };
      }
      // tools/call echoes the args + returns _meta
      return {
        jsonrpc: '2.0',
        id: body.id,
        result: {
          content: [{ type: 'text', text: 'Order unavailable' }],
          structuredContent: { ok: true },
          _meta: { flag: true },
          isError: true,
        },
      };
    });
    closers.push(upstream.close);
    const preview = await startPreview({ mcpUrl: upstream.url, theme: 'both', device: 'both' });
    closers.push(preview.close);

    const args = encodeURIComponent(JSON.stringify({ q: 5 }));
    const html = await (await fetch(new URL(`/widget?name=w&args=${args}`, preview.url))).text();
    expect(html).toContain('"toolInput":{"q":5}');
    expect(html).toContain('"toolResponseMetadata":{"flag":true}');
    expect(html).toContain(
      '"__noodleToolResult":{"content":[{"type":"text","text":"Order unavailable"}],"structuredContent":{"ok":true},"_meta":{"flag":true},"isError":true}',
    );
    // The tool was called with the threaded args, not {}.
    const call = preview.log.find((e) => e.method === 'tools/call');
    expect(call?.request).toEqual({ name: 'w', arguments: { q: 5 } });
  });

  it('rejects (not crashes) when the preview port is already in use', async () => {
    const blocker = createServer(() => {});
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const addr = blocker.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    closers.push(() => new Promise<void>((r) => blocker.close(() => r())));
    const upstream = await fakeMcp((body) => ({ jsonrpc: '2.0', id: body.id, result: {} }));
    closers.push(upstream.close);

    await expect(
      startPreview({ mcpUrl: upstream.url, theme: 'both', device: 'both', port }),
    ).rejects.toThrow();
  });

  it('serves the harness shell at /', async () => {
    const upstream = await fakeMcp((body) => ({ jsonrpc: '2.0', id: body.id, result: {} }));
    closers.push(upstream.close);
    const preview = await startPreview({ mcpUrl: upstream.url, theme: 'both', device: 'both' });
    closers.push(preview.close);
    const html = await (await fetch(preview.url)).text();
    expect(html).toContain('Noodle Seed');
    expect(html).toContain('id="tools"');
  });

  it('renders a one-field chat gate with inline OpenAI, Claude, and Gemini compatibility marks', () => {
    const html = harnessHtml({ mcpUrl: 'http://x/mcp', theme: 'both', device: 'both' });
    expect(html).toContain('id="mode-chat"');
    expect(html).toContain('id="chat-view"');
    expect(html).toContain('id="chat-input"');
    // The chat send loop posts to /chat and renders the tool call + widget inline (separately).
    expect(html).toContain('/chat');
    expect(html).toContain('renderToolCall');
    expect(html).toContain('renderWidget');
    expect(html).toContain('if(tc.isError||!tc.resourceUri) return');
    // Key-entry gate: an in-UI key form that stores the key server-side (never in the browser).
    expect(html).toContain('id="chat-key-input"');
    expect(html).toContain('Use your favourite model');
    expect(html).toContain('Test your local MCP server with');
    expect(html).toContain('data-provider-logo="openai"');
    expect(html).toContain('data-provider-logo="anthropic"');
    expect(html).toContain('data-provider-logo="gemini"');
    expect(html).toContain('M22.2819 9.8211');
    expect(html).toContain('m19.6 66.5 19.7-11');
    expect(html).toContain('aria-label="Provider API key"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('/chat/key');
    expect(html).toContain('/chat/status');
    expect(html).toContain('enterChat');
    // The key must never be persisted in the page (localStorage would be readable by same-origin widgets).
    expect(html).not.toContain('localStorage');
    expect(html).not.toContain('Enter an OpenAI API key');
    expect(html).not.toContain('class="provider-picker"');
    expect(html).not.toContain('id="chat-model-input"');
    expect(html).not.toContain('role="radiogroup"');
    expect(html).not.toContain(' — ');
  });

  it('exposes a fullscreen control + honors a widget requestDisplayMode("fullscreen")', () => {
    const html = harnessHtml({ mcpUrl: 'http://x/mcp', theme: 'both', device: 'both' });
    // Toolbar fullscreen button + presentation wiring.
    expect(html).toContain('id="fullscreen"');
    expect(html).toContain('enterFullscreen');
    expect(html).toContain('nd-frame-full');
    // Widget-initiated fullscreen: the shim posts a display-mode message the harness listens for.
    expect(html).toContain('noodle:display-mode');
    // Polished toolbar controls (labels + button class).
    expect(html).toContain('ctl__lbl');
    expect(html).toContain('ctl-btn');
  });

  it('uses direct theme and device controls instead of dropdown pickers', () => {
    const html = harnessHtml({ mcpUrl: 'http://x/mcp', theme: 'both', device: 'both' });
    expect(html).toContain('id="theme-toggle"');
    expect(html).toContain('class="theme-switch');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('class="device-switch" role="group"');
    expect(html).toContain('data-device="desktop"');
    expect(html).toContain('data-device="mobile"');
    expect(html).toContain('setDevice');
    expect(html).not.toContain('<select id="theme">');
    expect(html).not.toContain('<select id="device">');
  });

  it('renders a branded width scrubber with synchronized progress', () => {
    const html = harnessHtml({ mcpUrl: 'http://x/mcp', theme: 'both', device: 'both' });
    expect(html).toContain('id="width" type="range"');
    expect(html).toContain('aria-label="Preview width"');
    expect(html).toContain('<output id="width-val" for="width"');
    expect(html).toContain('>820 px</output>');
    expect(html).toContain('widthInput.style.setProperty("--width-progress",progress+"%")');
    expect(html).toContain('widthVal.textContent=widthInput.value+" px"');
    expect(html).toContain('appearance:none');
    expect(html).toContain('::-webkit-slider-runnable-track');
    expect(html).toContain('::-webkit-slider-thumb');
    expect(html).toContain('linear-gradient(90deg,var(--nd-accent),var(--nd-rose))');
    expect(html).toContain('var(--width-progress)');
    expect(html).toContain('.ctl--width:focus-within');
    expect(html).toContain(
      '@media (prefers-reduced-motion:reduce){\n  .ctl--width input[type=range]',
    );
    expect(html).not.toContain('accent-color:var(--nd-accent)');
  });

  it('calculates width progress from the range bounds at min, midpoint, and max', () => {
    expect(calculateRangeProgress(320, 320, 1200)).toBe(0);
    expect(calculateRangeProgress(760, 320, 1200)).toBe(50);
    expect(calculateRangeProgress(1200, 320, 1200)).toBe(100);
    expect(calculateRangeProgress(240, 320, 1200)).toBe(0);
    expect(calculateRangeProgress(1280, 320, 1200)).toBe(100);
  });

  it('clears the browser transcript when a pasted key changes the active provider', () => {
    const html = harnessHtml({ mcpUrl: 'http://x/mcp', theme: 'both', device: 'both' });
    expect(html).toContain('if(nextProvider!==chatProvider) chatMessages=[]');
  });

  it('uses native buttons for expandable developer-tool rows', () => {
    const html = harnessHtml({ mcpUrl: 'http://x/mcp', theme: 'both', device: 'both' });
    expect(html).toContain('var head=document.createElement("button"); head.type="button"');
    expect(html).toContain('head.setAttribute("aria-expanded","false")');
    expect(html).toContain('head.setAttribute("aria-expanded",open?"true":"false")');
  });

  it('substitutes every client placeholder (no literal __…__ tokens that would throw at runtime)', () => {
    for (const opts of [
      { mcpUrl: 'http://x/mcp', theme: 'both', device: 'both' } as const,
      { mcpUrl: 'http://x/mcp', theme: 'dark', device: 'mobile' } as const,
    ]) {
      const html = harnessHtml(opts);
      expect(html).not.toContain('__INITIAL_THEME__');
      expect(html).not.toContain('__INITIAL_DEVICE__');
    }
  });

  it('/chat returns a provider-specific no_api_key error when the selected key is unset', async () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const upstream = await fakeMcp((body) => ({ jsonrpc: '2.0', id: body.id, result: {} }));
      closers.push(upstream.close);
      const preview = await startPreview({ mcpUrl: upstream.url, theme: 'both', device: 'both' });
      closers.push(preview.close);
      const res = await fetch(new URL('/chat', preview.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      const json = (await res.json()) as { error?: { code: string; message: string } };
      expect(json.error?.code).toBe('no_api_key');
      expect(json.error?.message).toContain('OPENAI_API_KEY');
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
    }
  });

  it('rejects non-object JSON bodies on both chat routes without crashing', async () => {
    const upstream = await fakeMcp((body) => ({ jsonrpc: '2.0', id: body.id, result: {} }));
    closers.push(upstream.close);
    const preview = await startPreview({ mcpUrl: upstream.url, theme: 'both', device: 'both' });
    closers.push(preview.close);

    for (const path of ['/chat/key', '/chat']) {
      for (const body of ['null', '[]', '"string"', '1']) {
        const response = await fetch(new URL(path, preview.url), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: { code: 'invalid_json' },
        });
      }
    }

    expect((await fetch(new URL('/chat/status', preview.url))).status).toBe(200);
  });

  it('requires a pasted key when multiple provider environment keys are configured', async () => {
    const previous = {
      openai: process.env.OPENAI_API_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
      gemini: process.env.GEMINI_API_KEY,
    };
    process.env.OPENAI_API_KEY = 'sk-openai-env';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    delete process.env.GEMINI_API_KEY;
    try {
      const upstream = await fakeMcp((body) => ({ jsonrpc: '2.0', id: body.id, result: {} }));
      closers.push(upstream.close);
      const preview = await startPreview({ mcpUrl: upstream.url, theme: 'both', device: 'both' });
      closers.push(preview.close);

      const status0 = (await (await fetch(new URL('/chat/status', preview.url))).json()) as {
        activeProvider: string | null;
        requiresKey: boolean;
        error?: { code: string };
      };
      expect(status0).toMatchObject({
        activeProvider: null,
        requiresKey: true,
        error: { code: 'ambiguous_provider' },
      });

      const blocked = await fetch(new URL('/chat', preview.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toMatchObject({
        error: { code: 'ambiguous_provider' },
      });

      const connect = await fetch(new URL('/chat/key', preview.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'sk-ant-session-secret' }),
      });
      expect(await connect.json()).toMatchObject({ ok: true, provider: 'anthropic' });

      const status1 = (await (await fetch(new URL('/chat/status', preview.url))).json()) as {
        activeProvider: string | null;
        requiresKey: boolean;
      };
      expect(status1).toMatchObject({
        activeProvider: 'anthropic',
        requiresKey: false,
      });
    } finally {
      if (previous.openai !== undefined) process.env.OPENAI_API_KEY = previous.openai;
      else delete process.env.OPENAI_API_KEY;
      if (previous.anthropic !== undefined) process.env.ANTHROPIC_API_KEY = previous.anthropic;
      else delete process.env.ANTHROPIC_API_KEY;
      if (previous.gemini !== undefined) process.env.GEMINI_API_KEY = previous.gemini;
      else delete process.env.GEMINI_API_KEY;
    }
  });

  it('stores the key server-side via /chat/key and never returns it to the page', async () => {
    const openai: Server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi from key' } }] }),
        );
      });
    });
    await new Promise<void>((r) => openai.listen(0, '127.0.0.1', () => r()));
    const openaiPort = (openai.address() as { port: number }).port;
    closers.push(() => new Promise<void>((r) => openai.close(() => r())));

    const upstream = await fakeMcp((body) => ({
      jsonrpc: '2.0',
      id: body.id,
      result: { tools: [] },
    }));
    closers.push(upstream.close);

    const prevKey = process.env.OPENAI_API_KEY;
    const prevBase = process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${openaiPort}`;
    try {
      const preview = await startPreview({ mcpUrl: upstream.url, theme: 'both', device: 'both' });
      closers.push(preview.close);

      // Before setting a key, status reports none and /chat refuses.
      const status0 = (await (await fetch(new URL('/chat/status', preview.url))).json()) as {
        providers: Record<
          string,
          { hasKey: boolean; source: string; envName: string; model: string }
        >;
      };
      expect(status0.providers.openai).toMatchObject({ hasKey: false, source: 'none' });
      expect(status0.providers.anthropic).toMatchObject({
        envName: 'ANTHROPIC_API_KEY',
        model: 'claude-opus-5',
      });
      expect(status0.providers.gemini).toMatchObject({
        envName: 'GEMINI_API_KEY',
        model: 'gemini-3.6-flash',
      });

      // Set the key server-side. The response confirms presence but never echoes the key value.
      const setRes = await fetch(new URL('/chat/key', preview.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'sk-session-secret' }),
      });
      const setJson = (await setRes.json()) as Record<string, unknown>;
      expect(setJson).toMatchObject({
        ok: true,
        provider: 'openai',
        hasKey: true,
        source: 'session',
        model: 'gpt-5.5',
      });
      expect(JSON.stringify(setJson)).not.toContain('sk-session-secret');

      // Now /chat works with no key in the request body/headers.
      const res = await fetch(new URL('/chat', preview.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          model: 'gpt-5.5',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      const json = (await res.json()) as { text?: string; error?: { code: string } };
      expect(json.error).toBeUndefined();
      expect(json.text).toBe('hi from key');

      // Clearing the session key returns to the gated state.
      await fetch(new URL('/chat/key', preview.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai', key: '' }),
      });
      const status1 = (await (await fetch(new URL('/chat/status', preview.url))).json()) as {
        providers: Record<string, { hasKey: boolean }>;
      };
      expect(status1.providers.openai?.hasKey).toBe(false);
    } finally {
      if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey;
      if (prevBase !== undefined) process.env.OPENAI_BASE_URL = prevBase;
      else delete process.env.OPENAI_BASE_URL;
    }
  });

  it('/chat/key infers Claude and Gemini from their API-key prefixes', async () => {
    const upstream = await fakeMcp((body) => ({ jsonrpc: '2.0', id: body.id, result: {} }));
    closers.push(upstream.close);
    const preview = await startPreview({ mcpUrl: upstream.url, theme: 'both', device: 'both' });
    closers.push(preview.close);

    for (const [key, provider] of [
      ['sk-ant-local-secret', 'anthropic'],
      ['AIza-local-secret', 'gemini'],
    ]) {
      const response = await fetch(new URL('/chat/key', preview.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      expect(await response.json()).toMatchObject({ ok: true, provider });
    }
  });

  it('keeps the last inferred provider active when multiple API keys are available', async () => {
    const previous = {
      openai: process.env.OPENAI_API_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
      gemini: process.env.GEMINI_API_KEY,
    };
    process.env.OPENAI_API_KEY = 'sk-openai-env';
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const upstream = await fakeMcp((body) => ({ jsonrpc: '2.0', id: body.id, result: {} }));
      closers.push(upstream.close);
      const preview = await startPreview({
        mcpUrl: upstream.url,
        theme: 'both',
        device: 'both',
      });
      closers.push(preview.close);

      for (const [key, expectedProvider] of [
        ['sk-ant-local-secret', 'anthropic'],
        ['AIza-local-secret', 'gemini'],
      ]) {
        await fetch(new URL('/chat/key', preview.url), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key }),
        });
        const status = (await (await fetch(new URL('/chat/status', preview.url))).json()) as {
          activeProvider: string;
        };
        expect(status.activeProvider).toBe(expectedProvider);
      }
    } finally {
      if (previous.openai !== undefined) process.env.OPENAI_API_KEY = previous.openai;
      else delete process.env.OPENAI_API_KEY;
      if (previous.anthropic !== undefined) process.env.ANTHROPIC_API_KEY = previous.anthropic;
      else delete process.env.ANTHROPIC_API_KEY;
      if (previous.gemini !== undefined) process.env.GEMINI_API_KEY = previous.gemini;
      else delete process.env.GEMINI_API_KEY;
    }
  });

  it('binds chat requests to the provider inferred from the connected key', async () => {
    const previous = {
      openai: process.env.OPENAI_API_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
      gemini: process.env.GEMINI_API_KEY,
    };
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const upstream = await fakeMcp((body) => ({ jsonrpc: '2.0', id: body.id, result: {} }));
      closers.push(upstream.close);
      const preview = await startPreview({ mcpUrl: upstream.url, theme: 'both', device: 'both' });
      closers.push(preview.close);

      const connect = await fetch(new URL('/chat/key', preview.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          key: 'sk-ant-local-secret',
        }),
      });
      expect(await connect.json()).toMatchObject({ ok: true, provider: 'anthropic' });

      const response = await fetch(new URL('/chat', preview.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(await response.json()).toMatchObject({
        error: {
          code: 'provider_mismatch',
        },
      });
    } finally {
      if (previous.openai !== undefined) process.env.OPENAI_API_KEY = previous.openai;
      else delete process.env.OPENAI_API_KEY;
      if (previous.anthropic !== undefined) process.env.ANTHROPIC_API_KEY = previous.anthropic;
      else delete process.env.ANTHROPIC_API_KEY;
      if (previous.gemini !== undefined) process.env.GEMINI_API_KEY = previous.gemini;
      else delete process.env.GEMINI_API_KEY;
    }
  });

  it('/chat runs the agent loop: calls a tool on the MCP endpoint and returns the transcript', async () => {
    // Fake OpenAI: first completion requests a tool, second returns the final answer.
    let turn = 0;
    let receivedSystem = '';
    const openai: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          messages?: readonly { role?: string; content?: string }[];
        };
        receivedSystem = body.messages?.find((message) => message.role === 'system')?.content ?? '';
        turn += 1;
        const message =
          turn === 1
            ? {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'c1',
                    type: 'function',
                    function: { name: 'new_strong', arguments: '{"length":10}' },
                  },
                ],
              }
            : { role: 'assistant', content: 'Done — password generated.' };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message }] }));
      });
    });
    await new Promise<void>((r) => openai.listen(0, '127.0.0.1', () => r()));
    const openaiPort = (openai.address() as { port: number }).port;
    closers.push(() => new Promise<void>((r) => openai.close(() => r())));

    const upstream = await fakeMcp((body) => {
      if (body.method === 'tools/list') {
        return {
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools: [
              {
                name: 'new_strong',
                annotations: {
                  readOnlyHint: true,
                  destructiveHint: false,
                  openWorldHint: false,
                },
                _meta: { ui: { resourceUri: 'ui://a/w' } },
              },
            ],
          },
        };
      }
      return {
        jsonrpc: '2.0',
        id: body.id,
        result: { structuredContent: { password: 'xyz' } },
      };
    });
    closers.push(upstream.close);

    const prevKey = process.env.OPENAI_API_KEY;
    const prevBase = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${openaiPort}`;
    try {
      const preview = await startPreview({
        mcpUrl: upstream.url,
        theme: 'both',
        device: 'both',
        assistantInstructions: () => 'Use the local product evidence before making product claims.',
      });
      closers.push(preview.close);
      const res = await fetch(new URL('/chat', preview.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          messages: [{ role: 'user', content: 'make a password' }],
        }),
      });
      const json = (await res.json()) as {
        text: string;
        toolCalls: Array<{ name: string; arguments: unknown; resourceUri?: string }>;
      };
      expect(json.text).toBe('Done — password generated.');
      expect(receivedSystem).toContain('Noodle Seed devtools playground');
      expect(receivedSystem).toContain(
        'Use the local product evidence before making product claims.',
      );
      expect(json.toolCalls[0]).toMatchObject({
        name: 'new_strong',
        arguments: { length: 10 },
        resourceUri: 'ui://a/w',
      });
      // The agent's tool call went through the /rpc forwarder, so it shows up in the MCP call log too.
      expect(preview.log.some((e) => e.method === 'tools/call' && e.name === 'new_strong')).toBe(
        true,
      );
    } finally {
      if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey;
      else delete process.env.OPENAI_API_KEY;
      if (prevBase !== undefined) process.env.OPENAI_BASE_URL = prevBase;
      else delete process.env.OPENAI_BASE_URL;
    }
  });
});
