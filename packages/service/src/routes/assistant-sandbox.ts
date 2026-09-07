import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Hosted widget sandbox document (ADR 0151 addendum). The embedded assistant renders MCP App
 * widgets in a double iframe; when the outer frame is an `about:srcdoc` document it inherits the
 * customer page's CSP, so a strict `script-src` silently blanks every widget. Serving this relay
 * document from the service origin gives it — and the inner `srcdoc` widget document that inherits
 * from it — a CSP the platform controls. The body is pinned byte-for-byte to
 * `contract/v1/assistant-sandbox-document.html` and to the published client's srcdoc fallback; any
 * relay-protocol change is a coordinated contract event, never a local edit.
 */
const ASSISTANT_SANDBOX_DOCUMENT = `<!doctype html><meta charset="utf-8"><style>html,body,iframe{border:0;margin:0;width:100%;height:100%;overflow:hidden}body{background:transparent}</style><script>
let inner;
const ready={jsonrpc:'2.0',method:'ui/notifications/sandbox-proxy-ready',params:{}};
// Re-announce until the host acknowledges with the resource: when this document is hosted
// cross-origin, the first announcement can arrive before the host's load handler is listening.
const announce=setInterval(()=>parent.postMessage(ready,'*'),120);
setTimeout(()=>clearInterval(announce),15000);
addEventListener('message',(event)=>{
  if(event.source===parent){
    const message=event.data;
    if(message?.method==='ui/notifications/sandbox-resource-ready'){
      clearInterval(announce);
      if(inner)return;
      inner=document.createElement('iframe');
      inner.setAttribute('sandbox',message.params?.sandbox||'allow-scripts');
      inner.setAttribute('referrerpolicy','no-referrer');
      inner.srcdoc=String(message.params?.html||'');
      document.body.replaceChildren(inner);
      return;
    }
    inner?.contentWindow?.postMessage(message,'*');
  } else if(inner && event.source===inner.contentWindow) {
    parent.postMessage(event.data,'*');
  }
});
parent.postMessage(ready,'*');
</script>`;

/**
 * The sandbox document's own CSP. `sandbox allow-scripts` forces an opaque origin server-side even
 * if a future embedder frames the URL without a sandbox attribute (the document can never read
 * service cookies or storage); inline script/style must be allowed because the relay script and the
 * inner widget document's injected bridge are inline by design; everything else stays closed —
 * widget data flows only over the postMessage bridge, never direct fetch.
 */
const SANDBOX_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data: blob:; font-src https: data:; frame-src about:; form-action 'none'; base-uri 'none'; frame-ancestors *";

/** Serve the static, secret-free sandbox document. GET-only; cacheable despite the no-store baseline. */
export function handleAssistantSandbox(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', SANDBOX_CSP);
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.end(ASSISTANT_SANDBOX_DOCUMENT);
}
