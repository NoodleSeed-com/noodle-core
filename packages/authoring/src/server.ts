import { createHash } from 'node:crypto';
import type { Manifest, PackagedAssetReference } from '@noodle-borg/compiler';
import type { ComputeConnectorDef, ConnectorDef } from '@noodle-borg/connector-defs';
import { z } from 'zod';
import { type AgentGuideSource, manifestAgentGuide } from './agent-guide.js';
import type { EmbeddedAssistantConfig } from './assistant.js';
import {
  type DistributionMetadataSource,
  type DistributionMetadataV1,
  projectDistributionMetadata,
} from './distribution.js';
import { manifestAssistant, manifestShell } from './server-presentation.js';

export { annotations } from './annotations.js';

import {
  type ConfigRef,
  type DeclaredVariableRef,
  isConfigRef,
  manifestVariables,
  serializeVariableRef,
} from './config.js';
import { toManifestConnectorRef } from './connections.js';
import { type ConnectorCatalogDoc, type ConnectorRef, validateCatalog } from './connectors.js';
import { manifestContext, type ServerContextOptions } from './context.js';
import { type CustomerAuth, manifestCustomerAuth } from './customer-auth.js';
import { type JsonSchema, toJsonSchema } from './json-schema.js';
import { type KnowledgeDeclaration, manifestKnowledge } from './knowledge.js';
import * as collections from './managed-collection.js';
import { manifestToolAnnotations } from './model-tool-visibility.js';
import {
  type ConnectorClient,
  recordFulfilment,
  recordTool,
  type SymbolicScope,
} from './recording.js';
export type StateHandleKind = 'session' | 'draft' | 'selection' | 'search' | 'cart' | 'workflow';
export type StateHandleScope = 'deployment' | 'caller';

export interface StateHandleOptions {
  readonly kind: StateHandleKind;
  readonly schema: JsonSchema | z.ZodType;
  readonly version: string;
  readonly scope?: StateHandleScope;
  readonly ttlSeconds?: number;
  /** Move this caller-scoped, finite-lived state to the authenticated caller during ticket elevation. */
  readonly claimOnAuthentication?: true;
}

export interface ServerOptions {
  /** Typed managed configuration; only explicit Portal metadata exposes business settings. */
  readonly variables?: readonly DeclaredVariableRef[];
  readonly title: string;
  readonly version: string;
  /** One host-neutral guide for agents using this product's complete MCP surface. */
  readonly agentGuide?: AgentGuideSource;
  /** Host-neutral listing, legal, review, and asset facts for later host package adapters. */
  readonly distribution?: DistributionMetadataSource;
  /** Tenant IdP contract required when deploying with `--access customers`. */
  readonly auth?: CustomerAuth;
  /** Tool-facing connectors: aliased in the manifest `connectors` block and callable inside `fulfil`. */
  readonly use?: Readonly<Record<string, ConnectorRef>>;
  /**
   * Catalog-only connectors reached only via compute connector `callOperation`. They are emitted to the
   * connector catalog but are not aliased into the manifest.
   */
  readonly provides?: Readonly<Record<string, ConnectorRef>>;
  readonly instructions?: string;
  /** Trusted per-invocation facts, compiled to data and resolved by the shared runtime. */
  readonly context?: ServerContextOptions;
  /** Cross-host behavior when the transport cannot carry Noodle's standard confirmation form. */
  readonly interactions?: {
    /** Explicitly trust the MCP host's own approval UX for writes; omission remains fail-closed. */
    readonly confirmationFallback: 'host';
  };
  /** Optional customer-branded assistant hosted against this server's live MCP surface. */
  readonly assistant?: EmbeddedAssistantConfig;
  /** Customer-owned knowledge components (ADR 0202): compile to generated `search_<name>` capabilities. */
  readonly knowledge?: readonly KnowledgeDeclaration[];
  /** Typed managed records; operator-owned lifecycle and policy are bound outside reusable source. */
  readonly collections?: readonly collections.ManagedCollectionDeclaration[];
  readonly branding?: {
    readonly name?: string;
    readonly accent?: string;
    readonly surface?: string;
    readonly surfaceDark?: string;
    readonly logo?: {
      readonly uri: string | PackagedAssetReference;
      readonly darkUri?: string | PackagedAssetReference;
      readonly alt: string;
    };
    readonly mark?: {
      readonly uri: string | PackagedAssetReference;
      readonly darkUri?: string | PackagedAssetReference;
      readonly alt: string;
    };
    readonly avatar?: {
      readonly uri: string | PackagedAssetReference;
      readonly darkUri?: string | PackagedAssetReference;
      readonly alt: string;
    };
    readonly theme?: {
      readonly light?: BrandThemeTokens;
      readonly dark?: BrandThemeTokens;
    };
    readonly radius?: 'none' | 'sm' | 'md' | 'lg';
    readonly density?: 'compact' | 'comfortable';
    readonly typography?: 'system' | 'serif' | 'mono';
    readonly colorScheme?: 'auto' | 'light' | 'dark';
  };
  readonly handoff?: {
    readonly allowedDomains: readonly (string | ConfigRef)[];
  };
  readonly state?: {
    readonly handles: Readonly<Record<string, StateHandleOptions>>;
  };
  readonly shell?: {
    readonly displayMode?: 'compact' | 'comfortable' | 'immersive';
    readonly header?: {
      readonly title?: string;
      readonly subtitle?: string;
    };
    readonly navigation?: {
      readonly variant: 'tabs' | 'side' | 'bottom';
      readonly items: readonly {
        readonly id: string;
        readonly label: string;
        readonly view: string;
      }[];
    };
    readonly persistentActions?: readonly {
      readonly id: string;
      readonly label: string;
      readonly action: string;
    }[];
  };
}

