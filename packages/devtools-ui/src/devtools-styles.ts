import { DEVTOOLS_COPY_STYLES } from './devtools-copy-styles.js';
import { DEVTOOLS_DESIGN_STYLES } from './devtools-design-styles.js';
import { DEVTOOLS_PREVIEW_CONTROL_STYLES } from './devtools-preview-control-styles.js';
import { DEVTOOLS_RESPONSIVE_STYLES } from './devtools-responsive-styles.js';

/** Core browser stylesheet for the local `noodle devtools` shell. */
const DEVTOOLS_BASE_STYLES = String.raw`
:root{
  color-scheme:dark;
  --nd-bg:#000;
  --nd-panel:#0d0d0f;
  --nd-panel-solid:#101012;
  --nd-raised:rgba(255,255,255,.055);
  --nd-raised-strong:rgba(255,255,255,.09);
  --nd-border:rgba(255,255,255,.09);
  --nd-border-strong:rgba(255,255,255,.16);
  --nd-text:#f7f7f8;
  --nd-muted:#a1a1aa;
  --nd-faint:#71717a;
  --nd-accent:#f97316;
  --nd-amber:#f59e0b;
  --nd-rose:#f43f5e;
  --nd-success:#5CF59B;
  --nd-warning:#FBBF24;
  --nd-error:#FB7185;
  --nd-code:#07120B;
  --nd-code-muted:#82A990;
  --nd-radius:28px;
  --nd-radius-inner:16px;
  --nd-font:"Geist",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  --nd-mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
}
*{box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden}
body{
  margin:0;
  background:var(--nd-bg);
  color:var(--nd-text);
  font-family:var(--nd-font);
  font-feature-settings:"rlig" 1,"calt" 1;
  -webkit-font-smoothing:antialiased;
  text-rendering:optimizeLegibility;
}
button,input,select,textarea{font:inherit}
button{color:inherit}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{
  outline:0;
  background-color:var(--nd-raised-strong);
  box-shadow:0 0 0 2px rgba(249,115,22,.3) inset;
}
::selection{background:rgba(249,115,22,.28);color:#fff}
#ns-canvas,.ambient-fallback,.ambient-scrim{
  position:fixed;
  inset:0;
  width:100%;
  height:100%;
  pointer-events:none;
}
#ns-canvas{
  z-index:1;
  opacity:.42;
  contain:strict;
  transform:translateZ(0);
}
.ambient-fallback{
  z-index:0;
  background:
    radial-gradient(54% 64% at 68% 56%,rgba(249,115,22,.11),transparent 70%),
    radial-gradient(40% 46% at 58% 66%,rgba(244,63,94,.07),transparent 74%),
    #000;
}
.ambient-scrim{
  z-index:2;
  background:
    radial-gradient(90% 110% at 85% 100%,transparent 0%,rgba(0,0,0,.42) 58%,#000 100%),
    linear-gradient(180deg,rgba(0,0,0,.18),rgba(0,0,0,.52));
}
.workspace{
  position:relative;
  display:grid;
  grid-template-columns:minmax(248px,280px) minmax(0,1fr) minmax(288px,320px);
  grid-template-rows:minmax(0,1fr);
  gap:14px;
  width:100%;
  height:100dvh;
  min-height:0;
  padding:14px;
}
.pane{
  position:relative;
  z-index:3;
  min-width:0;
  min-height:0;
  overflow:hidden;
  border:0;
  border-radius:28px;
  background:rgba(13,13,15,.94);
  box-shadow:0 24px 80px rgba(0,0,0,.34);
}
.pane--tools,.pane--log{display:flex;flex-direction:column}
.pane--stage{background:rgba(8,8,10,.82)}
.pane--tools{padding:18px 12px 12px}
.brand{
  display:flex;
  align-items:center;
  gap:9px;
  min-height:44px;
  padding:2px 8px 18px;
}
.brand__logo{display:flex;min-width:0}
.brand__wordmark{display:block;width:128px;height:auto;flex:none}
.rail-heading{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  padding:10px 10px 8px;
}
.rail-heading h2{margin:0}
.rail-heading__hint,.rail-eyebrow{
  color:var(--nd-faint);
  font-size:9px;
  font-weight:600;
  letter-spacing:.11em;
  text-transform:uppercase;
}
.rail-heading--activity{
  min-height:73px;
  padding:16px 16px 12px;
}
.rail-heading--activity>div{display:flex;flex-direction:column;gap:4px}
.rail-heading--activity h2{
  color:var(--nd-text);
  font-size:15px;
  letter-spacing:-.015em;
  text-transform:none;
}
h2{
  color:var(--nd-faint);
  font-size:10px;
  font-weight:650;
  letter-spacing:.12em;
  text-transform:uppercase;
}
.activity-state{
  display:inline-flex;
  align-items:center;
  color:var(--nd-success);
}
.status-dot{
  display:inline-block;
  width:7px;
  height:7px;
  flex:none;
  border-radius:50%;
  background:var(--nd-success);
  box-shadow:0 0 14px rgba(92,245,155,.75);
}
#tool-list,#log-list{
  min-height:0;
  overflow:auto;
  scrollbar-width:thin;
  scrollbar-color:rgba(255,255,255,.13) transparent;
}
#tool-list{list-style:none;margin:0;padding:2px 0 12px}
.tool{
  position:relative;
  margin:2px 0;
  overflow:hidden;
  border:0;
  border-radius:14px;
  background:transparent;
  transition:background .18s ease;
}
.tool.open{background:rgba(255,255,255,.04)}
.tool__head{
  display:flex;
  align-items:center;
  width:100%;
  gap:8px;
  min-height:42px;
  padding:10px 11px;
  border:0;
  border-radius:14px;
  background:transparent;
  text-align:left;
  cursor:pointer;
  transition:background .18s ease,color .18s ease;
}
.tool__head:hover{background:var(--nd-raised)}
.tool.open .tool__head{background:rgba(255,255,255,.035)}
.tool__name{
  overflow:hidden;
  color:#e4e4e7;
  font-family:var(--nd-mono);
  font-size:12px;
  font-weight:560;
  text-overflow:ellipsis;
  white-space:nowrap;
}
.tag{
  padding:2px 6px;
  border:1px solid currentColor;
  border-radius:999px;
  background:transparent;
  color:#fdba74;
  font-size:8.5px;
  font-weight:650;
  letter-spacing:.05em;
  text-transform:uppercase;
}
.chev{color:var(--nd-faint);font-size:10px}
.tool__head .chev{margin-left:auto}
.tool__detail{display:none;padding:2px 11px 13px}
.tool.open .tool__detail{display:block}
.tool__desc{
  margin:5px 0 13px;
  color:var(--nd-muted);
  font-size:12px;
  line-height:1.5;
}
.field{margin-bottom:11px}
.field label{
  display:block;
  margin-bottom:5px;
  color:#d4d4d8;
  font-family:var(--nd-mono);
  font-size:10.5px;
}
.field__hint{margin-top:4px;color:var(--nd-faint);font-size:10.5px;line-height:1.45}
.field input[type=text],.field input[type=number],.field select{
  width:100%;
  min-height:34px;
  padding:7px 9px;
  border:0;
  border-radius:10px;
  background:rgba(0,0,0,.5);
  color:var(--nd-text);
  font-family:var(--nd-mono);
  font-size:11.5px;
}
.tool__actions{display:flex;justify-content:flex-end;margin-top:13px}
.btn{
  min-height:36px;
  padding:8px 15px;
  border:0;
  border-radius:999px;
  background:var(--nd-raised);
  color:var(--nd-text);
  font-size:12px;
  font-weight:620;
  cursor:pointer;
  transition:transform .2s ease,filter .2s ease,opacity .2s ease;
}
.btn:hover{filter:brightness(1.12)}
.primary-action{
  position:relative;
  isolation:isolate;
  overflow:hidden;
  border:1px solid transparent;
  border-radius:999px;
  background:
    linear-gradient(#0c0a09,#0c0a09) padding-box,
    linear-gradient(110deg,#F97316 0%,#F59E0B 36%,#F43F5E 68%,#F97316 100%) border-box;
  background-size:100% 100%,220% 220%;
  color:#fff;
  box-shadow:
    0 0 0 1px rgba(255,255,255,.08) inset,
    0 8px 28px rgba(249,115,22,.18),
    0 0 18px rgba(244,63,94,.08);
  animation:glow-shift 4s ease-in-out infinite;
}
.primary-action::after{
  content:"";
  position:absolute;
  inset:0 0 48%;
  z-index:-1;
  border-radius:999px 999px 45% 45%;
  background:linear-gradient(rgba(255,255,255,.11),transparent);
  pointer-events:none;
}
.primary-action:hover{transform:translateY(-1px) scale(1.012);filter:brightness(1.06)}
.btn:disabled{opacity:.48;cursor:default;transform:none;filter:none;animation:none}
@keyframes glow-shift{
  0%,100%{background-position:0 0,0% 50%}
  50%{background-position:0 0,100% 50%}
}
.pane--stage{display:flex;flex-direction:column}
.bar{
  display:flex;
  align-items:center;
  gap:12px;
  min-height:64px;
  flex:none;
  padding:10px 14px;
}
.modes{
  display:flex;
  gap:2px;
  padding:3px;
  border:0;
  border-radius:999px;
  background:rgba(255,255,255,.035);
}
.mode{
  min-width:78px;
  padding:7px 15px;
  border:0;
  border-radius:999px;
  background:transparent;
  color:var(--nd-muted);
  font-size:12px;
  font-weight:620;
  cursor:pointer;
  transition:background .18s ease,color .18s ease,box-shadow .18s ease;
}
.mode:hover{color:var(--nd-text)}
.mode.is-active{
  background:rgba(255,255,255,.1);
  color:#fff;
  box-shadow:inset 0 1px rgba(255,255,255,.07);
}
.brand__url{
  min-width:0;
  margin-left:auto;
  overflow:hidden;
  color:var(--nd-faint);
  font-family:var(--nd-mono);
  font-size:10px;
  text-overflow:ellipsis;
  white-space:nowrap;
}
.muted{color:var(--nd-muted)}
.rail-toggle,.rail-close{
  display:none;
  align-items:center;
  justify-content:center;
  gap:7px;
  min-height:34px;
  padding:7px 10px;
  border:0;
  border-radius:999px;
  background:rgba(255,255,255,.045);
  color:var(--nd-muted);
  font-size:11px;
  font-weight:600;
  cursor:pointer;
}
.rail-close{
  width:30px;
  min-height:30px;
  padding:0;
  border-radius:50%;
  font-size:18px;
  line-height:1;
}
.pane--stage>div{padding:16px 18px 18px}
#preview-view,#chat-view{display:flex;flex:1;min-height:0;flex-direction:column}
#preview-view{
  overflow-x:hidden;
  overflow-y:auto;
  scrollbar-width:thin;
  scrollbar-color:rgba(255,255,255,.13) transparent;
}
#preview-view>.controls{
  position:sticky;
  top:0;
  z-index:4;
  flex:none;
  background:rgba(18,18,20,.96);
  box-shadow:0 10px 24px rgba(0,0,0,.24);
}
.hidden{display:none}
#frame.hidden,#chat-view.hidden,#chat-body.hidden,#design-view.hidden{display:none}
#frame{
  display:block;
  width:820px;
  max-width:100%;
  height:300px;
  flex:none;
  margin:0 auto;
  border:0;
  border-radius:18px;
  background:#000;
  box-shadow:0 18px 60px rgba(0,0,0,.28);
}
.nd-frame-full{
  display:block!important;
  position:fixed!important;
  inset:0!important;
  z-index:60!important;
  width:100vw!important;
  height:100dvh!important;
  max-width:none!important;
  margin:0!important;
  border-radius:0!important;
  background:#000!important;
}
#fs-exit{
  position:fixed;
  top:16px;
  right:16px;
  z-index:61;
  padding:9px 14px;
  border:0;
  border-radius:999px;
  background:var(--nd-panel-solid);
  color:var(--nd-text);
  font-size:12px;
  cursor:pointer;
  box-shadow:0 12px 40px rgba(0,0,0,.55);
}
.empty-state{
  display:flex;
  align-items:center;
  justify-content:center;
  flex:1;
  flex-direction:column;
  gap:11px;
  padding:28px;
  color:var(--nd-muted);
  text-align:center;
}
.empty-state svg{width:40px;height:40px;color:#d4d4d8;opacity:.34}
.empty-state p{margin:0;color:#e4e4e7;font-size:14px;font-weight:610}
.empty-state span{max-width:330px;color:var(--nd-faint);font-size:11.5px;line-height:1.55}
#result{flex:1;min-height:0;overflow:auto}
.result__label,.log__label{
  color:var(--nd-faint);
  font-size:9px;
  font-weight:650;
  letter-spacing:.11em;
  text-transform:uppercase;
}
.result__label{margin:0}
#result pre{
  margin:0;
  padding:15px;
  border:0;
  border-radius:var(--nd-radius-inner);
  background:rgba(0,0,0,.55);
  color:var(--nd-text);
  font-family:var(--nd-mono);
  font-size:12px;
  line-height:1.65;
  white-space:pre-wrap;
  word-break:break-word;
}
#log-list{list-style:none;margin:0;padding:6px 10px 16px;font-size:11px}
.log{
  margin:4px 0;
  overflow:hidden;
  border:0;
  border-radius:12px;
  background:rgba(0,0,0,.16);
}
.log--ok{background:rgba(92,245,155,.055)}
.log--ok.open{background:rgba(7,24,14,.9)}
.log--error{background:rgba(251,113,133,.075)}
.log--error.open{background:rgba(35,7,12,.92)}
.log__head{
  display:grid;
  width:100%;
  grid-template-columns:10px minmax(72px,auto) minmax(0,1fr) auto;
  align-items:center;
  gap:7px;
  min-height:38px;
  padding:8px 9px;
  border:0;
  background:transparent;
  text-align:left;
  cursor:pointer;
}
.log__head:hover{background:rgba(255,255,255,.035)}
.log .m{font-family:var(--nd-mono);font-size:10px;font-weight:650}
.log .ok{color:var(--nd-success)}
.log .error{color:var(--nd-error)}
.log__sum{overflow:hidden;color:#c4c4c8;text-overflow:ellipsis;white-space:nowrap}
.log .d{color:var(--nd-code-muted);font-family:var(--nd-mono);font-size:9.5px}
.log__detail{display:none;padding:0 9px 10px}
.log.open .log__detail{display:block}
.log__label{margin:7px 0 4px;color:var(--nd-code-muted)}
.log__detail pre,.toolcall__detail pre{
  margin:0;
  overflow:auto;
  border:0;
  border-radius:10px;
  background:var(--nd-code);
  color:#e4e4e7;
  font-family:var(--nd-mono);
  font-size:10.5px;
  line-height:1.6;
  white-space:pre-wrap;
  word-break:break-word;
}
.log__detail pre{background:#09090b}
.log__detail pre{max-height:280px;padding:9px}
#chat-body{display:flex;flex:1;min-height:0;flex-direction:column;gap:12px}
.chat-gate{
  display:flex;
  align-items:center;
  justify-content:center;
  flex:1;
  min-height:0;
  padding:28px;
}
.chat-gate__card{
  display:flex;
  align-items:center;
  width:100%;
  max-width:560px;
  flex-direction:column;
  gap:12px;
  text-align:center;
}
.chat-gate__card h3{margin:4px 0 0;font-size:23px;font-weight:590;letter-spacing:-.035em}
.chat-gate__card p{max-width:480px;margin:0;color:var(--nd-muted);font-size:12.5px;line-height:1.62}
.model-compatibility{
  display:flex;
  align-items:center;
  justify-content:center;
  flex-wrap:wrap;
  gap:10px;
}
.compatibility-logos{display:inline-flex;align-items:center;gap:8px}
.compatibility-logo{
  display:inline-flex;
  width:24px;
  height:24px;
  align-items:center;
  justify-content:center;
}
.compatibility-logo svg{display:block;width:17px;height:17px;overflow:visible}
.compatibility-logo--openai{color:#f4f4f5}
.compatibility-logo--openai svg{fill:currentColor}
.compatibility-logo--anthropic{color:#D97757}
.compatibility-logo--anthropic svg{fill:currentColor}
.compatibility-logo--gemini{color:#8AB4F8}
.compatibility-logo--gemini svg{fill:currentColor}
#chat-key-form{
  display:grid;
  width:100%;
  grid-template-columns:minmax(0,1fr) auto;
  align-items:end;
  gap:8px;
  margin-top:18px;
  border:0;
  background:transparent;
}
.chat-config-field{
  display:flex;
  min-width:0;
  flex-direction:column;
  align-items:flex-start;
  gap:6px;
  color:var(--nd-faint);
  font-size:9px;
  font-weight:650;
  letter-spacing:.08em;
  text-transform:uppercase;
}
#chat-key-input{
  width:100%;
  min-width:0;
  height:40px;
  padding:0 12px;
  border:0;
  border-radius:12px;
  background:var(--nd-raised);
  color:var(--nd-text);
  font-family:var(--nd-mono);
  font-size:11.5px;
  outline:0;
}
#chat-connect{height:40px;padding:0 16px;white-space:nowrap}
.chat-gate__hint{max-width:470px;color:var(--nd-faint);font-size:10.5px;line-height:1.5}
.chat-gate__hint code{color:var(--nd-muted);font-family:var(--nd-mono)}
.chat-gate__hint.err{color:var(--nd-error)}
#chat-keybar{display:none;align-items:center;justify-content:flex-end;gap:10px;flex:none}
#chat-keybar.on{display:flex}
#chat-model-label{color:var(--nd-faint);font-family:var(--nd-mono);font-size:10px}
#chat-reset{
  padding:5px 8px;
  border:0;
  background:transparent;
  color:var(--nd-faint);
  font-size:10.5px;
  cursor:pointer;
}
#chat-reset:hover{color:var(--nd-text)}
#chat-log{
  display:flex;
  min-height:0;
  flex:1;
  flex-direction:column;
  gap:14px;
  overflow-y:auto;
  padding:4px 2px;
}
#chat-log>*{flex:0 0 auto}
.msg{max-width:84%;line-height:1.58;white-space:pre-wrap;word-break:break-word}
.msg--user{
  align-self:flex-end;
  padding:10px 14px;
  border:0;
  border-radius:18px 18px 5px 18px;
  background:var(--nd-raised-strong);
  color:#f4f4f5;
  font-size:13px;
}
.msg--assistant{align-self:stretch;max-width:100%;padding:3px 1px;color:var(--nd-text);font-size:13.5px}
.msg--error{
  align-self:flex-start;
  padding:10px 13px;
  border:0;
  border-radius:14px;
  background:rgba(251,113,133,.09);
  color:#fecdd3;
  font-size:12.5px;
}
.msg--pending{align-self:flex-start;padding:2px 1px;color:var(--nd-muted);font-size:12.5px;font-style:italic}
.toolcall{
  align-self:stretch;
  overflow:hidden;
  border:0;
  border-radius:14px;
  background:rgba(0,0,0,.2);
}
.toolcall__head{
  display:flex;
  align-items:center;
  width:100%;
  gap:8px;
  padding:9px 11px;
  border:0;
  background:transparent;
  text-align:left;
  cursor:pointer;
  font-size:11.5px;
}
.toolcall__head:hover{background:var(--nd-raised)}
.toolcall__ico{display:flex;align-items:center;color:var(--nd-success)}
.toolcall__ico svg{width:13px;height:13px}
.toolcall__name{color:#e4e4e7;font-family:var(--nd-mono);font-size:11.5px;font-weight:600}
.toolcall__name.error{color:var(--nd-error)}
.toolcall__chev{margin-left:auto;color:var(--nd-faint);font-size:10px}
.toolcall__detail{display:none;padding:0 11px 11px}
.toolcall.open .toolcall__detail{display:block}
.toolcall__detail .log__label{margin:9px 0 4px}
.toolcall__detail pre{padding:8px;overflow-x:auto}
.chat-widget{position:relative;align-self:stretch;min-height:160px;margin:2px 0}
.chat-widget iframe{
  display:block;
  width:100%;
  min-height:120px;
  border:0;
  border-radius:16px;
  background:#000;
}
.chat-skeleton{
  position:absolute;
  inset:0;
  overflow:hidden;
  border:0;
  border-radius:16px;
  background:var(--nd-raised);
}
.chat-skeleton::after{
  content:"";
  position:absolute;
  inset:0;
  transform:translateX(-100%);
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.07),transparent);
  animation:nd-shimmer 1.4s ease-in-out infinite;
}
@keyframes nd-shimmer{100%{transform:translateX(100%)}}
.chat-form{
  display:flex;
  align-items:flex-end;
  gap:8px;
  flex:none;
  padding:7px;
  border:0;
  border-radius:22px;
  background:rgba(255,255,255,.045);
  box-shadow:0 16px 50px rgba(0,0,0,.24);
}
#chat-input{
  min-width:0;
  max-height:160px;
  flex:1;
  resize:none;
  padding:8px 10px;
  border:0;
  background:transparent;
  color:var(--nd-text);
  font-size:13px;
  line-height:1.5;
  outline:0;
}
#chat-send:disabled{opacity:.48;cursor:default;animation:none}
`;

/** Complete composed stylesheet, kept as one `<style>` element in the self-contained harness. */
export const DEVTOOLS_STYLES =
  DEVTOOLS_BASE_STYLES +
  DEVTOOLS_COPY_STYLES +
  DEVTOOLS_PREVIEW_CONTROL_STYLES +
  DEVTOOLS_DESIGN_STYLES +
  DEVTOOLS_RESPONSIVE_STYLES;
