export type AssistantThemeMode = 'auto' | 'light' | 'dark' | 'invert';
type AssistantLayoutMode = 'floating' | 'inline' | 'drawer';
type AssistantPosition = 'bottom-left' | 'bottom-center' | 'bottom-right';
export type AssistantPresentationTone = 'neutral' | 'success' | 'warning' | 'danger';

interface AssistantPresentationConfiguration {
  readonly panel?: {
    readonly surface?: 'solid' | 'glass';
    readonly elevation?: 'soft' | 'dramatic';
    readonly border?: 'subtle' | 'strong';
    readonly radius?: number;
  };
  readonly launcher?: {
    readonly style?: 'pill' | 'bubble';
    readonly icon?: 'brand-mark' | 'chat' | 'none';
    readonly size?: 'md' | 'lg';
    readonly status?: 'none' | 'session';
    readonly effect?: 'none' | 'pulse';
  };
  readonly header?: {
    readonly mark?: 'none' | 'brand-mark' | 'status';
    readonly badge?: {
      readonly text: string;
      readonly tone?: AssistantPresentationTone;
      readonly indicator?: boolean;
    };
  };
  readonly composer?: {
    readonly leadingIcon?: 'none' | 'brand-mark';
    readonly sendIcon?: 'arrow-up' | 'paper-plane';
    readonly shape?: 'rounded' | 'pill';
  };
  readonly messages?: {
    readonly userStyle?: 'bubble' | 'accent';
    readonly assistantStyle?: 'plain' | 'bubble';
  };
}

export interface AssistantThemeTokens {
  readonly page: string;
  readonly panel: string;
  readonly elevated: string;
  readonly input: string;
  readonly hover: string;
  readonly selected: string;
  readonly text: string;
  readonly mutedText: string;
  readonly accent: string;
  readonly accentText: string;
  readonly link: string;
  readonly divider: string;
  readonly focus: string;
  readonly success: string;
  readonly warning: string;
  readonly danger: string;
  readonly overlay: string;
  readonly code: string;
  readonly widgetFrame: string;
  readonly fontFamily: string;
  readonly monoFontFamily: string;
  readonly baseFontSize: number;
  readonly messageFontSize: number;
  readonly lineHeight: number;
  readonly panelRadius: number;
  readonly cardRadius: number;
  readonly inputRadius: number;
  readonly buttonRadius: number;
  readonly launcherRadius: number;
  readonly spacing: number;
  readonly shadow: string;
  readonly backdropBlur: number;
  readonly motionScale: number;
}

export interface AssistantConfiguration {
  readonly branding?: {
    readonly name?: string;
    readonly accent?: string;
    readonly surface?: string;
    readonly surfaceDark?: string;
    readonly logo?: AssistantBrandAsset;
    readonly mark?: AssistantBrandAsset;
    readonly avatar?: AssistantBrandAsset;
    readonly theme?: {
      readonly light?: BrandThemeOverrides;
      readonly dark?: BrandThemeOverrides;
    };
    readonly radius?: 'none' | 'sm' | 'md' | 'lg';
    readonly density?: 'compact' | 'comfortable';
    readonly typography?: 'system' | 'serif' | 'mono';
    readonly colorScheme?: Exclude<AssistantThemeMode, 'invert'>;
  };
  readonly assistant?: AssistantUiConfiguration;
}

interface AssistantBrandAsset {
  readonly uri: string;
  readonly darkUri?: string;
  readonly alt: string;
}

interface BrandThemeOverrides {
  readonly surface?: string;
  readonly surfaceRaised?: string;
  readonly surfaceMuted?: string;
  readonly text?: string;
  readonly textMuted?: string;
  readonly accent?: string;
  readonly accentText?: string;
  readonly link?: string;
  readonly border?: string;
  readonly borderStrong?: string;
  readonly focus?: string;
  readonly success?: string;
  readonly warning?: string;
  readonly danger?: string;
  readonly code?: string;
}

