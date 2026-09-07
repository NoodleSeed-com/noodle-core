/** Premium, flat Design workspace styling kept separate from the core devtools stylesheet. */
export const DEVTOOLS_DESIGN_STYLES = `
.mode--design{display:inline-flex;align-items:center;justify-content:center}
#design-view{
  display:flex;
  min-height:0;
  flex:1;
  padding:0!important;
  overflow:hidden;
}
.design-empty{
  display:flex;
  align-items:center;
  justify-content:center;
  flex:1;
  flex-direction:column;
  gap:12px;
  padding:32px;
  text-align:center;
}
.design-empty[hidden],.design-workspace[hidden]{display:none}
.design-empty__mark{
  display:grid;
  width:48px;
  height:48px;
  place-items:center;
  border-radius:16px;
  background:linear-gradient(145deg,rgba(249,115,22,.16),rgba(244,63,94,.08));
  color:#fdba74;
  box-shadow:0 18px 48px rgba(0,0,0,.3);
}
.design-empty__mark svg{width:22px;height:22px}
.design-empty h3{margin:5px 0 0;font-size:22px;font-weight:590;letter-spacing:-.035em}
.design-empty p{max-width:390px;margin:0;color:var(--nd-muted);font-size:12px;line-height:1.65}
.design-workspace{
  display:grid;
  width:100%;
  min-height:0;
  grid-template-columns:minmax(0,1fr);
  gap:12px;
  padding:12px;
}
body.design-mode .design-workspace{grid-template-columns:minmax(0,1fr)}
body.design-mode .pane--log>.rail-heading--activity,
body.design-mode .pane--log>#log-list{display:none}
body.design-mode .rail-toggle--activity{display:none!important}
body.design-mode .pane--log>.design-inspector{
  width:100%;
  height:100%;
  max-height:none;
  flex:1;
  border-radius:inherit;
  transform:none;
}
.design-canvas{
  position:relative;
  display:flex;
  min-width:0;
  min-height:0;
  align-items:center;
  flex-direction:column;
  overflow:auto;
  border-radius:20px;
  background:
    radial-gradient(70% 60% at 50% 55%,rgba(249,115,22,.055),transparent 70%),
    rgba(0,0,0,.25);
}
.design-canvas__bar{
  position:sticky;
  top:0;
  z-index:4;
  display:flex;
  width:100%;
  align-items:center;
  justify-content:space-between;
  gap:12px;
  padding:13px 15px;
  background:linear-gradient(180deg,rgba(6,6,7,.94),rgba(6,6,7,.72),transparent);
}
.design-select-toggle{
  display:inline-flex;
  align-items:center;
  gap:8px;
  min-height:34px;
  padding:7px 10px;
  border:0;
  border-radius:10px;
  background:rgba(255,255,255,.045);
  color:#d4d4d8;
  font-size:10.5px;
  font-weight:600;
  cursor:pointer;
  transition:background 140ms ease,color 140ms ease,transform 140ms cubic-bezier(.23,1,.32,1);
}
.design-select-toggle svg{width:15px;height:15px;flex:none;color:#a1a1aa}
.design-select-toggle[aria-pressed=true]{
  background:rgba(249,115,22,.14);
  color:#fff7ed;
}
.design-select-toggle[aria-pressed=true] svg{color:#f97316}
.design-select-toggle:active{transform:scale(.98)}
.design-canvas__meta{
  display:flex;
  align-items:center;
  gap:7px;
}
.design-count{
  display:inline-flex;
  align-items:center;
  gap:5px;
  flex:none;
  min-height:30px;
  padding:5px 9px;
  border:0;
  border-radius:999px;
  background:rgba(255,255,255,.055);
  color:#b8b8bf;
  font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  font-size:9.5px;
  font-weight:650;
  cursor:pointer;
}
.design-count svg{width:12px;height:12px;transition:transform 140ms ease}
.design-count[aria-expanded=true] svg{transform:rotate(180deg)}
.design-count:disabled{opacity:.5;cursor:default}
.design-unsaved{
  padding:4px 7px;
  border-radius:999px;
  background:rgba(249,115,22,.12);
  color:#fdba74;
  font-size:8px;
  font-weight:700;
  letter-spacing:.05em;
  text-transform:uppercase;
}
#design-frame-slot{
  display:flex;
  width:100%;
  min-height:0;
  flex:1;
  align-items:flex-start;
  justify-content:center;
  padding:30px 24px 80px;
}
#design-frame-slot #frame{
  margin:0 auto;
  box-shadow:0 28px 90px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.045);
}
.design-inspector{
  display:flex;
  min-width:0;
  min-height:0;
  flex-direction:column;
  overflow:hidden;
  border-radius:20px;
  background:rgba(36,36,38,.985);
  color:#f4f4f5;
  font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  box-shadow:0 24px 70px rgba(0,0,0,.42);
}
.design-inspector__head{
  display:flex;
  align-items:flex-start;
  justify-content:space-between;
  gap:12px;
  padding:16px 16px 13px;
}
.design-inspector__eyebrow{
  display:block;
  margin-bottom:5px;
  color:#fdba74;
  font-family:var(--nd-mono);
  font-size:8px;
  font-weight:700;
  letter-spacing:.11em;
  text-transform:uppercase;
}
.design-target{
  min-width:0;
  margin:0;
  overflow:hidden;
  color:#f4f4f5;
  font-family:var(--nd-mono);
  font-size:12px;
  font-weight:630;
  text-overflow:ellipsis;
  white-space:nowrap;
}
.design-target-path{
  display:block;
  max-width:230px;
  margin-top:4px;
  overflow:hidden;
  color:var(--nd-faint);
  font-family:var(--nd-mono);
  font-size:9px;
  text-overflow:ellipsis;
  white-space:nowrap;
}
.design-icon-button{
  display:inline-grid;
  width:31px;
  height:31px;
  flex:none;
  place-items:center;
  border:0;
  border-radius:10px;
  background:rgba(255,255,255,.045);
  color:var(--nd-muted);
  cursor:pointer;
  transition:transform 140ms cubic-bezier(.23,1,.32,1),background 140ms ease,color 140ms ease;
}
.design-icon-button svg{width:15px;height:15px}
.design-icon-button:disabled{opacity:.3;cursor:default}
@media (hover:hover) and (pointer:fine){
  .design-icon-button:not(:disabled):hover{background:rgba(255,255,255,.09);color:#fff}
}
.design-icon-button:not(:disabled):active,.design-action:active{transform:scale(.97)}
.design-scroll{min-height:0;flex:1;overflow:auto;padding:0 12px 16px}
.design-section{
  padding:13px 4px;
  border-top:1px solid rgba(255,255,255,.055);
}
.design-section:first-child{border-top:0}
.design-section__label{
  display:block;
  margin-bottom:8px;
  color:var(--nd-faint);
  font-size:8px;
  font-weight:700;
  letter-spacing:.11em;
  text-transform:uppercase;
}
#design-intent{
  width:100%;
  min-height:76px;
  resize:vertical;
  padding:11px 12px;
  border:0;
  border-radius:13px;
  background:rgba(0,0,0,.34);
  color:#f4f4f5;
  font-size:11.5px;
  line-height:1.55;
  outline:0;
}
#design-intent::placeholder{color:#5d5d66}
#design-intent:focus-visible,.design-input:focus-visible{
  outline:2px solid rgba(249,115,22,.82);
  outline-offset:2px;
  box-shadow:0 0 0 4px rgba(249,115,22,.14);
}
.design-control-group{display:grid;gap:8px}
.design-control-row{
  display:grid;
  grid-template-columns:minmax(0,1fr) minmax(102px,126px);
  align-items:center;
  gap:9px;
}
.design-control-row>label{color:#b8b8bf;font-size:10.5px}
.design-input{
  width:100%;
  min-width:0;
  height:32px;
  padding:0 9px;
  border:0;
  border-radius:9px;
  background:rgba(0,0,0,.36);
  color:#e4e4e7;
  font-family:var(--nd-mono);
  font-size:10px;
  outline:0;
}
.design-color-input{display:grid;grid-template-columns:22px minmax(0,1fr);gap:5px}
.design-color-input input[type=color]{
  width:22px;
  height:32px;
  padding:0;
  border:0;
  border-radius:8px;
  background:transparent;
  overflow:hidden;
  cursor:pointer;
}
.design-color-input input[type=color]::-webkit-color-swatch-wrapper{padding:0}
.design-color-input input[type=color]::-webkit-color-swatch{border:0;border-radius:7px}
.design-segment{
  display:grid;
  grid-template-columns:repeat(3,1fr);
  gap:3px;
  padding:3px;
  border-radius:10px;
  background:rgba(0,0,0,.3);
}
.design-segment button{
  min-height:27px;
  padding:4px;
  border:0;
  border-radius:7px;
  background:transparent;
  color:var(--nd-faint);
  font-size:9px;
  cursor:pointer;
}
.design-segment button[aria-pressed=true]{background:rgba(255,255,255,.1);color:#fff}
.design-tweaks-popover{
  position:absolute;
  top:58px;
  right:15px;
  z-index:20;
  display:flex;
  width:min(360px,calc(100% - 30px));
  max-height:min(560px,calc(100% - 78px));
  flex-direction:column;
  gap:10px;
  padding:12px;
  overflow:hidden;
  border:0;
  border-radius:18px;
  background:rgba(38,38,41,.78);
  color:#f4f4f5;
  font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  box-shadow:0 26px 80px rgba(0,0,0,.62),0 1px 0 rgba(255,255,255,.045) inset;
  -webkit-backdrop-filter:blur(22px) saturate(1.15);
  backdrop-filter:blur(22px) saturate(1.15);
  opacity:0;
  visibility:hidden;
  pointer-events:none;
  transform:translateY(-6px) scale(.985);
  transform-origin:top right;
  transition:
    opacity 160ms ease,
    transform 160ms cubic-bezier(.23,1,.32,1),
    visibility 160ms step-end;
}
.design-tweaks-popover[hidden]{display:none}
.design-tweaks-popover.is-open{
  opacity:1;
  visibility:visible;
  pointer-events:auto;
  transform:translateY(0) scale(1);
  transition:
    opacity 160ms ease,
    transform 160ms cubic-bezier(.23,1,.32,1),
    visibility 0ms step-start;
}
.design-tweaks-popover__head{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px;
  flex:none;
  padding:1px 2px 3px;
}
.design-tweaks-popover__head>span:first-child{
  color:#f4f4f5;
  font-size:11px;
  font-weight:680;
  letter-spacing:-.01em;
}
.design-tweaks-popover__hint{
  color:#85858e;
  font-family:var(--nd-mono);
  font-size:7.5px;
  font-weight:700;
  letter-spacing:.1em;
  text-transform:uppercase;
}
.design-tweaks-popover .design-changes{
  min-height:0;
  overflow:auto;
  overscroll-behavior:contain;
  scrollbar-width:thin;
  scrollbar-color:rgba(255,255,255,.15) transparent;
}
.design-changes{display:grid;gap:8px}
.design-change{
  display:grid;
  gap:10px;
  padding:11px;
  border-radius:13px;
  background:rgba(0,0,0,.2);
}
.design-change__heading{display:grid;gap:3px}
.design-change__number{
  color:#fdba74;
  font-size:7.5px;
  font-weight:750;
  letter-spacing:.09em;
  text-transform:uppercase;
}
.design-change__heading strong{
  display:block;
  overflow:hidden;
  color:#f4f4f5;
  font-size:11px;
  font-weight:650;
  text-overflow:ellipsis;
  white-space:nowrap;
}
.design-change__details{display:grid;gap:8px;margin:0}
.design-change__details>div{display:grid;gap:2px}
.design-change__details dt{
  color:#8d8d96;
  font-size:8px;
  font-weight:700;
  letter-spacing:.07em;
  text-transform:uppercase;
}
.design-change__details dd{
  margin:0;
  color:#d4d4d8;
  font-family:var(--nd-mono);
  font-size:9px;
  line-height:1.5;
  white-space:pre-wrap;
  word-break:break-word;
}
.design-change__actions{display:flex;gap:5px}
.design-change__actions button{
  min-height:28px;
  padding:5px 8px;
  border:0;
  border-radius:8px;
  background:rgba(255,255,255,.055);
  color:#c4c4cc;
  font-size:9px;
  cursor:pointer;
}
.design-change__actions button.is-danger{margin-left:auto;background:transparent;color:#fb7185}
.design-changes-empty{padding:8px 1px;color:var(--nd-faint);font-size:10px;line-height:1.55}
.design-inspector__footer{
  display:grid;
  gap:8px;
  padding:12px;
  background:rgba(0,0,0,.2);
  box-shadow:0 -12px 32px rgba(0,0,0,.12);
}
.design-history{display:flex;gap:6px}
.design-history .design-icon-button{width:auto;min-width:65px;padding:0 9px;grid-auto-flow:column;gap:6px}
.design-history .design-icon-button span{font-size:9.5px}
.design-actions{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px}
.design-action{
  min-height:38px;
  padding:8px 12px;
  border:0;
  border-radius:12px;
  background:rgba(255,255,255,.065);
  color:#f4f4f5;
  font-size:11px;
  font-weight:640;
  cursor:pointer;
  transition:transform 140ms cubic-bezier(.23,1,.32,1),filter 140ms ease,opacity 140ms ease;
}
.design-action:disabled{opacity:.35;cursor:default}
.design-action--send{
  min-width:116px;
  background:linear-gradient(110deg,#f97316,#f59e0b 48%,#f43f5e);
  color:#100907;
  box-shadow:0 10px 28px rgba(249,115,22,.18);
}
.design-status{min-height:16px;color:var(--nd-faint);font-size:9.5px;line-height:1.45}
.design-status.is-error{color:#fb7185}
.design-copy-fallback{display:none;gap:7px}
.design-copy-fallback.is-visible{display:grid;grid-template-columns:minmax(0,1fr) auto}
.design-copy-fallback input{user-select:all}
@media (max-width:960px){
  .design-workspace{grid-template-columns:minmax(0,1fr)}
}
@media (max-width:760px){
  #design-view{overflow:hidden}
  .design-workspace{display:flex;position:relative;padding:8px}
  .design-canvas{width:100%;border-radius:18px}
  .design-tweaks-popover{
    top:56px;
    right:10px;
    left:10px;
    width:auto;
    max-height:min(55dvh,460px);
    transform-origin:top center;
  }
  #design-frame-slot{padding:22px 10px 250px}
  .design-inspector{
    position:absolute;
    right:8px;
    bottom:8px;
    left:8px;
    z-index:8;
    max-height:min(58dvh,510px);
    border-radius:20px;
    box-shadow:0 -22px 70px rgba(0,0,0,.68);
    transform-origin:bottom center;
  }
  .design-control-row{grid-template-columns:minmax(0,1fr) minmax(112px,138px)}
}
@media (max-width:420px){
  .design-canvas__bar{padding:11px 12px}
  .design-select-toggle span{display:none}
  .design-unsaved{display:none}
  .design-actions{grid-template-columns:1fr}
  .design-action--send{min-width:0}
}
@media (prefers-reduced-motion:reduce){
  .design-icon-button,.design-action{transition:opacity 120ms ease,background 120ms ease,color 120ms ease}
  .design-tweaks-popover,.design-tweaks-popover.is-open{transition:none}
  #noodle-design-overlay{transition:none!important}
}
`;
