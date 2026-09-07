import { type ConfigRef, serializeSecretRef, serializeVariableRef } from './config.js';

export type AssistantLayoutMode = 'floating' | 'inline' | 'drawer';
export type AssistantPosition = 'bottom-left' | 'bottom-center' | 'bottom-right';
export type AssistantThemeMode = 'auto' | 'light' | 'dark' | 'invert';
export type AssistantPresentationTone = 'neutral' | 'success' | 'warning' | 'danger';

/**
 * Safe, renderer-owned presentation primitives for the embedded assistant. Colors and brand identity
 * remain in the server-level `branding` block; this surface deliberately accepts no HTML, CSS, SVG,
 * class names, or callbacks.
 */
export interface AssistantPresentationOptions {
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

export interface AssistantLabels {
  readonly welcomeHeading?: string;
  readonly welcomeMessage?: string;
  readonly launcherPlaceholder?: string;
  readonly composerPlaceholder?: string;
  readonly thinking?: string;
  readonly send?: string;
  readonly stop?: string;
  readonly close?: string;
  readonly open?: string;
  readonly confirm?: string;
  readonly decline?: string;
  readonly cancel?: string;
  readonly confirmationHeading?: string;
  readonly additionalDetails?: string;
  readonly redacted?: string;
  readonly completed?: string;
  readonly stopped?: string;
  readonly copy?: string;
  readonly newMessages?: string;
  readonly reconnect?: string;
  readonly newConversation?: string;
  readonly retry?: string;
  readonly unavailable?: string;
  readonly sessionExpired?: string;
  readonly sessionIdle?: string;
  readonly sessionLoading?: string;
  readonly sessionReady?: string;
  readonly sessionError?: string;
  readonly signInHeading?: string;
  readonly signInBody?: string;
  readonly signInAction?: string;
  /** Renders a sign-up button on the sign-in card; leaving it unset renders none. */
  readonly signUpAction?: string;
}

export interface AssistantUiOptions {
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
    /** Show the built-in confirmation card's technical Additional details disclosure. Defaults to true. */
    readonly showConfirmationDetails?: boolean;
  };
  readonly labels?: AssistantLabels;
  readonly presentation?: AssistantPresentationOptions;
  /** Exact initial prompts only; omit to generate context-aware initial prompts, or pass [] for none. */
  readonly suggestedPrompts?: readonly string[];
  readonly privacyUrl?: string;
  readonly termsUrl?: string;
  readonly locale?: string;
  readonly direction?: 'ltr' | 'rtl' | 'auto';
}

export type OpenAICompatibleTransport = 'chat-completions' | 'responses';

export interface OpenAICompatibleModelInput {
  readonly transport?: OpenAICompatibleTransport;
  readonly baseUrl: string | ConfigRef;
  readonly model: string | ConfigRef;
  readonly apiKey: ConfigRef;
}

export interface OpenAICompatibleModel {
  readonly kind: 'openai-compatible';
  readonly transport?: OpenAICompatibleTransport;
  readonly baseUrl: string;
  readonly model: string;
  /** Managed secret name, never the secret value. */
  readonly apiKey: string;
}

/** Provider-neutral request for the model selected and operated by Noodle Seed Cloud. */
export interface NoodleManagedModel {
  readonly kind: 'noodle-managed';
}

export type AssistantModel = OpenAICompatibleModel | NoodleManagedModel;

/**
 * A verified session claim the embedding backend may pass at session exchange. Keys become
 * `${user.claims.<key>}` in tool fulfilment; `exposeToModel: true` additionally places the value
 * in the assistant's identity system line so the model can use it directly.
 */
interface SessionClaimDeclaration {
  readonly exposeToModel?: boolean;
}

/**
 * A component this assistant may reach: whatever `tool()`, `resource()`, `prompt()`, or
 * `knowledge()` returned. Declared structurally so the access surface does not import the server
 * module it is used from.
 */
export interface CapabilityRef {
  readonly kind: 'tool' | 'resource' | 'prompt' | 'knowledge';
  readonly name: string;
}

/** One projected capability as it appears in compiled data. */
export interface AssistantCapability {
  readonly kind: CapabilityRef['kind'];
  readonly name: string;
}

/**
 * Which audience a surface serves. One assistant — one brand, one model, one UI — projects onto as many
 * surfaces as the product has front doors, and the mode is what decides who may open a session:
 *
 * - `authenticated` — the embedding backend proves who the visitor is and exchanges that verified user.
 * - `public` — an anonymous visitor bootstraps straight from the browser with a non-secret embed id.
 * - `mixed` — public, and a visitor may sign in mid-conversation to reach more (ADR 0055's vocabulary,
 *   and the same shape ChatGPT and Claude use for connectors that work with or without a token).
 */
