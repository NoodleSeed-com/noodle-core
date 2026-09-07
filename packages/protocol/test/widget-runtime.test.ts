// @vitest-environment happy-dom
/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WIDGET_BOOTSTRAP_SOURCE } from '../src/widget/bootstrap.js';
import { runWidgetRuntimeSource } from './widget-runtime-eval.js';

/**
 * The widget runtime QA harness (W2.5) — the first rendered-DOM coverage for widgets. It `eval`s the
 * EXACT shipped bootstrap (`WIDGET_BOOTSTRAP_SOURCE`, the same string `inject.ts` concatenates after the
 * ext-apps bundle) against a happy-dom document and a mock host, so the runtime is regression-tested with
 * zero drift and no build step. It exercises the logic-level acceptance checks: theme toggle, result/input
 * binding, the CSP-safe `[data-action]` dispatch (send/context/call/open/display/download), UI-initiated
 * `callServerTool` with `{{...}}` arg templating + result re-bind, lifecycle (cancel/teardown), and graceful
 * degradation with no host. True-render checks (responsive reflow, real CSP enforcement) are deferred to a
 * Playwright slice — see docs/spec/apps-and-authoring.md.
 */

type Handler = (params: unknown) => unknown;

interface MockHost {
  handlers: Record<string, Handler | undefined>;
  calls: Array<{ method: string; args: unknown }>;
  connected: boolean;
  hostContext: unknown;
  hostCapabilities: unknown;
  callResult: unknown;
  widgetState: unknown;
  getHostContext(): unknown;
  getHostCapabilities(): unknown;
}

let captured: MockHost | undefined;
let nextWidgetState: unknown;

class MockApp implements MockHost {
  handlers: Record<string, Handler | undefined> = {};
  calls: Array<{ method: string; args: unknown }> = [];
  connected = false;
  hostContext: unknown = undefined;
  hostCapabilities: unknown = {
    tools: true,
    openLink: true,
    displayMode: true,
    downloadFile: true,
  };
  callResult: unknown = { content: [{ type: 'text', text: '{}' }] };
  widgetState: unknown = nextWidgetState;

  constructor(_info: unknown, _caps: unknown, _opts: unknown) {
    captured = this;
  }

  set ontoolresult(fn: Handler | undefined) {
    this.handlers.toolresult = fn;
  }
  set ontoolinput(fn: Handler | undefined) {
    this.handlers.toolinput = fn;
  }
  set ontoolcancelled(fn: Handler | undefined) {
    this.handlers.toolcancelled = fn;
  }
  set onhostcontextchanged(fn: Handler | undefined) {
    this.handlers.hostcontextchanged = fn;
  }
  set onteardown(fn: Handler | undefined) {
    this.handlers.teardown = fn;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }
  getHostContext(): unknown {
    return this.hostContext;
  }
  getHostCapabilities(): unknown {
    return this.hostCapabilities;
  }
  getWidgetState(): unknown {
    return this.widgetState;
  }
  setWidgetState(p: unknown): void {
    this.widgetState = p;
    this.calls.push({ method: 'setWidgetState', args: p });
  }
  sendMessage(p: unknown): Promise<unknown> {
    this.calls.push({ method: 'sendMessage', args: p });
    return Promise.resolve({});
  }
  updateModelContext(p: unknown): Promise<unknown> {
    this.calls.push({ method: 'updateModelContext', args: p });
    return Promise.resolve({});
  }
  callServerTool(p: unknown): Promise<unknown> {
    this.calls.push({ method: 'callServerTool', args: p });
    return Promise.resolve(this.callResult);
  }
  openLink(p: unknown): Promise<unknown> {
    this.calls.push({ method: 'openLink', args: p });
    return Promise.resolve({ isError: false });
  }
  requestDisplayMode(p: unknown): Promise<unknown> {
    this.calls.push({ method: 'requestDisplayMode', args: p });
    return Promise.resolve({});
  }
  readServerResource(p: unknown): Promise<unknown> {
    this.calls.push({ method: 'readServerResource', args: p });
    return Promise.resolve({
      contents: [{ uri: 'docs://guide', mimeType: 'text/plain', text: 'Guide text' }],
    });
  }
  listServerResources(p: unknown): Promise<unknown> {
    this.calls.push({ method: 'listServerResources', args: p });
    return Promise.resolve({ resources: [{ uri: 'docs://guide', name: 'Guide' }] });
  }
  downloadFile(p: unknown): Promise<unknown> {
    this.calls.push({ method: 'downloadFile', args: p });
    return Promise.resolve({ isError: false });
  }
}

const applyHostStyleVariables = vi.fn();
const applyHostFonts = vi.fn();
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const globals = globalThis as unknown as {
  ExtApps?: unknown;
  __noodleData?: unknown;
  __noodleInput?: unknown;
  __noodleState?: unknown;
  __noodleToolResult?: unknown;
  __noodleReactBridge?: unknown;
};

const DEFAULT_BODY = `
  <dd data-bind="severity">—</dd>
  <dd data-bind-input="customer">—</dd>
  <section data-bind-if="escalated" hidden>escalated</section>
  <button id="send" data-action="send" data-action-text="hello">Send</button>
  <button id="ctx" data-action="context" data-action-text="noted">Note</button>
  <button id="call" data-action="call" data-action-tool="escalate_ticket" data-action-args='{"severity":"{{severity}}"}'>Escalate</button>
  <button id="open" data-action="open" data-action-href="https://example.com/docs">Docs</button>
  <button id="disp" data-action="display" data-action-mode="fullscreen">FS</button>
  <button id="dl" data-action="download" data-action-file="t.txt" data-action-mime="text/plain" data-action-content="sev-{{severity}}">DL</button>
  <button id="read" data-action="resource-read" data-action-uri="docs://guide" data-action-state-key="guide">Read</button>
  <button id="reslist" data-action="resources-list" data-action-state-key="resources">Resources</button>
  <output id="guide" data-bind-state="guide.contents.0.text">—</output>
  <output id="resources" data-bind-state="resources.resources.0.name">—</output>
  <span id="tone" class="ns-badge" data-tone="neutral" data-bind-tone="check_tone">Checks</span>
  <button id="copy" data-action="copy" data-action-content="https://borg.example/{{slug}}">Copy link</button>
  <div data-copy-wrap="true"><pre><code data-copy-source="true">curl {{endpoint}} -H x</code></pre><button id="codecopy" data-action="copy">Copy</button></div>
  <button id="boundopen" data-action="open" data-action-href="https://example.com/d/{{doc_id}}">Open doc</button>
  <button id="jsopen" data-action="open" data-action-href="javascript:alert(1)">Bad</button>
  <button id="fullopen" data-action="open" data-action-href="{{configureUrl}}">Open form</button>
  <dd id="meta-token" data-bind="_meta.noodle.app.confirmToken">—</dd>
  <pre id="manifest" data-bind="manifest">—</pre>
  <pre id="items" data-bind="items">—</pre>
  <pre id="input-obj" data-bind-input="config">—</pre>
  <button id="confirm" data-action="call" data-action-tool="confirm_deploy" data-action-args='{"confirmToken":"{{_meta.noodle.app.confirmToken}}"}'>Confirm</button>
  <p id="emptymsg" data-repeat-empty="drafts">No drafts yet</p>
`;

