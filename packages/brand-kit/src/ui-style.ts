export interface WidgetUiBranding {
  readonly name?: string | undefined;
  readonly accent?: string | undefined;
  readonly surface?: string | undefined;
  readonly surfaceDark?: string | undefined;
  readonly logo?: BrandAsset | undefined;
  readonly mark?: BrandAsset | undefined;
  readonly avatar?: BrandAsset | undefined;
  readonly theme?:
    | {
        readonly light?: BrandThemeOverrides | undefined;
        readonly dark?: BrandThemeOverrides | undefined;
      }
    | undefined;
  readonly radius?: 'none' | 'sm' | 'md' | 'lg' | undefined;
  readonly density?: 'compact' | 'comfortable' | undefined;
  readonly typography?: 'system' | 'serif' | 'mono' | undefined;
  readonly colorScheme?: 'auto' | 'light' | 'dark' | undefined;
}

interface BrandAsset {
  readonly uri: string;
  readonly darkUri?: string | undefined;
  readonly alt: string;
}

interface BrandThemeOverrides {
  readonly surface?: string | undefined;
  readonly surfaceRaised?: string | undefined;
  readonly surfaceMuted?: string | undefined;
  readonly text?: string | undefined;
  readonly textMuted?: string | undefined;
  readonly accent?: string | undefined;
  readonly accentText?: string | undefined;
  readonly link?: string | undefined;
  readonly border?: string | undefined;
  readonly borderStrong?: string | undefined;
  readonly focus?: string | undefined;
  readonly success?: string | undefined;
  readonly warning?: string | undefined;
  readonly danger?: string | undefined;
  readonly code?: string | undefined;
}

export interface WidgetUiPolicy {
  readonly handoff?: { readonly allowedDomains: readonly string[] } | undefined;
}

export function widgetRuntimeConfigHtml(options: {
  readonly branding?: WidgetUiBranding;
  readonly policy?: WidgetUiPolicy;
}): string {
  const config: { branding?: WidgetUiBranding; handoff?: WidgetUiPolicy['handoff'] } = {};
  if (options.branding) config.branding = options.branding;
  if (options.policy?.handoff) config.handoff = options.policy.handoff;
  if (Object.keys(config).length === 0) return '';
  return `<script type="application/json" data-noodle-policy>${escapeHtml(JSON.stringify(config))}</script>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