export type AssistantSurfaceMode = 'authenticated' | 'public' | 'mixed';

export interface AuthenticatedWebsiteAccess {
  readonly mode: 'authenticated';
  readonly origins: readonly string[];
  readonly instructions?: string;
  /** Allowlist of verified session claims; undeclared claims are dropped at session exchange. */
  readonly sessionClaims?: Readonly<Record<string, SessionClaimDeclaration>>;
  readonly capabilities?: readonly CapabilityRef[];
  /** @see AuthenticatedWebsiteInput.webmcp */
  readonly webmcp?: { readonly enabled?: boolean };
}

/**
 * Anonymous cross-page display continuity for one public surface (ADR 0223, clauses 11-16).
 *
 * Off unless asked for. Anonymous conversation text is your content on your page, so whether it
 * survives a navigation is your call rather than a default the platform imposes.
 *
 * What a visitor gets is the text they have already read, re-rendered on the next page, on a fresh
 * session. What it never grants is the old session itself: no tool authority, no share of a spent
 * turn budget, and no pending confirmation carried across — a capability that survives a navigation
 * is exactly what this design refuses to create.
 */
export interface AssistantContinuityDeclaration {
  readonly enabled?: boolean;
  /**
   * How long a handle stays valid after the turn that issued it, measured from when the visitor last
   * spoke. Defaults to 300; 600 is the structural ceiling, and 0 disables continuity outright. An
   * operator may lower what you declare here and can never raise it.
   */
  readonly windowSeconds?: number;
  /**
   * How many times one conversation may be restored before continuity ends and the next page starts
   * fresh. Defaults to 3, ceiling 10, and 0 disables continuity outright.
   */
  readonly maxRestores?: number;
}

export interface PublicWebsiteAccess {
  readonly mode: 'public' | 'mixed';
  readonly origins: readonly string[];
  readonly capabilities: readonly CapabilityRef[];
  readonly instructions?: string;
  /** @see AuthenticatedWebsiteInput.webmcp */
  readonly webmcp?: { readonly enabled?: boolean };
  /** @see PublicWebsiteInput.continuity */
  readonly continuity?: AssistantContinuityDeclaration;
}

export type AssistantAccess = AuthenticatedWebsiteAccess | PublicWebsiteAccess;

export interface AuthenticatedWebsiteInput {
  readonly origins: readonly (string | ConfigRef)[];
  /** Assistant-only behavior for this exact signed-in website audience. */
  readonly instructions?: string;
  readonly sessionClaims?: Readonly<Record<string, SessionClaimDeclaration>>;
  /** Optional narrowing; omitted means the signed-in surface projects the whole server. */
  readonly capabilities?: readonly CapabilityRef[];
  /**
   * Override this assistant's WebMCP opt-in for sessions minted on this surface, in either
   * direction (ADR 0220, amended). Omitted inherits the assistant's value.
   *
   * It governs **discovery**: whether the embed registers this session's tools with
   * `document.modelContext`, and so whether a browser agent learns they exist. It is not a second
   * authorization boundary — every call the bridge makes already carries exactly this session's
   * authority. A deployment serving a marketing page and a signed-in app usually has two honest
   * answers, which one switch cannot express.
   */
  readonly webmcp?: { readonly enabled?: boolean };
}

export interface PublicWebsiteInput {
  readonly origins: readonly (string | ConfigRef)[];
  /** Assistant-only behavior for anonymous visitors on this website surface. */
  readonly instructions?: string;
  /**
   * Required: on a public page this list *is* the externally reachable surface, so it must be an
   * explicit positive choice rather than whatever the server happens to declare.
   */
  readonly capabilities: readonly CapabilityRef[];
  /**
   * Let a visitor sign in mid-conversation to reach identity-dependent capabilities (`mixed`).
   *
   * The capability stays visible to an anonymous visitor so the assistant can *offer* it; reaching for
   * it raises a sign-in prompt instead of executing. The login is the host application's own — Noodle
   * never operates one — and its backend completes the exchange.
   */
  readonly signIn?: boolean;
  /** @see AuthenticatedWebsiteInput.webmcp */
  readonly webmcp?: { readonly enabled?: boolean };
  /**
   * Let an anonymous visitor keep the conversation they can see when they navigate to another page
   * of this site. Omitted means off, and no existing embed changes behavior.
   *
   * Declared only here, never on an authenticated surface: that direction reattaches through a
   * backend-verified sign-in instead, so a declaration there would configure nothing.
   */
  readonly continuity?: AssistantContinuityDeclaration;
}