interface AssistantUiConfiguration {
  readonly theme?: AssistantThemeMode;
  readonly layout?: {
    readonly mode?: AssistantLayoutMode;
    readonly position?: AssistantPosition;
    readonly panelWidth?: number;
    readonly panelMinHeight?: number;
    readonly panelMaxHeight?: number;
    readonly edgeOffset?: number;
    readonly zIndex?: number;
    readonly density?: 'compact' | 'comfortable';
    readonly mobileFullscreen?: boolean;
  };
  readonly behavior?: {
    readonly startOpen?: boolean;
    readonly closeOnEscape?: boolean;
    readonly closeOnOutsideClick?: boolean;
    readonly showLauncher?: boolean;
    readonly showHeader?: boolean;
    readonly showAvatars?: boolean;
    readonly showTimestamps?: boolean;
    readonly showPoweredBy?: boolean;
    readonly showConfirmationDetails?: boolean;
  };
  readonly labels?: Partial<AssistantLabels>;
  readonly presentation?: AssistantPresentationConfiguration;
  readonly suggestedPrompts?: readonly string[];
  readonly privacyUrl?: string;
  readonly termsUrl?: string;
  readonly locale?: string;
  readonly direction?: 'ltr' | 'rtl' | 'auto';
  /** Opt in to projecting this session's governed tools to the browser's agent (ADR 0220). */
  readonly webmcp?: { readonly enabled?: boolean };
}

export interface AssistantLabels {
  readonly welcomeHeading: string;
  readonly welcomeMessage: string;
  readonly launcherPlaceholder: string;
  readonly composerPlaceholder: string;
  readonly thinking: string;
  readonly send: string;
  readonly stop: string;
  readonly close: string;
  readonly open: string;
  readonly confirm: string;
  readonly decline: string;
  readonly cancel: string;
  readonly confirmationHeading: string;
  readonly additionalDetails: string;
  readonly redacted: string;
  readonly completed: string;
  readonly stopped: string;
  readonly copy: string;
  readonly newMessages: string;
  readonly reconnect: string;
  readonly newConversation: string;
  readonly retry: string;
  readonly unavailable: string;
  readonly sessionExpired: string;
  readonly sessionIdle: string;
  readonly sessionLoading: string;
  readonly sessionReady: string;
  readonly sessionError: string;
  readonly signInHeading: string;
  readonly signInBody: string;
  readonly signInAction: string;
  readonly signUpAction: string;
}

interface ResolvedAssistantPresentation {
  readonly panel: {
    readonly surface: 'solid' | 'glass';
    readonly elevation: 'soft' | 'dramatic';
    readonly border: 'subtle' | 'strong';
    readonly radius?: number;
  };
  readonly launcher: {
    readonly style: 'pill' | 'bubble';
    readonly icon: 'brand-mark' | 'chat' | 'none';
    readonly size: 'md' | 'lg';
    readonly status: 'none' | 'session';
    readonly effect: 'none' | 'pulse';
  };
  readonly header: {
    readonly mark: 'none' | 'brand-mark' | 'status';
    readonly badge?: {
      readonly text: string;
      readonly tone: AssistantPresentationTone;
      readonly indicator: boolean;
    };
  };
  readonly composer: {
    readonly leadingIcon: 'none' | 'brand-mark';
    readonly sendIcon: 'arrow-up' | 'paper-plane';
    readonly shape: 'rounded' | 'pill';
  };
  readonly messages: {
    readonly userStyle: 'bubble' | 'accent';
    readonly assistantStyle: 'plain' | 'bubble';
  };
}