export interface BrandThemeTokens {
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

export interface ToolOptions {
  /** Human-readable action name shown by MCP hosts and confirmation surfaces. */
  readonly title?: string;
  readonly description: string;
  /** Verified caller claims required to discover and invoke this tool. */
  readonly authorization?: ToolAuthorizationOptions;
  /** Designate this ordinary zero-input MCP tool as the application context provider. */
  readonly contextProvider?: true;
  readonly input: JsonSchema | z.ZodType;
  readonly output?: JsonSchema | z.ZodType;
  readonly annotations?: Readonly<Record<string, unknown>>;
  /** Deterministic model-discovery constraints. These do not grant invocation authority. */
  readonly modelVisibility?: {
    /** Show this tool to the model only when the latest user message contains one of these literals. */
    readonly latestMessageIncludesAny: readonly string[];
    /** Hide this tool after its first successful model-selected use in one assistant session. */
    readonly oncePerSession?: true;
    /** Require a model call when this is the eligible required tool for the turn's first model step. */
    readonly requiredWhenVisible?: true;
  };
  /**
   * Tool-surface visibility (SEP-1865 `_meta.ui.visibility`). Default `['model', 'app']`. Set `['app']`
   * for a **UI-only helper** — discoverable with app-only metadata so hosts can hide it from the model
   * while allowing widget `callServerTool` calls. A model-surface concern, not authorization.
   */
  readonly visibility?: ('model' | 'app')[];
  /** Optional MCP Apps presentation linked to this tool. A view is metadata, not another tool kind. */
  readonly view?: ToolViewOptions;
  /** Stable view identity. Defaults to `<tool>_widget`. */
  readonly viewName?: string;
  readonly viewTitle?: string;
  readonly viewDescription?: string;
  readonly csp?: WidgetCsp;
  readonly domain?: string;
  readonly invoking?: string;
  readonly invoked?: string;
  readonly permissions?: WidgetPermissions;
  readonly fulfil: (ctx: ToolContext) => unknown | Promise<unknown>;
}

export interface ToolAuthorizationOptions {
  /** Every scope must be present on the verified caller. */
  readonly requiredScopes?: readonly string[];
  /** At least one role must be present on the verified caller. */
  readonly allowedRoles?: readonly string[];
}

export interface ToolContext {
  readonly input: SymbolicScope;
  readonly user: SymbolicScope;
  readonly context: SymbolicScope;
  readonly connectors: Record<string, ConnectorClient>;
  /** Request one bounded, non-sensitive form input and continue with its symbolic response. */
  readonly elicit: (options: ElicitationOptions) => SymbolicScope;
}

export interface ElicitationOptions {
  /** Stable step identity used for continuation binding and `${steps.<id>...}` expressions. */
  readonly id: string;
  readonly message: string;
  /** Portable MCP form input: a flat object of primitive/enum fields. */
  readonly input: JsonSchema | z.ZodType;
}

/**
 * The `fulfil` context for a resource or prompt. `input` is the input scope — a templated resource's
 * extracted URI variables, or a prompt's supplied arguments — and `connectors` are the `.use()`
 * connectors. The return value (a string, a symbolic ref, or a structure) becomes the content/messages.
 */
export interface ResourceContext {
  readonly input: SymbolicScope;
  readonly user: SymbolicScope;
  readonly context: SymbolicScope;
  readonly connectors: Record<string, ConnectorClient>;
}

/**
 * What a resource `fulfil` returns: the resource **body itself** — a string, a single content entry
 * (`{ text }` / `{ blob }`, optionally carrying its own `uri`/`mimeType`, which the runtime ignores in
 * favor of the resource's declared ones), a symbolic connector-call ref, or a plain data object the
 * runtime JSON-serializes. It must **not** be the MCP read-result wrapper `{ contents: [...] }`: the
 * runtime maps your return *into* `contents`, so returning that shape double-wraps it (contents[0].text
 * becomes the stringified `{"contents":[...]}`). The type bans **any** `contents` field — a deliberate
 * superset of the runtime guard in `mapping.ts` (which rejects only the array wrapper) — so the common
 * mistake is a compile error for typed callers, while leaving every other object/string/ref return valid;
 * the runtime guard still catches it for untyped/`any` callers.
 */
export type ResourceFulfilResult = string | number | boolean | (object & { contents?: never });

export interface ResourceOptions {
  /** A fixed URI (`docs://changelog`) or a simple `{var}` URI template (`tickets://{id}`). */
  readonly uri: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly fulfil: (ctx: ResourceContext) => ResourceFulfilResult | Promise<ResourceFulfilResult>;
}

/** A prompt argument descriptor when not derived from a Zod object. */
export interface PromptArgument {
  readonly name: string;
  readonly description?: string;
  readonly required?: boolean;
}

export interface PromptOptions {
  readonly title?: string;
  readonly description?: string;
  /** Either a Zod object (descriptors derived from its shape) or an explicit descriptor list. */
  readonly arguments?: z.ZodType | readonly PromptArgument[];
  readonly fulfil: (ctx: ResourceContext) => unknown | Promise<unknown>;
}

/** Host-enforced CSP capability metadata for a widget (mirrors the manifest `widgets[].csp` block). */
export interface WidgetCsp {
  readonly connectDomains?: string[];
  readonly resourceDomains?: string[];
  readonly frameDomains?: string[];
}

export type WidgetPermissionGrant = Readonly<Record<string, never>>;

export interface WidgetPermissions {
  readonly camera?: WidgetPermissionGrant;
  readonly microphone?: WidgetPermissionGrant;
  readonly geolocation?: WidgetPermissionGrant;
  readonly clipboardWrite?: WidgetPermissionGrant;
}

interface WidgetViewOptions {
  readonly component: string;
  readonly entry: string;
}

/** The one public view declaration: React component metadata or the explicit raw-HTML escape hatch. */
export type ToolViewOptions =
  | {
      readonly component: string;
      readonly entry: string;
      readonly html?: never;
    }
  | {
      readonly html: string;
      readonly component?: never;
      readonly entry?: never;
    };

/**
 * An MCP Apps widget: a `ui://` UI resource linked to `tool` via `_meta.ui.resourceUri`.
 * Exactly one body source is expected downstream: React `view` or raw `html`.
 * `csp`/`permissions` are host-enforced capability metadata. Secrets/tokens never reach widget HTML.
 */
interface WidgetOptions {
  readonly tool: string;
  readonly html?: string;
  readonly view?: WidgetViewOptions;
  readonly title?: string;
  readonly description?: string;
  readonly csp?: WidgetCsp;
  /** Dedicated widget origin (`_meta.ui.domain`); ChatGPT requires one per app for submission. */
  readonly domain?: string;
  /**
   * Host status copy for the widget-opening tool (ChatGPT `openai/toolInvocation/*`): `invoking` is
   * shown while the tool runs ("Loading the greeting…"), `invoked` once it returns ("Greeting ready").
   */
  readonly invoking?: string;
  readonly invoked?: string;
  readonly permissions?: WidgetPermissions;
}

const WIDGET_RESULT_META_KEY = '__noodleResultMeta';

interface CanonicalToolDefinition {
  readonly kind: 'tool';
  readonly name: string;
  readonly options: ToolOptions;
}

interface CanonicalResourceDefinition {
  readonly kind: 'resource';
  readonly name: string;
  readonly options: ResourceOptions;
}

interface CanonicalPromptDefinition {
  readonly kind: 'prompt';
  readonly name: string;
  readonly options: PromptOptions;
}

export type ServerComponent =
  | CanonicalToolDefinition
  | CanonicalResourceDefinition
  | CanonicalPromptDefinition;

/**
 * A compiled server. Components (tools, resources, and prompts) are declared in the `definitions`
 * array passed to {@link server}; connectors are bound through `use`/`provides` in the server options
 * object. The public surface is intentionally output-only — there is no chained builder
 * (`server(...).tool(...)`) on this type (see [ADR 0094](../../../docs/decisions/0094-unified-authoring-grammar.md)).
 */
export interface ServerDefinition {
  toManifest(): Promise<Manifest>;
  /** Separate host-distribution source; deliberately omitted from the manifest and runtime artifact. */
  toDistributionMetadata(): DistributionMetadataV1 | undefined;
  /**
   * Emit the connector catalog: every `use`/`provides` connector that has fulfilment — `.http()` and
   * `.compute()` connectors — validated against `connectorFileSchema`. Returns `undefined` when no
   * connector has fulfilment (e.g. a pure signature-only server).
   */
  toConnectorCatalog(): ConnectorCatalogDoc | undefined;
}

interface ToolDef {
  readonly name: string;
  readonly options: ToolOptions;
}

interface ResourceDef {
  readonly name: string;
  readonly options: ResourceOptions;
}

interface PromptDef {
  readonly name: string;
  readonly options: PromptOptions;
}

interface WidgetDef {
  readonly name: string;
  readonly options: WidgetOptions;
}

export function server(
  name: string,
  options: ServerOptions,
  definitions: readonly ServerComponent[] = [],
): ServerDefinition {
  const { use = {}, provides = {} } = options;
  const tools: ToolDef[] = [];
  const resources: ResourceDef[] = [];
  const prompts: PromptDef[] = [];
  const widgets: WidgetDef[] = [];
  for (const definition of definitions) {
    if (definition.kind === 'tool') {
      const {
        view,
        viewName,
        viewTitle,
        viewDescription,
        csp,
        domain,
        invoking,
        invoked,
        permissions,
        ...options
      } = definition.options;
      tools.push({ name: definition.name, options });
      if (view !== undefined) {
        widgets.push({
          name: viewName ?? `${definition.name}_widget`,
          options: toolViewWidgetOptions(definition.name, {
            view,
            viewTitle,
            viewDescription,
            csp,
            domain,
            invoking,
            invoked,
            permissions,
          }),
        });
      }
      continue;
    }
    if (definition.kind === 'resource') {
      resources.push({ name: definition.name, options: definition.options });
      continue;
    }
    if (definition.kind === 'prompt') {
      prompts.push({ name: definition.name, options: definition.options });
    }
  }
  return new ServerBuilder(name, options, use, provides, tools, resources, prompts, widgets);
}

export function tool(name: string, options: ToolOptions): ServerComponent {
  return { kind: 'tool', name, options };
}

export function resource(name: string, options: ResourceOptions): ServerComponent {
  return { kind: 'resource', name, options };
}

export function prompt(name: string, options: PromptOptions): ServerComponent {
  return { kind: 'prompt', name, options };
}

function toolViewWidgetOptions(
  toolName: string,
  options: {
    readonly view: ToolViewOptions;
    readonly viewTitle: string | undefined;
    readonly viewDescription: string | undefined;
    readonly csp: WidgetCsp | undefined;
    readonly domain: string | undefined;
    readonly invoking: string | undefined;
    readonly invoked: string | undefined;
    readonly permissions: WidgetPermissions | undefined;
  },
): WidgetOptions {
  const { view } = options;
  return {
    tool: toolName,
    ...(view.component !== undefined
      ? { view: { component: view.component, entry: view.entry } }
      : { html: view.html }),
    ...(options.viewTitle !== undefined ? { title: options.viewTitle } : {}),
    ...(options.viewDescription !== undefined ? { description: options.viewDescription } : {}),
    ...(options.csp !== undefined ? { csp: options.csp } : {}),
    ...(options.domain !== undefined ? { domain: options.domain } : {}),
    ...(options.invoking !== undefined ? { invoking: options.invoking } : {}),
    ...(options.invoked !== undefined ? { invoked: options.invoked } : {}),
    ...(options.permissions !== undefined ? { permissions: options.permissions } : {}),
  };
}

export function isServerDefinition(value: unknown): value is ServerDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toManifest?: unknown }).toManifest === 'function'
  );
}

