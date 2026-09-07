import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadEmbedScript } from '@noodle-borg/assistant-gateway/portable';

/**
 * `GET /v1/assistant/embed.js` — the one line a marketing page pastes.
 *
 * Static, secret-free, and unauthenticated by design, exactly like the widget sandbox document: the
 * script contains no tenant material, and the embed id that selects a tenant travels as a `data-`
 * attribute on the customer's own page. Serving it from the service origin is what lets the pasted
 * snippet derive its service URL from its own `src`, so one snippet works in every environment.
 *
 * Long, immutable caching with a content ETag: the bundle changes only when the service image does, and
 * a redeploy that did not change it keeps every visitor's cache warm.
 */
export function handleAssistantEmbedScript(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET, HEAD');
    res.end();
    return;
  }
  const loaded = loadEmbedScript();
  if (!loaded.ok) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(loaded.reason);
    return;
  }
  const { bytes, etag } = loaded.script;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  // Any page may load it: which origins may actually *talk* to the assistant is decided at mint time
  // against the surface's allowlist, never by who was allowed to download the script.
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
  res.setHeader('Content-Length', String(bytes.byteLength));
  res.end(req.method === 'HEAD' ? undefined : bytes);
}