function mockClipboard(writeText: unknown): void {
  Object.defineProperty(navigator, 'clipboard', {
    value: writeText === undefined ? undefined : { writeText },
    configurable: true,
  });
}

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected a value');
  return value;
}
function el<T extends Element = HTMLElement>(selector: string): T {
  return must(document.querySelector(selector)) as unknown as T;
}

/** Reset the DOM + globals, then `eval` the exact shipped runtime source against the current mock host. */
async function installRuntime(html = DEFAULT_BODY): Promise<MockHost | undefined> {
  document.documentElement.className = '';
  document.body.innerHTML = html;
  globals.__noodleData = undefined;
  globals.__noodleInput = undefined;
  globals.__noodleState = undefined;
  globals.__noodleToolResult = undefined;
  globals.__noodleReactBridge = undefined;
  (globals as { __noodleActiveView?: unknown }).__noodleActiveView = undefined;
  captured = undefined;
  await runWidgetRuntimeSource(WIDGET_BOOTSTRAP_SOURCE);
  return captured;
}

beforeEach(() => {
  applyHostStyleVariables.mockClear();
  applyHostFonts.mockClear();
  nextWidgetState = undefined;
  globals.__noodleReactBridge = undefined;
  globals.ExtApps = { App: MockApp, applyHostStyleVariables, applyHostFonts };
});