export function asset(sourcePath: string): PackagedAssetReference {
  const normalized = sourcePath.replace(/\\/g, '/').replace(/^\.\/+/, '');
  return {
    kind: 'asset',
    sourcePath,
    logicalId: createHash('sha256').update(normalized).digest('hex').slice(0, 16),
  };
}

export function widgetResult<T extends Record<string, unknown>>(options: {
  readonly visible: T;
  readonly meta: Record<string, unknown>;
}): T & { readonly __noodleResultMeta: Record<string, unknown> } {
  return { ...options.visible, [WIDGET_RESULT_META_KEY]: options.meta };
}

class ServerBuilder implements ServerDefinition {
  constructor(
    private readonly name: string,
    private readonly options: ServerOptions,
    /** Tool-facing connectors: aliased in the manifest and exposed to `fulfil`. */
    private readonly connectors: Readonly<Record<string, ConnectorRef>>,
    /** Catalog-only connectors: emitted to the catalog, never aliased, never in the `fulfil` scope. */
    private readonly provided: Readonly<Record<string, ConnectorRef>>,
    private readonly tools: readonly ToolDef[],
    private readonly resources: readonly ResourceDef[],
    private readonly prompts: readonly PromptDef[],
    private readonly widgets: readonly WidgetDef[],
  ) {}

