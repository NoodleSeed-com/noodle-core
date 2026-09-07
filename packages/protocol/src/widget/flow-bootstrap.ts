export const WIDGET_FLOW_SOURCE = `
  function nonEmptyViewParams(value) {
    const out = {};
    for (const k of Object.keys(value || {})) {
      if (value[k] && typeof value[k] === 'object' && Object.keys(value[k]).length > 0) out[k] = value[k];
    }
    return Object.keys(out).length ? out : null;
  }
  function initializeSurfaces() {
    const state = stateData();
    for (const surface of document.querySelectorAll('[data-surface]')) {
      const raw = surface.getAttribute('data-state-defaults');
      if (raw) {
        try {
          const defaults = JSON.parse(raw);
          if (defaults && typeof defaults === 'object') {
            for (const k of Object.keys(defaults)) {
              if (state[k] === undefined) state[k] = defaults[k];
            }
          }
        } catch (e) {}
      }
      const initial = surface.getAttribute('data-initial-view') || '';
      showView(surface, globalThis.__noodleActiveView || initial, false, false, null);
      restoreOverlays(surface);
    }
    bindState(state);
  }
  function currentParams() {
    const stack = globalThis.__noodleOverlayStack || [];
    const top = stack.length ? stack[stack.length - 1] : null;
    if (top && top.params) return top.params;
    const byView = globalThis.__noodleViewParams || {};
    return byView[globalThis.__noodleActiveView] || {};
  }
  function parseParamTypes(view) {
    try { return JSON.parse(view.getAttribute('data-view-params') || '{}') || {}; } catch (e) { return {}; }
  }
  function coerceParams(view, params) {
    const types = parseParamTypes(view), out = {};
    for (const k of Object.keys(types)) {
      let v = params && params[k];
      if (v === undefined || v === null || v === '') { status('Navigation blocked: missing view parameter.'); return null; }
      if (types[k] === 'number') { v = Number(v); if (!Number.isFinite(v)) { status('Navigation blocked: invalid view parameter.'); return null; } }
      else if (types[k] === 'boolean') v = v === true || v === 'true';
      else v = String(v);
      out[k] = v;
    }
    for (const k of Object.keys(params || {})) if (!(k in out)) out[k] = params[k];
    return out;
  }
  function transition(surface, effect, ctx) {
    if (effect.guard !== undefined && !resolveArgs(effect.guard, ctx)) { status('Navigation blocked.'); return null; }
    const view = surface ? surface.querySelector('[data-view="' + effect.view + '"]') : null;
    if (!view) { status('Navigation blocked: unknown view.'); return null; }
    const params = coerceParams(view, resolveArgs(effect.params || {}, ctx));
    return params === null ? null : { view, params };
  }
  function showView(surface, name, persist, remember, params) {
    if (persist === undefined) persist = true;
    if (remember === undefined) remember = false;
    if (!surface || !name) return;
    const previous = surface.getAttribute('data-active-view');
    if (remember && previous && previous !== name) {
      const stack = globalThis.__noodleViewStack || []; stack.push(previous); globalThis.__noodleViewStack = stack;
    }
    const target = surface.querySelector('[data-view="' + name + '"]');
    if (!target || target.hasAttribute('data-overlay-mode')) return;
    const coerced = coerceParams(target, params || {});
    if (coerced === null) return;
    for (const view of surface.querySelectorAll('[data-view]:not([data-overlay-mode])')) {
      view.hidden = view.getAttribute('data-view') !== name;
    }
    const byView = Object.assign({}, globalThis.__noodleViewParams || {});
    byView[name] = coerced; globalThis.__noodleViewParams = byView;
    surface.setAttribute('data-active-view', name);
    globalThis.__noodleActiveView = name;
    refreshBindings();
    if (persist) persistWidgetState();
  }
  function openOverlay(surface, view, mode, params, persist) {
    view.hidden = false; view.setAttribute('data-overlay-active', 'true'); view.setAttribute('data-overlay-mode', mode);
    const stack = globalThis.__noodleOverlayStack || [];
    stack.push({ view: view.getAttribute('data-view'), mode, params }); globalThis.__noodleOverlayStack = stack;
    refreshBindings(); if (persist !== false) persistWidgetState();
  }
  function closeOverlay(surface, persist) {
    const stack = globalThis.__noodleOverlayStack || [];
    const top = stack.pop(); globalThis.__noodleOverlayStack = stack;
    if (!top || !surface) return false;
    const view = surface.querySelector('[data-view="' + top.view + '"][data-overlay-mode]');
    if (view) { view.hidden = true; view.removeAttribute('data-overlay-active'); }
    refreshBindings(); if (persist !== false) persistWidgetState();
    return true;
  }
  function restoreOverlays(surface) {
    const stack = globalThis.__noodleOverlayStack || [];
    globalThis.__noodleOverlayStack = [];
    for (const item of stack) {
      const view = surface.querySelector('[data-view="' + item.view + '"][data-overlay-mode]');
      if (view) openOverlay(surface, view, item.mode || view.getAttribute('data-overlay-mode') || 'modal', item.params || {}, false);
    }
  }
`;
