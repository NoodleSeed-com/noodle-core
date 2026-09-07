/**
 * Widget CSP origin honorability — the canonical rule shared by the compiler (author-time diagnostics
 * and the deploy gate) and mirrored by the first-party host renderer's `isSafeOrigin`
 * (apps/console/app/lib/mcp/widget-host.ts). The host silently drops any declared origin that is not
 * an absolute https:// origin (http:// only for localhost), so a widget that declares one loses the
 * access it asked for with no feedback; the compiler warns and the deploy route gates on the same
 * rule. SEP-1865's `baseUriDomains` is not a manifest field (ADR 0150); unknown csp keys never gate.
 */
import { isRecord, parseManifestDocument } from './parse-document.js';

/** The CSP domain lists the first-party host actually enforces (and therefore the ones we gate on). */
const HONORED_CSP_LISTS = ['connectDomains', 'resourceDomains', 'frameDomains'] as const;

export type CspList = (typeof HONORED_CSP_LISTS)[number];

export interface CspFault {
  /** The declaring widget's name. */
  readonly widget: string;
  /** Index of the widget in `manifest.widgets` (for a precise author-time path). */
  readonly widgetIndex: number;
  /** Which CSP domain list the origin came from. */
  readonly list: CspList;
  /** Index within that list. */
  readonly index: number;
  /** The offending origin string as declared. */
  readonly value: string;
  /** A `https://…` rewrite when the fault is a bare scheme-less host that would then be honored. */
  readonly suggestion?: string;
}

/**
 * True when `value` is an origin the first-party host renderer keeps: an absolute https:// origin, or
 * an http:// origin whose host is loopback (the narrow local-dev carve-out). Mirrors `isSafeOrigin`.
 */
export function isHonorableCspOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))
  );
}

/** A `https://<host>` rewrite when `value` is a bare host that would then be honorable, else undefined. */
function suggestHttpsOrigin(value: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return undefined; // already has a scheme — no bare-host rewrite
  const candidate = `https://${value}`;
  return isHonorableCspOrigin(candidate) ? candidate : undefined;
}

interface WidgetCspShape {
  readonly name: string;
  readonly csp?: unknown;
}

/**
 * Collect every unhonorable origin across the honored CSP lists of the given widgets. Pure and shape-
 * tolerant so it can run on Zod-parsed manifest widgets (compiler) or JSON.parsed widgets (deploy route).
 */
export function cspOriginFaults(
  widgets: readonly WidgetCspShape[] | undefined,
): readonly CspFault[] {
  const faults: CspFault[] = [];
  (widgets ?? []).forEach((widget, widgetIndex) => {
    const csp = widget?.csp;
    if (!isRecord(csp)) return;
    for (const list of HONORED_CSP_LISTS) {
      const entries = csp[list];
      if (!Array.isArray(entries)) continue;
      entries.forEach((value, index) => {
        if (typeof value !== 'string' || isHonorableCspOrigin(value)) return;
        const suggestion = suggestHttpsOrigin(value);
        faults.push({
          widget: widget.name,
          widgetIndex,
          list,
          index,
          value,
          ...(suggestion !== undefined ? { suggestion } : {}),
        });
      });
    }
  });
  return faults;
}

/**
 * Parse a manifest string (JSON or YAML — the deploy route accepts both, and JSON is valid YAML) and
 * report its widget CSP faults. Tolerant of unparseable input — the compiler owns the parse/shape
 * errors, so this returns `[]` rather than throwing. Used by the deploy route to gate a deploy on the
 * same rule the compiler warns about.
 */
export function cspFaultsInManifest(manifest: string): readonly CspFault[] {
  let parsed: unknown;
  try {
    parsed = parseManifestDocument(manifest);
  } catch {
    return [];
  }
  const widgets = isRecord(parsed) && Array.isArray(parsed.widgets) ? parsed.widgets : [];
  return cspOriginFaults(widgets as readonly WidgetCspShape[]);
}