export interface ResolvedAssistantAppearance {
  readonly brand: {
    readonly name: string;
    readonly logo: { readonly light?: string; readonly dark?: string };
    readonly avatar: { readonly light?: string; readonly dark?: string };
    readonly mark: { readonly light?: string; readonly dark?: string };
  };
  readonly theme: {
    readonly defaultMode: AssistantThemeMode;
    readonly light: AssistantThemeTokens;
    readonly dark: AssistantThemeTokens;
  };
  readonly layout: {
    readonly mode: AssistantLayoutMode;
    readonly position: AssistantPosition;
    readonly panelWidth: number;
    readonly panelMinHeight: number;
    readonly panelMaxHeight: number;
    readonly edgeOffset: number;
    readonly zIndex: number;
    readonly density: 'compact' | 'comfortable';
    readonly mobileFullscreen: boolean;
  };
  readonly behavior: {
    readonly startOpen: boolean;
    readonly closeOnEscape: boolean;
    readonly closeOnOutsideClick: boolean;
    readonly showLauncher: boolean;
    readonly showHeader: boolean;
    readonly showAvatars: boolean;
    readonly showTimestamps: boolean;
    readonly showPoweredBy: boolean;
    readonly showConfirmationDetails: boolean;
  };
  readonly labels: AssistantLabels;
  readonly presentation: ResolvedAssistantPresentation;
  readonly suggestedPrompts: readonly string[];
  /** Whether the initial prompt set is exact configuration or should be requested from the model. */
  readonly suggestedPromptsSource: 'configured' | 'model';
  readonly privacyUrl?: string;
  readonly termsUrl?: string;
  readonly locale: string;
  readonly direction: 'ltr' | 'rtl' | 'auto';
}

const common = {
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  monoFontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  baseFontSize: 15,
  messageFontSize: 15,
  lineHeight: 1.5,
  panelRadius: 24,
  cardRadius: 16,
  inputRadius: 999,
  buttonRadius: 999,
  launcherRadius: 999,
  spacing: 8,
  backdropBlur: 6,
  motionScale: 1,
} as const;

export const DEFAULT_APPEARANCE: ResolvedAssistantAppearance = {
  brand: { name: 'Assistant', logo: {}, avatar: {}, mark: {} },
  theme: {
    defaultMode: 'auto',
    light: {
      ...common,
      page: '#F8F8F8',
      panel: '#F8F8F8',
      elevated: '#F4F4F5',
      input: '#FFFFFF',
      hover: '#F4F4F5',
      selected: '#FFF1E7',
      text: '#09090B',
      mutedText: '#71717A',
      accent: '#C2410C',
      accentText: '#FFFFFF',
      link: '#9A3412',
      divider: 'rgba(0, 0, 0, 0.1)',
      focus: '#C2410C',
      success: '#16835D',
      warning: '#A45B00',
      danger: '#C92A45',
      overlay: '#18181B66',
      code: '#F1F1F3',
      widgetFrame: '#E4E4E7',
      shadow: '0 4px 16px rgba(0, 0, 0, 0.06)',
    },
    dark: {
      ...common,
      page: '#0C0A09',
      panel: '#0C0A09',
      elevated: '#27272A',
      input: '#1C1917',
      hover: '#27272A',
      selected: '#431B0B',
      text: '#FAFAFA',
      mutedText: '#A1A1AA',
      accent: '#FB923C',
      accentText: '#1C0A02',
      link: '#FDBA74',
      divider: 'rgba(255, 255, 255, 0.1)',
      focus: '#FB923C',
      success: '#58C69A',
      warning: '#F2B45F',
      danger: '#FF8094',
      overlay: '#00000099',
      code: '#26262C',
      widgetFrame: '#34343B',
      shadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
    },
  },
  layout: {
    mode: 'floating',
    position: 'bottom-center',
    panelWidth: 970,
    panelMinHeight: 0,
    panelMaxHeight: 1025,
    edgeOffset: 20,
    zIndex: 2147483000,
    density: 'comfortable',
    mobileFullscreen: true,
  },
  behavior: {
    startOpen: false,
    closeOnEscape: true,
    closeOnOutsideClick: false,
    showLauncher: true,
    showHeader: true,
    showAvatars: true,
    showTimestamps: false,
    showPoweredBy: true,
    showConfirmationDetails: false,
  },
  labels: {
    welcomeHeading: '',
    welcomeMessage: '',
    launcherPlaceholder: 'Chat with us',
    composerPlaceholder: 'Ask a question…',
    thinking: 'Thinking',
    send: 'Send',
    stop: 'Stop',
    close: 'Close assistant',
    open: 'Open assistant',
    confirm: 'Confirm',
    decline: "Don't proceed",
    cancel: 'Cancel',
    confirmationHeading: 'Review and confirm',
    additionalDetails: 'Additional details',
    redacted: 'Hidden for security',
    completed: 'Completed',
    stopped: 'Stopped',
    copy: 'Copy',
    newMessages: 'New messages',
    reconnect: 'Reconnect',
    newConversation: 'New conversation',
    retry: 'Try again',
    unavailable: 'The assistant is temporarily unavailable.',
    sessionExpired: 'Your assistant session expired. Reopen it to continue.',
    sessionIdle: 'Assistant session idle',
    sessionLoading: 'Assistant session loading',
    sessionReady: 'Assistant session ready',
    sessionError: 'Assistant session unavailable',
    signInHeading: 'Sign in to continue',
    signInBody: '',
    signInAction: 'Sign in',
    // Empty means no sign-up button: authoring the label is the opt-in (ADR 0201, 2026-08-22).
    signUpAction: '',
  },
  presentation: {
    panel: {
      surface: 'solid',
      elevation: 'soft',
      border: 'subtle',
    },
    launcher: {
      style: 'pill',
      icon: 'brand-mark',
      size: 'md',
      status: 'none',
      effect: 'none',
    },
    header: { mark: 'none' },
    composer: { leadingIcon: 'none', sendIcon: 'arrow-up', shape: 'pill' },
    messages: { userStyle: 'bubble', assistantStyle: 'plain' },
  },
  suggestedPrompts: [],
  suggestedPromptsSource: 'model',
  locale: 'en',
  direction: 'auto',
};