describe('widget runtime bootstrap', () => {
  it('opens the host bridge and registers result/input/lifecycle handlers before connect', async () => {
    const app = must(await installRuntime());
    expect(app.connected).toBe(true);
    for (const h of [
      'toolresult',
      'toolinput',
      'toolcancelled',
      'hostcontextchanged',
      'teardown',
    ]) {
      expect(typeof app.handlers[h]).toBe('function');
    }
  });

  it('applies host theme: toggles .dark and forwards style variables + fonts', async () => {
    const app = must(await installRuntime());
    must(app.handlers.hostcontextchanged)({
      theme: 'dark',
      styles: { variables: { '--x': '1' }, css: { fonts: '@font-face{}' } },
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(applyHostStyleVariables).toHaveBeenCalledWith({ '--x': '1' });
    expect(applyHostFonts).toHaveBeenCalledWith('@font-face{}');
    must(app.handlers.hostcontextchanged)({ theme: 'light' });
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('keeps the theme class on a styles-only partial host-context update (no theme field)', async () => {
    const app = must(await installRuntime());
    must(app.handlers.hostcontextchanged)({ theme: 'dark' });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    // A partial update carrying only styles (theme omitted) must NOT flip a dark widget back to light.
    must(app.handlers.hostcontextchanged)({ styles: { variables: { '--y': '2' } } });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(applyHostStyleVariables).toHaveBeenCalledWith({ '--y': '2' });
  });

  it('binds the tool result into [data-bind] and toggles [data-bind-if]', async () => {
    const app = must(await installRuntime());
    must(app.handlers.toolresult)({ structuredContent: { severity: 'high', escalated: 'yes' } });
    expect(el('[data-bind="severity"]').textContent).toBe('high');
    expect(el<HTMLElement>('[data-bind-if="escalated"]').hidden).toBe(false);
    expect(globals.__noodleData).toEqual({ severity: 'high', escalated: 'yes' });
  });

  it('summarizes object and array bindings in ordinary text while preserving explicit code blocks', async () => {
    const app = must(
      await installRuntime(`
        <p id="plain-object" data-bind="profile">—</p>
        <p id="plain-array" data-bind="items">—</p>
        <pre><code id="code-object" data-bind="profile">—</code></pre>
      `),
    );
    must(app.handlers.toolresult)({
      structuredContent: {
        profile: { name: 'Asha', tier: 'gold' },
        items: ['one', 'two'],
      },
    });

    expect(el('#plain-object').textContent).toBe('Available');
    expect(el('#plain-array').textContent).toBe('2 items');
    expect(el('#code-object').textContent).toBe('{\n  "name": "Asha",\n  "tier": "gold"\n}');
  });

  it('falls back to parsing the first text content block as JSON', async () => {
    const app = must(await installRuntime());
    must(app.handlers.toolresult)({
      content: [{ type: 'text', text: JSON.stringify({ severity: 'low' }) }],
    });
    expect(el('[data-bind="severity"]').textContent).toBe('low');
  });

  it('binds tool-call arguments into [data-bind-input]', async () => {
    const app = must(await installRuntime());
    must(app.handlers.toolinput)({ arguments: { customer: 'Acme Corp' } });
    expect(el('[data-bind-input="customer"]').textContent).toBe('Acme Corp');
    expect(globals.__noodleInput).toEqual({ customer: 'Acme Corp' });
  });

  it('initializes field defaults from input, result, state, and literals without overwriting user edits', async () => {
    const app = must(
      await installRuntime(`
        <div data-surface data-initial-view="main" data-state-defaults='{"item":"soup"}'>
          <section data-view="main">
            <input id="customer" data-state-name="customer" data-default-input="customer">
            <select id="item" data-state-name="item" data-default-state="item">
              <option value="wrap">Wrap</option>
              <option value="soup">Soup</option>
            </select>
            <input id="qty" data-state-name="quantity" data-default-value="1">
            <input id="note" data-state-name="note" data-default-result="note">
          </section>
        </div>
      `),
    );
    must(app.handlers.toolinput)({ arguments: { customer: 'Acme Corp' } });
    must(app.handlers.toolresult)({ structuredContent: { note: 'extra mint' } });

    expect(el<HTMLInputElement>('#customer').value).toBe('Acme Corp');
    expect(el<HTMLSelectElement>('#item').value).toBe('soup');
    expect(el<HTMLInputElement>('#qty').value).toBe('1');
    expect(el<HTMLInputElement>('#note').value).toBe('extra mint');

    el<HTMLInputElement>('#customer').value = 'Edited';
    must(app.handlers.toolinput)({ arguments: { customer: 'Other Corp' } });
    expect(el<HTMLInputElement>('#customer').value).toBe('Edited');
  });

  it('renders surface state collections and media before tool results arrive', async () => {
    const app = must(
      await installRuntime(`
      <div data-surface data-initial-view="main" data-state-defaults='{"destinations":[{"title":"Lisbon","imageUrl":"https://cdn.example.com/lisbon.jpg","alt":"Lisbon tram"}]}'>
        <section data-view="main">
          <div id="hero" data-media data-media-image="https://cdn.example.com/hero.jpg" data-media-alt="Hero image"></div>
          <div id="collection" class="ns-collection ns-collection-carousel" data-collection-state="destinations" data-collection-item="item">
            <template data-collection-template>
              <p data-bind="item.title">—</p>
              <div data-media data-media-image-bind="item.imageUrl" data-media-alt-bind="item.alt"></div>
            </template>
            <p data-collection-empty="destinations">No destinations</p>
          </div>
        </section>
      </div>
    `),
    );

    expect(document.querySelectorAll('[data-collection-generated]')).toHaveLength(1);
    expect(el('#collection [data-collection-empty]').hasAttribute('hidden')).toBe(true);
    expect(el('#collection [data-collection-generated] p').textContent).toBe('Lisbon');
    expect(el<HTMLImageElement>('#hero img.ns-media-image').getAttribute('src')).toBe(
      'https://cdn.example.com/hero.jpg',
    );
    expect(
      el<HTMLImageElement>(
        '#collection [data-collection-generated] img.ns-media-image',
      ).getAttribute('src'),
    ).toBe('https://cdn.example.com/lisbon.jpg');

    must(app.handlers.toolresult)({ structuredContent: { ok: true } });
    expect(el('#collection [data-collection-generated] p').textContent).toBe('Lisbon');
    expect(
      el<HTMLImageElement>(
        '#collection [data-collection-generated] img.ns-media-image',
      ).getAttribute('src'),
    ).toBe('https://cdn.example.com/lisbon.jpg');
  });

  it('marks state-setting item actions as selected and persists private widget state', async () => {
    const app = must(
      await installRuntime(`
        <div data-surface data-initial-view="menu" data-state-defaults='{"item":"wrap"}'>
          <section data-view="menu">
            <article id="wrap-card" class="ns-item-group">
              <button id="wrap" data-action="sequence" data-select-state-key="item" data-select-state-value="wrap" data-action-effects='[
                {"type":"setState","set":{"item":"wrap"}}
              ]'>Choose wrap</button>
            </article>
            <article id="soup-card" class="ns-item-group">
              <button id="soup" data-action="sequence" data-select-state-key="item" data-select-state-value="soup" data-action-effects='[
                {"type":"setState","set":{"item":"soup"}}
              ]'>Choose soup</button>
            </article>
            <span id="chosen" data-bind-state="item">—</span>
          </section>
        </div>
      `),
    );

    expect(el<HTMLButtonElement>('#wrap').getAttribute('aria-pressed')).toBe('true');
    expect(el<HTMLElement>('#wrap-card').getAttribute('data-selected')).toBe('true');
    expect(el<HTMLButtonElement>('#soup').getAttribute('aria-pressed')).toBe('false');

    el<HTMLButtonElement>('#soup').click();
    await flush();

    expect(el('#chosen').textContent).toBe('soup');
    expect(el<HTMLButtonElement>('#wrap').getAttribute('aria-pressed')).toBe('false');
    expect(el<HTMLElement>('#wrap-card').hasAttribute('data-selected')).toBe(false);
    expect(el<HTMLButtonElement>('#soup').getAttribute('aria-pressed')).toBe('true');
    expect(el<HTMLElement>('#soup-card').getAttribute('data-selected')).toBe('true');
    expect(app.calls.find((c) => c.method === 'setWidgetState')?.args).toEqual({
      modelContent: null,
      privateContent: { activeView: 'menu', state: { item: 'soup' } },
      imageIds: [],
    });
  });

  it('dispatches state-handle effects through generated app-only helper tools and binds records', async () => {
    const app = must(
      await installRuntime(`
        <input id="title" data-state-name="title" value="Tea">
        <button id="load" data-action="sequence" data-action-effects='[
          {"type":"loadStateHandle","handle":"draft","resultKey":"draft_state"}
        ]'>Load</button>
        <button id="patch" data-action="sequence" data-action-effects='[
          {
            "type":"patchStateHandle",
            "handle":"draft",
            "expectedRevision":{"from":"state","path":"draft_state.revision"},
            "value":{"title":{"from":"state","path":"title"}},
            "resultKey":"draft_state"
          }
        ]'>Patch</button>
        <output id="title-out" data-bind-state="draft_state.value.title">—</output>
        <output id="rev-out" data-bind-state="draft_state.revision">—</output>
      `),
    );

    app.callResult = {
      structuredContent: {
        ok: true,
        handle: 'draft',
        key: 'default',
        value: { title: 'Stored' },
        revision: 3,
        status: 'active',
      },
    };
    el<HTMLButtonElement>('#load').click();
    await flush();

    expect(app.calls.find((c) => c.method === 'callServerTool')?.args).toEqual({
      name: '__noodle_state_load_draft',
      arguments: {},
    });
    expect(el('#title-out').textContent).toBe('Stored');
    expect(el('#rev-out').textContent).toBe('3');

    app.calls = [];
    app.callResult = {
      structuredContent: {
        ok: true,
        handle: 'draft',
        key: 'default',
        value: { title: 'Tea' },
        revision: 4,
        status: 'active',
      },
    };
    el<HTMLButtonElement>('#patch').click();
    await flush();

    expect(app.calls.find((c) => c.method === 'callServerTool')?.args).toEqual({
      name: '__noodle_state_patch_draft',
      arguments: { expectedRevision: 3, value: { title: 'Tea' } },
    });
    expect(el('#title-out').textContent).toBe('Tea');
    expect(el('#rev-out').textContent).toBe('4');
  });

  it('shows a safe error when a state-handle effect is rejected', async () => {
    const app = must(
      await installRuntime(`
        <button id="patch" data-action="sequence" data-action-effects='[
          {
            "type":"patchStateHandle",
            "handle":"draft",
            "expectedRevision":1,
            "value":{"title":"New"},
            "resultKey":"draft_state"
          }
        ]'>Patch</button>
        <output id="title-out" data-bind-state="draft_state.value.title">—</output>
      `),
    );
    app.callResult = {
      structuredContent: {
        ok: true,
        handle: 'draft',
        key: 'default',
        value: { title: 'Old' },
        revision: 1,
        status: 'active',
      },
    };
    (app.callServerTool as unknown as (p: unknown) => Promise<unknown>) = (p: unknown) => {
      app.calls.push({ method: 'callServerTool', args: p });
      return Promise.reject(new Error('revision conflict: expected 1'));
    };

    el<HTMLButtonElement>('#patch').click();
    await flush();

    expect(el('[data-noodle-error]').textContent).toBe(
      'State update failed. Refresh the widget and try again.',
    );
    expect(el('#title-out').textContent).toBe('—');
  });

  it('restores private widget state before applying surface defaults', async () => {
    nextWidgetState = {
      modelContent: null,
      privateContent: { activeView: 'detail', state: { item: 'soup' } },
      imageIds: [],
    };
    await installRuntime(`
      <div data-surface data-initial-view="menu" data-state-defaults='{"item":"wrap"}'>
        <section id="menu" data-view="menu"><span id="chosen" data-bind-state="item">—</span></section>
        <section id="detail" data-view="detail" hidden>Detail</section>
      </div>
    `);

    expect(el('#chosen').textContent).toBe('soup');
    expect(el<HTMLElement>('#menu').hidden).toBe(true);
    expect(el<HTMLElement>('#detail').hidden).toBe(false);
  });

  it('dispatches data-action send → sendMessage and context → updateModelContext', async () => {
    const app = must(await installRuntime());
    el<HTMLButtonElement>('#send').click();
    el<HTMLButtonElement>('#ctx').click();
    expect(app.calls.find((c) => c.method === 'sendMessage')?.args).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    });
    expect(app.calls.find((c) => c.method === 'updateModelContext')?.args).toEqual({
      content: [{ type: 'text', text: 'noted' }],
    });
  });

  it('data-action="call" invokes the server tool with {{...}} args from the result, then re-binds', async () => {
    const app = must(await installRuntime());
    must(app.handlers.toolresult)({ structuredContent: { severity: 'high' } });
    app.callResult = { structuredContent: { escalated: 'yes', severity: 'high' } };
    const btn = el<HTMLButtonElement>('#call');
    btn.click();
    expect(app.calls.find((c) => c.method === 'callServerTool')?.args).toEqual({
      name: 'escalate_ticket',
      arguments: { severity: 'high' },
    });
    expect(btn.disabled).toBe(true); // disabled while in-flight
    await flush();
    expect(btn.disabled).toBe(false); // re-enabled on completion
    expect(el<HTMLElement>('[data-bind-if="escalated"]').hidden).toBe(false); // result re-bound in place
    expect(globals.__noodleToolResult).toBe(app.callResult);
  });

  it('dispatches retry actions rendered inside status-state markup', async () => {
    const html = `<section data-status-kind="retry"><button id="retry" data-action="call" data-action-tool="refresh_results" data-action-args='{"query":"{{query}}"}'>Try again</button></section>`;
    const app = must(await installRuntime(html));
    must(app.handlers.toolresult)({ structuredContent: { query: 'falafel' } });
    el<HTMLButtonElement>('#retry').click();
    expect(app.calls.find((c) => c.method === 'callServerTool')?.args).toEqual({
      name: 'refresh_results',
      arguments: { query: 'falafel' },
    });
  });

  it('runs sequenced effects: call tool, capture result into state, then navigate views', async () => {
    const app = must(
      await installRuntime(`
        <div data-surface data-initial-view="list" data-state-defaults='{"selected_item":null}'>
          <section id="list" data-view="list">
            <button id="open" data-action="sequence" data-action-effects='[
              {"type":"callTool","tool":"load_item","args":{"id":"{{item.id}}"},"resultKey":"selected_item"},
              {"type":"navigate","view":"detail"}
            ]'>Open</button>
          </section>
          <section id="detail" data-view="detail" hidden>
            <span id="title" data-bind-state="selected_item.title">—</span>
          </section>
        </div>
      `),
    );
    must(app.handlers.toolresult)({ structuredContent: { item: { id: 'item_1' } } });
    app.callResult = { structuredContent: { title: 'Item One' } };

    el<HTMLButtonElement>('#open').click();
    expect(el<HTMLButtonElement>('#open').disabled).toBe(true);
    await flush();

    expect(app.calls.find((c) => c.method === 'callServerTool')?.args).toEqual({
      name: 'load_item',
      arguments: { id: 'item_1' },
    });
    expect(el<HTMLElement>('#list').hidden).toBe(true);
    expect(el<HTMLElement>('#detail').hidden).toBe(false);
    expect(el('#title').textContent).toBe('Item One');
    expect(globals.__noodleState).toEqual({ selected_item: { title: 'Item One' } });
  });

  it('re-binds a non-state sequence result through the canonical React result path', async () => {
    const app = must(
      await installRuntime(`
        <span id="status" data-bind="status">—</span>
        <button id="refresh" data-action="sequence" data-action-effects='[
          {"type":"callTool","tool":"refresh_status"}
        ]'>Refresh</button>
      `),
    );
    app.callResult = {
      structuredContent: { status: 'ready' },
      _meta: { source: 'sequence' },
    };

    el<HTMLButtonElement>('#refresh').click();
    await flush();

    expect(el('#status').textContent).toBe('ready');
    expect(globals.__noodleToolResult).toBe(app.callResult);
  });

  it('runs back and refresh effects without a server-held surface session', async () => {
    const app = must(
      await installRuntime(`
        <div data-surface data-initial-view="list">
          <section id="list" data-view="list">
            <span id="summary" data-bind="summary">stale</span>
            <button id="open" data-action="sequence" data-action-effects='[
              {"type":"navigate","view":"detail"}
            ]'>Open</button>
            <button id="refresh" data-action="sequence" data-action-effects='[
              {"type":"refresh"}
            ]'>Refresh</button>
          </section>
          <section id="detail" data-view="detail" hidden>
            <button id="back" data-action="sequence" data-action-effects='[
              {"type":"back"}
            ]'>Back</button>
          </section>
        </div>
      `),
    );
    must(app.handlers.toolresult)({ structuredContent: { summary: 'Fresh summary' } });

    el<HTMLButtonElement>('#open').click();
    await flush();
    expect(el<HTMLElement>('#list').hidden).toBe(true);
    expect(el<HTMLElement>('#detail').hidden).toBe(false);

    el<HTMLButtonElement>('#back').click();
    await flush();
    expect(el<HTMLElement>('#list').hidden).toBe(false);
    expect(el<HTMLElement>('#detail').hidden).toBe(true);

    el('#summary').textContent = 'manually stale';
    el<HTMLButtonElement>('#refresh').click();
    await flush();
    expect(el('#summary').textContent).toBe('Fresh summary');
    expect(app.calls.filter((c) => c.method === 'callServerTool')).toHaveLength(0);
  });

  it('halts a sequence on tool failure and leaves the current view unchanged', async () => {
    const app = must(
      await installRuntime(`
        <div data-surface data-initial-view="list">
          <section id="list" data-view="list">
            <button id="open" data-action="sequence" data-action-effects='[
              {"type":"callTool","tool":"load_item","resultKey":"selected_item"},
              {"type":"navigate","view":"detail"}
            ]'>Open</button>
          </section>
          <section id="detail" data-view="detail" hidden>Detail</section>
        </div>
      `),
    );
    app.callServerTool = (p: unknown) => {
      app.calls.push({ method: 'callServerTool', args: p });
      return Promise.reject(new Error('denied'));
    };

    el<HTMLButtonElement>('#open').click();
    await flush();

    expect(el<HTMLElement>('#list').hidden).toBe(false);
    expect(el<HTMLElement>('#detail').hidden).toBe(true);
    expect(el('[data-noodle-error]').textContent).toBe(
      'Action failed. Check the tool result or host permissions.',
    );
  });

  it('shows action failures instead of swallowing them', async () => {
    const app = must(await installRuntime());
    app.callServerTool = (p: unknown) => {
      app.calls.push({ method: 'callServerTool', args: p });
      return Promise.reject(new Error('denied by host'));
    };
    must(app.handlers.toolresult)({ structuredContent: { severity: 'high' } });
    el<HTMLButtonElement>('#call').click();
    await flush();
    const status = el('[data-noodle-error]');
    expect(status.textContent).toContain('Action failed');
    expect(el<HTMLButtonElement>('#call').disabled).toBe(false);
  });

  it('disables unsupported host actions while preserving content', async () => {
    const app = must(await installRuntime());
    app.hostCapabilities = {
      tools: false,
      openLink: false,
      displayMode: false,
      downloadFile: false,
    };
    must(app.handlers.hostcontextchanged)({});
    for (const id of ['call', 'open', 'disp', 'dl']) {
      const button = el<HTMLButtonElement>(`#${id}`);
      expect(button.disabled).toBe(true);
      expect(button.getAttribute('title')).toContain('not supported');
    }
    expect(el('[data-bind="severity"]')).not.toBeNull();
  });

  it('wires open / display / download to the host bridge', async () => {
    const app = must(await installRuntime());
    must(app.handlers.toolresult)({ structuredContent: { severity: 'high' } });
    el<HTMLButtonElement>('#open').click();
    el<HTMLButtonElement>('#disp').click();
    el<HTMLButtonElement>('#dl').click();
    expect(app.calls.find((c) => c.method === 'openLink')?.args).toEqual({
      url: 'https://example.com/docs',
    });
    expect(app.calls.find((c) => c.method === 'requestDisplayMode')?.args).toEqual({
      mode: 'fullscreen',
    });
    const dl = app.calls.find((c) => c.method === 'downloadFile')?.args as {
      contents: Array<{ resource: { text: string; mimeType: string } }>;
    };
    expect(dl.contents[0]?.resource.text).toBe('sev-high'); // {{severity}} resolved from the result
    expect(dl.contents[0]?.resource.mimeType).toBe('text/plain');
  });

  it('wires resource read/list actions to the host bridge and binds results into local state', async () => {
    const app = must(await installRuntime());
    el<HTMLButtonElement>('#read').click();
    el<HTMLButtonElement>('#reslist').click();
    await flush();
    expect(app.calls.find((c) => c.method === 'readServerResource')?.args).toEqual({
      uri: 'docs://guide',
    });
    expect(app.calls.find((c) => c.method === 'listServerResources')?.args).toEqual({});
    expect(el('#guide').textContent).toBe('Guide text');
    expect(el('#resources').textContent).toBe('Guide');
  });

  it('ontoolcancelled re-enables in-flight buttons', async () => {
    const app = must(await installRuntime());
    let notified = false;
    globalThis.addEventListener('noodle:toolcancelled', () => (notified = true), { once: true });
    const btn = el<HTMLButtonElement>('#call');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    must(app.handlers.toolcancelled)({ reason: 'user action' });
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('aria-busy')).toBe(null);
    expect(notified).toBe(true);
  });

  it('onteardown reports dismissal and returns a result', async () => {
    const app = must(await installRuntime());
    let notified = false;
    globalThis.addEventListener('noodle:teardown', () => (notified = true), { once: true });
    expect(must(app.handlers.teardown)({})).toEqual({});
    expect(notified).toBe(true);
  });

  it('data-action="copy" resolves {{...}} at click time, writes the clipboard, and shows a copied affordance', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);
    const app = must(await installRuntime());
    must(app.handlers.toolresult)({ structuredContent: { slug: 'acme' } });
    el<HTMLButtonElement>('#copy').click();
    await flush();
    expect(writeText).toHaveBeenCalledWith('https://borg.example/acme');
    const btn = el<HTMLButtonElement>('#copy');
    expect(btn.getAttribute('data-copied')).toBe('true');
    expect(btn.textContent).toBe('Copied');
  });

  it('a copy button inside [data-copy-wrap] copies the live [data-copy-source] text verbatim (no {{...}} resolution)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeText);
    const app = must(await installRuntime());
    must(app.handlers.toolresult)({ structuredContent: { endpoint: 'https://x.example' } });
    el<HTMLButtonElement>('#codecopy').click();
    await flush();
    expect(writeText).toHaveBeenCalledWith('curl {{endpoint}} -H x');
  });

  it('capability-gates data-action="copy" on host clipboardWrite', async () => {
    const app = must(await installRuntime());
    app.hostCapabilities = { clipboardWrite: false };
    must(app.handlers.hostcontextchanged)({});
    const btn = el<HTMLButtonElement>('#copy');
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('title')).toContain('not supported');
  });

  it('falls back to execCommand("copy") when navigator.clipboard is unavailable', async () => {
    mockClipboard(undefined);
    const execCommand = vi.fn(() => true);
    (document as unknown as { execCommand?: unknown }).execCommand = execCommand;
    const app = must(await installRuntime());
    must(app.handlers.toolresult)({ structuredContent: { slug: 'acme' } });
    el<HTMLButtonElement>('#copy').click();
    await flush();
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(el<HTMLButtonElement>('#copy').getAttribute('data-copied')).toBe('true');
  });

  it('resolves {{...}} in data-action-href from the live result at click time and refuses javascript:', async () => {
    const app = must(await installRuntime());
    must(app.handlers.toolresult)({ structuredContent: { doc_id: 'abc' } });
    el<HTMLButtonElement>('#boundopen').click();
    expect(app.calls.find((c) => c.method === 'openLink')?.args).toEqual({
      url: 'https://example.com/d/abc',
    });
    el<HTMLButtonElement>('#jsopen').click();
    expect(app.calls.filter((c) => c.method === 'openLink')).toHaveLength(1);
  });

  it('resolves a FULLY bound href ({{path}} is the whole URL) and refuses a javascript: resolved value', async () => {
    const app = must(await installRuntime());
    must(app.handlers.toolresult)({
      structuredContent: { configureUrl: 'https://borg.example/settings/secrets/tok-1' },
    });
    el<HTMLButtonElement>('#fullopen').click();
    expect(app.calls.filter((c) => c.method === 'openLink')).toHaveLength(1);
    expect(app.calls.find((c) => c.method === 'openLink')?.args).toEqual({
      url: 'https://borg.example/settings/secrets/tok-1',
    });
    // A malicious resolved value is refused at click time — the compile-time schema cannot pin the
    // scheme of a fully bound URL, so the runtime guard is the enforcement point.
    must(app.handlers.toolresult)({
      structuredContent: { configureUrl: 'javascript:alert(1)' },
    });
    el<HTMLButtonElement>('#fullopen').click();
    expect(app.calls.filter((c) => c.method === 'openLink')).toHaveLength(1);
    // An unresolved binding (missing field) resolves to '' and must not open anything either.
    must(app.handlers.toolresult)({ structuredContent: { somethingElse: true } });
    el<HTMLButtonElement>('#fullopen').click();
    expect(app.calls.filter((c) => c.method === 'openLink')).toHaveLength(1);
  });

  it('enforces an http(s) allowlist on the RESOLVED URL of a templated href at click time', async () => {
    // Bound data could otherwise select the scheme of a fully bound href ({{path}} is the whole URL):
    // the anchored javascript:-only denylist is bypassable with leading whitespace, and
    // data:/vbscript:/file: would pass straight through. The runtime must require the resolved URL —
    // after stripping edge whitespace/control chars browsers ignore — to be http(s).
    const app = must(await installRuntime());
    for (const bad of ['data:text/html,x', 'vbscript:x', 'file:///x', ' javascript:alert(1)']) {
      must(app.handlers.toolresult)({ structuredContent: { configureUrl: bad } });
      el<HTMLButtonElement>('#fullopen').click();
    }
    expect(app.calls.filter((c) => c.method === 'openLink')).toHaveLength(0);
    // Refusal surfaces the existing degraded-status affordance instead of failing silently.
    expect(el('[data-noodle-error]').textContent).toContain('http');
    must(app.handlers.toolresult)({ structuredContent: { configureUrl: 'https://example.com/x' } });
    el<HTMLButtonElement>('#fullopen').click();
    expect(app.calls.filter((c) => c.method === 'openLink')).toHaveLength(1);
    expect(app.calls.find((c) => c.method === 'openLink')?.args).toEqual({
      url: 'https://example.com/x',
    });
  });

  it('enforces the widget handoff domain policy before opening links', async () => {
    const app = must(
      await installRuntime(`
        <script type="application/json" data-noodle-policy>{"handoff":{"allowedDomains":["https://app.example.com"]}}</script>
        <button id="static-ok" data-action="open" data-action-href="https://app.example.com/tickets/1">Open</button>
        <button id="static-bad" data-action="open" data-action-href="https://evil.example.com/tickets/1">Bad</button>
        <button id="dynamic" data-action="open" data-action-href="{{nextUrl}}">Dynamic</button>
      `),
    );
    el<HTMLButtonElement>('#static-ok').click();
    expect(app.calls.filter((c) => c.method === 'openLink')).toHaveLength(1);
    expect(app.calls[0]?.args).toEqual({ url: 'https://app.example.com/tickets/1' });

    el<HTMLButtonElement>('#static-bad').click();
    expect(app.calls.filter((c) => c.method === 'openLink')).toHaveLength(1);
    expect(document.querySelector('[data-noodle-error]')?.textContent).toContain('not allowed');

    must(app.handlers.toolresult)({
      structuredContent: { nextUrl: 'https://app.example.com/tickets/2' },
    });
    el<HTMLButtonElement>('#dynamic').click();
    expect(app.calls.filter((c) => c.method === 'openLink')).toHaveLength(2);
    expect(app.calls[1]?.args).toEqual({ url: 'https://app.example.com/tickets/2' });

    must(app.handlers.toolresult)({
      structuredContent: { nextUrl: 'https://evil.example.com/tickets/2' },
    });
    el<HTMLButtonElement>('#dynamic').click();
    expect(app.calls.filter((c) => c.method === 'openLink')).toHaveLength(2);
  });

  it('shows [data-repeat-empty] for an empty/absent bound array and hides it once items exist', async () => {
    const app = must(await installRuntime());
    const empty = el<HTMLElement>('#emptymsg');
    expect(empty.hidden).toBe(false); // before any result arrives
    must(app.handlers.toolresult)({ structuredContent: { drafts: [{ id: 'd1' }] } });
    expect(empty.hidden).toBe(true); // populated array → empty text hidden
    must(app.handlers.toolresult)({ structuredContent: { drafts: [] } });
    expect(empty.hidden).toBe(false); // empty array → empty text shown
    must(app.handlers.toolresult)({ structuredContent: { somethingElse: true } });
    expect(empty.hidden).toBe(false); // absent path → empty text shown
  });

  it('renders missing nullable values with stable fallbacks instead of stale content', async () => {
    const app = must(
      await installRuntime(`
        <p id="name" data-bind="name">Previous</p>
        <p id="state-note" data-bind-state="note">Previous</p>
      `),
    );
    must(app.handlers.toolresult)({ structuredContent: { name: 'Asha' } });
    expect(el('#name').textContent).toBe('Asha');
    must(app.handlers.toolresult)({ structuredContent: { name: null } });
    expect(el('#name').textContent).toBe('—');
    expect(el('#name').getAttribute('data-missing')).toBe('true');
    must(app.handlers.toolresult)({ structuredContent: {} });
    expect(el('#name').textContent).toBe('—');
    must(app.handlers.toolresult)({ structuredContent: { name: 'Asha' } });
    expect(el('#name').textContent).toBe('Asha');
    expect(el('#name').hasAttribute('data-missing')).toBe(false);

    must(app.handlers.toolresult)({ structuredContent: { ok: true } });
    (globals as { __noodleState?: unknown }).__noodleState = { note: null };
    must(app.handlers.hostcontextchanged)({});
    expect(el('#state-note').textContent).toBe('—');
  });

  it('caps oversized collections and tables with visible summaries', async () => {
    const app = must(
      await installRuntime(`
        <div id="collection" class="ns-collection ns-collection-list" data-collection="items" data-collection-item="item">
          <template data-collection-template><p data-bind="item.name">—</p></template>
          <p data-collection-empty="items">No items</p>
        </div>
        <div class="ns-table-wrap" data-rows="items">
          <table><tbody><tr><td data-column-path="name"></td><td data-column-path="quantity"></td></tr></tbody></table>
        </div>
      `),
    );
    const items = Array.from({ length: 75 }, (_, i) => ({
      name: `Item ${i + 1}`,
      quantity: i + 1,
    }));
    must(app.handlers.toolresult)({ structuredContent: { items } });
    expect(document.querySelectorAll('[data-collection-generated]')).toHaveLength(50);
    expect(el('#collection [data-noodle-overflow]').textContent).toContain('Showing 50 of 75');
    expect(document.querySelectorAll('.ns-table-wrap tbody tr')).toHaveLength(50);
    expect(el('.ns-table-wrap [data-noodle-overflow]').textContent).toContain('Showing 50 of 75');
  });

  it('shows media failure states for blocked or broken assets', async () => {
    const app = must(
      await installRuntime(`
        <figure class="ns-media">
          <div id="frame" class="ns-media-frame" data-media data-media-image="https://cdn.example.com/missing.jpg" data-media-alt="Missing image"></div>
        </figure>
      `),
    );
    must(app.handlers.toolresult)({ structuredContent: { ok: true } });
    const img = el<HTMLImageElement>('#frame img');
    img.dispatchEvent(new Event('error'));
    expect(el('#frame [data-media-error]').textContent).toContain('Media unavailable');
    expect(el('#frame').getAttribute('aria-label')).toBe('Missing image');
  });

  it('renders video media with visible playback controls', async () => {
    const app = must(
      await installRuntime(`
        <figure class="ns-media">
          <div
            id="frame"
            class="ns-media-frame"
            data-media
            data-media-image="https://cdn.example.com/poster.jpg"
            data-media-video="https://cdn.example.com/travel.webm"
            data-media-autoplay="true"
            data-media-alt="Travel video"
          ></div>
        </figure>
      `),
    );
    must(app.handlers.toolresult)({ structuredContent: { ok: true } });
    const video = el<HTMLVideoElement>('#frame video');
    expect(video.getAttribute('src')).toBe('https://cdn.example.com/travel.webm');
    expect(video.poster).toBe('https://cdn.example.com/poster.jpg');
    expect(video.autoplay).toBe(true);
    expect(video.controls).toBe(true);
    expect(video.preload).toBe('metadata');
    expect(video.muted).toBe(true);
  });

  it('prevents duplicate side-effect calls while an action is already in flight', async () => {
    const app = must(await installRuntime());
    let resolveCall: ((value: unknown) => void) | undefined;
    app.callServerTool = (p: unknown) => {
      app.calls.push({ method: 'callServerTool', args: p });
      return new Promise((resolve) => {
        resolveCall = resolve;
      });
    };
    must(app.handlers.toolresult)({ structuredContent: { severity: 'high' } });
    const btn = el<HTMLButtonElement>('#call');
    btn.click();
    btn.click();
    expect(app.calls.filter((c) => c.method === 'callServerTool')).toHaveLength(1);
    resolveCall?.({ structuredContent: { severity: 'done' } });
    await flush();
    expect(btn.disabled).toBe(false);
    expect(el('[data-bind="severity"]').textContent).toBe('done');
  });

  it('binds [data-bind-tone] from the tool result and falls back to neutral for unknown tones', async () => {
    const app = must(await installRuntime());
    must(app.handlers.toolresult)({ structuredContent: { check_tone: 'warn' } });
    expect(el('#tone').getAttribute('data-tone')).toBe('warn');
    must(app.handlers.toolresult)({ structuredContent: { check_tone: 'sparkly' } });
    expect(el('#tone').getAttribute('data-tone')).toBe('neutral');
  });

  it('exposes the wire CallToolResult _meta to binds under "_meta" alongside structuredContent', async () => {
    const app = must(await installRuntime());
    must(app.handlers.toolresult)({
      structuredContent: { severity: 'high' },
      _meta: { noodle: { app: { confirmToken: 'tok-1' } } },
    });
    expect(el('#meta-token').textContent).toBe('tok-1');
    expect(el('[data-bind="severity"]').textContent).toBe('high'); // structured content still bound
  });

  it('keeps a structuredContent "_meta" key intact — structured content wins over the wire _meta', async () => {
    const app = must(await installRuntime());
    must(app.handlers.toolresult)({
      structuredContent: {
        severity: 'low',
        _meta: { noodle: { app: { confirmToken: 'content-token' } } },
      },
      _meta: { noodle: { app: { confirmToken: 'wire-token' } } },
    });
    expect(el('#meta-token').textContent).toBe('content-token');
    expect(el('[data-bind="severity"]').textContent).toBe('low');
  });

  it('binds _meta even when the result has no structured content or parseable text', async () => {
    const app = must(await installRuntime());
    must(app.handlers.toolresult)({
      content: [],
      _meta: { noodle: { app: { confirmToken: 'tok-2' } } },
    });
    expect(el('#meta-token').textContent).toBe('tok-2');
  });

  it('renders object and array bind targets as pretty-printed JSON', async () => {
    const app = must(await installRuntime());
    const manifest = { name: 'demo', tools: ['greet'] };
    must(app.handlers.toolresult)({ structuredContent: { manifest, items: ['a', 'b'] } });
    expect(el('#manifest').textContent).toBe(JSON.stringify(manifest, null, 2));
    expect(el('#items').textContent).toBe(JSON.stringify(['a', 'b'], null, 2));
    must(app.handlers.toolinput)({ arguments: { config: { retries: 2 } } });
    expect(el('#input-obj').textContent).toBe(JSON.stringify({ retries: 2 }, null, 2));
  });

  it('data-action-args resolves {{_meta...}} templates and forwards them to callServerTool', async () => {
    const app = must(await installRuntime());
    must(app.handlers.toolresult)({
      structuredContent: { ok: true },
      _meta: { noodle: { app: { confirmToken: 'tok-3' } } },
    });
    el<HTMLButtonElement>('#confirm').click();
    expect(app.calls.find((c) => c.method === 'callServerTool')?.args).toEqual({
      name: 'confirm_deploy',
      arguments: { confirmToken: 'tok-3' },
    });
    await flush();
  });

  it('degrades gracefully when no host bridge is present', async () => {
    globals.ExtApps = undefined;
    await expect(installRuntime('<button data-action="send">x</button>')).resolves.toBeUndefined();
    expect(document.querySelector('[data-action="send"]')).not.toBeNull(); // body intact, no throw
  });
});

