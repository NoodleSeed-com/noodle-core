import { knowledgeComponentManifestSchema } from '@noodle-borg/knowledge/portable';
import { z } from 'zod';
import {
  MAX_MANAGED_COLLECTIONS,
  managedCollectionManifestSchema,
} from '../managed-collections.js';
import { MAX_COMPILED_WIDGET_HTML_BYTES, MAX_RAW_WIDGET_HTML_BYTES } from '../widget-limits.js';
import { agentGuideSchema } from './agent-guide-schema.js';
import { serverAuthSchema, serverAuthV2Schema } from './auth-schema.js';
import {
  assistantOriginOrVariableSchema,
  httpsUrlSchema,
  managedVariableExpressionSchema,
  serverBrandingSchema,
} from './branding-schema.js';
import { NAME_PATTERN } from './naming.js';

/**
 * Zod schema for Core v1 and v2 manifests (ADRs 0150 and 0157). V1 remains accepted unchanged;
 * canonical TypeScript authoring emits v2, whose auth surface excludes the unfinished generic bridge.
 * Persisted `"0.2"` manifests are normalized to `"1"` at the service load seam.
 *
 * This validates the manifest's *static shape*. It covers server identity, tools/resources/prompts with
 * single-operation or flow fulfilment, the `connectors` block of named connector references that the
 * resolution pass checks against the catalog, and the `widgets` block (MCP Apps UI resources; ADR 0022).
 * Other optional top-level blocks (`connections`) are out of scope; unknown keys are stripped, not
 * rejected, so the schema stays forward-compatible. See docs/SPEC.md "Manifest Reference".
 */
const nameSchema = z
  .string()
  .regex(NAME_PATTERN, 'must use lowercase letters, numbers, and underscores');

/** A tenant-authored JSON Schema document. Validated as an object here; deep checks run in compile(). */
const jsonSchemaSchema = z.record(z.string(), z.unknown());

/** An expression map (`args`/`map`/`output`): field name to a raw value parsed in the compile pass. */
const exprMapSchema = z.record(z.string(), z.unknown());

/**
 * A flow step. Zod validates only the static shape; the compile pass enforces "exactly one verb"
 * (`use`/`map`/`elicit`), operation-ref well-formedness, portable elicitation schema, and
 * expression/step-reference validity so those errors carry precise dotted paths. `compute` remains
 * reserved for a future core version (ADR 0150).
 */
const elicitationSchema = z.object({
  message: z.string().trim().min(1).max(1000),
  requestedSchema: jsonSchemaSchema,
});

const stepSchema = z.object({
  id: nameSchema,
  if: z.string().optional(),
  use: z.string().optional(),
  args: exprMapSchema.optional(),
  map: exprMapSchema.optional(),
  elicit: elicitationSchema.optional(),
});

/**
 * Fulfilment is single-operation (`use` + `args`) sugar OR a flow (`steps` + `output`). Kept
 * deliberately loose here (all fields optional); the compile pass discriminates on `use` vs `steps`,
 * rejecting "neither/both" as `invalid_fulfilment`, and parses every expression value.
 */
const fulfilmentSchema = z.object({
  use: z.string().optional(),
  args: exprMapSchema.optional(),
  steps: z.array(stepSchema).optional(),
  output: exprMapSchema.optional(),
});

const MAX_TOOL_AUTHORIZATION_VALUES = 128;
const scopeTokenSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(
    /^[\x21\x23-\x5B\x5D-\x7E]+$/,
    'Scope tokens must use OAuth scope-token characters and may not contain spaces',
  );
const roleSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\p{Cc}]+$/u, 'Role values may not contain control characters');
const authorizationListSchema = (item: z.ZodString) =>
  z.array(item).min(1).max(MAX_TOOL_AUTHORIZATION_VALUES);
