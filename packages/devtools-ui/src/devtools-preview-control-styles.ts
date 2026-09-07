/** Compact, direct preview controls for theme, device presets, width, reload, and fullscreen. */
export const DEVTOOLS_PREVIEW_CONTROL_STYLES = `
.controls{
  display:flex;
  align-items:center;
  gap:9px;
  flex-wrap:wrap;
  margin-bottom:16px;
  padding:7px;
  border:0;
  border-radius:15px;
  background:rgba(255,255,255,.035);
}
.ctl{display:flex;align-items:center;gap:7px}
.ctl__lbl{
  color:var(--nd-faint);
  font-size:9px;
  font-weight:650;
  letter-spacing:.09em;
  text-transform:uppercase;
}
.theme-switch,.device-switch{
  display:inline-flex;
  align-items:center;
  border:0;
  border-radius:999px;
  background:rgba(0,0,0,.34);
}
.theme-switch{
  gap:6px;
  min-height:31px;
  padding:4px 7px;
  color:var(--nd-faint);
  cursor:pointer;
}
.theme-switch:hover{color:var(--nd-text)}
.theme-switch__icon{display:grid;width:14px;height:14px;place-items:center}
.theme-switch__icon svg{width:13px;height:13px}
.theme-switch__track{
  position:relative;
  width:27px;
  height:15px;
  border-radius:999px;
  background:rgba(255,255,255,.11);
  transition:background .18s ease;
}
.theme-switch__thumb{
  position:absolute;
  top:3px;
  left:3px;
  width:9px;
  height:9px;
  border-radius:50%;
  background:#f4f4f5;
  box-shadow:0 1px 5px rgba(0,0,0,.45);
  transition:transform .2s cubic-bezier(.2,.8,.2,1),background .18s ease;
}
.theme-switch[aria-pressed=true] .theme-switch__track{background:rgba(249,115,22,.32)}
.theme-switch[aria-pressed=true] .theme-switch__thumb{
  background:#fdba74;
  transform:translateX(12px);
}
.device-switch{gap:2px;padding:3px}
.device-switch button{
  display:grid;
  width:29px;
  height:25px;
  place-items:center;
  padding:0;
  border:0;
  border-radius:999px;
  background:transparent;
  color:var(--nd-faint);
  cursor:pointer;
  transition:background .18s ease,color .18s ease,transform .18s ease;
}
.device-switch button:hover{color:var(--nd-text);transform:translateY(-1px)}
.device-switch button.is-active{
  background:rgba(255,255,255,.11);
  color:#fff;
}
.device-switch svg{width:14px;height:14px}
.ctl--width{
  gap:10px;
  padding:3px 4px 3px 9px;
  border-radius:999px;
  background:rgba(0,0,0,.28);
  transition:background .18s ease,box-shadow .18s ease;
}
.ctl--width:hover{background:rgba(0,0,0,.42)}
.ctl--width:focus-within{
  background:rgba(255,255,255,.055);
  box-shadow:0 8px 24px rgba(0,0,0,.18),0 0 20px rgba(249,115,22,.07);
}
.ctl--width input[type=range]{
  --width-progress:56.82%;
  appearance:none;
  -webkit-appearance:none;
  width:clamp(132px,12vw,184px);
  height:24px;
  margin:0;
  padding:0;
  border:0;
  background:transparent;
  cursor:ew-resize;
}
.ctl--width input[type=range]:focus-visible{background:transparent;box-shadow:none}
.ctl--width input[type=range]::-webkit-slider-runnable-track{
  height:5px;
  border-radius:999px;
  background:
    linear-gradient(90deg,var(--nd-accent),var(--nd-rose)) 0/var(--width-progress) 100% no-repeat,
    rgba(255,255,255,.11);
  box-shadow:inset 0 1px 2px rgba(0,0,0,.55);
}
.ctl--width input[type=range]::-webkit-slider-thumb{
  appearance:none;
  -webkit-appearance:none;
  width:15px;
  height:15px;
  margin-top:-5px;
  border:0;
  border-radius:50%;
  background:#fafafa;
  box-shadow:
    0 2px 8px rgba(0,0,0,.62),
    0 0 0 4px rgba(249,115,22,.13),
    0 0 14px rgba(244,63,94,.13);
  transition:transform .17s cubic-bezier(.2,.8,.2,1),box-shadow .17s ease;
}
.ctl--width input[type=range]::-moz-range-track{
  height:5px;
  border:0;
  border-radius:999px;
  background:rgba(255,255,255,.11);
  box-shadow:inset 0 1px 2px rgba(0,0,0,.55);
}
.ctl--width input[type=range]::-moz-range-progress{
  height:5px;
  border-radius:999px;
  background:linear-gradient(90deg,var(--nd-accent),var(--nd-rose));
}
.ctl--width input[type=range]::-moz-range-thumb{
  width:15px;
  height:15px;
  border:0;
  border-radius:50%;
  background:#fafafa;
  box-shadow:
    0 2px 8px rgba(0,0,0,.62),
    0 0 0 4px rgba(249,115,22,.13),
    0 0 14px rgba(244,63,94,.13);
  transition:transform .17s cubic-bezier(.2,.8,.2,1),box-shadow .17s ease;
}
.ctl--width:hover input[type=range]::-webkit-slider-thumb,
.ctl--width:focus-within input[type=range]::-webkit-slider-thumb{
  transform:scale(1.1);
  box-shadow:
    0 3px 10px rgba(0,0,0,.7),
    0 0 0 5px rgba(249,115,22,.17),
    0 0 18px rgba(244,63,94,.2);
}
.ctl--width:hover input[type=range]::-moz-range-thumb,
.ctl--width:focus-within input[type=range]::-moz-range-thumb{
  transform:scale(1.1);
  box-shadow:
    0 3px 10px rgba(0,0,0,.7),
    0 0 0 5px rgba(249,115,22,.17),
    0 0 18px rgba(244,63,94,.2);
}
.ctl--width:active input[type=range]::-webkit-slider-thumb{transform:scale(.94)}
.ctl--width:active input[type=range]::-moz-range-thumb{transform:scale(.94)}
.ctl__val{
  min-width:57px;
  padding:5px 8px;
  border-radius:999px;
  background:rgba(255,255,255,.06);
  color:#e4e4e7;
  font-family:var(--nd-mono);
  font-size:10.5px;
  font-variant-numeric:tabular-nums;
  line-height:1;
  text-align:center;
}
@media (prefers-reduced-motion:reduce){
  .ctl--width input[type=range]::-webkit-slider-thumb,
  .ctl--width input[type=range]::-moz-range-thumb{transform:none!important}
}
.ctl__spacer{margin-left:auto}
.ctl-btn{
  display:inline-flex;
  align-items:center;
  gap:6px;
  min-height:31px;
  padding:6px 10px;
  border:0;
  border-radius:9px;
  background:rgba(0,0,0,.34);
  color:var(--nd-muted);
  font-size:11px;
  font-weight:550;
  cursor:pointer;
}
.ctl-btn:hover{background:var(--nd-raised);color:var(--nd-text)}
.ctl-btn svg{width:13px;height:13px}
`;
