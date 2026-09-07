import type { WidgetUiMeta } from './artifact/types.js';

export function withAssetResourceDomain(
  uiMeta: WidgetUiMeta | undefined,
  assetOrigin: string | undefined,
): WidgetUiMeta | undefined {
  if (assetOrigin === undefined) return uiMeta;
  const existing = uiMeta?.csp?.resourceDomains ?? [];
  const resourceDomains = [...new Set([...existing, assetOrigin])];
  return {
    ...(uiMeta ?? {}),
    csp: {
      ...(uiMeta?.csp ?? {}),
      resourceDomains,
    },
  };
}

export function openAiWidgetCsp(
  uiMeta: WidgetUiMeta | undefined,
  redirectDomains: readonly string[] = [],
):
  | {
      resource_domains?: string[];
      connect_domains?: string[];
      frame_domains?: string[];
      redirect_domains?: string[];
    }
  | undefined {
  const resourceDomains = uiMeta?.csp?.resourceDomains ?? [];
  const connectDomains = uiMeta?.csp?.connectDomains ?? [];
  const frameDomains = uiMeta?.csp?.frameDomains ?? [];
  const csp = {
    ...(resourceDomains.length > 0 ? { resource_domains: [...new Set(resourceDomains)] } : {}),
    ...(connectDomains.length > 0 ? { connect_domains: [...new Set(connectDomains)] } : {}),
    ...(frameDomains.length > 0 ? { frame_domains: [...new Set(frameDomains)] } : {}),
    // `_meta.ui.csp` has no redirect concept; `redirect_domains` on the legacy key is what lets
    // ChatGPT open `openExternal` targets without the safe-link warning. Derived from the app's
    // `handoff.allowedDomains` so external-link targets are declared exactly once.
    ...(redirectDomains.length > 0 ? { redirect_domains: [...new Set(redirectDomains)] } : {}),
  };
  return Object.keys(csp).length > 0 ? csp : undefined;
}