const requiredScopesSchema = authorizationListSchema(scopeTokenSchema);
const allowedRolesSchema = authorizationListSchema(roleSchema);
type ToolAuthorizationManifest = {
  readonly requiredScopes?: readonly string[] | undefined;
  readonly allowedRoles?: readonly string[] | undefined;
};
const toolAuthorizationSchema: z.ZodType<ToolAuthorizationManifest> = z.union([
  z
    .object({
      requiredScopes: requiredScopesSchema,
      allowedRoles: allowedRolesSchema.optional(),
    })
    .strict(),
  z
    .object({
      requiredScopes: requiredScopesSchema.optional(),
      allowedRoles: allowedRolesSchema,
    })
    .strict(),
]);

const toolSchema = z.object({
  name: nameSchema,
  title: z.string().trim().min(1).optional(),
  description: z.string().min(1),
  authorization: toolAuthorizationSchema.optional(),
  inputSchema: jsonSchemaSchema,
  outputSchema: jsonSchemaSchema.optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
  /**
   * Tool-surface visibility (SEP-1865 `_meta.ui.visibility`). Default (omitted) = `['model', 'app']`:
   * the model sees and can call it. `['app']` makes it a **UI-only helper** — discoverable with app-only
   * metadata so hosts can hide it from the model while allowing widget `callServerTool` calls. This is a
   * model-surface concern, **not** an authorization boundary (the policy layer remains the gate).
   */
  visibility: z
    .array(z.enum(['model', 'app']))
    .min(1)
    .optional(),
  fulfilment: fulfilmentSchema,
});

const toolV2Schema = toolSchema.extend({ contextProvider: z.literal(true).optional() });

/**
 * An MCP resource. Like a tool, it carries a `fulfilment` (it can return a constant or call connectors);
 * its `uri` is a fixed URI or a simple `{var}` URI template (validated in compile()). The compile pass
 * classifies fixed vs template and emits the matcher. Resources have no input/output schema — a templated
 * resource's extracted URI variables are the fulfilment's `input` scope.
 */
const resourceSchema = z.object({
  name: nameSchema,
  uri: z.string().min(1),
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  mimeType: z.string().min(1).optional(),
  fulfilment: fulfilmentSchema,
});

/** A prompt argument descriptor (the `prompts/list` shape). Values arrive as strings at `prompts/get`. */
const promptArgumentSchema = z.object({
  name: nameSchema,
  description: z.string().min(1).optional(),
  required: z.boolean().optional(),
});

/**
 * An MCP prompt. Carries a `fulfilment` whose `input` scope is the supplied `arguments` map; its output
 * maps to prompt messages (see the protocol layer). `arguments` is the descriptor list for `prompts/list`.
 */
const promptSchema = z.object({
  name: nameSchema,
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  arguments: z.array(promptArgumentSchema).optional(),
  fulfilment: fulfilmentSchema,
});

const assistantPresentationToneSchema = z.enum(['neutral', 'success', 'warning', 'danger']);

const optionalStrictObject = <Shape extends z.ZodRawShape>(shape: Shape) =>
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

const assistantUiSchema = z
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
  })
  .strict();

const assistantCapabilitySchema = z
  .object({
    kind: z.enum(['tool', 'resource', 'prompt', 'knowledge']),
    name: z.string().trim().min(1),
  })
  .strict();

/**
 * Upper bound on server- and surface-level instructions. These are concise behavior primers, not
 * documentation; the shared cap keeps prompt ownership predictable across both layers.
 */
const MAX_SERVER_INSTRUCTIONS = 4000;

/** Verified session claims an embedding backend may pass at exchange; undeclared keys are dropped. */
const sessionClaimsSchema = z.record(
  z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, 'claim keys are identifier-style'),
  z.object({ exposeToModel: z.boolean().optional() }).strict(),
);