export function resolveAppearance(input: AssistantConfiguration = {}): ResolvedAssistantAppearance {
  const branding = input.branding;
  const assistant = input.assistant;
  return {
    brand: {
      ...DEFAULT_APPEARANCE.brand,
      ...(branding?.name ? { name: branding.name } : {}),
      logo: themedAsset(branding?.logo),
      avatar: themedAsset(branding?.avatar),
      mark: themedAsset(branding?.mark),
    },
    theme: {
      defaultMode:
        assistant?.theme ?? branding?.colorScheme ?? DEFAULT_APPEARANCE.theme.defaultMode,
      light: resolveTheme('light', branding),
      dark: resolveTheme('dark', branding),
    },
    layout: {
      ...DEFAULT_APPEARANCE.layout,
      ...(branding?.density ? { density: branding.density } : {}),
      ...assistant?.layout,
      ...(assistant?.layout?.edgeOffset === undefined
        ? {}
        : { edgeOffset: boundedNumber(assistant.layout.edgeOffset, 0, 96) }),
    },
    behavior: { ...DEFAULT_APPEARANCE.behavior, ...assistant?.behavior },
    labels: {
      ...DEFAULT_APPEARANCE.labels,
      ...(branding?.name ? { launcherPlaceholder: `Chat with ${branding.name}` } : {}),
      ...assistant?.labels,
    },
    presentation: resolvePresentation(assistant?.presentation),
    suggestedPrompts: assistant?.suggestedPrompts ?? [],
    suggestedPromptsSource: assistant?.suggestedPrompts === undefined ? 'model' : 'configured',
    ...(assistant?.privacyUrl ? { privacyUrl: assistant.privacyUrl } : {}),
    ...(assistant?.termsUrl ? { termsUrl: assistant.termsUrl } : {}),
    locale: assistant?.locale ?? DEFAULT_APPEARANCE.locale,
    direction: assistant?.direction ?? DEFAULT_APPEARANCE.direction,
  };
}

