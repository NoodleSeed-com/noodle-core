import { MCP_APP_MIME_TYPE } from '@noodle-borg/compiler';
import { WIDGET_BOOTSTRAP_SOURCE } from './bootstrap.js';
import { EXT_APPS_BUNDLE } from './ext-apps-bundle.js';

/**
 * Serve-time injection of the MCP Apps client bridge into a widget's HTML body.
 *
 * A host (Claude/ChatGPT) renders a widget's `ui://` resource in a sandboxed iframe, but keeps the frame
 * **blank** until the widget connects over the `ui/*` bridge — and the iframe CSP blocks CDN script fetches,
 * so the bridge client must be **inlined**. We add the vendored `@modelcontextprotocol/ext-apps` bundle plus
 * the widget runtime bootstrap (`./bootstrap.ts`) here, at serve time, as **shared runtime infrastructure**:
 * it is not stored per artifact and is not counted against the author's widget-`html` size budget. The author
 * writes static HTML (with `data-bind*`/`data-action` attributes); the runtime supplies the bridge, host
 * theming, auto-resize, the live tool result/input, and UI-initiated actions. See
 * docs/decisions/0022-adopt-mcp-ui-for-apps-widgets.md (W2 / W2.5).
 */

/** `</script>` inside the minified bundle would close the host `<script>` tag early — neutralize it once. */
const SAFE_BUNDLE = EXT_APPS_BUNDLE.replace(/<\/(script)/gi, '<\\/$1');

/** The injected bridge: the ext-apps bundle + the widget runtime bootstrap, as one inline module script. */
const BRIDGE_SCRIPT = `<script type="module">\n${SAFE_BUNDLE}\n${WIDGET_BOOTSTRAP_SOURCE}\n</script>`;

/**
 * Inject the MCP Apps client bridge into a widget body, gated strictly on the
 * `text/html;profile=mcp-app` mime type. No-op for every other content type, and idempotent (a body that
 * already inlines the bundle is returned unchanged). The script is added before `</body>` when present, else
 * appended.
 */
export function injectWidgetBridge(mimeType: string | undefined, html: string): string {
  if (mimeType !== MCP_APP_MIME_TYPE) return html;
  if (html.includes('globalThis.ExtApps')) return html;
  const idx = html.toLowerCase().lastIndexOf('</body>');
  return idx === -1
    ? `${html}\n${BRIDGE_SCRIPT}`
    : `${html.slice(0, idx)}${BRIDGE_SCRIPT}\n${html.slice(idx)}`;
}