const embeddedAssistantSchema = z
  .object({
    model: z.union([
      z
        .object({
          kind: z.literal('openai-compatible'),
          transport: z.enum(['chat-completions', 'responses']).optional(),
          baseUrl: z.string().trim().min(1),
          model: z.string().trim().min(1),
          apiKey: z.string().regex(/^[A-Za-z0-9_]+$/),
        })
        .strict(),
      z.object({ kind: z.literal('noodle-managed') }).strict(),
    ]),
    allowedOrigins: z.array(assistantOriginOrVariableSchema).min(1),
    // The front doors this assistant serves (ADR 0201, amended 2026-08-12). Absent means the pre-0201
    // authenticated shape, so released artifacts keep their meaning; `allowedOrigins` stays the union
    // and `sessionClaims` stays mirrored, so the service reads both unchanged. `capabilities` is the
    // exact reachable surface: optional when authenticated, required when public or mixed.
    surfaces: z
      .array(
        z
          .object({
            mode: z.enum(['authenticated', 'public', 'mixed']),
            origins: z.array(assistantOriginOrVariableSchema).min(1),
            instructions: z.string().trim().min(1).max(MAX_SERVER_INSTRUCTIONS).optional(),
            capabilities: z.array(assistantCapabilitySchema).optional(),
            sessionClaims: sessionClaimsSchema.optional(),
            // Overrides the assistant's own opt-in for sessions minted on this surface, in either
            // direction (ADR 0220, amended). Declared explicitly rather than inherited from
            // `assistantUiSchema.shape` — this is not renderer presentation, and a surface that
            // acquired it by a spread would be an accident rather than a decision.
            webmcp: optionalStrictObject({ enabled: z.boolean().optional() }),
            // Anonymous cross-page display continuity (ADR 0223, clauses 11-16), declared per public
            // or mixed surface. These bounds mirror the structural ceilings the gateway clamps to at
            // runtime; the ADR is the single source, and this package cannot import the gateway
            // because the dependency runs the other way. Refusing rather than clamping is deliberate:
            // the gateway narrows an operator's value silently by design, but a developer who asks
            // for more than the ceiling has made a mistake, and silence would hide it until someone
            // measured the live behaviour.
            continuity: optionalStrictObject({
              enabled: z.boolean().optional(),
              windowSeconds: z.number().int().min(0).max(600).optional(),
              maxRestores: z.number().int().min(0).max(10).optional(),
            }),
          })
          .strict(),
      )
      .min(1)
      .optional(),
    // Mirrored from the authenticated surface; the session exchange reads it here (ADR 0141,
    // 2026-07-14). Keys become `${user.claims.<key>}`; `exposeToModel` adds it to the identity line.
    sessionClaims: sessionClaimsSchema.optional(),
    // Additive optional field: a v1.x minor under ADR 0150, so no existing manifest can observe it.
    // The deployment's default, which any surface may override. Declared here rather than in
    // `assistantUiSchema` because that shape is spread into every surface as renderer-owned
    // presentation, and this is not presentation — the surface carries its own copy on purpose.
    webmcp: optionalStrictObject({ enabled: z.boolean().optional() }),
    ...assistantUiSchema.shape,
  })
  .strict()
  .superRefine((assistant, ctx) => {
    assistant.surfaces?.forEach((surface, index) => {
      // The authenticated direction already reattaches through ADR 0223 clause 7, authorized by a
      // backend-verified subject rather than by possession of a handle. A `continuity` block here
      // would be a developer believing they configured something nothing reads, so refuse it rather
      // than drop it silently.
      if (surface.mode === 'authenticated' && surface.continuity !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['surfaces', index, 'continuity'],
          message: 'continuity belongs on a public or mixed website surface',
        });
      }
      if (surface.mode === 'authenticated') return;
      // A public surface fails closed: an omitted allowlist would otherwise read as "expose
      // everything" exactly where that is most dangerous.
      if (surface.capabilities === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['surfaces', index, 'capabilities'],
          message: 'a public website surface must declare its capability allowlist',
        });
      }
      // There is no signed-in user to describe on a public page, so a claim allowlist there could
      // never be satisfied. A mixed surface elevates through the authenticated surface's claims.
      if (surface.sessionClaims !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['surfaces', index, 'sessionClaims'],
          message: 'sessionClaims belongs on an authenticated website surface',
        });
      }
    });
  });

