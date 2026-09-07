/** Browser-only projection of local delegated-exchange trust and per-binding test progress. */
export const DEVTOOLS_DELEGATED_EXCHANGE_STYLES = `
.local-delegated-exchange{
  position:relative;
  z-index:21;
  flex:none;
  margin:0 14px 8px;
  overflow:hidden;
  border:1px solid var(--nd-border);
  border-radius:16px;
  background:rgba(255,255,255,.025);
}
.local-delegated-exchange summary{
  display:flex;
  min-height:42px;
  align-items:center;
  justify-content:space-between;
  gap:12px;
  padding:10px 12px;
  cursor:pointer;
  list-style:none;
}
.local-delegated-exchange summary::-webkit-details-marker{display:none}
.local-delegated-exchange__title{display:flex;min-width:0;align-items:center;gap:9px}
.local-delegated-exchange__title strong{font-size:11.5px;font-weight:640}
.local-delegated-exchange__summary{color:var(--nd-faint);font-size:10px}
.local-delegated-exchange__chevron{color:var(--nd-faint);font-size:10px;transition:transform .18s ease}
.local-delegated-exchange[open] .local-delegated-exchange__chevron{transform:rotate(90deg)}
.local-delegated-exchange__body{
  display:grid;
  grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);
  gap:12px;
  padding:2px 12px 12px;
  border-top:1px solid var(--nd-border);
}
.local-delegated-exchange__trust,.local-delegated-exchange__bindings{
  display:flex;
  min-width:0;
  flex-direction:column;
  gap:8px;
  padding-top:11px;
}
.local-delegated-exchange__context{
  display:grid;
  min-width:0;
  gap:7px;
}
.local-delegated-exchange__context-values{
  display:grid;
  min-width:0;
  gap:6px;
}
.local-delegated-exchange__context-value{
  display:grid;
  min-width:0;
  gap:2px;
}
.local-delegated-exchange__field-label{color:var(--nd-faint);font-size:9px}
.local-delegated-exchange__context-value code{
  min-width:0;
  color:#e4e4e7;
  font:10px/1.45 var(--nd-mono);
  overflow-wrap:anywhere;
}
.local-delegated-exchange__label{
  color:var(--nd-faint);
  font-size:9px;
  font-weight:650;
  letter-spacing:.09em;
  text-transform:uppercase;
}
.local-delegated-exchange pre{
  max-height:150px;
  margin:0;
  padding:9px;
  overflow:auto;
  border-radius:10px;
  background:rgba(0,0,0,.5);
  color:#d4d4d8;
  font:10px/1.55 var(--nd-mono);
  white-space:pre-wrap;
  overflow-wrap:anywhere;
}
.local-delegated-exchange__warning,
.local-delegated-exchange__clarification,
.local-delegated-exchange__rotation{
  margin:0;
  color:var(--nd-muted);
  font-size:10px;
  line-height:1.5;
}
.local-delegated-exchange__warning,.local-delegated-exchange__rotation{color:var(--nd-warning)}
.local-delegated-exchange__rotation[hidden]{display:none}
.local-delegated-exchange__copy{align-self:flex-start}
.local-delegated-exchange__binding{
  display:grid;
  grid-template-columns:minmax(0,1fr) auto;
  gap:5px 10px;
  padding:8px 9px;
  border-radius:10px;
  background:rgba(0,0,0,.28);
}
.local-delegated-exchange__binding>*{min-width:0}
.local-delegated-exchange__binding-name{color:#e4e4e7;font:10.5px/1.45 var(--nd-mono);overflow-wrap:anywhere}
.local-delegated-exchange__binding-audience,.local-delegated-exchange__binding-key{grid-column:1/-1;min-width:0;font:9px/1.45 var(--nd-mono);overflow-wrap:anywhere}
.local-delegated-exchange__binding-audience{color:#d4d4d8}
.local-delegated-exchange__binding-key{color:var(--nd-faint)}
.local-delegated-exchange__state{font-size:9.5px;font-weight:620;white-space:nowrap}
.local-delegated-exchange__state--required{color:var(--nd-warning)}
.local-delegated-exchange__state--ready{color:#fdba74}
.local-delegated-exchange__state--verified{color:var(--nd-success)}
@media (max-width:760px){
  .local-delegated-exchange__body{grid-template-columns:1fr}
}
@media (prefers-reduced-motion:reduce){
  .local-delegated-exchange__chevron{transition:none}
}
`;

export const DEVTOOLS_DELEGATED_EXCHANGE_HTML =
  '<details id="local-delegated-exchange" class="local-delegated-exchange">' +
  '<summary><span class="local-delegated-exchange__title"><span class="status-dot" aria-hidden="true"></span>' +
  '<strong>Local delegated exchange</strong><span id="local-delegated-exchange-summary" class="local-delegated-exchange__summary" aria-live="polite" aria-atomic="true">Loading status…</span></span>' +
  '<span class="local-delegated-exchange__chevron" aria-hidden="true">▸</span></summary>' +
  '<div class="local-delegated-exchange__body">' +
  '<section class="local-delegated-exchange__trust" aria-label="Development trust">' +
  '<p class="local-delegated-exchange__warning"><strong>Development only.</strong> Never trust this issuer in production.</p>' +
  '<div class="local-delegated-exchange__context" aria-label="Assertion context"><span class="local-delegated-exchange__label">Assertion context</span><div class="local-delegated-exchange__context-values"><div class="local-delegated-exchange__context-value"><span class="local-delegated-exchange__field-label">Tenant</span><code id="local-delegated-exchange-tenant"></code></div><div class="local-delegated-exchange__context-value"><span class="local-delegated-exchange__field-label">Deployment</span><code id="local-delegated-exchange-deployment"></code></div></div></div>' +
  '<p class="local-delegated-exchange__clarification">Your OIDC IdP needs no additional signing-key change.</p>' +
  '<p id="local-delegated-exchange-rotation" class="local-delegated-exchange__rotation" hidden>Issuer or key changed. Update development endpoint trust before testing again.</p>' +
  '<span class="local-delegated-exchange__label">Issuer</span><pre id="local-delegated-exchange-issuer"></pre>' +
  '<span class="local-delegated-exchange__label">Public JWKS</span><pre id="local-delegated-exchange-jwks"></pre>' +
  '<button id="local-delegated-exchange-copy" class="copy-action local-delegated-exchange__copy" type="button" disabled>' +
  '<span class="copy-action__label">Copy setup JSON</span></button>' +
  '</section>' +
  '<section class="local-delegated-exchange__bindings" aria-label="Delegated bindings">' +
  '<span class="local-delegated-exchange__label">Bindings</span>' +
  '<div id="local-delegated-exchange-bindings" aria-live="polite" aria-atomic="true"></div>' +
  '</section></div></details>';

