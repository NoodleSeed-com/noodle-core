/** Authenticated-preview UI. All OAuth credentials remain in the loopback process. */
export const DEVTOOLS_AUTH_STYLES = `
.auth-gate{
  position:absolute;
  inset:64px 0 0;
  z-index:22;
  display:none;
  align-items:center;
  justify-content:center;
  padding:28px;
  background:rgba(8,8,10,.88);
  backdrop-filter:blur(18px);
}
.auth-locked .auth-gate{display:flex}
.auth-optional.auth-prompt .auth-gate{display:flex;inset:auto 16px 16px auto;padding:0;background:none;backdrop-filter:none;max-width:calc(100% - 32px)}
.auth-cancel{display:none}
.auth-optional .auth-cancel{display:inline-flex}
.auth-locked .nd-frame-full,
.auth-locked #fs-exit{display:none!important}
.auth-card{
  display:flex;
  width:min(440px,100%);
  flex-direction:column;
  align-items:center;
  gap:12px;
  padding:30px;
  border:1px solid var(--nd-border);
  border-radius:24px;
  background:var(--nd-panel-solid);
  text-align:center;
  box-shadow:0 24px 80px rgba(0,0,0,.45);
}
.auth-card h3{margin:0;font-size:22px;font-weight:610;letter-spacing:-.03em}
.auth-card p{margin:0;color:var(--nd-muted);font-size:12.5px;line-height:1.6}
.auth-issuer{font-family:var(--nd-mono);color:#d4d4d8!important;word-break:break-all}
.auth-issuer[hidden]{display:none}
.auth-provider{
  display:grid;
  width:min(320px,100%);
  gap:6px;
  text-align:left;
}
.auth-provider[hidden]{display:none}
.auth-provider label{color:var(--nd-muted);font-size:10.5px}
.auth-provider select{
  width:100%;
  padding:9px 30px 9px 10px;
  border:1px solid var(--nd-border);
  border-radius:9px;
  background:var(--nd-panel);
  color:var(--nd-text);
  font:11px var(--nd-mono);
}
.auth-provider select:disabled{cursor:wait;opacity:.7}
.auth-detail{min-height:16px;color:var(--nd-faint)!important;font-size:10.5px!important}
.auth-detail.err{color:var(--nd-error)!important}
.auth-card .btn{
  min-width:164px;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  gap:8px;
}
.auth-card .btn.is-loading::before{
  width:12px;
  height:12px;
  border:2px solid currentColor;
  border-right-color:transparent;
  border-radius:50%;
  content:"";
  animation:auth-button-spin .7s linear infinite;
}
@keyframes auth-button-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){
  .auth-card .btn.is-loading::before{animation-duration:1.4s}
}
.auth-session{
  display:none;
  align-items:center;
  gap:7px;
  margin-left:auto;
  color:var(--nd-muted);
  font-size:10.5px;
}
.auth-session.on{display:flex}
.auth-session button{
  padding:5px 8px;
  border:0;
  background:transparent;
  color:var(--nd-faint);
  font-size:10px;
  cursor:pointer;
}
.auth-session button:hover{color:var(--nd-text)}
.auth-session .status-dot{width:6px;height:6px}
.auth-required .brand__url{display:none}
`;

export const DEVTOOLS_AUTH_GATE_HTML =
  '<div id="auth-gate" class="auth-gate" aria-live="polite">' +
  '<div class="auth-card">' +
  '<h3>Sign in to test</h3>' +
  '<p id="auth-explanation">This MCP app requires a customer account. Your token stays in this local Devtools process.</p>' +
  '<p id="auth-issuer" class="auth-issuer"></p>' +
  '<div id="auth-provider" class="auth-provider" hidden>' +
  '<label for="auth-issuer-choice">Identity provider</label>' +
  '<select id="auth-issuer-choice"></select>' +
  '</div>' +
  '<button id="auth-sign-in" class="btn primary-action" type="button" disabled>Sign in</button>' +
  '<button id="auth-cancel" class="btn auth-cancel" type="button">Continue without signing in</button>' +
  '<p id="auth-detail" class="auth-detail"></p>' +
  '</div></div>';

export const DEVTOOLS_AUTH_SESSION_HTML =
  '<div id="auth-session" class="auth-session">' +
  '<span class="status-dot" aria-hidden="true"></span>' +
  '<span id="auth-session-label">Signed in</span>' +
  '<button id="auth-logout" type="button">Sign out</button>' +
  '</div>';