const serverShellActionSchema = z
  .object({
    id: nameSchema,
    label: z.string().trim().min(1),
    action: nameSchema,
  })
  .strict();

const serverShellSchema = z
  .object({
    displayMode: z.enum(['compact', 'comfortable', 'immersive']).optional(),
    header: z
      .object({
        title: z.string().trim().min(1).optional(),
        subtitle: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
    navigation: z
      .object({
        variant: z.enum(['tabs', 'side', 'bottom']),
        items: z
          .array(
            z
              .object({
                id: nameSchema,
                label: z.string().trim().min(1),
                view: nameSchema,
              })
              .strict(),
          )
          .min(1),
      })
      .strict()
      .optional(),
    persistentActions: z.array(serverShellActionSchema).optional(),
  })
  .strict();

const serverContextSchema = z
  .object({
    defaults: z
      .object({
        locale: z.string().trim().min(2).max(35).optional(),
        timeZone: z.string().trim().min(1).max(100).optional(),
      })
      .strict()
      .optional(),
    ambient: z
      .object({
        outputSchema: jsonSchemaSchema,
        fulfilment: fulfilmentSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

const serverInteractionsSchema = z
  .object({
    /** Trust the MCP host's own write-approval UX when standard form confirmation is unavailable. */
    confirmationFallback: z.literal('host'),
  })
  .strict();

const serverSchema = z.object({
  name: nameSchema,
  version: z.string().min(1),
  title: z.string().min(1),
  instructions: z.string().trim().min(1).max(MAX_SERVER_INSTRUCTIONS).optional(),
  context: serverContextSchema.optional(),
  interactions: serverInteractionsSchema.optional(),
  auth: serverAuthSchema.optional(),
  assistant: embeddedAssistantSchema.optional(),
  branding: serverBrandingSchema.optional(),
  shell: serverShellSchema.optional(),
});

const serverV2Schema = serverSchema.extend({
  auth: serverAuthV2Schema.optional(),
  agentGuide: agentGuideSchema.optional(),
  /** Customer-owned knowledge components (ADR 0202): Core v2 only. */
  knowledge: z.array(knowledgeComponentManifestSchema).optional(),
  /** Managed business records: reusable schema intent only, never operator lifecycle state. */
  collections: z.array(managedCollectionManifestSchema).max(MAX_MANAGED_COLLECTIONS).optional(),
});

const handoffSchema = z
  .object({
    allowedDomains: z.array(z.union([httpsUrlSchema, managedVariableExpressionSchema])).min(1),
  })
  .strict();

const stateHandleSchema = z
  .object({
    kind: z.enum(['session', 'draft', 'selection', 'search', 'cart', 'workflow']),
    schema: jsonSchemaSchema,
    version: z.string().trim().min(1),
    scope: z.enum(['deployment', 'caller']).optional(),
    ttlSeconds: z
      .number()
      .int()
      .positive()
      .max(60 * 60 * 24 * 30)
      .optional(),
    claimOnAuthentication: z.literal(true).optional(),
  })
  .strict()
  .superRefine((handle, ctx) => {
    if (handle.claimOnAuthentication !== true) return;
    if (handle.scope !== 'caller') {
      ctx.addIssue({
        code: 'custom',
        path: ['scope'],
        message: 'claimOnAuthentication requires an explicit caller scope',
      });
    }
    if (handle.ttlSeconds === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['ttlSeconds'],
        message: 'claimOnAuthentication requires a finite ttlSeconds',
      });
    }
  });

const stateSchema = z
  .object({
    handles: z
      .record(nameSchema, stateHandleSchema)
      .refine(
        (handles) => Object.keys(handles).length > 0,
        'must declare at least one state handle',
      ),
  })
  .strict();

/**
 * A CSP source token: an origin or host — optional `https?://` scheme, optional `*.` wildcard label, a
 * host, optional `:port`. Rejects whitespace, `${…}`, and dangerous schemes (`javascript:`/`data:`) at
 * author time. These are *host*-enforced (the iframe sandbox), but the compiler must not emit a
 * syntactically invalid CSP source to the wire (defense-in-depth + author feedback).
 *
 * This shape stays deliberately permissive (scheme-less/wildcard tokens parse) so a faulty origin does
 * not become a hard compile error that would break the local author loop. Semantic honorability — the
 * first-party host renderer keeps only absolute `https://` origins (http for loopback) and silently drops
 * the rest — is checked separately: a non-blocking `widget_csp_unhonorable_origin` compile warning, an
 * error-severity `noodle check` finding, and a hard deploy gate. See `csp-origins.ts` and ADR 0137.
 */
const cspDomainSchema = z
  .string()
  .regex(
    /^(https?:\/\/)?(\*\.)?[A-Za-z0-9.-]+(:\d+)?$/,
    'must be an origin or host (e.g. "https://api.example.com" or "*.example.com")',
  );

/**
 * CSP capability metadata for a widget's `ui://` resource. These are the standardized MCP Apps fields
 * (SEP-1865 `_meta.ui.csp`), enforced by the host iframe sandbox — not by our runtime. Deny-by-default:
 * a widget reaches only the origins it lists. See docs/spec/apps-and-authoring.md. SEP-1865's
 * `baseUriDomains` is deliberately absent: no supported host emits a `base-uri` directive from it, so
 * offering it would be a dead field (ADR 0150 settles it out of Core v1; re-add when a host honors it).
 */
const widgetCspSchema = z.object({
  connectDomains: z.array(cspDomainSchema).optional(),
  resourceDomains: z.array(cspDomainSchema).optional(),
  frameDomains: z.array(cspDomainSchema).optional(),
});

const widgetPermissionGrantSchema = z.object({}).strict();

/**
 * Upper bound on a widget's inline `html` body. Rich markup + inline CSS/JS is a few KB (the shipped
 * examples are < 3 KB); the cap bounds artifact size so a single widget cannot bloat the stored/served
 * artifact. JSON Schema exposes the matching character ceiling as a coarse guard; compile-time semantic
 * validation enforces the actual contract in UTF-8 bytes and also caps aggregate widget HTML.
 */
const widgetViewSchema = z
  .object({
    component: nameSchema.or(
      z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'must be a safe React view component name'),
    ),
    entry: z.string().min(1),
    compiledHtml: z.string().min(1).max(MAX_COMPILED_WIDGET_HTML_BYTES).optional(),
  })
  .strict();

/**
 * An MCP Apps widget (Phase 2; [ADR 0022](../decisions/0022-adopt-mcp-ui-for-apps-widgets.md)). The
 * compiler desugars each widget into a fixed `ui://<server>/<name>` resource (mimeType
 * `text/html;profile=mcp-app`) and stamps the linking `tool`'s `_meta.ui.resourceUri`. Exactly one body
 * source is allowed: React `view` or raw `html`. `csp`/`permissions` ride on the resource's `_meta.ui`
 * as host-enforced capability metadata.
 */
const widgetSchema = z
  .object({
    name: nameSchema,
    tool: nameSchema,
    html: z.string().min(1).max(MAX_RAW_WIDGET_HTML_BYTES).optional(),
    view: widgetViewSchema.optional(),
    title: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    csp: widgetCspSchema.optional(),
    /**
     * Dedicated widget origin (`_meta.ui.domain`), e.g. `https://tickets.example.com`. Host-dependent:
     * ChatGPT requires a unique domain per app for app-store submission and renders the widget under a
     * sandbox origin derived from it; optional everywhere else.
     */
    domain: httpsUrlSchema.optional(),
    /**
     * Host status copy for the widget-opening tool, emitted as ChatGPT `openai/toolInvocation/invoking`
     * (shown while the tool runs) and `openai/toolInvocation/invoked` (shown once it returns).
     */
    invoking: z.string().min(1).optional(),
    invoked: z.string().min(1).optional(),
    permissions: z
      .object({
        camera: widgetPermissionGrantSchema.optional(),
        microphone: widgetPermissionGrantSchema.optional(),
        geolocation: widgetPermissionGrantSchema.optional(),
        clipboardWrite: widgetPermissionGrantSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .refine((widget) => [widget.html, widget.view].filter(Boolean).length === 1, {
    message: 'exactly one of html or view is required',
    path: ['html'],
  });

/**
 * A named connector reference: the manifest alias (the record key) points to a catalog connector
 * `id` pinned to a `version`. Operation references (`<connector>.<operation>`) use the alias.
 */
const connectorRefSchema = z.object({
  id: nameSchema,
  version: z.string().min(1),
});

const managedRefSchema = z
  .string()
  .regex(/^[A-Za-z0-9_]+$/, 'must be a managed config reference name');
const managedVariableExprSchema = z
  .string()
  .regex(/^\$\{env\.[A-Za-z0-9_]+\}$/, 'must be a managed variable expression');
const connectionSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('externalExchange') }).strict(),
  z
    .object({
      kind: z.literal('managedSecret'),
      secret: managedRefSchema,
      scopes: z.array(z.string().trim().min(1)).optional(),
      audience: z.string().trim().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('clientCredentials'),
      tokenUrl: z.union([z.url(), managedVariableExprSchema]),
      clientId: z.union([managedRefSchema, managedVariableExprSchema]),
      clientSecret: managedRefSchema,
      scopes: z.array(z.string().trim().min(1)).optional(),
      audience: z.string().trim().min(1).optional(),
      authMethod: z.enum(['client_secret_basic', 'client_secret_post']).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('googleWorkloadIdentity'),
      provider: managedVariableExprSchema,
      access: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('direct') }).strict(),
        z
          .object({
            kind: z.literal('serviceAccountImpersonation'),
            serviceAccount: managedVariableExprSchema,
          })
          .strict(),
      ]),
    })
    .strict(),
]);
const connectorBindingSchema = z
  .object({
    profile: nameSchema,
    connection: z
      .object({
        id: nameSchema,
        source: connectionSourceSchema,
      })
      .strict(),
  })
  .strict();
