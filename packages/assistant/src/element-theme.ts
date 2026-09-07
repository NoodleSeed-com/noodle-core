import type { ResolvedAssistantAppearance } from './appearance.js';
import { camelToKebab, tokenValue } from './element-helpers.js';
import type { ResolvedAssistantThemeMode } from './element-theme-resolution.js';
import {
  type AssistantAppearance,
  type AssistantAppearanceWarning,
  applyHostAppearance,
} from './host-appearance.js';
import { type AssistantSessionVisualState, syncAssistantPresentation } from './presentation.js';

export function applyAssistantElementTheme(input: {
  readonly host: HTMLElement;
  readonly root: ShadowRoot | null;
  readonly appearance: ResolvedAssistantAppearance;
  readonly hostAppearance: AssistantAppearance | undefined;
  readonly mode: ResolvedAssistantThemeMode;
  readonly sessionState: AssistantSessionVisualState;
  readonly styleSnapshot: Map<string, { readonly value: string; readonly priority: string }>;
}): readonly AssistantAppearanceWarning[] {
  const { host, root, appearance, mode } = input;
  host.setAttribute('data-theme', mode);
  for (const [name, value] of Object.entries(appearance.theme[mode])) {
    host.style.setProperty(`--ns-assistant-default-${camelToKebab(name)}`, tokenValue(name, value));
  }
  const warnings = applyHostAppearance(host.style, input.hostAppearance, mode, input.styleSnapshot);
  host.style.setProperty('--ns-assistant-default-panel-width', `${appearance.layout.panelWidth}px`);
  host.style.setProperty(
    '--ns-assistant-default-min-height',
    `${appearance.layout.panelMinHeight}px`,
  );
  host.style.setProperty(
    '--ns-assistant-default-max-height',
    `${appearance.layout.panelMaxHeight}px`,
  );
  host.style.setProperty('--ns-assistant-default-z-index', String(appearance.layout.zIndex));
  host.style.setProperty('--ns-assistant-default-edge-offset', `${appearance.layout.edgeOffset}px`);
  const logo = root?.querySelector<HTMLImageElement>('.brand-logo');
  const logoUrl = appearance.brand.logo[mode];
  if (logo) {
    logo.hidden = !logoUrl;
    if (logoUrl) logo.src = logoUrl;
  }
  if (root) syncAssistantPresentation(host, root, appearance, mode, input.sessionState);
  return warnings;
}