/** Optional ChatGPT compatibility bridge, used only when the standard MCP Apps bridge is unavailable. */
interface MockOpenAi {
  theme: string;
  displayMode?: string;
  locale?: string;
  widgetState?: unknown;
  toolInput: unknown;
  toolOutput: unknown;
  toolResponseMetadata: unknown;
  callResult: unknown;
  callTool(name: string, args: unknown): Promise<unknown>;
  sendFollowUpMessage(p: unknown): Promise<unknown>;
  openExternal(p: unknown): void;
  requestDisplayMode(p: unknown): Promise<unknown>;
  setWidgetState?(p: unknown): Promise<unknown>;
  updateModelContext?(p: unknown): Promise<unknown>;
}

describe('widget runtime — ChatGPT window.openai bridge', () => {
  let oaiCalls: Array<{ method: string; name?: string; args: unknown }>;
  let oai: MockOpenAi;

  beforeEach(() => {
    // Exercise the optional compatibility fallback independently of the standard bridge.
    globals.ExtApps = undefined;
    oaiCalls = [];
    oai = {
      theme: 'light',
      displayMode: 'inline',
      locale: 'en-US',
      widgetState: undefined,
      toolInput: undefined,
      toolOutput: undefined,
      toolResponseMetadata: undefined,
      callResult: undefined,
      callTool(name: string, args: unknown): Promise<unknown> {
        oaiCalls.push({ method: 'callTool', name, args });
        return Promise.resolve(this.callResult);
      },
      sendFollowUpMessage(p: unknown): Promise<unknown> {
        oaiCalls.push({ method: 'sendFollowUpMessage', args: p });
        return Promise.resolve({});
      },
      openExternal(p: unknown): void {
        oaiCalls.push({ method: 'openExternal', args: p });
      },
      requestDisplayMode(p: unknown): Promise<unknown> {
        oaiCalls.push({ method: 'requestDisplayMode', args: p });
        return Promise.resolve({});
      },
      setWidgetState(p: unknown): Promise<unknown> {
        oaiCalls.push({ method: 'setWidgetState', args: p });
        this.widgetState = p;
        return Promise.resolve({});
      },
    };
    (globalThis as unknown as { openai?: unknown }).openai = oai;
  });

  afterEach(() => {
    (globalThis as unknown as { openai?: unknown }).openai = undefined;
  });

  const fireGlobals = (): void => {
    globalThis.dispatchEvent(new CustomEvent('openai:set_globals'));
  };

  it('prefers the standard MCP Apps bridge when both host surfaces exist', async () => {
    globals.ExtApps = { App: MockApp, applyHostStyleVariables, applyHostFonts };
    const app = await installRuntime();
    expect(app).toBeDefined();
    expect(oaiCalls).toEqual([]);
  });

  it('binds the initial tool result + _meta from window.openai globals via openai:set_globals', async () => {
    await installRuntime();
    oai.toolOutput = { severity: 'high' };
    oai.toolResponseMetadata = { noodle: { app: { confirmToken: 'tok-oai' } } };
    fireGlobals();
    expect(el('[data-bind="severity"]').textContent).toBe('high');
    // The deploy confirm token resolves from toolResponseMetadata (the channel ChatGPT does NOT strip).
    expect(el('#meta-token').textContent).toBe('tok-oai');
  });

  it('Confirm deploy resolves the token from toolResponseMetadata and calls window.openai.callTool', async () => {
    await installRuntime();
    oai.toolOutput = { ok: true };
    oai.toolResponseMetadata = { noodle: { app: { confirmToken: 'tok-oai' } } };
    fireGlobals();
    el<HTMLButtonElement>('#confirm').click();
    expect(oaiCalls.find((c) => c.method === 'callTool')).toEqual({
      method: 'callTool',
      name: 'confirm_deploy',
      args: { confirmToken: 'tok-oai' },
    });
  });

  it('routes send / open / display actions to the window.openai bridge', async () => {
    await installRuntime();
    el<HTMLButtonElement>('#send').click();
    el<HTMLButtonElement>('#open').click();
    el<HTMLButtonElement>('#disp').click();
    expect(oaiCalls.find((c) => c.method === 'sendFollowUpMessage')?.args).toEqual({
      prompt: 'hello',
    });
    expect(oaiCalls.find((c) => c.method === 'openExternal')?.args).toEqual({
      href: 'https://example.com/docs',
    });
    expect(oaiCalls.find((c) => c.method === 'requestDisplayMode')?.args).toEqual({
      mode: 'fullscreen',
    });
  });

  it('binds tool-call arguments from window.openai.toolInput', async () => {
    await installRuntime();
    oai.toolInput = { customer: 'Acme Corp' };
    fireGlobals();
    expect(el('[data-bind-input="customer"]').textContent).toBe('Acme Corp');
  });
});