// Plain browser script; it intentionally receives only safe `/auth/status` fields.
export const DEVTOOLS_AUTH_CLIENT_JS = [
  'var authGate=document.getElementById("auth-gate"); var authSignIn=document.getElementById("auth-sign-in"); var authIssuer=document.getElementById("auth-issuer"); var authProvider=document.getElementById("auth-provider"); var authIssuerChoice=document.getElementById("auth-issuer-choice"); var authDetail=document.getElementById("auth-detail");',
  'var authSessionView=document.getElementById("auth-session"); var authSessionLabel=document.getElementById("auth-session-label"); var authLogout=document.getElementById("auth-logout");',
  'var authWasSignedIn=false; var authWasAuthorizing=false; var authStarting=false; var authOptional=document.body.classList.contains("auth-optional"); var authPending=[];',
  'if(authOptional) document.getElementById("auth-explanation").textContent="This action needs a customer account. You can keep using anonymous tools without signing in.";',
  'function settleAuthRequests(ok){ var pending=authPending; authPending=[]; pending.forEach(function(entry){clearTimeout(entry.timer);entry.resolve(ok);}); document.body.classList.remove("auth-prompt"); }',
  'function requestCustomerSignIn(){ if(authPending.length>=32)return Promise.resolve(false); document.body.classList.add("auth-prompt"); refreshAuthStatus(); authSignIn.focus(); return new Promise(function(resolve){var entry={resolve:resolve,timer:setTimeout(function(){var index=authPending.indexOf(entry);if(index<0)return;authPending.splice(index,1);resolve(false);if(!authPending.length)document.body.classList.remove("auth-prompt");},300000)};authPending.push(entry);}); }',
  'document.getElementById("auth-cancel").addEventListener("click",function(){ authStarting=false; settleAuthRequests(false); authRequest("/auth/logout",{method:"POST"}).then(refreshAuthStatus); });',
  'function authRequest(path,options){ var init=options||{}; init.headers=hostHeaders(Boolean(init.body)); return fetch(path,init); }',
  'function authIssuerLabel(value){ try{ return new URL(value).host; }catch(e){ return value||""; } }',
  'function authMethodLabel(status){ return status&&status.method==="firebase"?"Firebase":status&&status.method==="microsoft"?"Microsoft":""; }',
  'function syncAuthIssuers(status){ var issuers=status&&Array.isArray(status.issuers)?status.issuers.filter(function(value){return typeof value==="string";}):[]; var current=authIssuerChoice.value; var options=Array.from(authIssuerChoice.options).map(function(option){return option.value;}); var changed=options.length!==issuers.length||options.some(function(value,index){return value!==issuers[index];}); if(changed){ while(authIssuerChoice.firstChild) authIssuerChoice.removeChild(authIssuerChoice.firstChild); issuers.forEach(function(issuer){ var option=document.createElement("option"); option.value=issuer; option.textContent=authIssuerLabel(issuer); authIssuerChoice.appendChild(option); }); } var statusOwnsChoice=status&&(status.state==="authorizing"||status.state==="signed_in"||status.state==="reauthorization_required"); var selected=statusOwnsChoice&&issuers.includes(status.issuer)?status.issuer:issuers.includes(current)?current:issuers.includes(status&&status.issuer)?status.issuer:issuers[0]||""; authIssuerChoice.value=selected; authProvider.hidden=issuers.length<2; authIssuer.hidden=issuers.length>1; authIssuer.textContent=authIssuerLabel((status&&status.issuer)||issuers[0]); }',
  'function paintAuthStatus(status){ var failedAttempt=(authWasAuthorizing||authStarting)&&status&&(status.state==="error"||status.state==="unsupported"); authWasAuthorizing=Boolean(status&&status.state==="authorizing"); if(failedAttempt)settleAuthRequests(false); if(status&&status.signInRequested) document.body.classList.add("auth-prompt"); var signedIn=status&&status.state==="signed_in"; var becameSignedIn=signedIn&&!authWasSignedIn; var becameSignedOut=!signedIn&&authWasSignedIn; if(status&&status.state!=="signed_out"&&status.state!=="authorizing") authStarting=false; var authBusy=Boolean(authStarting||(status&&status.state==="authorizing")); authWasSignedIn=Boolean(signedIn); document.body.classList.toggle("auth-locked",!signedIn&&!authOptional); if(!signedIn&&!authOptional&&typeof exitFullscreen==="function")exitFullscreen(); authSessionView.classList.toggle("on",signedIn||authOptional); authLogout.textContent=signedIn?"Sign out":"Sign in"; syncAuthIssuers(status); var scopes=(status&&status.scopes)||[]; var signedInIssuer=authIssuerLabel(status&&status.issuer); var methodLabel=authMethodLabel(status); authSessionLabel.textContent=!signedIn?"Using anonymous tools":(signedInIssuer?"Signed in · "+signedInIssuer:"Signed in")+(scopes.length?" · "+scopes.join(" "):""); authDetail.className="auth-detail"+(status&&(status.state==="error"||status.state==="unsupported")?" err":""); var statusMessage=(status&&status.message)||""; authDetail.textContent=(status&&status.errorCode?status.errorCode+": ":"")+statusMessage||(status&&status.state==="authorizing"?"Finish signing in in the new window.":status&&status.state==="reauthorization_required"?"Additional permission is required. Sign in again.":""); authSignIn.disabled=Boolean(authBusy||(status&&!status.supported)); authIssuerChoice.disabled=authBusy; authSignIn.classList.toggle("is-loading",authBusy); authSignIn.setAttribute("aria-busy",authBusy?"true":"false"); authSignIn.textContent=authBusy?(status&&status.state==="authorizing"?"Waiting for sign-in…":"Starting sign-in…"):status&&status.state==="error"?"Try sign-in again":status&&status.state==="reauthorization_required"?"Continue sign-in":methodLabel?"Sign in with "+methodLabel:"Sign in"; if(becameSignedIn) settleAuthRequests(true); if((becameSignedIn||becameSignedOut)&&typeof refreshTools==="function") refreshTools(); }',
  'function refreshAuthStatus(){ return authRequest("/auth/status").then(function(r){return r.json();}).then(paintAuthStatus).catch(function(){ authDetail.className="auth-detail err"; authDetail.textContent="Could not reach the local Devtools auth host."; }); }',
  'authSignIn.addEventListener("click",function(){ if(authSignIn.disabled)return; if(authStarting)return; authStarting=true; var selectedIssuer=authIssuerChoice.value; var startPath="/auth/start"+(selectedIssuer?"?issuer="+encodeURIComponent(selectedIssuer):""); var popup=window.open("","noodle-devtools-auth","popup,width=540,height=720"); authSignIn.disabled=true; authIssuerChoice.disabled=true; authSignIn.classList.add("is-loading"); authSignIn.setAttribute("aria-busy","true"); authSignIn.textContent="Starting sign-in…"; authDetail.className="auth-detail"; authDetail.textContent="Starting sign-in…"; authRequest(startPath,{method:"POST"}).then(function(r){return r.json().then(function(j){return {ok:r.ok,body:j};});}).then(function(result){ if(!result.ok||!result.body.authorizationUrl) throw new Error((result.body.error&&result.body.error.message)||"Could not start sign-in"); if(popup) popup.location.href=result.body.authorizationUrl; else window.open(result.body.authorizationUrl,"_blank","noopener"); paintAuthStatus({state:"authorizing",supported:true,issuer:result.body.issuer,issuers:result.body.issuers||[],method:result.body.method,scopes:result.body.scopes||[]}); }).catch(function(error){ settleAuthRequests(false); authStarting=false; if(popup) popup.close(); authSignIn.disabled=false; authIssuerChoice.disabled=false; authSignIn.classList.remove("is-loading"); authSignIn.setAttribute("aria-busy","false"); authSignIn.textContent="Sign in"; authDetail.className="auth-detail err"; authDetail.textContent=error&&error.message||"Could not start sign-in."; }); });',
  'authLogout.addEventListener("click",function(){ if(authOptional&&!authWasSignedIn){requestCustomerSignIn();return;} settleAuthRequests(false); authRequest("/auth/logout",{method:"POST"}).then(refreshAuthStatus).catch(refreshAuthStatus); });',
  'window.addEventListener("message",function(ev){ var callbackUrl; try{callbackUrl=new URL(ev.origin);}catch(e){return;} var sameLoopbackPort=callbackUrl.protocol===window.location.protocol&&callbackUrl.port===window.location.port&&callbackUrl.hostname==="localhost"&&window.location.hostname==="127.0.0.1"; if((ev.origin!==window.location.origin&&!sameLoopbackPort)||!ev.data||ev.data.type!=="noodle:auth-complete") return; refreshAuthStatus(); });',
  'refreshAuthStatus();',
  'setInterval(refreshAuthStatus,2000);',
].join('\n');
