import {
  type WidgetUiBranding,
  type WidgetUiPolicy,
  widgetRuntimeConfigHtml,
} from '@noodle-borg/brand-kit';
import type { WidgetUiMeta } from './artifact/types.js';
import type { Manifest } from './manifest/schema.js';

/** The canonical `ui://` URI for a widget: `ui://<server>/<widget>` (a fixed, non-template resource). */
export function widgetUri(serverName: string, widgetName: string): string {
  return `ui://${serverName}/${widgetName}`;
}

export function widgetHtml(
  widget: NonNullable<Manifest['widgets']>[number],
  options: { readonly branding?: WidgetUiBranding; readonly policy?: WidgetUiPolicy } = {},
): string {
  if (widget.html !== undefined)
    return injectRuntimeConfig(widget.html, widgetRuntimeConfigHtml(options));
  if (widget.view !== undefined)
    return injectRuntimeConfig(reactViewHtml(widget), widgetRuntimeConfigHtml(options));
  return '';
}

function injectRuntimeConfig(html: string, config: string): string {
  if (!config) return html;
  if (html.includes('data-noodle-policy')) return html;
  const idx = html.toLowerCase().indexOf('<body');
  if (idx === -1) return `${config}${html}`;
  const end = html.indexOf('>', idx);
  if (end === -1) return `${config}${html}`;
  return `${html.slice(0, end + 1)}${config}${html.slice(end + 1)}`;
}

/**
 * The widget UI resource's `_meta.ui` value — its host-enforced CSP/permission metadata — or `undefined`
 * when the widget declares neither, so a metadata-free widget stays `_meta`-free on the wire.
 */
export function resourceUiMeta(
  widget: NonNullable<Manifest['widgets']>[number],
): WidgetUiMeta | undefined {
  const csp = widget.csp;
  const hasCsp = csp !== undefined && Object.values(csp).some((v) => v !== undefined);
  const permissions = widget.permissions;
  const hasPermissions = permissions !== undefined && Object.keys(permissions).length > 0;
  const prefersBorder = widget.view !== undefined ? false : undefined;
  const cleanPermissions =
    permissions === undefined ? undefined : cleanPermissionRecord(permissions);
  if (!hasCsp && !hasPermissions && prefersBorder === undefined && widget.domain === undefined) {
    return undefined;
  }
  return {
    ...(csp && hasCsp ? { csp } : {}),
    ...(widget.domain !== undefined ? { domain: widget.domain } : {}),
    ...(cleanPermissions && Object.keys(cleanPermissions).length > 0
      ? { permissions: cleanPermissions }
      : {}),
    ...(prefersBorder !== undefined ? { prefersBorder } : {}),
  };
}

function reactViewHtml(widget: NonNullable<Manifest['widgets']>[number]): string {
  const view = widget.view;
  if (view === undefined) return '';
  if (view.compiledHtml !== undefined) return view.compiledHtml;
  const title = escapeHtml(widget.title ?? view.component);
  const component = escapeHtml(view.component);
  const entry =
    view.entry === undefined ? '' : ` data-noodle-react-entry="${escapeHtml(view.entry)}"`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><main id="noodle-react-root" data-noodle-react-view="${component}"${entry}></main><noscript>This React widget requires JavaScript in the host iframe.</noscript></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function cleanPermissionRecord(
  value: Readonly<Record<string, Readonly<Record<string, never>> | undefined>>,
): Record<string, Record<string, never>> {
  const out: Record<string, Record<string, never>> = {};
  for (const [key, enabled] of Object.entries(value)) {
    if (enabled !== undefined) out[key] = {};
  }
  return out;
}
