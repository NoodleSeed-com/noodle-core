/** Sticky response actions and copy-to-check feedback for developer output. */
export const DEVTOOLS_COPY_STYLES = `
.result__bar{
  position:sticky;
  top:0;
  z-index:2;
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px;
  min-height:42px;
  padding:0 2px 10px;
  background:linear-gradient(180deg,rgba(8,8,10,.99) 74%,rgba(8,8,10,0));
}
.copy-action{
  display:inline-flex;
  min-height:30px;
  align-items:center;
  gap:7px;
  padding:6px 10px;
  border:0;
  border-radius:999px;
  background:rgba(255,255,255,.055);
  color:var(--nd-muted);
  font-size:10.5px;
  font-weight:620;
  cursor:pointer;
  transition:background .18s ease,color .18s ease,transform .18s ease;
}
.copy-action:hover{background:rgba(255,255,255,.09);color:var(--nd-text);transform:translateY(-1px)}
.copy-action__icons{position:relative;display:block;width:14px;height:14px}
.copy-action svg{
  position:absolute;
  inset:0;
  width:14px;
  height:14px;
  transition:opacity .16s ease,transform .16s ease;
}
.copy-action__check{opacity:0;transform:scale(.72) rotate(-12deg)}
.copy-action.is-copied{color:var(--nd-success)}
.copy-action.is-copied .copy-action__copy{opacity:0;transform:scale(.72) rotate(12deg)}
.copy-action.is-copied .copy-action__check{opacity:1;transform:scale(1) rotate(0)}
.sr-only{
  position:absolute!important;
  width:1px!important;
  height:1px!important;
  padding:0!important;
  overflow:hidden!important;
  clip:rect(0,0,0,0)!important;
  white-space:nowrap!important;
  border:0!important;
}
`;
