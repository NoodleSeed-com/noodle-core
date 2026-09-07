/** Raw HTML is the low-level escape hatch; React build output has a separate, larger budget. */
export const MAX_RAW_WIDGET_HTML_BYTES = 256 * 1024;

/** Performance guidance only: larger compiled widgets remain valid through the hard ceiling. */
export const RECOMMENDED_COMPILED_WIDGET_HTML_BYTES = 1024 * 1024;

/** Hard per-widget ceiling for the final UTF-8 HTML resource stored in the runtime artifact. */
export const MAX_COMPILED_WIDGET_HTML_BYTES = 10 * 1024 * 1024;

/** Hard aggregate ceiling for final UTF-8 widget HTML stored by one deployment. */
export const MAX_TOTAL_WIDGET_HTML_BYTES = 20 * 1024 * 1024;

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}