function resolvePresentation(
  input: AssistantPresentationConfiguration | undefined,
): ResolvedAssistantPresentation {
  const defaults = DEFAULT_APPEARANCE.presentation;
  const panelRadius =
    input?.panel?.radius === undefined
      ? defaults.panel.radius
      : boundedNumber(input.panel.radius, 0, 64);
  return {
    panel: {
      ...defaults.panel,
      ...input?.panel,
      ...(panelRadius === undefined ? {} : { radius: panelRadius }),
    },
    launcher: { ...defaults.launcher, ...input?.launcher },
    header: {
      mark: input?.header?.mark ?? defaults.header.mark,
      ...(input?.header?.badge
        ? {
            badge: {
              text: input.header.badge.text,
              tone: input.header.badge.tone ?? 'neutral',
              indicator: input.header.badge.indicator ?? false,
            },
          }
        : {}),
    },
    composer: { ...defaults.composer, ...input?.composer },
    messages: { ...defaults.messages, ...input?.messages },
  };
}

function boundedNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? Math.round(value) : min));
}

function themedAsset(asset: AssistantBrandAsset | undefined): {
  readonly light?: string;
  readonly dark?: string;
} {
  return asset ? { light: asset.uri, dark: asset.darkUri ?? asset.uri } : {};
}

function resolveTheme(
  mode: 'light' | 'dark',
  branding: AssistantConfiguration['branding'],
): AssistantThemeTokens {
  const defaults = DEFAULT_APPEARANCE.theme[mode];
  const surface = mode === 'light' ? branding?.surface : branding?.surfaceDark;
  const portable = branding?.theme?.[mode];
  const configuredAccent = portable?.accent ?? branding?.accent;
  const derivedAccentText =
    configuredAccent && !portable?.accentText ? contrastingText(configuredAccent) : undefined;
  const radius = branding?.radius ? radiusValue(branding.radius) : undefined;
  return {
    ...defaults,
    ...(branding?.accent ? { accent: branding.accent } : {}),
    ...(surface ? { page: surface, panel: surface } : {}),
    ...mapPortableTheme(portable),
    ...(derivedAccentText ? { accentText: derivedAccentText } : {}),
    ...(radius === undefined
      ? {}
      : {
          panelRadius: radius,
          cardRadius: radius,
          inputRadius: Math.max(0, radius - 2),
          buttonRadius: Math.max(0, radius - 2),
        }),
    ...(branding?.typography === 'serif'
      ? { fontFamily: 'ui-serif, Georgia, serif' }
      : branding?.typography === 'mono'
        ? { fontFamily: defaults.monoFontFamily }
        : {}),
  };
}

function contrastingText(background: string): '#09090B' | '#FFFFFF' {
  const dark = '#09090B' as const;
  const light = '#FFFFFF' as const;
  return contrastRatio(background, dark) >= contrastRatio(background, light) ? dark : light;
}

function contrastRatio(first: string, second: string): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(color: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!match) return 0;
  const channels = match.slice(1).map((channel) => {
    const value = Number.parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

function mapPortableTheme(input: BrandThemeOverrides | undefined): Partial<AssistantThemeTokens> {
  if (!input) return {};
  return {
    ...(input.surface ? { page: input.surface, panel: input.surface } : {}),
    ...(input.surfaceRaised ? { elevated: input.surfaceRaised } : {}),
    ...(input.surfaceMuted
      ? { input: input.surfaceMuted, hover: input.surfaceMuted, selected: input.surfaceMuted }
      : {}),
    ...(input.text ? { text: input.text } : {}),
    ...(input.textMuted ? { mutedText: input.textMuted } : {}),
    ...(input.accent ? { accent: input.accent } : {}),
    ...(input.accentText ? { accentText: input.accentText } : {}),
    ...(input.link ? { link: input.link } : {}),
    ...(input.border ? { divider: input.border, widgetFrame: input.border } : {}),
    ...(input.focus ? { focus: input.focus } : {}),
    ...(input.success ? { success: input.success } : {}),
    ...(input.warning ? { warning: input.warning } : {}),
    ...(input.danger ? { danger: input.danger } : {}),
    ...(input.code ? { code: input.code } : {}),
  };
}

function radiusValue(radius: 'none' | 'sm' | 'md' | 'lg'): number {
  if (radius === 'none') return 0;
  if (radius === 'sm') return 8;
  if (radius === 'lg') return 18;
  return 14;
}
