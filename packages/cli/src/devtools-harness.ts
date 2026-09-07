/**
 * The `noodle devtools` browser harness: the three-pane shell HTML/CSS, the client script, the
 * `window.openai` shim injected into widget iframes, and small HTML helpers. Kept separate from the
 * preview server (`devtools-preview.ts`) so each file owns one concern.
 *
 * The client script is plain (no template literals / no `${...}`) so it splices safely into the shell
 * and so the shim's classic script runs before the widget's deferred bridge module.
 */

import { DEVTOOLS_STYLES } from '@noodle-borg/devtools-ui';
import {
  DEVTOOLS_AUTH_CLIENT_JS,
  DEVTOOLS_AUTH_GATE_HTML,
  DEVTOOLS_AUTH_SESSION_HTML,
  DEVTOOLS_AUTH_STYLES,
} from './devtools-auth-ui.js';
import {
  DEVTOOLS_FAVICON_DATA_URI,
  DEVTOOLS_SHADER_SCRIPT,
  DEVTOOLS_WORDMARK,
} from './devtools-brand.js';
import {
  DEVTOOLS_DELEGATED_EXCHANGE_CLIENT_JS,
  DEVTOOLS_DELEGATED_EXCHANGE_HTML,
  DEVTOOLS_DELEGATED_EXCHANGE_STYLES,
} from './devtools-delegated-exchange-ui.js';
import { DEVTOOLS_DESIGN_CLIENT_JS, DEVTOOLS_DESIGN_HTML } from './devtools-design.js';
import { DEVTOOLS_JSON_CLIENT_JS, DEVTOOLS_JSON_STYLES } from './devtools-json.js';
import { CLAUDE_MARK, GEMINI_MARK, OPENAI_MARK } from './devtools-provider-logos.js';
import { isAutoSafeTool, parseWidgetToolCallMessage } from './devtools-tool-safety.js';

export type PreviewTheme = 'light' | 'dark' | 'both';
export type PreviewDevice = 'desktop' | 'mobile' | 'both';

/** Convert a native range value to a clamped percentage using its actual, non-zero bounds. */
export function calculateRangeProgress(value: number, min: number, max: number): number {
  if (![value, min, max].every(Number.isFinite) || max <= min) return 0;
  return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
}

/**
 * Serialize a value for safe inlining inside a `<script>` block. Tool output/metadata can contain
 * `</script>` (and can come from an untrusted upstream API), which would otherwise close the inline script
 * early and inject markup. `<`/`>`/`&` and the JS line/paragraph separators are neutralized.
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

/** Build the classic (non-module) `window.openai` shim injected ahead of the deferred widget bridge. */
export function openAiShimScript(init: {
  readonly toolInput?: unknown;
  readonly toolOutput?: unknown;
  readonly toolResponseMetadata?: unknown;
  readonly toolResult?: unknown;
  readonly theme?: 'light' | 'dark';
  /** Route calls through the credential-owning parent rather than allowing the widget to call loopback. */
  readonly hostMediated?: boolean;
}): string {
  const data = {
    __noodleDevtools: true,
    __noodleToolResult: init.toolResult ?? null,
    toolInput: init.toolInput ?? {},
    toolOutput: init.toolOutput ?? null,
    toolResponseMetadata: init.toolResponseMetadata ?? null,
    theme: init.theme ?? 'light',
  };
  const toolCallBridge = init.hostMediated
    ? 'var __noodleToolCalls={}; var __noodleToolSequence=0;' +
      'window.addEventListener("message",function(ev){ var d=ev.data;' +
      ' if(ev.source!==window.parent||!d||d.type!=="noodle:tool-result"||typeof d.requestId!=="string") return;' +
      ' var pending=__noodleToolCalls[d.requestId]; if(!pending) return; delete __noodleToolCalls[d.requestId];' +
      ' if(d.error) pending.reject(new Error(String(d.error))); else pending.resolve(d.result); });'
    : '';
  const callTool = init.hostMediated
    ? ' callTool: function (name, args) {' +
      '  return new Promise(function(resolve,reject){' +
      '   var requestId="widget-"+Date.now()+"-"+(++__noodleToolSequence);' +
      '   __noodleToolCalls[requestId]={resolve:resolve,reject:reject};' +
      '   window.parent.postMessage({type:"noodle:tool-call",requestId:requestId,name:name,arguments:args||{}},"*");' +
      '  });' +
      ' },'
    : ' callTool: function (name, args) {' +
      '  return fetch("/rpc", { method: "POST", headers: { "content-type": "application/json" },' +
      '   body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call",' +
      '    params: { name: name, arguments: args || {} } }) })' +
      '   .then(function (r) { return r.json(); })' +
      '   .then(function (j) { if (j && j.error) { throw new Error((j.error && j.error.message) || "tool error"); } return j.result; });' +
      ' },';
  return (
    '<script>' +
    toolCallBridge +
    'window.openai = Object.assign(' +
    jsonForScript(data) +
    ', {' +
    ' widgetState: null, displayMode: "inline", locale: "en",' +
    callTool +
    ' setWidgetState: function (s) { window.openai.widgetState = s; return Promise.resolve(); },' +
    // Notify the harness so a widget calling requestDisplayMode("fullscreen") is actually presented fullscreen.
    ' requestDisplayMode: function (p) { var m = (p && p.mode) || "inline"; window.openai.displayMode = m; try { window.parent.postMessage({ type: "noodle:display-mode", mode: m }, "*"); } catch (e) {} return Promise.resolve({ mode: m }); },' +
    ' openExternal: function (p) { try { window.open((p && p.href) || "#", "_blank", "noopener"); } catch (e) {} },' +
    ' sendFollowUpMessage: function () { return Promise.resolve(); }' +
    '});' +
    '</script>'
  );
}

/**
 * Paint the widget document canvas with the devtools stage colour ({@link STAGE_BG}) so it blends into the
 * preview instead of showing a white default canvas. Iframes do not render reliably transparent across
 * browser color-scheme handling, so an explicit opaque colour is used rather than `transparent`.
 */