export function authenticatedWebsite(input: AuthenticatedWebsiteInput): AuthenticatedWebsiteAccess {
  return {
    mode: 'authenticated',
    origins: serializeOrigins(input.origins, 'assistant.access.origins'),
    ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    ...(input.sessionClaims ? { sessionClaims: structuredClone(input.sessionClaims) } : {}),
    ...(input.capabilities ? { capabilities: [...input.capabilities] } : {}),
    ...(input.webmcp === undefined ? {} : { webmcp: { ...input.webmcp } }),
  };
}

export function publicWebsite(input: PublicWebsiteInput): PublicWebsiteAccess {
  return {
    mode: input.signIn === true ? 'mixed' : 'public',
    origins: serializeOrigins(input.origins, 'assistant.access.origins'),
    capabilities: [...input.capabilities],
    ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    ...(input.webmcp === undefined ? {} : { webmcp: { ...input.webmcp } }),
    ...(input.continuity === undefined ? {} : { continuity: { ...input.continuity } }),
  };
}

function serializeOrigins(origins: readonly (string | ConfigRef)[], path: string): string[] {
  return origins.map((origin, index) =>
    typeof origin === 'string' ? origin : serializeVariableRef(origin, `${path}.${index}`),
  );
}

export interface EmbeddedAssistantOptions extends AssistantUiOptions {
  readonly model: AssistantModel;
  /** One surface, or every front door this assistant serves. */
  readonly access: AssistantAccess | readonly AssistantAccess[];
  /**
   * Let a browser agent (Gemini-in-Chrome, Claude-in-Chrome) call this assistant's tools through the
   * page's WebMCP API. Off unless set. Calls carry exactly the embed session's authority and take the
   * same authorization, limits, confirmation, and audit path as the assistant's own — see ADR 0220.
   *
   * The default for every surface, which any surface may override in either direction.
   */
  readonly webmcp?: { readonly enabled?: boolean };
}

/** One projected surface as it appears in compiled data. */
export interface AssistantSurfaceConfig {
  readonly mode: AssistantSurfaceMode;
  readonly origins: readonly string[];
  readonly instructions?: string;
  readonly capabilities?: readonly AssistantCapability[];
  readonly sessionClaims?: Readonly<Record<string, SessionClaimDeclaration>>;
  /** @see AuthenticatedWebsiteInput.webmcp */
  readonly webmcp?: { readonly enabled?: boolean };
  /**
   * Present only on a public or mixed surface; an authenticated one never carries it.
   *
   * @see PublicWebsiteInput.continuity
   */
  readonly continuity?: AssistantContinuityDeclaration;
}

export interface EmbeddedAssistantConfig extends AssistantUiOptions {
  readonly model: AssistantModel;
  readonly surfaces: readonly AssistantSurfaceConfig[];
  /**
   * Union of every surface's origins. Kept at the top level so the service's origin check and the
   * published session-exchange contract read on unchanged while surfaces are added.
   */
  readonly allowedOrigins: readonly string[];
  /** Mirrored from the authenticated surface, for the same reason. */
  readonly sessionClaims?: Readonly<Record<string, SessionClaimDeclaration>>;
  /** @see EmbeddedAssistantOptions.webmcp — the default each surface may override. */
  readonly webmcp?: { readonly enabled?: boolean };
}

export function openAICompatible(input: OpenAICompatibleModelInput): OpenAICompatibleModel {
  const baseUrl =
    typeof input.baseUrl === 'string'
      ? input.baseUrl
      : serializeVariableRef(input.baseUrl, 'assistant.model.baseUrl');
  const model =
    typeof input.model === 'string'
      ? input.model
      : serializeVariableRef(input.model, 'assistant.model.model');
  return {
    kind: 'openai-compatible',
    ...(input.transport === undefined ? {} : { transport: input.transport }),
    baseUrl,
    model,
    apiKey: serializeSecretRef(input.apiKey, 'assistant.model.apiKey'),
  };
}

/** Use Noodle Seed Cloud's operator-selected model. Provider details never enter authored source. */
export function noodleManaged(): NoodleManagedModel {
  return { kind: 'noodle-managed' };
}

