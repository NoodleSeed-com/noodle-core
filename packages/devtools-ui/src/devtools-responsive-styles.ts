/** Breakpoint, reduced-motion, and overlay layering rules for the devtools shell. */
export const DEVTOOLS_RESPONSIVE_STYLES = String.raw`
.rail-scrim{display:none}
@media (max-width:1179px){
  .workspace{grid-template-columns:minmax(248px,280px) minmax(0,1fr)}
  .rail-toggle--activity{display:inline-flex}
  .pane--log{
    position:fixed;
    z-index:20;
    top:14px;
    right:14px;
    bottom:14px;
    width:min(340px,calc(100vw - 28px));
    transform:translateX(calc(100% + 28px));
    transition:transform .24s cubic-bezier(.2,.8,.2,1);
  }
  body.activity-open .pane--log{transform:translateX(0)}
  body.design-mode .pane--log{transform:translateX(0)}
  .pane--log .rail-close{display:inline-flex}
  body.design-mode .pane--log .rail-close{display:none}
  body.activity-open .rail-scrim{display:block}
  body.design-mode .rail-scrim{display:none}
}
@media (max-width:859px){
  .workspace{grid-template-columns:minmax(0,1fr)}
  .rail-toggle--tools{display:inline-flex}
  .pane--tools{
    position:fixed;
    z-index:20;
    top:14px;
    bottom:14px;
    left:14px;
    width:min(290px,calc(100vw - 28px));
    transform:translateX(calc(-100% - 28px));
    transition:transform .24s cubic-bezier(.2,.8,.2,1);
  }
  body.tools-open .pane--tools{transform:translateX(0)}
  .pane--tools .rail-close{display:inline-flex;margin-left:auto}
  body.tools-open .rail-scrim{display:block}
  .brand__url{display:none}
}
@media (max-width:639px){
  .workspace{gap:8px;padding:8px}
  .pane{border-radius:22px}
  .bar{min-height:58px;padding:9px 10px}
  .rail-toggle{padding:7px 9px}
  .rail-toggle span:last-child{display:none}
  .modes{margin:auto}
  .mode{min-width:68px;padding:7px 12px}
  .pane--stage>div{padding:12px}
  .controls{
    flex-wrap:nowrap;
    overflow-x:auto;
    margin-bottom:10px;
  }
  .ctl--width{display:none}
  .ctl__spacer{display:none}
  .ctl-btn{white-space:nowrap}
  .chat-gate{padding:18px 4px}
  .chat-gate__card h3{font-size:20px}
  #chat-key-form{grid-template-columns:1fr;align-items:stretch}
  #chat-key-input{min-height:40px}
  .primary-action{width:100%}
  .chat-form .primary-action{width:auto}
  .pane--tools{top:8px;bottom:8px;left:8px;width:min(290px,calc(100vw - 16px))}
  .pane--log{top:8px;right:8px;bottom:8px;width:calc(100vw - 16px)}
  body.design-mode .pane--log{
    top:auto;
    left:8px;
    height:min(58dvh,510px);
  }
  body.design-mode .pane--log>.design-inspector{
    position:static;
    right:auto;
    bottom:auto;
    left:auto;
    max-height:none;
  }
}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{scroll-behavior:auto!important;animation:none!important;transition-duration:.01ms!important}
}
.rail-scrim{
  position:fixed;
  inset:0;
  z-index:15;
  background:rgba(0,0,0,.58);
}
`;