// Plain browser script. It receives only the safe projection from the capability-protected parent route.
export const DEVTOOLS_DELEGATED_EXCHANGE_CLIENT_JS = [
  'var localDelegatedExchangeSummary=document.getElementById("local-delegated-exchange-summary"); var localDelegatedExchangeIssuer=document.getElementById("local-delegated-exchange-issuer"); var localDelegatedExchangeJwks=document.getElementById("local-delegated-exchange-jwks"); var localDelegatedExchangeTenant=document.getElementById("local-delegated-exchange-tenant"); var localDelegatedExchangeDeployment=document.getElementById("local-delegated-exchange-deployment"); var localDelegatedExchangeBindings=document.getElementById("local-delegated-exchange-bindings"); var localDelegatedExchangeRotation=document.getElementById("local-delegated-exchange-rotation"); var localDelegatedExchangeCopy=document.getElementById("local-delegated-exchange-copy");',
  'var localDelegatedExchangeStatus=null; var localDelegatedExchangeSetupJson=""; var localDelegatedExchangeFingerprint="";',
  'function localDelegatedExchangeState(status,binding){ if(!status.customerSignedIn)return {label:"Customer sign-in required",kind:"required"}; if(status.trustChanged||!binding.verified)return {label:"Local assertion ready",kind:"ready"}; return {label:"Exchange verified",kind:"verified"}; }',
  'function paintLocalDelegatedExchangeStatus(status){ var fingerprint=JSON.stringify([status.issuer,status.jwks,status.tenant,status.deployment,status.customerSignedIn,status.trustChanged,status.bindings]); if(fingerprint===localDelegatedExchangeFingerprint)return; localDelegatedExchangeFingerprint=fingerprint; localDelegatedExchangeStatus=status; localDelegatedExchangeSetupJson=JSON.stringify({issuer:status.issuer,jwks:status.jwks,assertion:{tenant:status.tenant,deployment:status.deployment,bindings:status.bindings.map(function(binding){return {connectorId:binding.connectorId,...(binding.operation===undefined?{}:{operation:binding.operation}),audience:binding.audience};})}},null,2); localDelegatedExchangeIssuer.textContent=status.issuer; localDelegatedExchangeJwks.textContent=JSON.stringify(status.jwks,null,2); localDelegatedExchangeTenant.textContent=status.tenant; localDelegatedExchangeDeployment.textContent=status.deployment; localDelegatedExchangeRotation.hidden=!status.trustChanged; localDelegatedExchangeCopy.disabled=false; while(localDelegatedExchangeBindings.firstChild)localDelegatedExchangeBindings.removeChild(localDelegatedExchangeBindings.firstChild); var verified=0; status.bindings.forEach(function(binding){ var state=localDelegatedExchangeState(status,binding); if(state.kind==="verified")verified+=1; var row=document.createElement("div"); row.className="local-delegated-exchange__binding"; var name=document.createElement("span"); name.className="local-delegated-exchange__binding-name"; name.textContent=binding.connectorId+(binding.operation?" · "+binding.operation:""); var stateView=document.createElement("span"); stateView.className="local-delegated-exchange__state local-delegated-exchange__state--"+state.kind; stateView.textContent=state.label; var audience=document.createElement("span"); audience.className="local-delegated-exchange__binding-audience"; audience.textContent=binding.audience; var key=document.createElement("span"); key.className="local-delegated-exchange__binding-key"; key.textContent=binding.bindingKey; row.appendChild(name); row.appendChild(stateView); row.appendChild(audience); row.appendChild(key); localDelegatedExchangeBindings.appendChild(row); }); localDelegatedExchangeSummary.textContent=status.customerSignedIn?verified+" of "+status.bindings.length+" verified":"Customer sign-in required"; }',
  'function refreshLocalDelegatedExchangeStatus(){ return fetch("/delegated-exchange/status",{headers:{"x-noodle-devtools-capability":RPC_CAPABILITY}}).then(function(r){if(!r.ok)throw new Error("status unavailable");return r.json();}).then(paintLocalDelegatedExchangeStatus).catch(function(){}); }',
  'localDelegatedExchangeCopy.addEventListener("click",function(){ if(localDelegatedExchangeStatus)copyText(localDelegatedExchangeSetupJson,localDelegatedExchangeCopy,"setup JSON"); });',
  'refreshLocalDelegatedExchangeStatus();',
  'setInterval(refreshLocalDelegatedExchangeStatus,2000);',
].join('\n');
