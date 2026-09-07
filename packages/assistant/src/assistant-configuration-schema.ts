import { z } from 'zod';
import type { AssistantConfiguration } from './appearance.js';

const hexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const resolvedBorderColorSchema = z.union([
  hexColorSchema,
  z.string().max(64).refine(isBoundedRgbaColor, 'must be a six-digit hex or bounded rgba color'),
]);
const browserAssetUrlSchema = z
  .string()
  .trim()
  .url()
  .refine(isSecureBrowserAssetUrl, 'must use https (http is allowed only for loopback testing)');
const httpsUrlSchema = z.string().trim().url().refine(isHttpsUrl, 'must use https');

const brandAssetSchema = z
  .object({
    uri: browserAssetUrlSchema,
    darkUri: browserAssetUrlSchema.optional(),
    alt: z.string().trim().min(1).max(240),
  })
  .strict();

const brandThemeSchema = z
  .object({
    surface: hexColorSchema.optional(),
    surfaceRaised: hexColorSchema.optional(),
    surfaceMuted: hexColorSchema.optional(),
    text: hexColorSchema.optional(),
    textMuted: hexColorSchema.optional(),
    accent: hexColorSchema.optional(),
    accentText: hexColorSchema.optional(),
    link: hexColorSchema.optional(),
    border: resolvedBorderColorSchema.optional(),
    borderStrong: resolvedBorderColorSchema.optional(),
    focus: hexColorSchema.optional(),
    success: hexColorSchema.optional(),
    warning: hexColorSchema.optional(),
    danger: hexColorSchema.optional(),
    code: hexColorSchema.optional(),
  })
  .strict();

const brandingSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    accent: hexColorSchema.optional(),
    surface: hexColorSchema.optional(),
    surfaceDark: hexColorSchema.optional(),
    logo: brandAssetSchema.optional(),
    mark: brandAssetSchema.optional(),
    avatar: brandAssetSchema.optional(),
    theme: z
      .object({ light: brandThemeSchema.optional(), dark: brandThemeSchema.optional() })
      .strict()
      .optional(),
    radius: z.enum(['none', 'sm', 'md', 'lg']).optional(),
    density: z.enum(['compact', 'comfortable']).optional(),
    typography: z.enum(['system', 'serif', 'mono']).optional(),
    colorScheme: z.enum(['auto', 'light', 'dark']).optional(),
  })
  .strict();