const STAGE_BG = '#000000';
const PREVIEW_RESET_STYLE = `<style>html,body{background:${STAGE_BG}!important;margin:0;padding:0}</style>`;

/** Insert the reset + shim into the widget document so they run before the (deferred) bridge module script. */
export function wrapWidgetHtml(html: string, shimScript: string): string {
  const inject = PREVIEW_RESET_STYLE + shimScript;
  const lower = html.toLowerCase();
  const headIdx = lower.indexOf('<head>');
  if (headIdx !== -1) {
    const at = headIdx + '<head>'.length;
    return html.slice(0, at) + inject + html.slice(at);
  }
  const bodyIdx = lower.indexOf('<body');
  if (bodyIdx !== -1) {
    const close = html.indexOf('>', bodyIdx);
    if (close !== -1) return html.slice(0, close + 1) + inject + html.slice(close + 1);
  }
  return inject + html;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** The three-pane harness shell. */
export function harnessHtml(options: {
  readonly mcpUrl: string;
  readonly theme: PreviewTheme;
  readonly device: PreviewDevice;
  readonly rpcCapability?: string;
  readonly secureWidgets?: boolean;
  readonly authRequired?: boolean;
  readonly localDelegatedExchangeRequired?: boolean;
}): string {
  const client = HARNESS_CLIENT_JS.replace(
    '__INITIAL_THEME__',
    options.theme === 'dark' ? 'dark' : 'light',
  )
    .replace('__INITIAL_DEVICE__', options.device === 'mobile' ? 'mobile' : 'desktop')
    .replace('__RPC_CAPABILITY__', jsonForScript(options.rpcCapability ?? ''))
    .replace('__SECURE_WIDGETS__', options.secureWidgets ? 'true' : 'false');
  const designAttributes = options.secureWidgets
    ? ' disabled aria-disabled="true" title="Design mode is unavailable for authenticated previews"'
    : '';
  const frameSandbox = options.secureWidgets ? ' sandbox="allow-scripts allow-popups"' : '';
  const bodyClass = options.authRequired ? ' class="auth-required auth-locked"' : '';
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<link rel="icon" type="image/svg+xml" href="${DEVTOOLS_FAVICON_DATA_URI}">` +
    '<title>Noodle Seed Devtools</title><style>' +
    DEVTOOLS_STYLES +
    DEVTOOLS_JSON_STYLES +
    (options.authRequired ? DEVTOOLS_AUTH_STYLES : '') +
    (options.localDelegatedExchangeRequired ? DEVTOOLS_DELEGATED_EXCHANGE_STYLES : '') +
    `</style></head><body${bodyClass}>` +
    '<canvas id="ns-canvas" aria-hidden="true"></canvas>' +
    '<div class="ambient-fallback" aria-hidden="true"></div>' +
    '<div class="ambient-scrim" aria-hidden="true"></div>' +
    '<div id="rail-scrim" class="rail-scrim" aria-hidden="true"></div>' +
    '<div class="workspace">' +
    '<aside id="tools" class="pane pane--tools" aria-label="Tools">' +
    '<div class="brand"><span class="brand__logo">' +
    DEVTOOLS_WORDMARK +
    '</span>' +
    '<button id="close-tools" class="rail-close" type="button" aria-label="Close tools">×</button></div>' +
    '<div class="rail-heading"><h2>Tools</h2><span class="rail-heading__hint">Server surface</span></div>' +
    '<ul id="tool-list"></ul></aside>' +
    '<main id="stage" class="pane pane--stage">' +
    '<header class="bar">' +
    '<button id="toggle-tools" class="rail-toggle rail-toggle--tools" type="button" aria-label="Open tools" aria-controls="tools" aria-expanded="false">' +
    '<span aria-hidden="true">☰</span><span>Tools</span></button>' +
    '<div class="modes" role="tablist" aria-label="Devtools mode">' +
    '<button id="mode-preview" class="mode is-active" type="button" role="tab">Preview</button>' +
    '<button id="mode-chat" class="mode" type="button" role="tab">Chat</button>' +
    `<button id="mode-design" class="mode mode--design" type="button" role="tab" aria-controls="design-view" aria-selected="false"${designAttributes}>Design</button>` +
    '</div>' +
    `<span class="muted brand__url" title="${escapeHtml(options.mcpUrl)}">${escapeHtml(options.mcpUrl)}</span>` +
    (options.authRequired ? DEVTOOLS_AUTH_SESSION_HTML : '') +
    '<button id="toggle-activity" class="rail-toggle rail-toggle--activity" type="button" aria-label="Open MCP calls" aria-controls="log" aria-expanded="false">' +
    '<span class="status-dot" aria-hidden="true"></span><span>Activity</span></button></header>' +
    (options.localDelegatedExchangeRequired ? DEVTOOLS_DELEGATED_EXCHANGE_HTML : '') +
    (options.authRequired ? DEVTOOLS_AUTH_GATE_HTML : '') +
    '<div id="preview-view">' +
    '<div id="controls" class="controls">' +
    '<span class="ctl"><span class="ctl__lbl">Theme</span><button id="theme-toggle" class="theme-switch" type="button" aria-label="Switch to dark theme" aria-pressed="false">' +
    '<span class="theme-switch__icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3.5"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/></svg></span>' +
    '<span class="theme-switch__track" aria-hidden="true"><span class="theme-switch__thumb"></span></span>' +
    '<span class="theme-switch__icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3 6.7 6.7 0 0 0 21 12.8Z"/></svg></span></button></span>' +
    '<span class="ctl"><span class="ctl__lbl">Device</span><span class="device-switch" role="group" aria-label="Preview device">' +
    '<button type="button" data-device="desktop" aria-label="Desktop preview" title="Desktop preview" aria-pressed="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg></button>' +
    '<button type="button" data-device="mobile" aria-label="Mobile preview" title="Mobile preview" aria-pressed="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></svg></button>' +
    '</span></span>' +
    '<span class="ctl ctl--width"><span class="ctl__lbl">Width</span><input id="width" type="range" min="320" max="1200" value="820" aria-label="Preview width"><output id="width-val" for="width" class="ctl__val">820 px</output></span>' +
    '<span class="ctl__spacer"></span>' +
    '<button id="fullscreen" class="ctl-btn" type="button" title="Toggle fullscreen preview">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3m13 5h3a2 2 0 0 0 2-2v-3"/></svg>Fullscreen</button>' +
    '<button id="reload" class="ctl-btn" type="button" title="Reload widget">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5"/></svg>Reload</button>' +
    '</div>' +
    '<div id="empty" class="empty-state">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M7.5 4v5"/></svg>' +
    '<p>Nothing selected</p>' +
    '<span>Pick a tool on the left to preview a widget or inspect its JSON response here.</span>' +
    '</div>' +
    `<iframe id="frame" class="hidden" title="widget preview"${frameSandbox}></iframe>` +
    '<div id="result" class="hidden"><div class="result__bar"><div class="result__label">response</div>' +
    '<button id="copy-result" class="copy-action" type="button" aria-label="Copy response">' +
    '<span class="copy-action__icons" aria-hidden="true">' +
    '<svg class="copy-action__copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/></svg>' +
    '<svg class="copy-action__check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg>' +
    '</span><span class="copy-action__label">Copy</span></button>' +
    '<span id="copy-status" class="sr-only" aria-live="polite"></span></div><pre id="result-pre"></pre></div>' +
    '</div>' +
    '<div id="chat-view" class="hidden">' +
    // Key gate. The key prefix identifies the provider on the loopback server and is never retained by the page.
    '<div id="chat-gate" class="chat-gate"><div class="chat-gate__card">' +
    '<h3>Use your favourite model</h3>' +
    '<p class="model-compatibility"><span>Test your local MCP server with</span>' +
    '<span class="compatibility-logos">' +
    `<span class="compatibility-logo compatibility-logo--openai" data-provider-logo="openai">${OPENAI_MARK}</span>` +
    `<span class="compatibility-logo compatibility-logo--anthropic" data-provider-logo="anthropic">${CLAUDE_MARK}</span>` +
    `<span class="compatibility-logo compatibility-logo--gemini" data-provider-logo="gemini">${GEMINI_MARK}</span>` +
    '</span></p>' +
    '<form id="chat-key-form">' +
    '<label class="chat-config-field"><span>API key</span><input id="chat-key-input" type="password" aria-label="Provider API key" autocomplete="off" spellcheck="false"></label>' +
    '<button id="chat-connect" class="btn primary-action" type="submit">Start chatting</button></form>' +
    '<span id="chat-gate-hint" class="chat-gate__hint" aria-live="polite">Your key stays in this local process.</span>' +
    '</div></div>' +
    '<div id="chat-body" class="hidden">' +
    '<div id="chat-keybar"><span id="chat-model-label"></span><button id="chat-reset" type="button">Change key</button></div>' +
    '<div id="chat-log"><div id="chat-empty" class="empty-state">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
    '<p>Chat playground</p>' +
    '<span>Ask the agent to use this server&#39;s tools. Tool calls and any widgets render inline.</span>' +
    '</div></div>' +
    '<form id="chat-form" class="chat-form">' +
    '<textarea id="chat-input" rows="1" placeholder="Ask the agent to run a tool…"></textarea>' +
    '<button id="chat-send" class="btn primary-action" type="submit">Send</button>' +
    '</form>' +
    '</div>' +
    '</div>' +
    DEVTOOLS_DESIGN_HTML +
    '</main>' +
    '<aside id="log" class="pane pane--log" aria-label="MCP calls">' +
    '<div class="rail-heading rail-heading--activity"><div><span class="rail-eyebrow">Activity</span><h2>MCP calls</h2></div>' +
    '<span class="activity-state" aria-label="Listening for MCP calls"><span class="status-dot" aria-hidden="true"></span></span>' +
    '<button id="close-activity" class="rail-close" type="button" aria-label="Close MCP calls">×</button></div>' +
    '<ol id="log-list"></ol></aside>' +
    '</div>' +
    '<script>' +
    DEVTOOLS_JSON_CLIENT_JS +
    '\n' +
    DEVTOOLS_DESIGN_CLIENT_JS +
    '\n' +
    client +
    (options.localDelegatedExchangeRequired ? `\n${DEVTOOLS_DELEGATED_EXCHANGE_CLIENT_JS}` : '') +
    (options.authRequired ? `\n${DEVTOOLS_AUTH_CLIENT_JS}` : '') +
    '</script><script>' +
    DEVTOOLS_SHADER_SCRIPT +
    '</script></body></html>'
  );
}

// Plain ES5-ish client (no template literals / no ${...}) — spliced into the harness verbatim.
const HARNESS_CLIENT_JS = [
  calculateRangeProgress.toString(),
  isAutoSafeTool.toString(),
  parseWidgetToolCallMessage.toString(),
  'var RPC_CAPABILITY=__RPC_CAPABILITY__; var SECURE_WIDGETS=__SECURE_WIDGETS__;',
  'var frame=document.getElementById("frame");',
  'var empty=document.getElementById("empty");',
  'var themeToggle=document.getElementById("theme-toggle");',
  'var deviceButtons=document.querySelectorAll("[data-device]");',
  'var widthInput=document.getElementById("width");',
  'var widthVal=document.getElementById("width-val");',
  'var current=null; var currentArgs={}; var currentResourceUri=null;',
  'var resultBox=document.getElementById("result"); var resultPre=document.getElementById("result-pre"); var copyResult=document.getElementById("copy-result"); var copyStatus=document.getElementById("copy-status"); var controlsBar=document.getElementById("controls"); var currentResultSource="";',
  'var toolsToggle=document.getElementById("toggle-tools"); var activityToggle=document.getElementById("toggle-activity"); var railScrim=document.getElementById("rail-scrim");',
  'function setRail(name,open){ var isTools=name==="tools"; document.body.classList.toggle(isTools?"tools-open":"activity-open",open); (isTools?toolsToggle:activityToggle).setAttribute("aria-expanded",open?"true":"false"); }',
  'function closeRails(){ setRail("tools",false); setRail("activity",false); }',
  'toolsToggle.addEventListener("click",function(){ var open=!document.body.classList.contains("tools-open"); closeRails(); setRail("tools",open); });',
  'activityToggle.addEventListener("click",function(){ var open=!document.body.classList.contains("activity-open"); closeRails(); setRail("activity",open); });',
  'document.getElementById("close-tools").addEventListener("click",function(){ setRail("tools",false); });',
  'document.getElementById("close-activity").addEventListener("click",function(){ setRail("activity",false); });',
  'railScrim.addEventListener("click",closeRails);',
  'window.addEventListener("resize",function(){ if(window.innerWidth>=1180) closeRails(); });',
  'document.addEventListener("keydown",function(e){ if(e.key==="Escape") closeRails(); });',
  'var currentTheme="__INITIAL_THEME__"; var currentDevice="__INITIAL_DEVICE__";',
  'function hostHeaders(json){ var headers=json?{"content-type":"application/json"}:{}; if(SECURE_WIDGETS) headers["x-noodle-devtools-capability"]=RPC_CAPABILITY; return headers; }',
  'function rpc(method,params){ return fetch("/rpc",{method:"POST",headers:hostHeaders(true),body:JSON.stringify({jsonrpc:"2.0",id:Date.now(),method:method,params:params||{}})}).then(function(r){return r.json();}); }',
  'function inputResponse(id,value){ if(!value||value.method!=="elicitation/create"||!value.params||value.params.mode!=="form") throw new Error("Unsupported input request"); var p=value.params; var schema=p.requestedSchema||{}; var props=schema.properties||{}; var keys=Object.keys(props); if(keys.length<1||keys.length>32) throw new Error("Unsupported input schema"); if(id==="__noodle_confirmation"&&props.confirm&&props.confirm.type==="boolean") return window.confirm(String(p.message||"Approve this action?"))?{action:"accept",content:{confirm:true}}:{action:"decline"}; var content={}; for(var i=0;i<keys.length;i++){ var name=keys[i]; var field=props[name]||{}; if(["string","number","integer","boolean"].indexOf(field.type)<0) throw new Error("Unsupported input field"); var hint=String(p.message||"Input required")+"\\n\\n"+String(field.title||name)+(field.description?": "+field.description:""); var initial=field.default===undefined?"":String(field.default); var answer=window.prompt(hint,initial); if(answer===null) return {action:"cancel"}; if(answer===""&&(schema.required||[]).indexOf(name)<0) continue; if(field.type==="number"||field.type==="integer") content[name]=Number(answer); else if(field.type==="boolean") content[name]=answer.toLowerCase()==="true"; else content[name]=answer; } return {action:"accept",content:content}; }',
  'function completeRpc(method,params,round){ return rpc(method,params).then(function(j){ var result=j&&j.result; if(!result||result.resultType!=="input_required") return j; if((round||0)>=8||typeof result.requestState!=="string"||!result.inputRequests||typeof result.inputRequests!=="object") throw new Error("Invalid input-required response"); var responses={}; var ids=Object.keys(result.inputRequests); if(ids.length<1||ids.length>32) throw new Error("Invalid input-required response"); ids.forEach(function(id){ responses[id]=inputResponse(id,result.inputRequests[id]); }); return completeRpc(method,Object.assign({},params,{requestState:result.requestState,inputResponses:responses}),(round||0)+1); }); }',
  'function syncThemeControl(){ var dark=currentTheme==="dark"; themeToggle.setAttribute("aria-pressed",dark?"true":"false"); themeToggle.setAttribute("aria-label",dark?"Switch to light theme":"Switch to dark theme"); themeToggle.dataset.theme=currentTheme; }',
  'function applyTheme(){ syncThemeControl(); try{ var w=frame.contentWindow; if(w&&w.openai){ w.openai.theme=currentTheme; w.dispatchEvent(new Event("openai:set_globals")); } }catch(e){} }',
  'function fitFrame(){ if(frame.classList.contains("nd-frame-full")) return; try{ var d=frame.contentDocument; if(d&&d.documentElement){ frame.style.height=Math.max(120, d.documentElement.scrollHeight)+"px"; } }catch(e){} }',
  'function clearBg(){ try{ var d=frame.contentDocument; if(d){ if(d.documentElement) d.documentElement.style.setProperty("background","#000000","important"); if(d.body) d.body.style.setProperty("background","#000000","important"); } }catch(e){} }',
  'function syncDeviceControl(){ for(var i=0;i<deviceButtons.length;i++){ var active=deviceButtons[i].dataset.device===currentDevice; deviceButtons[i].classList.toggle("is-active",active); deviceButtons[i].setAttribute("aria-pressed",active?"true":"false"); } }',
  'function setDevice(device){ currentDevice=device; widthInput.value=device==="mobile"?390:820; syncDeviceControl(); syncWidth(); }',
  'function syncWidth(){ var progress=calculateRangeProgress(Number(widthInput.value),Number(widthInput.min),Number(widthInput.max)); widthInput.style.setProperty("--width-progress",progress+"%"); frame.style.width=widthInput.value+"px"; widthVal.textContent=widthInput.value+" px"; }',
  'function setState(s){ empty.style.display=s==="empty"?"flex":"none"; frame.style.display=s==="widget"?"block":"none"; resultBox.style.display=s==="result"?"block":"none"; controlsBar.style.display=s==="widget"?"flex":"none"; }',
  'function setWidgetDocument(target,q){ if(!SECURE_WIDGETS){ target.src=q; return; } fetch(q,{headers:hostHeaders(false)}).then(function(r){if(!r.ok) throw new Error("widget load failed"); return r.text();}).then(function(html){target.srcdoc=html;}).catch(function(){target.srcdoc="<!doctype html><p>Failed to load widget.</p>";}); }',
  'function loadWidget(name,args,resourceUri){ current=name; currentArgs=args||{}; if(resourceUri!==undefined) currentResourceUri=resourceUri||null; setState("widget"); var q="/widget?name="+encodeURIComponent(name); if(Object.keys(currentArgs).length) q+="&args="+encodeURIComponent(JSON.stringify(currentArgs)); setWidgetDocument(frame,q); if(!SECURE_WIDGETS&&modeDesign&&modeDesign.classList.contains("is-active")&&window.NoodleDesignUI) window.NoodleDesignUI.enter(); }',
  'function legacyCopy(value){ var textarea=document.createElement("textarea"); textarea.value=value; textarea.setAttribute("readonly",""); textarea.style.position="fixed"; textarea.style.left="-9999px"; document.body.appendChild(textarea); textarea.select(); var copied=false; try{ copied=document.execCommand("copy"); }catch(e){} textarea.remove(); return copied?Promise.resolve():Promise.reject(new Error("copy failed")); }',
  'function copyText(value,trigger,label){ var operation=navigator.clipboard&&navigator.clipboard.writeText?navigator.clipboard.writeText(value).catch(function(){return legacyCopy(value);}):legacyCopy(value); return operation.then(function(){ var text=trigger.querySelector(".copy-action__label"); trigger.classList.add("is-copied"); if(text) text.textContent="Copied"; copyStatus.textContent="Copied "+label; setTimeout(function(){ trigger.classList.remove("is-copied"); if(text) text.textContent="Copy"; },1600); }).catch(function(){ copyStatus.textContent="Could not copy "+label; }); }',
  'copyResult.addEventListener("click",function(){ copyText(currentResultSource,copyResult,"response"); });',
  'function showResult(v){ current=null; currentResourceUri=null; currentResultSource=jsonSource(v); renderJson(resultPre,v); setState("result"); }',
  'frame.addEventListener("load", function(){ applyTheme(); clearBg(); fitFrame(); if(window.NoodleDesignUI) window.NoodleDesignUI.frameLoaded(); try{ var b=frame.contentDocument&&frame.contentDocument.body; if(b&&window.ResizeObserver){ new ResizeObserver(function(){ clearBg(); fitFrame(); }).observe(b); } }catch(e){} setTimeout(function(){ clearBg(); fitFrame(); },150); setTimeout(function(){ clearBg(); fitFrame(); },600); });',
  'themeToggle.addEventListener("click", function(){ currentTheme=currentTheme==="dark"?"light":"dark"; applyTheme(); });',
  'for(var deviceIndex=0;deviceIndex<deviceButtons.length;deviceIndex++){ deviceButtons[deviceIndex].addEventListener("click",function(){ setDevice(this.dataset.device); }); }',
  'widthInput.addEventListener("input", function(){ currentDevice="custom"; syncDeviceControl(); syncWidth(); });',
  'document.getElementById("reload").addEventListener("click", function(){ if(current) loadWidget(current, currentArgs, currentResourceUri); });',
  // Fullscreen: works for the preview frame (toolbar button) and any chat widget (its requestDisplayMode).
  'var fsFrame=null; var fsExitBtn=null;',
  'function ndFit(f){ if(f===frame) fitFrame(); else fitChatFrame(f); }',
  'function notifyDisplayMode(f,mode){ try{ var w=f.contentWindow; if(w&&w.openai){ w.openai.displayMode=mode; w.dispatchEvent(new Event("openai:set_globals")); } }catch(e){} }',
  'function enterFullscreen(f){ if(!f) return; if(fsFrame) exitFullscreen(); fsFrame=f; f.classList.add("nd-frame-full"); if(!fsExitBtn){ fsExitBtn=document.createElement("button"); fsExitBtn.id="fs-exit"; fsExitBtn.type="button"; fsExitBtn.innerHTML="\\u2715 Exit fullscreen"; fsExitBtn.addEventListener("click", exitFullscreen); document.body.appendChild(fsExitBtn); } notifyDisplayMode(f,"fullscreen"); }',
  'function exitFullscreen(){ if(fsFrame){ var f=fsFrame; f.classList.remove("nd-frame-full"); notifyDisplayMode(f,"inline"); fsFrame=null; setTimeout(function(){ ndFit(f); },0); } if(fsExitBtn){ fsExitBtn.remove(); fsExitBtn=null; } }',
  'document.addEventListener("keydown", function(e){ if(e.key==="Escape"&&fsFrame) exitFullscreen(); });',
  'document.getElementById("fullscreen").addEventListener("click", function(){ if(fsFrame) exitFullscreen(); else if(current) enterFullscreen(frame); });',
  'function findFrameBySource(src){ if(frame&&frame.contentWindow===src) return frame; var list=document.querySelectorAll("#chat-log iframe"); for(var i=0;i<list.length;i++){ if(list[i].contentWindow===src) return list[i]; } return null; }',
  'window.addEventListener("message", function(ev){ var d=ev.data; if(!d||d.type!=="noodle:display-mode") return; var f=findFrameBySource(ev.source); if(!f) return; if(d.mode==="fullscreen") enterFullscreen(f); else if(fsFrame===f) exitFullscreen(); });',
  'var currentToolsByName={};',
  'function replyToWidget(target,requestId,result,error){ try{ target.postMessage({type:"noodle:tool-result",requestId:requestId,result:result,error:error||null},"*"); }catch(e){} }',
  'window.addEventListener("message",function(ev){ if(!findFrameBySource(ev.source)) return; var call=parseWidgetToolCallMessage(ev.data); if(!call) return; var tool=currentToolsByName[call.name]; if(!tool){ replyToWidget(ev.source,call.requestId,null,"Unknown tool"); return; } if(!isAutoSafeTool(tool)&&!window.confirm("This widget wants to run "+call.name+". Allow this call?")){ replyToWidget(ev.source,call.requestId,null,"Tool call denied"); return; } completeRpc("tools/call",{name:call.name,arguments:call.arguments}).then(function(j){ if(j&&j.error) replyToWidget(ev.source,call.requestId,null,(j.error&&j.error.message)||"tool error"); else replyToWidget(ev.source,call.requestId,j&&j.result,null); }).catch(function(e){replyToWidget(ev.source,call.requestId,null,(e&&e.message)||"Tool call failed");}); });',
  // Tool cards (expandable: description + schema fields + a single Run; widget tools render in the preview).
  'function makeControl(p){ if(Array.isArray(p.enum)){ var s=document.createElement("select"); p.enum.forEach(function(v){ var o=document.createElement("option"); o.value=String(v); o.textContent=String(v); s.appendChild(o); }); return s; } if(p.type==="boolean"){ var c=document.createElement("input"); c.type="checkbox"; return c; } var i=document.createElement("input"); i.type=(p.type==="number"||p.type==="integer")?"number":"text"; if(p.default!==undefined&&p.type!=="object"&&p.type!=="array") i.value=String(p.default); return i; }',
  'function collect(props,controls){ var args={}; Object.keys(controls).forEach(function(k){ var p=props[k]||{}; var el=controls[k]; if(el.type==="checkbox"){ args[k]=el.checked; return; } var v=el.value; if(v==="") return; if(p.type==="number"||p.type==="integer"){ args[k]=Number(v); return; } if(p.type==="object"||p.type==="array"){ try{ args[k]=JSON.parse(v); }catch(e){ args[k]=v; } return; } args[k]=v; }); return args; }',
  'function buildDetail(detail,t,hasWidget){ if(t.description){ var d=document.createElement("p"); d.className="tool__desc"; d.textContent=t.description; detail.appendChild(d); } var schema=t.inputSchema||{}; var props=schema.properties||{}; var req=schema.required||[]; var controls={}; Object.keys(props).forEach(function(k){ var p=props[k]||{}; var f=document.createElement("div"); f.className="field"; var lab=document.createElement("label"); lab.textContent=k+(req.indexOf(k)>=0?" *":"")+(p.type?"  ("+p.type+")":""); var ctrl=makeControl(p); f.appendChild(lab); f.appendChild(ctrl); if(p.description){ var h=document.createElement("div"); h.className="field__hint"; h.textContent=p.description; f.appendChild(h); } controls[k]=ctrl; detail.appendChild(f); }); var actions=document.createElement("div"); actions.className="tool__actions"; var run=document.createElement("button"); run.className="btn primary-action"; run.textContent="Run"; run.addEventListener("click", function(){ if(hasWidget){ loadWidget(t.name, collect(props,controls), hasWidget); return; } var args=collect(props,controls); run.disabled=true; var o=run.textContent; run.textContent="Running…"; completeRpc("tools/call",{name:t.name,arguments:args}).then(function(j){ showResult(j&&j.result!==undefined?j.result:(j&&j.error!==undefined?j.error:j)); }).catch(function(){}).then(function(){ run.disabled=false; run.textContent=o; }); }); actions.appendChild(run); detail.appendChild(actions); }',
  'function renderTools(tools){ var ul=document.getElementById("tool-list"); ul.innerHTML=""; currentToolsByName={}; tools.forEach(function(t){ currentToolsByName[t.name]=t; var li=document.createElement("li"); li.className="tool"; var head=document.createElement("button"); head.type="button"; head.className="tool__head"; head.setAttribute("aria-expanded","false"); var nm=document.createElement("span"); nm.className="tool__name"; nm.textContent=t.name; head.appendChild(nm); var hasWidget=t._meta&&t._meta.ui&&t._meta.ui.resourceUri; if(hasWidget){ var b=document.createElement("span"); b.className="tag"; b.textContent="widget"; head.appendChild(b); } var chev=document.createElement("span"); chev.className="chev"; chev.textContent="▸"; head.appendChild(chev); var detail=document.createElement("div"); detail.className="tool__detail"; head.addEventListener("click", function(){ var open=li.classList.toggle("open"); head.setAttribute("aria-expanded",open?"true":"false"); chev.textContent=open?"▾":"▸"; if(open&&!detail.dataset.built){ buildDetail(detail,t,hasWidget); detail.dataset.built="1"; } }); li.appendChild(head); li.appendChild(detail); ul.appendChild(li); }); }',
  'function refreshTools(){ return rpc("tools/list",{}).then(function(j){ renderTools((j.result&&j.result.tools)||[]); }); }',
  'refreshTools();',
  // MCP call log (expandable: input + output JSON).
  'function section(label,value){ var w=document.createElement("div"); var h=document.createElement("div"); h.className="log__label"; h.textContent=label; var pre=document.createElement("pre"); renderJson(pre,value); w.appendChild(h); w.appendChild(pre); return w; }',
  'function addLog(e){ var ol=document.getElementById("log-list"); var li=document.createElement("li"); li.className="log log--"+(e.status==="error"?"error":"ok"); var has=(e.request!==undefined||e.response!==undefined); var head=document.createElement(has?"button":"div"); if(has){ head.type="button"; head.setAttribute("aria-expanded","false"); } head.className="log__head"; var chev=document.createElement("span"); chev.className="chev"; chev.textContent=has?"▸":""; var m=document.createElement("span"); m.className="m "+e.status; m.textContent=e.method; var n=document.createElement("span"); n.className="log__sum"; n.textContent=(e.name?e.name+" ":"")+e.summary; var d=document.createElement("span"); d.className="d"; d.textContent=e.durationMs+"ms"; head.appendChild(chev); head.appendChild(m); head.appendChild(n); head.appendChild(d); var detail=document.createElement("div"); detail.className="log__detail"; if(has){ head.addEventListener("click", function(){ var open=li.classList.toggle("open"); head.setAttribute("aria-expanded",open?"true":"false"); chev.textContent=open?"▾":"▸"; if(open&&!detail.dataset.built){ if(e.request!==undefined) detail.appendChild(section("input",e.request)); if(e.response!==undefined) detail.appendChild(section("output",e.response)); detail.dataset.built="1"; } }); } li.appendChild(head); li.appendChild(detail); ol.insertBefore(li, ol.firstChild); }',
  'try{ var es=new EventSource("/rpc/log"); es.onmessage=function(ev){ try{ addLog(JSON.parse(ev.data)); }catch(e){} }; }catch(e){}',
  'try{ var rs=new EventSource("/reload"); rs.onmessage=function(ev){ if(ev.data==="hard"){window.location.reload();return;} refreshTools(); if(current) loadWidget(current, currentArgs, currentResourceUri); }; }catch(e){}',
  // Preview | Chat | Design mode toggle.
  'var previewView=document.getElementById("preview-view"); var chatView=document.getElementById("chat-view"); var designView=document.getElementById("design-view");',
  'var modePreview=document.getElementById("mode-preview"); var modeChat=document.getElementById("mode-chat"); var modeDesign=document.getElementById("mode-design");',
  'if(!SECURE_WIDGETS&&window.NoodleDesignUI) window.NoodleDesignUI.configure({frame:frame,getContext:function(){ if(!current) return null; var height=640; try{height=frame.contentWindow.innerHeight||frame.getBoundingClientRect().height||640;}catch(e){} return {toolName:current,resourceUri:currentResourceUri,width:Number(widthInput.value)||820,height:Math.round(height),device:currentDevice,theme:currentTheme}; }});',
  'function setMode(m){ if(SECURE_WIDGETS&&m==="design") m="preview"; var p=m==="preview"; var c=m==="chat"; var d=m==="design"; var wasDesign=modeDesign.classList.contains("is-active"); document.body.classList.toggle("design-mode",d); if(d) document.body.classList.remove("activity-open"); modePreview.classList.toggle("is-active",p); modeChat.classList.toggle("is-active",c); modeDesign.classList.toggle("is-active",d); modePreview.setAttribute("aria-selected",p?"true":"false"); modeChat.setAttribute("aria-selected",c?"true":"false"); modeDesign.setAttribute("aria-selected",d?"true":"false"); previewView.style.display=p?"flex":"none"; chatView.style.display=c?"flex":"none"; designView.style.display=d?"flex":"none"; if(wasDesign&&!d&&window.NoodleDesignUI) window.NoodleDesignUI.leave(); if(d&&window.NoodleDesignUI) window.NoodleDesignUI.enter(); if(c) enterChat(); }',
  'modePreview.addEventListener("click", function(){ setMode("preview"); });',
  'modeChat.addEventListener("click", function(){ setMode("chat"); });',
  'modeDesign.addEventListener("click", function(){ setMode("design"); });',
  // Chat playground: an agent turn posts the running message history to /chat and renders tool calls inline.
  'var chatMessages=[]; var chatBusy=false;',
  'var chatLog=document.getElementById("chat-log"); var chatForm=document.getElementById("chat-form"); var chatInput=document.getElementById("chat-input"); var chatSend=document.getElementById("chat-send"); var chatEmpty=document.getElementById("chat-empty");',
  // Key gate: credentials stay in the loopback server. The browser retains only the inferred provider id.
  'var chatGate=document.getElementById("chat-gate"); var chatBody=document.getElementById("chat-body"); var chatKeyForm=document.getElementById("chat-key-form"); var chatKeyInput=document.getElementById("chat-key-input"); var chatGateHint=document.getElementById("chat-gate-hint"); var chatKeybar=document.getElementById("chat-keybar"); var chatReset=document.getElementById("chat-reset"); var chatConnect=document.getElementById("chat-connect"); var chatModelLabel=document.getElementById("chat-model-label");',
  'var chatProvider="openai"; var chatProviders={}; var chatRequiresKey=false; var chatStatusMessage="";',
  'var providerInfo={openai:{label:"OpenAI"},anthropic:{label:"Claude"},gemini:{label:"Gemini"}};',
  'function activeProvider(){ if(chatRequiresKey) return {hasKey:false,source:"none",model:""}; return chatProviders[chatProvider]||{hasKey:false,source:"none",model:""}; }',
  'function paintKeyGate(){ var s=activeProvider(); chatKeyInput.placeholder=s.hasKey?"Paste a different API key":"Paste your API key"; chatConnect.textContent=s.hasKey?"Use connected key":"Start chatting"; chatGateHint.className="chat-gate__hint"+(chatRequiresKey?" err":""); chatGateHint.textContent=chatRequiresKey?chatStatusMessage:(s.hasKey?"A "+providerInfo[chatProvider].label+" key is connected. Paste another key to switch models.":"Your key stays in this local process."); }',
  'function refreshChatReady(cb){ fetch("/chat/status",{headers:hostHeaders(false)}).then(function(r){return r.json();}).then(function(j){ chatProviders=(j&&j.providers)||{}; chatRequiresKey=Boolean(j&&j.requiresKey); chatStatusMessage=(j&&j.error&&j.error.message)||""; if(j&&j.activeProvider) chatProvider=j.activeProvider; paintKeyGate(); if(cb) cb(); }).catch(function(){ if(cb) cb(); }); }',
  'function renderGate(){ var s=activeProvider(); if(s.hasKey){ chatGate.style.display="none"; chatBody.style.display="flex"; chatKeybar.className="on"; chatModelLabel.textContent=providerInfo[chatProvider].label; chatInput.focus(); } else { chatBody.style.display="none"; chatGate.style.display="flex"; paintKeyGate(); chatKeyInput.focus(); } }',
  'function enterChat(){ refreshChatReady(renderGate); }',
  'function showKeyError(msg){ chatGateHint.textContent=msg; chatGateHint.className="chat-gate__hint err"; chatBody.style.display="none"; chatGate.style.display="flex"; chatKeyInput.focus(); }',
  'chatKeyForm.addEventListener("submit", function(e){ e.preventDefault(); var key=chatKeyInput.value.trim(); var s=activeProvider(); if(!key&&!s.hasKey) return; var payload=key?{key:key}:{provider:chatProvider}; fetch("/chat/key",{method:"POST",headers:hostHeaders(true),body:JSON.stringify(payload)}).then(function(r){return r.json();}).then(function(j){ chatKeyInput.value=""; if(j&&j.ok){ var nextProvider=j.provider||chatProvider; if(nextProvider!==chatProvider) chatMessages=[]; chatProvider=nextProvider; chatRequiresKey=false; chatStatusMessage=""; chatProviders[chatProvider]=j; renderGate(); } else { showKeyError((j&&j.error&&j.error.message)||"Could not connect this key. Check it and try again."); } }).catch(function(){ showKeyError("Could not reach the devtools server."); }); });',
  'chatReset.addEventListener("click", function(){ chatBody.style.display="none"; chatGate.style.display="flex"; paintKeyGate(); chatKeyInput.focus(); });',
  'function scrollChat(){ chatLog.scrollTop=chatLog.scrollHeight; }',
  'function clearChatEmpty(){ if(chatEmpty){ chatEmpty.remove(); chatEmpty=null; } }',
  'function chatBubble(cls,text){ clearChatEmpty(); var d=document.createElement("div"); d.className="msg "+cls; d.textContent=text; chatLog.appendChild(d); scrollChat(); return d; }',
  'function fitChatFrame(f){ if(f.classList.contains("nd-frame-full")) return; try{ var d=f.contentDocument; if(d&&d.documentElement){ var h=Math.max(d.documentElement.scrollHeight, d.body?d.body.scrollHeight:0); f.style.height=Math.max(120,h)+"px"; } }catch(e){} }',
  // The widget mounts async, so fit on load, keep fitting via ResizeObserver, and retry a couple of times.
  'function wireChatFrame(f, onReady){ f.addEventListener("load", function(){ try{ var d=f.contentDocument; if(d){ if(d.documentElement) d.documentElement.style.setProperty("background","#000000","important"); if(d.body) d.body.style.setProperty("background","#000000","important"); } }catch(e){} fitChatFrame(f); try{ var b=f.contentDocument&&f.contentDocument.body; if(b&&window.ResizeObserver){ new ResizeObserver(function(){ fitChatFrame(f); scrollChat(); }).observe(b); } }catch(e){} setTimeout(function(){ fitChatFrame(f); },150); setTimeout(function(){ fitChatFrame(f); if(onReady) onReady(); scrollChat(); },500); }); }',
  'var TOOL_ICO=\'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.3"/><circle cx="18" cy="6" r="2.3"/><circle cx="6" cy="18" r="2.3"/><circle cx="18" cy="18" r="2.3"/><path d="M8.3 6h7.4M6 8.3v7.4M18 8.3v7.4M8.3 18h7.4"/></svg>\';',
  // Tool call: a minimal card, collapsed by default; its I/O is separate from the widget below it.
  'function renderToolCall(tc){ clearChatEmpty(); var card=document.createElement("div"); card.className="toolcall"; var head=document.createElement("button"); head.type="button"; head.className="toolcall__head"; head.setAttribute("aria-expanded","false"); var ico=document.createElement("span"); ico.className="toolcall__ico"; ico.innerHTML=TOOL_ICO; var nm=document.createElement("span"); nm.className="toolcall__name"+(tc.isError?" error":""); nm.textContent=tc.name; head.appendChild(ico); head.appendChild(nm); if(tc.resourceUri){ var tag=document.createElement("span"); tag.className="tag"; tag.textContent="widget"; head.appendChild(tag); } var chev=document.createElement("span"); chev.className="toolcall__chev"; chev.textContent="▸"; head.appendChild(chev); var detail=document.createElement("div"); detail.className="toolcall__detail"; detail.appendChild(section("input",tc.arguments)); detail.appendChild(section("output",tc.result)); head.addEventListener("click", function(){ var open=card.classList.toggle("open"); head.setAttribute("aria-expanded",open?"true":"false"); chev.textContent=open?"▾":"▸"; if(open) setTimeout(function(){ try{ card.scrollIntoView({block:"nearest"}); }catch(e){} },0); }); card.appendChild(head); card.appendChild(detail); chatLog.appendChild(card); scrollChat(); }',
  // Widget: rendered inline in the conversation, unboxed.
  'function renderWidget(tc){ if(tc.isError||!tc.resourceUri) return; clearChatEmpty(); var wrap=document.createElement("div"); wrap.className="chat-widget"; var sk=document.createElement("div"); sk.className="chat-skeleton"; wrap.appendChild(sk); var f=document.createElement("iframe"); f.title="widget"; if(SECURE_WIDGETS) f.setAttribute("sandbox","allow-scripts allow-popups"); wireChatFrame(f, function(){ if(sk&&sk.parentNode) sk.remove(); }); var q="/widget?name="+encodeURIComponent(tc.name); if(tc.arguments&&Object.keys(tc.arguments).length) q+="&args="+encodeURIComponent(JSON.stringify(tc.arguments)); setWidgetDocument(f,q); wrap.appendChild(f); chatLog.appendChild(wrap); scrollChat(); }',
  'function sendChat(){ var text=chatInput.value.trim(); if(!text||chatBusy) return; chatBubble("msg--user",text); chatInput.value=""; chatInput.style.height="auto"; chatBusy=true; chatSend.disabled=true; var pending=chatBubble("msg--pending","Thinking..."); var outgoing=chatMessages.concat([{role:"user",content:text}]); fetch("/chat",{method:"POST",headers:hostHeaders(true),body:JSON.stringify({provider:chatProvider,messages:outgoing})}).then(function(r){return r.json();}).then(function(j){ pending.remove(); if(j&&j.error){ if(j.error.code==="no_api_key"||j.error.code==="ambiguous_provider"){ showKeyError(j.error.message||"Connect an API key to start chatting."); return; } chatBubble("msg--error","Chat failed: "+(j.error.message||"unknown error")); return; } chatMessages=(j&&j.messages)||outgoing; (j&&j.toolCalls||[]).forEach(function(tc){ renderToolCall(tc); renderWidget(tc); }); if(j&&j.text) chatBubble("msg--assistant",j.text); }).catch(function(e){ pending.remove(); chatBubble("msg--error","Chat failed: "+(e&&e.message||e)); }).then(function(){ chatBusy=false; chatSend.disabled=false; scrollChat(); }); }',
  'chatForm.addEventListener("submit", function(e){ e.preventDefault(); sendChat(); });',
  'chatInput.addEventListener("keydown", function(e){ if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); sendChat(); } });',
  'chatInput.addEventListener("input", function(){ chatInput.style.height="auto"; chatInput.style.height=Math.min(160, chatInput.scrollHeight)+"px"; });',
  'setState("empty"); applyTheme(); setDevice(currentDevice); setMode("preview");',
].join('\n');
