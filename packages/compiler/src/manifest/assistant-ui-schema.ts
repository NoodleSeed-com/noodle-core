import { z } from 'zod';
import { httpsUrlSchema } from './branding-schema.js';

/**
 * The embedded assistant's renderer-owned UI shape: layout, behavior, labels, presentation, and the
 * server-side retention notice template.
 *
 * Extracted verbatim from `schema.ts` so that file stays inside its size budget as the assistant
 * surface grows. It depends only on leaf validators, never on tools, surfaces, or the assistant
 * block that spreads it, so the split is one-directional and free of an import cycle.
 */

const assistantPresentationToneSchema = z.enum(['neutral', 'success', 'warning', 'danger']);

export const optionalStrictObject = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.object(shape).strict().optional();

const assistantPresentationSchema = z
  .object({
    panel: optionalStrictObject({
      surface: z.enum(['solid', 'glass']).optional(),
      elevation: z.enum(['soft', 'dramatic']).optional(),
      border: z.enum(['subtle', 'strong']).optional(),
      radius: z.number().int().min(0).max(64).optional(),
    }),
    launcher: optionalStrictObject({
      style: z.enum(['pill', 'bubble']).optional(),
      icon: z.enum(['brand-mark', 'chat', 'none']).optional(),
      size: z.enum(['md', 'lg']).optional(),
      status: z.enum(['none', 'session']).optional(),
      effect: z.enum(['none', 'pulse']).optional(),
    }),
    header: optionalStrictObject({
      mark: z.enum(['none', 'brand-mark', 'status']).optional(),
      badge: optionalStrictObject({
        text: z.string().trim().min(1).max(80),
        tone: assistantPresentationToneSchema.optional(),
        indicator: z.boolean().optional(),
      }),
    }),
    composer: optionalStrictObject({
      leadingIcon: z.enum(['none', 'brand-mark']).optional(),
      sendIcon: z.enum(['arrow-up', 'paper-plane']).optional(),
      shape: z.enum(['rounded', 'pill']).optional(),
    }),
    messages: optionalStrictObject({
      userStyle: z.enum(['bubble', 'accent']).optional(),
      assistantStyle: z.enum(['plain', 'bubble']).optional(),
    }),
  })
  .strict();

export const assistantUiSchema = z
  .object({
    theme: z.enum(['auto', 'light', 'dark', 'invert']).optional(),
    layout: optionalStrictObject({
      mode: z.enum(['floating', 'inline', 'drawer']).optional(),
      position: z.enum(['bottom-left', 'bottom-center', 'bottom-right']).optional(),
      panelWidth: z.number().int().min(280).max(1200).optional(),
      panelMinHeight: z.number().int().min(240).max(1600).optional(),
      panelMaxHeight: z.number().int().min(320).max(2400).optional(),
      edgeOffset: z.number().int().min(0).max(96).optional(),
      zIndex: z.number().int().min(0).max(2147483647).optional(),
      density: z.enum(['compact', 'comfortable']).optional(),
      mobileFullscreen: z.boolean().optional(),
    }),
    behavior: optionalStrictObject({
      startOpen: z.boolean().optional(),
      closeOnEscape: z.boolean().optional(),
      closeOnOutsideClick: z.boolean().optional(),
      showLauncher: z.boolean().optional(),
      showHeader: z.boolean().optional(),
      showAvatars: z.boolean().optional(),
      showTimestamps: z.boolean().optional(),
      showPoweredBy: z.boolean().optional(),
      showConfirmationDetails: z.boolean().optional(),
    }),
    labels: optionalStrictObject({
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
    }),
    presentation: assistantPresentationSchema.optional(),
    suggestedPrompts: z.array(z.string().trim().min(1).max(240)).max(8).optional(),
    privacyUrl: httpsUrlSchema.optional(),
    termsUrl: httpsUrlSchema.optional(),
    locale: z.string().trim().min(2).max(35).optional(),
    direction: z.enum(['ltr', 'rtl', 'auto']).optional(),
    // Server-side only (ADR 0241 decision 17): rendered into the session's top-level `history`, never
    // forwarded inside the browser `configuration`, whose strict published schemas reject new keys.
    historyNotice: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .refine((value) => value.includes('{days}'), 'historyNotice must contain {days}')
      .optional(),
  })
  .strict();