  toDistributionMetadata(): DistributionMetadataV1 | undefined {
    return projectDistributionMetadata(this.options.distribution);
  }

  async toManifest(): Promise<Manifest> {
    const invocationContext =
      this.options.context === undefined
        ? undefined
        : await manifestContext(this.options.context, this.connectors);
    const tools: Manifest['tools'] = [];
    for (const tool of this.tools) {
      const recorded = await recordTool(tool.options.fulfil, this.connectors);
      tools.push({
        name: tool.name,
        ...(tool.options.title ? { title: tool.options.title } : {}),
        description: tool.options.description,
        ...(tool.options.authorization
          ? {
              authorization: {
                ...(tool.options.authorization.requiredScopes
                  ? { requiredScopes: [...tool.options.authorization.requiredScopes] }
                  : {}),
                ...(tool.options.authorization.allowedRoles
                  ? { allowedRoles: [...tool.options.authorization.allowedRoles] }
                  : {}),
              },
            }
          : {}),
        ...(tool.options.contextProvider ? { contextProvider: true as const } : {}),
        inputSchema: toJsonSchema(tool.options.input, 'input'),
        ...(tool.options.output ? { outputSchema: toJsonSchema(tool.options.output) } : {}),
        ...manifestToolAnnotations(tool.options),
        ...(tool.options.visibility?.length ? { visibility: [...tool.options.visibility] } : {}),
        fulfilment: {
          steps: recorded.steps,
          output: recorded.output,
        },
      });
    }

    const resources: NonNullable<Manifest['resources']> = [];
    for (const resource of this.resources) {
      const recorded = await recordFulfilment(resource.options.fulfil, this.connectors, 'resource');
      resources.push({
        name: resource.name,
        uri: resource.options.uri,
        ...(resource.options.title ? { title: resource.options.title } : {}),
        ...(resource.options.description ? { description: resource.options.description } : {}),
        ...(resource.options.mimeType ? { mimeType: resource.options.mimeType } : {}),
        fulfilment: { steps: recorded.steps, output: recorded.output },
      });
    }

    const prompts: NonNullable<Manifest['prompts']> = [];
    for (const prompt of this.prompts) {
      const recorded = await recordFulfilment(prompt.options.fulfil, this.connectors, 'prompt');
      const args = derivePromptArguments(prompt.options.arguments);
      prompts.push({
        name: prompt.name,
        ...(prompt.options.title ? { title: prompt.options.title } : {}),
        ...(prompt.options.description ? { description: prompt.options.description } : {}),
        ...(args ? { arguments: args } : {}),
        fulfilment: { steps: recorded.steps, output: recorded.output },
      });
    }

    // Widgets are pure data (the compiler desugars each to a `ui://` resource + a tool `_meta` link).
    const widgets: NonNullable<Manifest['widgets']> = this.widgets.map((w) => ({
      name: w.name,
      tool: w.options.tool,
      ...(w.options.html !== undefined ? { html: w.options.html } : {}),
      ...(w.options.view !== undefined ? { view: { ...w.options.view } } : {}),
      ...(w.options.title ? { title: w.options.title } : {}),
      ...(w.options.description ? { description: w.options.description } : {}),
      ...(w.options.csp ? { csp: { ...w.options.csp } } : {}),
      ...(w.options.domain ? { domain: w.options.domain } : {}),
      ...(w.options.invoking ? { invoking: w.options.invoking } : {}),
      ...(w.options.invoked ? { invoked: w.options.invoked } : {}),
      ...(w.options.permissions ? { permissions: { ...w.options.permissions } } : {}),
    }));

    return {
      manifestVersion: '2',
      server: {
        name: this.name,
        version: this.options.version,
        title: this.options.title,
        ...(this.options.agentGuide
          ? { agentGuide: manifestAgentGuide(this.options.agentGuide) }
          : {}),
        ...(this.options.auth ? { auth: manifestCustomerAuth(this.options.auth) } : {}),
        ...(this.options.instructions ? { instructions: this.options.instructions } : {}),
        ...(invocationContext !== undefined ? { context: invocationContext } : {}),
        ...(this.options.interactions ? { interactions: this.options.interactions } : {}),
        ...(this.options.assistant ? { assistant: manifestAssistant(this.options.assistant) } : {}),
        ...(this.options.knowledge && this.options.knowledge.length > 0
          ? { knowledge: this.options.knowledge.map(manifestKnowledge) }
          : {}),
        ...collections.manifestCollections(this.options.collections, this.connectors),
        ...manifestVariables(this.options.variables),
        ...(this.options.branding ? { branding: this.options.branding } : {}),
        ...(this.options.shell ? { shell: manifestShell(this.options.shell) } : {}),
      },
      ...(this.options.handoff
        ? {
            handoff: {
              allowedDomains: this.options.handoff.allowedDomains.map((domain, index) =>
                isConfigRef(domain)
                  ? serializeVariableRef(domain, `server.handoff.allowedDomains.${index}`)
                  : domain,
              ),
            },
          }
        : {}),
      ...(this.options.state
        ? {
            state: {
              handles: Object.fromEntries(
                Object.entries(this.options.state.handles).map(([name, handle]) => [
                  name,
                  {
                    kind: handle.kind,
                    // `io:'input'` = the write/validate projection: `.default()`/`.optional()` fields
                    // drop out of `required`, so a patch relying on a default is not rejected.
                    schema: toJsonSchema(handle.schema, 'input'),
                    version: handle.version,
                    ...(handle.scope !== undefined ? { scope: handle.scope } : {}),
                    ...(handle.ttlSeconds !== undefined ? { ttlSeconds: handle.ttlSeconds } : {}),
                    ...(handle.claimOnAuthentication === true
                      ? { claimOnAuthentication: true as const }
                      : {}),
                  },
                ]),
              ),
            },
          }
        : {}),
      ...(Object.keys(this.connectors).length > 0
        ? {
            connectors: Object.fromEntries(
              Object.entries(this.connectors).map(([alias, c]) => [
                alias,
                toManifestConnectorRef(c),
              ]),
            ),
          }
        : {}),
      tools,
      ...(resources.length > 0 ? { resources } : {}),
      ...(prompts.length > 0 ? { prompts } : {}),
      ...(widgets.length > 0 ? { widgets } : {}),
    };
  }