const connectorRefV2Schema = connectorRefSchema.extend({
  binding: connectorBindingSchema.optional(),
});

const commonManifestFields = {
  handoff: handoffSchema.optional(),
  state: stateSchema.optional(),
  requires: z.record(z.string(), z.boolean()).optional(),
  schemas: z.record(nameSchema, jsonSchemaSchema).optional(),
  resources: z.array(resourceSchema).optional(),
  prompts: z.array(promptSchema).optional(),
  widgets: z.array(widgetSchema).optional(),
} as const;

export const manifestV1Schema = z.object({
  manifestVersion: z.literal('1'),
  server: serverSchema,
  tools: z.array(toolSchema).min(1),
  connectors: z.record(nameSchema, connectorRefSchema).optional(),
  ...commonManifestFields,
});

export const manifestV2Schema = z
  .object({
    manifestVersion: z.literal('2'),
    server: serverV2Schema,
    tools: z.array(toolV2Schema),
    connectors: z.record(nameSchema, connectorRefV2Schema).optional(),
    ...commonManifestFields,
  })
  // A v2 server's callable surface may come entirely from generated knowledge capabilities
  // (ADR 0217): a knowledge-only server is valid, an empty server is not. v1 keeps its
  // authored-tool minimum — it has no server.knowledge to count.
  .superRefine((manifest, ctx) => {
    if (manifest.tools.length === 0 && (manifest.server.knowledge?.length ?? 0) === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['tools'],
        message: 'declare at least one tool or one server.knowledge component',
      });
    }
  });

export const manifestSchema = z.discriminatedUnion('manifestVersion', [
  manifestV1Schema,
  manifestV2Schema,
]);

export type Manifest = z.infer<typeof manifestSchema>;