export function embeddedAssistant(input: EmbeddedAssistantOptions): EmbeddedAssistantConfig {
  const { model, access, suggestedPrompts, ...ui } = input;
  assertAccessDeclared(input, access);
  const surfaces = (Array.isArray(access) ? access : [access]) as readonly AssistantAccess[];
  assertDistinctSurfaces(surfaces);

  const sessionClaims = surfaces.find(
    (surface): surface is AuthenticatedWebsiteAccess => surface.mode === 'authenticated',
  )?.sessionClaims;

  return {
    model: { ...model },
    surfaces: surfaces.map((surface) => ({
      mode: surface.mode,
      origins: [...surface.origins],
      ...(surface.instructions === undefined ? {} : { instructions: surface.instructions }),
      ...(surface.capabilities
        ? { capabilities: normalizeCapabilities(surface.capabilities) }
        : {}),
      ...(surface.mode === 'authenticated' && surface.sessionClaims
        ? { sessionClaims: structuredClone(surface.sessionClaims) }
        : {}),
      ...(surface.webmcp === undefined ? {} : { webmcp: { ...surface.webmcp } }),
      ...(surface.mode !== 'authenticated' && surface.continuity !== undefined
        ? { continuity: { ...surface.continuity } }
        : {}),
    })),
    allowedOrigins: surfaces.flatMap((surface) => [...surface.origins]),
    ...structuredClone(ui),
    ...(suggestedPrompts ? { suggestedPrompts: [...suggestedPrompts] } : {}),
    ...(sessionClaims ? { sessionClaims: structuredClone(sessionClaims) } : {}),
  };
}

/**
 * `access` became required when surfaces replaced the flat `allowedOrigins`/`sessionClaims` shape.
 *
 * Without this, omitting it read `.mode` off `undefined` and the author saw
 * `TypeError: Cannot read properties of undefined (reading 'mode')` from inside the SDK — reported from
 * a real deploy, which is how it earned an explicit check. An author on the previous shape has made an
 * ordinary migration mistake, so say which constructor to reach for and, when the old keys are still
 * present, name them: the message is the migration guide they will actually read.
 */
function assertAccessDeclared(input: EmbeddedAssistantOptions, access: unknown): void {
  const legacy = input as { readonly allowedOrigins?: unknown; readonly sessionClaims?: unknown };
  const moved: string[] = [];
  if (legacy.allowedOrigins !== undefined) {
    moved.push('`allowedOrigins` is now `origins` on a surface');
  }
  if (legacy.sessionClaims !== undefined) {
    moved.push('`sessionClaims` now belongs to authenticatedWebsite({ origins, sessionClaims })');
  }
  const migration = moved.length > 0 ? ` (${moved.join('; ')})` : '';
  const usage =
    'access: publicWebsite({ origins, capabilities }) or authenticatedWebsite({ origins })';

  if (access === undefined || access === null) {
    throw new Error(`embeddedAssistant requires an access surface — ${usage}${migration}`);
  }
  const surfaces = Array.isArray(access) ? access : [access];
  for (const surface of surfaces) {
    const mode = (surface as { readonly mode?: unknown } | undefined)?.mode;
    if (mode !== 'public' && mode !== 'mixed' && mode !== 'authenticated') {
      throw new Error(`embeddedAssistant access must be built with ${usage}${migration}`);
    }
  }
}

/**
 * Two surfaces of the same audience, or one origin claimed twice, would make "which projection is this
 * request?" ambiguous at mint time — so both are author-time errors rather than a resolution rule.
 */
function assertDistinctSurfaces(surfaces: readonly AssistantAccess[]): void {
  if (surfaces.length === 0) {
    throw new Error('embeddedAssistant requires at least one access surface');
  }
  const publicSurfaces = surfaces.filter((surface) => surface.mode !== 'authenticated');
  if (publicSurfaces.length > 1) {
    throw new Error('embeddedAssistant accepts at most one public surface (public or mixed)');
  }
  if (surfaces.length - publicSurfaces.length > 1) {
    throw new Error('embeddedAssistant accepts at most one authenticated surface');
  }
  const seen = new Set<string>();
  for (const surface of surfaces) {
    for (const origin of surface.origins) {
      if (seen.has(origin)) {
        throw new Error(`embeddedAssistant surfaces must not share an origin: ${origin}`);
      }
      seen.add(origin);
    }
  }
}

/** Declaration order is the review order, so it is preserved; a repeat is a no-op, not an error. */
function normalizeCapabilities(
  capabilities: readonly CapabilityRef[],
): readonly AssistantCapability[] {
  const seen = new Set<string>();
  const normalized: AssistantCapability[] = [];
  for (const capability of capabilities) {
    const key = `${capability.kind}:${capability.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ kind: capability.kind, name: capability.name });
  }
  return normalized;
}