const labelsSchema = z
  .object({
    welcomeHeading: z.string().trim().min(1).max(160).optional(),
    welcomeMessage: z.string().max(1000).optional(),
    launcherPlaceholder: z.string().trim().min(1).max(160).optional(),
    composerPlaceholder: z.string().trim().min(1).max(160).optional(),
    thinking: z.string().trim().min(1).max(80).optional(),
    send: z.string().trim().min(1).max(80).optional(),
    stop: z.string().trim().min(1).max(80).optional(),
    close: z.string().trim().min(1).max(80).optional(),
    open: z.string().trim().min(1).max(80).optional(),
    confirm: z.string().trim().min(1).max(80).optional(),
    decline: z.string().trim().min(1).max(80).optional(),
    cancel: z.string().trim().min(1).max(80).optional(),
    confirmationHeading: z.string().trim().min(1).max(120).optional(),
    additionalDetails: z.string().trim().min(1).max(120).optional(),
    redacted: z.string().trim().min(1).max(120).optional(),
    completed: z.string().trim().min(1).max(80).optional(),
    stopped: z.string().trim().min(1).max(80).optional(),
    copy: z.string().trim().min(1).max(80).optional(),
    newMessages: z.string().trim().min(1).max(80).optional(),
    reconnect: z.string().trim().min(1).max(80).optional(),
    newConversation: z.string().trim().min(1).max(80).optional(),
    retry: z.string().trim().min(1).max(80).optional(),
    unavailable: z.string().trim().min(1).max(240).optional(),
    sessionExpired: z.string().trim().min(1).max(240).optional(),
    sessionIdle: z.string().trim().min(1).max(120).optional(),
    sessionLoading: z.string().trim().min(1).max(120).optional(),
    sessionReady: z.string().trim().min(1).max(120).optional(),
    sessionError: z.string().trim().min(1).max(120).optional(),
    signInHeading: z.string().trim().min(1).max(120).optional(),
    signInBody: z.string().max(240).optional(),
    signInAction: z.string().trim().min(1).max(80).optional(),
    signUpAction: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

const presentationSchema = z
  .object({
    panel: z
      .object({
        surface: z.enum(['solid', 'glass']).optional(),
        elevation: z.enum(['soft', 'dramatic']).optional(),
        border: z.enum(['subtle', 'strong']).optional(),
        radius: z.number().int().min(0).max(64).optional(),
      })
      .strict()
      .optional(),
    launcher: z
      .object({
        style: z.enum(['pill', 'bubble']).optional(),
        icon: z.enum(['brand-mark', 'chat', 'none']).optional(),
        size: z.enum(['md', 'lg']).optional(),
        status: z.enum(['none', 'session']).optional(),
        effect: z.enum(['none', 'pulse']).optional(),
      })
      .strict()
      .optional(),
    header: z
      .object({
        mark: z.enum(['none', 'brand-mark', 'status']).optional(),
        badge: z
          .object({
            text: z.string().trim().min(1).max(80),
            tone: z.enum(['neutral', 'success', 'warning', 'danger']).optional(),
            indicator: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    composer: z
      .object({
        leadingIcon: z.enum(['none', 'brand-mark']).optional(),
        sendIcon: z.enum(['arrow-up', 'paper-plane']).optional(),
        shape: z.enum(['rounded', 'pill']).optional(),
      })
      .strict()
      .optional(),
    messages: z
      .object({
        userStyle: z.enum(['bubble', 'accent']).optional(),
        assistantStyle: z.enum(['plain', 'bubble']).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const assistantUiSchema = z
  .object({
    theme: z.enum(['auto', 'light', 'dark', 'invert']).optional(),
    layout: z
      .object({
        mode: z.enum(['floating', 'inline', 'drawer']).optional(),
        position: z.enum(['bottom-left', 'bottom-center', 'bottom-right']).optional(),
        panelWidth: z.number().int().min(280).max(1200).optional(),
        panelMinHeight: z.number().int().min(240).max(1600).optional(),
        panelMaxHeight: z.number().int().min(320).max(2400).optional(),
        edgeOffset: z.number().int().min(0).max(96).optional(),
        zIndex: z.number().int().min(0).max(2_147_483_647).optional(),
        density: z.enum(['compact', 'comfortable']).optional(),
        mobileFullscreen: z.boolean().optional(),
      })
      .strict()
      .optional(),
    behavior: z
      .object({
        startOpen: z.boolean().optional(),
        closeOnEscape: z.boolean().optional(),
        closeOnOutsideClick: z.boolean().optional(),
        showLauncher: z.boolean().optional(),
        showHeader: z.boolean().optional(),
        showAvatars: z.boolean().optional(),
        showTimestamps: z.boolean().optional(),
        showPoweredBy: z.boolean().optional(),
        showConfirmationDetails: z.boolean().optional(),
      })
      .strict()
      .optional(),
    labels: labelsSchema.optional(),
    presentation: presentationSchema.optional(),
    suggestedPrompts: z.array(z.string().trim().min(1).max(240)).max(8).optional(),
    privacyUrl: httpsUrlSchema.optional(),
    termsUrl: httpsUrlSchema.optional(),
    locale: z.string().trim().min(2).max(35).optional(),
    direction: z.enum(['ltr', 'rtl', 'auto']).optional(),
    webmcp: z.object({ enabled: z.boolean().optional() }).strict().optional(),
  })
  .strict();

const assistantConfigurationSchema = z
  .object({ branding: brandingSchema.optional(), assistant: assistantUiSchema.optional() })
  .strict() as z.ZodType<AssistantConfiguration>;

/** Parse the closed browser-safe appearance contract received from an assistant service. */
export function parseAssistantConfiguration(value: unknown): AssistantConfiguration | undefined {
  const parsed = assistantConfigurationSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isSecureBrowserAssetUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  } catch {
    return false;
  }
}

function isBoundedRgbaColor(value: string): boolean {
  const match =
    /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(0(?:\.\d{1,6})?|1(?:\.0{1,6})?)\s*\)$/.exec(
      value,
    );
  if (match === null) return false;
  return match.slice(1, 4).every((channel) => Number(channel) <= 255);
}
