import type { WidgetUiBranding } from '@noodle-borg/brand-kit';
import type { CompileError } from './errors.js';
import type { Manifest } from './manifest/schema.js';
import { widgetHtml } from './widget-emit.js';
import {
  MAX_COMPILED_WIDGET_HTML_BYTES,
  MAX_RAW_WIDGET_HTML_BYTES,
  MAX_TOTAL_WIDGET_HTML_BYTES,
  utf8ByteLength,
} from './widget-limits.js';

export function widgetHtmlSizeErrors(
  manifest: Manifest,
  branding: WidgetUiBranding | undefined,
): CompileError[] {
  const errors: CompileError[] = [];
  let totalBytes = 0;
  for (const [index, widget] of (manifest.widgets ?? []).entries()) {
    if (widget.html !== undefined) {
      const rawBytes = utf8ByteLength(widget.html);
      if (rawBytes > MAX_RAW_WIDGET_HTML_BYTES) {
        errors.push({
          code: 'widget_html_too_large',
          path: `widgets.${index}.html`,
          message: `widget "${widget.name}" raw HTML is ${rawBytes} UTF-8 bytes; the limit is ${MAX_RAW_WIDGET_HTML_BYTES} bytes`,
        });
      }
    }

    const emittedHtml = widgetHtml(widget, {
      ...(branding !== undefined ? { branding } : {}),
      ...(manifest.handoff !== undefined ? { policy: { handoff: manifest.handoff } } : {}),
    });
    const emittedBytes = utf8ByteLength(emittedHtml);
    totalBytes += emittedBytes;
    if (widget.view?.compiledHtml !== undefined && emittedBytes > MAX_COMPILED_WIDGET_HTML_BYTES) {
      errors.push({
        code: 'widget_html_too_large',
        path: `widgets.${index}.view.compiledHtml`,
        message: `widget "${widget.name}" compiled HTML is ${emittedBytes} UTF-8 bytes; the limit is ${MAX_COMPILED_WIDGET_HTML_BYTES} bytes`,
      });
    }
  }

  if (totalBytes > MAX_TOTAL_WIDGET_HTML_BYTES) {
    errors.push({
      code: 'widget_html_total_too_large',
      path: 'widgets',
      message: `compiled widget HTML totals ${totalBytes} UTF-8 bytes; the deployment limit is ${MAX_TOTAL_WIDGET_HTML_BYTES} bytes`,
    });
  }
  return errors;
}