  toConnectorCatalog(): ConnectorCatalogDoc | undefined {
    // `use ∪ provides` is the authoritative emit set: each connector carries its own fulfilment — an
    // HTTP/MCP transport def or compute definitions. Signature-only connectors are skipped.
    const connectors: ConnectorDef[] = [];
    const seen = new Set<string>();
    for (const c of [...Object.values(this.connectors), ...Object.values(this.provided)]) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);

      if (c.httpDef) {
        connectors.push(c.httpDef);
        continue;
      }
      if (c.mcpDef) {
        connectors.push(c.mcpDef);
        continue;
      }

      const definitions = c.definitions;
      if (definitions && Object.keys(definitions).length > 0) {
        const credentialProfiles = c.credentialProfiles;
        // Emit as a compute connector: `input`/`output` are the SDK-built JSON Schemas, re-validated by
        // `validateCatalog` below against the same connector-defs schema the service uses.
        const operations: ComputeConnectorDef['operations'] = {};
        for (const [name, def] of Object.entries(definitions)) {
          operations[name] = {
            type: def.type,
            input: def.input,
            output: def.output,
            code: def.code,
            ...(def.limits ? { limits: def.limits } : {}),
            ...(def.calls ? { calls: def.calls } : {}),
          };
        }
        const computeConnector: ComputeConnectorDef = {
          id: c.id,
          version: c.version,
          kind: 'custom',
          ...(credentialProfiles !== undefined ? { credentialProfiles } : {}),
          operations,
        };
        connectors.push(computeConnector);
      }
      // Otherwise the connector is signature-only (fulfilment resolved from an external catalog) — skip.
    }
    if (connectors.length === 0) return undefined;
    // Validate the merged document so an invalid catalog fails here, before any deploy request.
    return validateCatalog({ connectors });
  }
}

/**
 * Derive a prompt's argument descriptors. A Zod object's shape becomes one descriptor per key (its
 * `required` flag from whether the field is optional, its `description` from `.describe()`); an explicit
 * descriptor list passes through. The `arguments` are metadata for `prompts/list`; values arrive at
 * `prompts/get` and feed the fulfilment's `input` scope.
 */
function derivePromptArguments(
  args: PromptOptions['arguments'],
): Array<{ name: string; description?: string; required?: boolean }> | undefined {
  if (!args) return undefined;
  if (Array.isArray(args)) {
    return (args as readonly PromptArgument[]).map((a) => ({
      name: a.name,
      ...(a.description !== undefined ? { description: a.description } : {}),
      ...(a.required !== undefined ? { required: a.required } : {}),
    }));
  }
  if (args instanceof z.ZodObject) {
    const shape = args.shape as Record<string, z.ZodType>;
    return Object.entries(shape).map(([name, field]) => ({
      name,
      ...(field.description !== undefined ? { description: field.description } : {}),
      required: !field.isOptional(),
    }));
  }
  throw new Error('prompt arguments must be a Zod object or an explicit descriptor list');
}
