import { WIDGET_ACTION_WIRING_SOURCE } from './action-wiring-bootstrap.js';
import { WIDGET_FLOW_SOURCE } from './flow-bootstrap.js';
import { WIDGET_FORMAT_SOURCE } from './format-bootstrap.js';
import { WIDGET_HANDOFF_SOURCE } from './handoff-bootstrap.js';
import { WIDGET_INTERACTION_SOURCE } from './interaction-bootstrap.js';
import { WIDGET_MODEL_CONTEXT_SOURCE } from './model-context-bootstrap.js';
import { OPENAI_WIDGET_BRIDGE_SOURCE } from './openai-bridge.js';
import { WIDGET_REACT_BRIDGE_SOURCE } from './react-bridge-bootstrap.js';

/** Widget runtime bootstrap, eval-tested in widget-runtime.test.ts. */
export const WIDGET_BOOTSTRAP_SOURCE: string = `
(async () => {
${OPENAI_WIDGET_BRIDGE_SOURCE}
  const E = globalThis.ExtApps;
  const oai = globalThis.openai;
  const MAX_RENDERED_ITEMS = 50;
  const app = makeWidgetApp(E, oai);
  if (!app) return;
${WIDGET_MODEL_CONTEXT_SOURCE}  guardModelContextUpdates(app);
${WIDGET_REACT_BRIDGE_SOURCE}
  const get = (o, p) => String(p).split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);

  function tmpl(s, data) {
    s = String(s);
    let out = '';
    let i = 0;
    while (i < s.length) {
      const open = s.indexOf('{{', i);
      if (open === -1) { out += s.slice(i); break; }
      out += s.slice(i, open);
      const close = s.indexOf('}}', open + 2);
      if (close === -1) { out += s.slice(open); break; }
      const v = get(data, s.slice(open + 2, close).trim());
      out += (v == null ? '' : String(v));
      i = close + 2;
    }
    return out;
  }
  function resolveArgs(v, data) {
    if (typeof v === 'string') return tmpl(v, data);
    if (Array.isArray(v)) return v.map((x) => resolveArgs(x, data));
    if (v && typeof v === 'object') {
      if (typeof v.from === 'string' && typeof v.path === 'string') return get(data[v.from] || {}, v.path);
      const out = {};
      for (const k of Object.keys(v)) out[k] = resolveArgs(v[k], data);
      return out;
    }
    return v;
  }

  const toText = (v, el) => {
    if (v === undefined || v === null) return '—';
    if (v !== null && typeof v === 'object') {
      const tag = el && el.tagName ? String(el.tagName).toLowerCase() : '';
      const pre = el && el.closest ? el.closest('pre') : null;
      if (tag === 'pre' || tag === 'code' || pre) return JSON.stringify(v, null, 2);
      if (Array.isArray(v)) return v.length === 1 ? '1 item' : String(v.length) + ' items';
      return 'Available';
    }
    return String(v);
  };
  function viewData(data) {
    return Object.assign({}, data || {}, {
      result: data || {},
      input: globalThis.__noodleInput || {},
      state: globalThis.__noodleState || {},
      params: currentParams(),
    });
  }
  function getBound(el, prefix, data) {
    if (el.hasAttribute('data-' + prefix)) return get(data, el.getAttribute('data-' + prefix));
    if (el.hasAttribute('data-' + prefix + '-result')) return get(data.result || {}, el.getAttribute('data-' + prefix + '-result'));
    if (el.hasAttribute('data-' + prefix + '-input')) return get(data.input || {}, el.getAttribute('data-' + prefix + '-input'));
    if (el.hasAttribute('data-' + prefix + '-state')) return get(data.state || {}, el.getAttribute('data-' + prefix + '-state'));
    if (el.hasAttribute('data-' + prefix + '-params')) return get(data.params || {}, el.getAttribute('data-' + prefix + '-params'));
    return undefined;
  }
  function getDefaultValue(el, data) {
    if (el.hasAttribute('data-default-value')) return el.getAttribute('data-default-value');
    if (el.hasAttribute('data-default-result')) return get(data.result || {}, el.getAttribute('data-default-result'));
    if (el.hasAttribute('data-default-input')) return get(data.input || {}, el.getAttribute('data-default-input'));
    if (el.hasAttribute('data-default-state')) return get(data.state || {}, el.getAttribute('data-default-state'));
    if (el.hasAttribute('data-default-params')) return get(data.params || {}, el.getAttribute('data-default-params'));
    return undefined;
  }
  function applyFieldDefaults(data) {
    const state = Object.assign({}, globalThis.__noodleState || {});
    let changed = false;
    for (const el of document.querySelectorAll('[data-state-name]')) {
      const name = el.getAttribute('data-state-name');
      if (!name) continue;
      const current = el.type === 'checkbox' ? Boolean(el.checked) : el.value;
      if (state[name] !== undefined && state[name] !== null && state[name] !== '') {
        if (el.tagName === 'SELECT' || current === undefined || current === null || current === '') {
          if (el.type === 'checkbox') el.checked = Boolean(state[name]);
          else el.value = String(state[name]);
        }
        continue;
      }
      if (el.tagName !== 'SELECT' && current !== undefined && current !== null && current !== '') continue;
      const v = getDefaultValue(el, data);
      if (v === undefined || v === null) continue;
      if (el.type === 'checkbox') el.checked = Boolean(v);
      else el.value = String(v);
      state[name] = el.type === 'checkbox' ? Boolean(el.checked) : el.value;
      changed = true;
    }
    if (changed) globalThis.__noodleState = state;
  }
  function renderMedia(frame, data) {
    const bound = (name) => {
      const direct = frame.getAttribute('data-media-' + name);
      if (direct) return direct;
      const path = frame.getAttribute('data-media-' + name + '-bind');
      const v = path ? get(data, path) : undefined;
      return v == null ? '' : String(v);
    };
    const image = bound('image');
    const video = bound('video');
    const poster = bound('poster') || image;
    const alt = bound('alt');
    const autoplay = frame.getAttribute('data-media-autoplay') === 'true';
    if (!image && !video) return;
    frame.textContent = '';
    if (alt) frame.setAttribute('aria-label', alt);
    const showMediaError = () => {
      frame.textContent = '';
      const fallback = document.createElement('div');
      fallback.className = 'ns-media-error';
      fallback.setAttribute('data-media-error', '');
      fallback.textContent = 'Media unavailable';
      frame.appendChild(fallback);
    };
    if (video) {
      const el = document.createElement('video');
      el.src = video;
      if (poster) el.poster = poster;
      if (alt) el.setAttribute('aria-label', alt);
      el.autoplay = autoplay;
      el.controls = true;
      el.muted = true;
      el.loop = true;
      el.playsInline = true;
      el.preload = 'metadata';
      el.addEventListener('error', () => {
        if (poster) return;
        if (!image) { showMediaError(); return; }
        const img = document.createElement('img');
        img.className = 'ns-media-image';
        img.src = image;
        img.alt = alt || '';
        img.addEventListener('error', showMediaError);
        el.replaceWith(img);
      });
      frame.appendChild(el);
      if (autoplay && typeof el.play === 'function') {
        try {
          const attempt = el.play();
          if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {});
        } catch (_) {}
      }
      return;
    }
    const img = document.createElement('img');
    img.className = 'ns-media-image';
    img.src = image;
    img.alt = alt || '';
    img.loading = 'lazy';
    img.addEventListener('error', showMediaError);
      frame.appendChild(img);
  }
${WIDGET_FORMAT_SOURCE}
  function setBoundText(el, value) {
    const missing = value === undefined || value === null;
    el.textContent = toText(applyFormat(value, attrFormat(el)), el);
    if (missing) el.setAttribute('data-missing', 'true');
    else el.removeAttribute('data-missing');
  }
  function renderScope(root, data) {
    const ctx = viewData(data);
    for (const el of root.querySelectorAll('[data-bind],[data-bind-result],[data-bind-input],[data-bind-state],[data-bind-params]')) {
      if (root === document && el.closest('[data-collection-generated]')) continue;
      setBoundText(el, getBound(el, 'bind', ctx));
    }
    applyFieldDefaults(ctx);
    for (const frame of root.querySelectorAll('[data-media]')) {
      if (root === document && frame.closest('[data-collection-generated]')) continue;
      renderMedia(frame, ctx);
    }
    for (const el of root.querySelectorAll('[data-bind-if]')) {
      const v = get(ctx, el.getAttribute('data-bind-if'));
      el.hidden = !(v !== undefined && v !== null && v !== false && v !== '');
    }
    for (const el of root.querySelectorAll('[data-bind-tone]')) {
      const v = get(ctx, el.getAttribute('data-bind-tone'));
      if (v === undefined || v === null) continue;
      const t = String(v);
      el.setAttribute('data-tone', t === 'ok' || t === 'warn' || t === 'error' || t === 'neutral' ? t : 'neutral');
    }
  }
  function renderCollections(data) {
    const ctx = viewData(data);
    for (const el of document.querySelectorAll('[data-collection],[data-collection-result],[data-collection-input],[data-collection-state],[data-collection-params]')) {
      const items = getBound(el, 'collection', ctx);
      for (const old of el.querySelectorAll(':scope > [data-collection-generated]')) old.remove();
      for (const old of el.querySelectorAll(':scope > [data-noodle-overflow]')) old.remove();
      const empty = el.querySelector(':scope > [data-collection-empty]');
      if (empty) empty.hidden = Array.isArray(items) && items.length > 0;
      if (!Array.isArray(items) || items.length === 0) continue;
      const template = el.querySelector(':scope > template[data-collection-template]');
      if (!template || !template.content) continue;
      const itemName = el.getAttribute('data-collection-item') || 'item';
      const visibleItems = items.slice(0, MAX_RENDERED_ITEMS);
      for (let index = 0; index < visibleItems.length; index++) {
        const wrapper = document.createElement('div');
        wrapper.className = 'ns-collection-item';
        wrapper.setAttribute('data-collection-generated', '');
        wrapper.appendChild(template.content.cloneNode(true));
        const scoped = Object.assign({}, data || {}, { [itemName]: visibleItems[index], item: visibleItems[index], index });
        if (!globalThis.__noodleScopes) globalThis.__noodleScopes = new WeakMap();
        globalThis.__noodleScopes.set(wrapper, scoped);
        renderScope(wrapper, scoped);
        wireActions(wrapper);
        el.insertBefore(wrapper, empty || null);
      }
      if (items.length > visibleItems.length) {
        const overflow = document.createElement('p');
        overflow.className = 'ns-overflow';
        overflow.setAttribute('data-noodle-overflow', '');
        overflow.textContent = 'Showing ' + String(visibleItems.length) + ' of ' + String(items.length) + ' items. Use filters or fullscreen for the full result.';
        el.insertBefore(overflow, empty || null);
      }
    }
  }
  function renderTables(data) {
    const ctx = viewData(data);
    for (const wrap of document.querySelectorAll('[data-rows],[data-rows-result],[data-rows-input],[data-rows-state],[data-rows-params]')) {
      const rows = getBound(wrap, 'rows', ctx);
      const tbody = wrap.querySelector('tbody');
      if (!tbody) continue;
      for (const old of wrap.querySelectorAll(':scope > [data-noodle-overflow]')) old.remove();
      const template = tbody.querySelector('tr');
      if (!template) continue;
      const cells = Array.from(template.querySelectorAll('[data-column-path]')).map((cell) => cell.getAttribute('data-column-path') || '');
      tbody.textContent = '';
      if (!Array.isArray(rows) || rows.length === 0) {
        const tr = document.createElement('tr'), td = document.createElement('td');
        td.colSpan = Math.max(cells.length, 1);
        td.textContent = 'No rows';
        td.setAttribute('data-missing', 'true');
        tr.appendChild(td);
        tbody.appendChild(tr);
        continue;
      }
      const visibleRows = rows.slice(0, MAX_RENDERED_ITEMS);
      for (const row of visibleRows) {
        const tr = document.createElement('tr');
        for (const path of cells) {
          const td = document.createElement('td');
          const source = template.querySelector('[data-column-path="' + path + '"]');
          const raw = source && source.getAttribute('data-column-format');
          let format = null;
          if (raw) {
            try {
              format = JSON.parse(raw);
              td.setAttribute('data-column-format', raw);
              td.setAttribute('data-format-kind', format.kind || '');
            } catch (e) {}
          }
          setBoundText(td, format ? applyFormat(get(row, path), format) : get(row, path));
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      if (rows.length > visibleRows.length) {
        const overflow = document.createElement('p');
        overflow.className = 'ns-overflow';
        overflow.setAttribute('data-noodle-overflow', '');
        overflow.textContent = 'Showing ' + String(visibleRows.length) + ' of ' + String(rows.length) + ' rows. Use filters or fullscreen for the full result.';
        wrap.appendChild(overflow);
      }
    }
  }

  function bind(data) {
    if (data == null) return;
    globalThis.__noodleData = data;
    renderInteractionCard(data);
    renderCollections(data);
    renderTables(data);
    renderScope(document, data);
    for (const el of document.querySelectorAll('[data-repeat-empty]')) {
      const v = get(data, el.getAttribute('data-repeat-empty'));
      el.hidden = Array.isArray(v) && v.length > 0;
    }
    try { globalThis.dispatchEvent(new CustomEvent('noodle:data', { detail: data })); } catch (e) {}
    notifyReact('noodle:data');
  }
  function bindState(state) {
    if (state == null) return;
    globalThis.__noodleState = state;
    renderScope(document, globalThis.__noodleData || {});
    for (const el of document.querySelectorAll('[data-bind-state]')) {
      setBoundText(el, get(state, el.getAttribute('data-bind-state')));
    }
    renderCollections(globalThis.__noodleData || {});
    renderTables(globalThis.__noodleData || {});
    applySelectedStates();
    try { globalThis.dispatchEvent(new CustomEvent('noodle:state', { detail: state })); } catch (e) {}
    notifyReact('noodle:state');
  }
  // Tool-call ARGUMENTS → [data-bind-input].
  function bindInput(args) {
    if (args == null) return;
    globalThis.__noodleInput = args;
    for (const el of document.querySelectorAll('[data-bind-input]')) {
      setBoundText(el, get(args, el.getAttribute('data-bind-input')));
    }
    if (globalThis.__noodleData) {
      renderCollections(globalThis.__noodleData);
      renderScope(document, globalThis.__noodleData);
    } else {
      applyFieldDefaults(viewData({}));
    }
    notifyReact('noodle:input');
  }
  function collectState(el) {
    const state = {};
    const root = (el && el.closest && el.closest('form')) || document;
    for (const input of root.querySelectorAll('[data-state-name]')) {
      const name = input.getAttribute('data-state-name');
      if (!name) continue;
      if (input.type === 'radio') {
        if (input.checked) state[name] = input.value;
      } else if (input.getAttribute('data-state-kind') === 'checkbox-group') {
        if (!Array.isArray(state[name])) state[name] = [];
        if (input.checked) state[name].push(input.value);
      } else if (input.type === 'checkbox') state[name] = Boolean(input.checked);
      else state[name] = input.value;
    }
    globalThis.__noodleState = Object.assign({}, globalThis.__noodleState || {}, state);
    bindState(globalThis.__noodleState);
    return state;
  }
  function stateData() {
    return Object.assign({}, globalThis.__noodleState || {});
  }
  function setState(patch) {
    const state = stateData();
    for (const k of Object.keys(patch || {})) state[k] = patch[k];
    bindState(state);
    persistWidgetState();
    return state;
  }
  function refreshBindings() {
    if (globalThis.__noodleData) bind(globalThis.__noodleData); if (globalThis.__noodleInput) bindInput(globalThis.__noodleInput); bindState(stateData());
  }
  function readWidgetState() {
    try {
      const value = app.getWidgetState && app.getWidgetState();
      if (value && typeof value === 'object') return value;
    } catch (e) {}
    return null;
  }
  function restoreWidgetState() {
    const saved = readWidgetState();
    if (!saved || typeof saved !== 'object') return;
    const priv = saved.privateContent && typeof saved.privateContent === 'object'
      ? saved.privateContent
      : saved;
    const state = priv.state && typeof priv.state === 'object' ? priv.state : null;
    if (state) globalThis.__noodleState = Object.assign({}, state);
    if (typeof priv.activeView === 'string') globalThis.__noodleActiveView = priv.activeView;
    if (priv.viewParams && typeof priv.viewParams === 'object') globalThis.__noodleViewParams = Object.assign({}, priv.viewParams);
    if (Array.isArray(priv.overlayStack)) globalThis.__noodleOverlayStack = priv.overlayStack;
  }
  function persistWidgetState() {
    try {
      if (typeof app.setWidgetState !== 'function') return;
      const saved = readWidgetState();
      const modelContent = saved && Object.prototype.hasOwnProperty.call(saved, 'modelContent')
        ? saved.modelContent
        : null;
      const viewParams = nonEmptyViewParams(globalThis.__noodleViewParams || {});
      const overlayStack = globalThis.__noodleOverlayStack || [];
      app.setWidgetState({
        modelContent,
        privateContent: {
          activeView: globalThis.__noodleActiveView || null,
          state: stateData(),
          ...(viewParams ? { viewParams } : {}),
          ...(overlayStack.length ? { overlayStack } : {}),
        },
        imageIds: [],
      });
    } catch (e) {}
  }
  function applySelectedStates() {
    const state = stateData();
    for (const el of document.querySelectorAll('[data-select-state-key][data-select-state-value]')) {
      const key = el.getAttribute('data-select-state-key');
      const value = el.getAttribute('data-select-state-value');
      const selected = key ? String(state[key]) === String(value) : false;
      el.setAttribute('aria-pressed', selected ? 'true' : 'false');
      const item = el.closest && el.closest('.ns-item-group');
      if (item) {
        if (selected) item.setAttribute('data-selected', 'true');
        else item.removeAttribute('data-selected');
      }
    }
  }
${WIDGET_FLOW_SOURCE}
${WIDGET_INTERACTION_SOURCE}
  function actionContext(el) {
    const data = globalThis.__noodleData;
    const itemRoot = el && el.closest ? el.closest('[data-collection-generated]') : null;
    const scoped = itemRoot && globalThis.__noodleScopes ? globalThis.__noodleScopes.get(itemRoot) : null;
    return Object.assign({}, data || {}, scoped || {}, {
      result: data || {},
      input: globalThis.__noodleInput || {},
      state: Object.assign(stateData(), collectState(el)),
      params: currentParams(),
    });
  }
  function stateToolName(operation, handle) {
    return '__noodle_state_' + operation + '_' + handle;
  }
  function bindStateHandleRecord(key, record) {
    if (!record || typeof record !== 'object') return;
    const patch = {};
    patch[key || record.handle || 'state'] = record;
    setState(patch);
  }
  async function callStateHandle(effect, ctx) {
    if (!supported('call')) throw new Error('unsupported state handle effect');
    const handle = effect.handle;
    if (!handle) throw new Error('missing state handle');
    const isPatch = effect.type === 'patchStateHandle';
    const isComplete = effect.type === 'completeStateHandle';
    const operation = isPatch ? 'patch' : isComplete ? 'complete' : 'load';
    const args = {};
    const key = effect.key === undefined ? undefined : resolveArgs(effect.key, ctx);
    if (key !== undefined && key !== null && key !== '') args.key = String(key);
    if (isPatch || isComplete) args.expectedRevision = resolveArgs(effect.expectedRevision, ctx);
    if (isPatch) args.value = resolveArgs(effect.value, ctx);
    const result = await app.callServerTool({
      name: stateToolName(operation, handle),
      arguments: args,
    });
    const data = fromResult(result);
    bindStateHandleRecord(effect.resultKey || handle, data);
  }
  function fromResult(r) {
    if (!r) return null;
    let data = null;
    if (r.structuredContent != null) {
      data = r.structuredContent;
    } else {
      const t = r.content && r.content[0] && r.content[0].text;
      if (typeof t === 'string') { try { data = JSON.parse(t); } catch (e) { data = null; } }
    }
    // Surface the wire CallToolResult _meta to binds/templates as '_meta' — the widget-only side channel
    // for values that must never reach model-visible structured content (e.g.
    // {{_meta.noodle.app.confirmToken}}). Structured content wins: an existing '_meta' key is never
    // clobbered, and non-object data (arrays/scalars) is returned untouched.
    const meta = r._meta;
    if (meta == null) return data;
    if (data == null) return { _meta: meta };
    if (typeof data !== 'object' || Array.isArray(data) || '_meta' in data) return data;
    return Object.assign({}, data, { _meta: meta });
  }
  function bindResult(r) {
    globalThis.__noodleToolResult = r || {};
    const data = fromResult(r);
    if (data == null) notifyReact('noodle:data');
    else bind(data);
  }
  function theme(ctx) {
    try {
      // host-context-changed may be a PARTIAL update (theme/styles independently optional) — only touch the
      // theme class when 'theme' is actually present, so a styles-only update never flips a dark widget back
      // to light.
      if (ctx && ctx.theme !== undefined) {
        document.documentElement.classList.toggle('dark', ctx.theme === 'dark');
      }
      if (ctx) {
        globalThis.__noodleLayout = {
          theme: ctx.theme === 'dark' ? 'dark' : 'light',
          displayMode: ctx.displayMode === 'fullscreen' ? 'fullscreen' : 'inline',
          ...(ctx.locale ? { locale: ctx.locale } : {}),
        };
        notifyReact('noodle:layout');
      }
      const styles = ctx && ctx.styles;
      if (styles && styles.variables && E && E.applyHostStyleVariables) E.applyHostStyleVariables(styles.variables);
      if (styles && styles.css && styles.css.fonts && E && E.applyHostFonts) E.applyHostFonts(styles.css.fonts);
    } catch (e) {}
  }
  function clearBusy() {
    for (const el of document.querySelectorAll('[aria-busy="true"]')) {
      el.disabled = false; el.removeAttribute('aria-busy');
    }
  }
  function status(msg) {
    let el = document.querySelector('[data-noodle-error]');
    if (!el) {
      el = document.createElement('div');
      el.setAttribute('data-noodle-error', '');
      el.setAttribute('role', 'status');
      el.style.marginTop = '8px';
      el.style.color = 'var(--color-text-danger, #b42318)';
      document.body.appendChild(el);
    }
    el.textContent = msg;
  }
  let sequencePending = false;
  function caps() {
    try { return app.getHostCapabilities && app.getHostCapabilities(); } catch (e) { return {}; }
  }
  function config() {
    try {
      const el = document.querySelector('[data-noodle-policy]');
      if (!el) return {};
      return JSON.parse(el.textContent || '{}') || {};
    } catch (e) {
      return {};
    }
  }
  const cfg = config();
  globalThis.__noodleBranding = cfg.branding || {};
${WIDGET_HANDOFF_SOURCE}
  function supported(action) {
    const c = caps() || {};
    if (action === 'call') return c.tools !== false && typeof app.callServerTool === 'function';
    if (action === 'open') return c.openLink !== false && typeof app.openLink === 'function';
    if (action === 'display') return c.displayMode !== false && typeof app.requestDisplayMode === 'function';
    if (action === 'download') return c.downloadFile !== false && typeof app.downloadFile === 'function';
    if (action === 'resource-read') return c.resources !== false && typeof app.readServerResource === 'function';
    if (action === 'resources-list') return c.resources !== false && typeof app.listServerResources === 'function';
    if (action === 'send') return c.message !== false && typeof app.sendMessage === 'function';
    if (action === 'context') return c.modelContext !== false && typeof app.updateModelContext === 'function';
    // Clipboard writes happen in-frame (iframe permission), not over the bridge — gate only on an
    // explicit host clipboardWrite refusal.
    if (action === 'copy') return c.clipboardWrite !== false;
    return true;
  }
  function applyCapabilities() {
    for (const el of document.querySelectorAll('[data-action]')) {
      const action = el.getAttribute('data-action');
      if (!supported(action)) {
        el.disabled = true;
        el.setAttribute('aria-disabled', 'true');
        el.setAttribute('title', 'Action is not supported by this host');
      } else if (el.getAttribute('aria-busy') !== 'true') {
        el.disabled = false;
        el.removeAttribute('aria-disabled');
        if (el.getAttribute('title') === 'Action is not supported by this host') el.removeAttribute('title');
      }
    }
  }

  // Clipboard fallback for hosts without navigator.clipboard: a throwaway textarea + execCommand('copy').
  function copyFallback(value) {
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand ? document.execCommand('copy') : false;
      ta.remove();
      return Boolean(ok);
    } catch (e) { return false; }
  }
  // Visible transient 'copied' affordance: swap the label, restore shortly after.
  function markCopied(el) {
    const prev = el.textContent;
    el.setAttribute('data-copied', 'true');
    el.textContent = 'Copied';
    setTimeout(() => {
      el.removeAttribute('data-copied');
      el.textContent = prev;
    }, 1200);
  }

  // CSP-safe declarative actions (no inline handlers). A [data-action] element drives the host bridge:
  //   send|context → conversation;  call → server tools/call (re-binds the result in place);
  //   open → external link;  display → display mode;  download → host-mediated file export;
  //   copy → in-frame clipboard write (navigator.clipboard, execCommand fallback).
  function actOnce(el) {
    if (el.getAttribute('aria-busy') === 'true') return;
    const action = el.getAttribute('data-action');
    if (!supported(action)) { status('Action is not supported by this host.'); return; }
    const text = el.getAttribute('data-action-text') || el.textContent || '';
    const data = globalThis.__noodleData;
    const actionData = actionContext(el);
    try {
      if (action === 'send') {
        app.sendMessage({ role: 'user', content: [{ type: 'text', text }] });
      } else if (action === 'context') {
        app.updateModelContext({ content: [{ type: 'text', text }] });
      } else if (action === 'call') {
        const name = el.getAttribute('data-action-tool');
        if (!name) return;
        let args = {};
        const raw = el.getAttribute('data-action-args');
        if (raw) { try { args = resolveArgs(JSON.parse(raw), actionData); } catch (e) { args = {}; } }
        else if (el.closest && el.closest('form')) args = collectState(el);
        el.disabled = true; el.setAttribute('aria-busy', 'true');
        Promise.resolve(app.callServerTool({ name, arguments: args }))
          .then((r) => bindResult(r))
          .catch(() => { status('Action failed. Check the tool result or host permissions.'); })
          .then(() => { el.disabled = false; el.removeAttribute('aria-busy'); });
      } else if (action === 'sequence') {
        if (sequencePending) return;
        let effects = [];
        try { effects = JSON.parse(el.getAttribute('data-action-effects') || '[]'); } catch (e) { effects = []; }
        sequencePending = true;
        el.disabled = true; el.setAttribute('aria-busy', 'true');
        runSequence(el, effects)
          .catch(() => { status('Action failed. Check the tool result or host permissions.'); })
          .then(() => {
            sequencePending = false;
            el.disabled = false; el.removeAttribute('aria-busy');
          });
      } else if (action === 'open') {
        // {{...}} in the href resolves against the LIVE bound data at click time. Two safe shapes:
        //   - a LITERAL or MIXED-template href (no '{{', or '{{...}}' embedded after a literal scheme):
        //     the compiler pins a literal http(s) scheme, so we only need to refuse a resolved
        //     javascript: value as defense in depth.
        //   - a FULLY BOUND href ('{{path}}' is the entire URL): bound data selects the WHOLE URL,
        //     including the scheme, so the compiler cannot pin it. The runtime is the enforcement point:
        //     after stripping leading whitespace/control chars (which browsers ignore when parsing a
        //     URL scheme), the resolved URL MUST match an http(s) allowlist before we open it. This
        //     blocks data:/vbscript:/file:/blob: and whitespace-prefixed javascript: that the anchored
        //     javascript:-only denylist would miss.
        const rawSession = el.getAttribute('data-action-handoff-session') || '';
        const session = rawSession ? resolveHandoffSession(rawSession, actionData) : null;
        if (session && !session.ok) {
          status('Handoff session is not ready yet.');
          return;
        }
        if (session && session.expired) {
          status('Handoff session expired. Refresh and try again.');
          return;
        }
        const rawHref = el.getAttribute('data-action-href') || '';
        const url = session && session.ok ? session.url : tmpl(rawHref, actionData);
        const checked = allowedLink(url);
        if (!url) { /* unresolved/empty binding: open nothing */ }
        else if (checked.ok) {
          app.openLink({ url: checked.url });
        } else if (checked.reason === 'domain') {
          status('Link refused: this destination is not allowed by the app handoff policy.');
        } else {
          status('Link refused: a link must resolve to an http(s) URL.');
        }
      } else if (action === 'copy') {
        // A copy button inside a [data-copy-wrap] block copies the nearest [data-copy-source]
        // element's live text VERBATIM ({{...}} never resolves — code blocks are verbatim);
        // a standalone copy button resolves {{...}} in data-action-content at click time.
        const wrap = el.closest ? el.closest('[data-copy-wrap]') : null;
        const src = wrap ? wrap.querySelector('[data-copy-source]') : null;
        const value = src ? (src.textContent || '') : tmpl(el.getAttribute('data-action-content') || '', actionData);
        const clip = typeof navigator !== 'undefined' && navigator.clipboard ? navigator.clipboard : null;
        if (clip && typeof clip.writeText === 'function') {
          Promise.resolve(clip.writeText(value))
            .then(() => markCopied(el))
            .catch(() => {
              if (copyFallback(value)) markCopied(el);
              else status('Copy failed. The host may block clipboard access.');
            });
        } else if (copyFallback(value)) {
          markCopied(el);
        } else {
          status('Copy failed. The host may block clipboard access.');
        }
      } else if (action === 'display') {
        app.requestDisplayMode({ mode: el.getAttribute('data-action-mode') || 'fullscreen' });
      } else if (action === 'download') {
        const file = el.getAttribute('data-action-file') || 'download.txt';
        const mimeType = el.getAttribute('data-action-mime') || 'text/plain';
        const content = tmpl(el.getAttribute('data-action-content') || '', data);
        app.downloadFile({
          contents: [{ type: 'resource', resource: { uri: 'ui://download/' + file, mimeType, text: content } }],
        });
      } else if (action === 'resource-read') {
        const uri = el.getAttribute('data-action-uri');
        const stateKey = el.getAttribute('data-action-state-key');
        if (!uri || !stateKey) return;
        el.disabled = true; el.setAttribute('aria-busy', 'true');
        Promise.resolve(app.readServerResource({ uri }))
          .then((r) => {
            const state = Object.assign({}, globalThis.__noodleState || {});
            state[stateKey] = r;
            bindState(state);
          })
          .catch(() => { status('Resource action failed. Check the resource URI or host permissions.'); })
          .then(() => { el.disabled = false; el.removeAttribute('aria-busy'); });
      } else if (action === 'resources-list') {
        const stateKey = el.getAttribute('data-action-state-key');
        if (!stateKey) return;
        el.disabled = true; el.setAttribute('aria-busy', 'true');
        Promise.resolve(app.listServerResources({}))
          .then((r) => {
            const state = Object.assign({}, globalThis.__noodleState || {});
            state[stateKey] = r;
            bindState(state);
          })
          .catch(() => { status('Resource action failed. Check host resource support.'); })
          .then(() => { el.disabled = false; el.removeAttribute('aria-busy'); });
      }
    } catch (e) {}
  }
  async function runSequence(el, effects) {
    let ctx = actionContext(el);
    for (const effect of effects || []) {
      if (!effect || typeof effect !== 'object') continue;
      if (effect.type === 'callTool') {
        if (!supported('call')) throw new Error('unsupported callTool');
        const name = effect.tool;
        if (!name) throw new Error('missing tool');
        const args = resolveArgs(effect.args || {}, ctx);
        const result = await app.callServerTool({ name, arguments: args });
        const data = fromResult(result);
        if (effect.resultKey) {
          const patch = {};
          patch[effect.resultKey] = data;
          setState(patch);
        } else {
          bindResult(result);
        }
        ctx = actionContext(el);
      } else if (effect.type === 'setState') {
        setState(resolveArgs(effect.set || {}, ctx));
        ctx = actionContext(el);
      } else if (effect.type === 'navigate') {
        const surface = el.closest ? el.closest('[data-surface]') : null;
        const next = transition(surface, effect, ctx);
        if (!next) return;
        showView(surface, effect.view, true, true, next.params);
      } else if (effect.type === 'openOverlay') {
        const surface = el.closest ? el.closest('[data-surface]') : null;
        const next = transition(surface, effect, ctx);
        if (!next) return;
        openOverlay(surface, next.view, effect.mode || 'modal', next.params, true);
      } else if (effect.type === 'closeOverlay') {
        const surface = el.closest ? el.closest('[data-surface]') : null;
        closeOverlay(surface, true);
      } else if (
        effect.type === 'loadStateHandle' ||
        effect.type === 'refreshStateHandle' ||
        effect.type === 'patchStateHandle' ||
        effect.type === 'completeStateHandle'
      ) {
        try {
          await callStateHandle(effect, ctx);
          ctx = actionContext(el);
        } catch (e) {
          status('State update failed. Refresh the widget and try again.');
          return;
        }
      } else if (effect.type === 'back') {
        const surface = el.closest ? el.closest('[data-surface]') : null;
        if (closeOverlay(surface, true)) continue;
        const stack = globalThis.__noodleViewStack || [];
        showView(surface, stack.pop(), true, false, null);
      } else if (effect.type === 'refresh') {
        refreshBindings();
      }
    }
  }
${WIDGET_ACTION_WIRING_SOURCE}

  // Register handlers BEFORE connect() so no one-shot host notification is missed.
  app.ontoolresult = bindResult;
  app.ontoolinput = (p) => bindInput(p && p.arguments);
  app.ontoolcancelled = () => { clearBusy(); notifyReact('noodle:toolcancelled'); };
  app.onhostcontextchanged = (p) => { theme(p); applyCapabilities(); };
  app.onteardown = () => { try { clearBusy(); notifyReact('noodle:teardown'); } catch (e) {} return {}; };
  try { await app.connect(); } catch (e) { return; }
  installReactBridge();
  wireActions();
  restoreWidgetState();
  initializeSurfaces();
  try { theme(app.getHostContext && app.getHostContext()); } catch (e) {}
  try { applyCapabilities(); } catch (e) {}
})();
`;
