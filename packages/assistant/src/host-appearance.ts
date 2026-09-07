export interface AssistantSurfaceAppearance {
  readonly surface?: string;
  readonly text?: string;
  readonly border?: string;
}

/** Exact visual roles controlled by the embedding application, above portable server branding. */
export interface AssistantAppearanceTheme {
  readonly canvas?: string;
  readonly text?: string;
  readonly mutedText?: string;
  readonly link?: string;
  readonly focus?: string;
  readonly success?: string;
  readonly warning?: string;
  readonly danger?: string;
  readonly panel?: AssistantSurfaceAppearance;
  readonly header?: AssistantSurfaceAppearance;
  readonly assistantMessage?: AssistantSurfaceAppearance;
  readonly userMessage?: AssistantSurfaceAppearance;
  readonly composer?: AssistantSurfaceAppearance;
  readonly suggestion?: AssistantSurfaceAppearance;
  readonly confirmation?: AssistantSurfaceAppearance;
  readonly primaryButton?: AssistantSurfaceAppearance;
  readonly secondaryButton?: AssistantSurfaceAppearance;
  readonly launcher?: AssistantSurfaceAppearance;
  readonly code?: AssistantSurfaceAppearance;
  readonly app?: AssistantSurfaceAppearance;
}

export interface AssistantAppearance {
  readonly light?: AssistantAppearanceTheme;
  readonly dark?: AssistantAppearanceTheme;
}

export interface AssistantAppearanceWarning {
  readonly code: 'low_contrast';
  readonly theme: 'light' | 'dark';
  readonly role: string;
  readonly foreground: string;
  readonly background: string;
  readonly contrastRatio: number;
  readonly recommendedRatio: number;
}

const ROLE_VARIABLES = {
  canvas: '--ns-assistant-canvas',
  text: '--ns-assistant-text',
  mutedText: '--ns-assistant-muted-text',
  link: '--ns-assistant-link',
  focus: '--ns-assistant-focus',
  success: '--ns-assistant-success',
  warning: '--ns-assistant-warning',
  danger: '--ns-assistant-danger',
} as const;

const SURFACE_VARIABLES = {
  panel: '--ns-assistant-panel',
  header: '--ns-assistant-header',
  assistantMessage: '--ns-assistant-assistant-message',
  userMessage: '--ns-assistant-user-message',
  composer: '--ns-assistant-composer',
  suggestion: '--ns-assistant-suggestion',
  confirmation: '--ns-assistant-confirmation',
  primaryButton: '--ns-assistant-primary-button',
  secondaryButton: '--ns-assistant-secondary-button',
  launcher: '--ns-assistant-launcher',
  code: '--ns-assistant-code',
  app: '--ns-assistant-app',
} as const;

export function applyHostAppearance(
  style: CSSStyleDeclaration,
  appearance: AssistantAppearance | undefined,
  theme: 'light' | 'dark',
  previous: Map<string, { readonly value: string; readonly priority: string }> = new Map(),
): readonly AssistantAppearanceWarning[] {
  for (const [variable, original] of previous) {
    if (original.value) style.setProperty(variable, original.value, original.priority);
    else style.removeProperty(variable);
  }
  previous.clear();
  const selected = appearance?.[theme];
  if (!selected) return [];
  for (const [role, variable] of Object.entries(ROLE_VARIABLES)) {
    const value = selected[role as keyof typeof ROLE_VARIABLES];
    if (typeof value === 'string') setManagedProperty(style, previous, variable, value);
  }
  for (const [role, variable] of Object.entries(SURFACE_VARIABLES)) {
    const value = selected[role as keyof typeof SURFACE_VARIABLES];
    if (!value || typeof value !== 'object') continue;
    if (value.surface) setManagedProperty(style, previous, variable, value.surface);
    if (value.text) setManagedProperty(style, previous, `${variable}-text`, value.text);
    if (value.border) setManagedProperty(style, previous, `${variable}-border`, value.border);
  }
  return contrastWarnings(selected, theme);
}

function setManagedProperty(
  style: CSSStyleDeclaration,
  previous: Map<string, { readonly value: string; readonly priority: string }>,
  variable: string,
  value: string,
): void {
  previous.set(variable, {
    value: style.getPropertyValue(variable),
    priority: style.getPropertyPriority(variable),
  });
  style.setProperty(variable, value);
}

function contrastWarnings(
  theme: AssistantAppearanceTheme,
  mode: 'light' | 'dark',
): AssistantAppearanceWarning[] {
  const warnings: AssistantAppearanceWarning[] = [];
  const pairs: readonly [string, string | undefined, string | undefined][] = [
    ['panel', theme.panel?.text ?? theme.text, theme.panel?.surface ?? theme.canvas],
    ['userMessage', theme.userMessage?.text ?? theme.text, theme.userMessage?.surface],
    ['composer', theme.composer?.text ?? theme.text, theme.composer?.surface],
    ['confirmation', theme.confirmation?.text ?? theme.text, theme.confirmation?.surface],
    ['primaryButton', theme.primaryButton?.text, theme.primaryButton?.surface],
  ];
  for (const [role, foreground, background] of pairs) {
    if (!foreground || !background) continue;
    const ratio = contrastRatio(foreground, background);
    if (ratio === undefined || ratio >= 4.5) continue;
    warnings.push({
      code: 'low_contrast',
      theme: mode,
      role,
      foreground,
      background,
      contrastRatio: Math.round(ratio * 100) / 100,
      recommendedRatio: 4.5,
    });
  }
  return warnings;
}

function contrastRatio(first: string, second: string): number | undefined {
  const firstLuminance = luminance(first);
  const secondLuminance = luminance(second);
  if (firstLuminance === undefined || secondLuminance === undefined) return undefined;
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function luminance(color: string): number | undefined {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!match) return undefined;
  const values = match.slice(1).map((value) => {
    const channel = Number.parseInt(value, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (values[0] ?? 0) + 0.7152 * (values[1] ?? 0) + 0.0722 * (values[2] ?? 0);
}
