import { sensitiveContentFinding } from '@noodle-borg/app-package';
import {
  CAPABILITY_NAMES,
  CAPABILITY_REQUIREMENT_NAMES,
  type CapabilityRequirementName,
  isCapabilityRequirementName,
  suggestCapabilityRequirementName,
} from '@noodle-borg/capabilities';
import {
  compileKnowledgeComponents,
  type KnowledgeCompileIssue,
  type KnowledgeComponentManifest,
} from '@noodle-borg/knowledge/portable';
import { parseUriTemplate } from '@noodle-borg/uri-template';
import { YAMLParseError } from 'yaml';
import {
  APP_PACKAGE_SENSITIVE_ERROR,
  compileAppPackagePreflighted,
  preflightAppPackageSensitiveContent,
} from './app-package/compile.js';
import { assembleRuntimeArtifact } from './artifact/assemble.js';
import {
  emitCatalogArtifactSurfaces,
  isContextProvider,
  type StructuralPrompt,
  type StructuralResource,
  type StructuralTool,
} from './artifact/catalog-emission.js';
import {
  type ArtifactMeta,
  type ArtifactResource,
  type JsonSchema,
  MCP_APP_MIME_TYPE,
  type RuntimeArtifact,
} from './artifact/types.js';
import {
  type HostedAssetOptions,
  type LocalAssetOptions,
  rewriteHostedAssets,
  rewriteLocalAssets,
} from './assets.js';
import { brandingWarnings, normalizeRuntimeBranding } from './branding.js';
import type { ConnectorCatalog } from './catalog/types.js';
import { validateInteractiveFlow } from './confirmation-flow.js';
import { parseAmbientContext } from './context-compile.js';
import type { CompileError, CompileResult, CompileWarning } from './errors.js';
import { findExternalRef, parseFulfilment } from './fulfilment-structural.js';
import { compileManagedCollections } from './managed-collections.js';
import { cspOriginFaults } from './manifest/csp-origins.js';
import { parseManifestDocument } from './manifest/parse-document.js';
import { type Manifest, manifestSchema } from './manifest/schema.js';
import { resolveSchemaUses } from './manifest/schema-refs.js';
import { validateWebsiteProjection } from './manifest/website-projection.js';
import { compileState } from './state-handles.js';
import { suggestionFields } from './suggest.js';
import { openAiWidgetCsp, withAssetResourceDomain } from './widget-compile-helpers.js';
import { resourceUiMeta, widgetHtml, widgetUri } from './widget-emit.js';
import { widgetHtmlSizeErrors } from './widget-size-validation.js';
import { translateIssue } from './zod-issue.js';

export interface CompileOptions {
  /**
   * Connector catalog used to resolve operation references. When supplied, the compiler resolves
   * every connector alias against the catalog and emits a `resolved` artifact (docs/SPEC.md
   * "Runtime Invariants"). When omitted, it emits a `shape-only` artifact whose operation
   * references are left unresolved and which a runtime must refuse to serve.
   */
  readonly catalog?: ConnectorCatalog;
  /** Local-only packaged asset resolver used by `noodle dev`. */
  readonly localAssets?: LocalAssetOptions;
  /** Hosted packaged asset resolver used after deploy preflight/upload verification. */
  readonly hostedAssets?: HostedAssetOptions;
  /**
   * Project root for reading declared knowledge documents (ADR 0202). When supplied, the compile
   * pass hashes and validates every `server.knowledge` document; when omitted, components must
   * already be in compiled (hashed) form.
   */
  readonly knowledgeFiles?: { readonly rootDir: string };
}

/**
 * Compile manifest source into a normalized runtime artifact.
 *
 * Pipeline: parse YAML -> validate static shape (Zod) -> structural passes (duplicate names,
 * `$use` schema resolution, external `$ref` rejection, fulfilment parsing — flow steps + `${...}`
 * expressions to AST) -> emit artifact. Expression and `$use` resolution are catalog-independent and
 * always run. With a catalog in {@link CompileOptions}, connector resolution follows (alias/operation
 * lookup, argument signature checks) and the artifact is `resolved`; without one it is `shape-only`
 * (only connector resolution deferred). Returns every error it can find rather than stopping at the
 * first. See docs/SPEC.md and docs/IMPLEMENTATION-LOG.md.
 */
export function compile(source: string, options: CompileOptions = {}): CompileResult {
  // 1. Parse the document (JSON-first; YAML fallback).
  let raw: unknown;
  try {
    raw = parseManifestDocument(source);
  } catch (err) {
    if (err instanceof YAMLParseError) {
      const pos = err.linePos?.[0];
      const where = pos ? ` at line ${pos.line}, column ${pos.col}` : '';
      return {
        ok: false,
        errors: [{ code: 'yaml_parse_error', path: '', message: `${err.message}${where}` }],
      };
    }
    throw err;
  }

  return compileManifest(raw, options);
}

/** Result of {@link validateManifest}: whether the manifest conforms, and any errors found. */
export interface ValidateResult {
  readonly ok: boolean;
  /** Empty when `ok` is true. The same {@link CompileError}s {@link compileManifest} would emit. */
  readonly errors: readonly CompileError[];
}

/**
 * Validate an already-materialized manifest **object** for authoring-contract conformance **without** a
 * connector catalog: Zod shape validation plus every catalog-independent structural pass (duplicate
 * names, `$use` resolution, external-`$ref` rejection, fulfilment + `${...}` expression parsing,
 * URI-template classification, resource/prompt namespacing). Connector-resolution errors (unknown
 * alias/operation, unused alias, argument signature) are **not** reported here — they require a catalog
 * and are produced by {@link compile} / {@link compileManifest} with `{ catalog }`.
 *
 * This is the stable, in-process contract a *machine* manifest generator targets: an object in,
 * structured {@link CompileError}s out (carrying GT-1's `didYouMean`/`expected`/`got` where relevant).
 * To also parse YAML, use {@link compile}; to resolve against a catalog, pass one to
 * {@link compileManifest}. See GT-2 in docs/STATUS.md. It is a faithful projection of
 * `compileManifest(raw)` — the artifact is dropped, the error set is identical.
 */
export function validateManifest(raw: unknown): ValidateResult {
  const result = compileManifest(raw);
  return result.ok ? { ok: true, errors: [] } : { ok: false, errors: result.errors };
}

/**
 * Compile an already-materialized manifest object into the same normalized runtime artifact emitted by
 * {@link compile}. This is the shared path for parsed control-plane data and TypeScript authoring
 * SDK output.
 */
export function compileManifest(raw: unknown, options: CompileOptions = {}): CompileResult {
  // 1. Validate static shape.
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'manifestVersion' in raw &&
    raw.manifestVersion !== '1' &&
    raw.manifestVersion !== '2'
  ) {
    return {
      ok: false,
      errors: [
        {
          code: 'unsupported_manifest_version',
          path: 'manifestVersion',
          message: "Unsupported manifest version. Expected '1' | '2'",
          expected: '1 | 2',
          got:
            typeof raw.manifestVersion === 'string'
              ? raw.manifestVersion
              : typeof raw.manifestVersion,
          docAnchor: 'compile-errors#unsupported-manifest-version',
        },
      ],
    };
  }
  const sourceAgentGuide = rawAgentGuide(raw);
  if (sourceAgentGuide !== undefined && sensitiveContentFinding(sourceAgentGuide) !== undefined) {
    return appPackageSensitiveFailure();
  }
  if (hasReservedModuleKey(raw)) {
    return {
      ok: false,
      errors: [
        {
          code: 'invalid_shape',
          path: 'modules',
          message:
            'tenant manifests cannot declare service modules; configure service capabilities outside the manifest',
        },
      ],
    };
  }
  const reserved = reservedVerbErrors(raw);
  if (reserved.length > 0) return { ok: false, errors: reserved };
  // `reportInput` retains the offending value on each issue so `translateIssue` can derive a `got`
  // field. Only the value's *type* (or a primitive enum literal) is ever emitted — never the raw value.
  const parsed = manifestSchema.safeParse(raw, { reportInput: true });
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map(translateIssue) };
  }
  if (preflightAppPackageSensitiveContent(parsed.data)) return appPackageSensitiveFailure();
  const assetRewrite =
    options.hostedAssets !== undefined
      ? rewriteHostedAssets(parsed.data, options.hostedAssets)
      : rewriteLocalAssets(parsed.data, options.localAssets);
  if (assetRewrite.errors.length > 0) return { ok: false, errors: assetRewrite.errors };
  const manifest = assetRewrite.manifest;
  const packagedAssets = assetRewrite.assets;
  const assetOrigin = assetRewrite.assetOrigin;
  const knowledgeIssues: KnowledgeCompileIssue[] = [];
  const knowledge = compileKnowledgeComponents(
    (manifest.server as { knowledge?: readonly KnowledgeComponentManifest[] }).knowledge ?? [],
    options.knowledgeFiles,
    knowledgeIssues,
  );
  if (knowledgeIssues.length > 0) return { ok: false, errors: knowledgeIssues };
  const runtimeBranding = normalizeRuntimeBranding(manifest.server.branding);
  const runtimeShell = manifest.server.shell as RuntimeArtifact['server']['shell'];

  // 2. Structural passes (catalog-independent): duplicate names, `$use` resolution, external refs,
  // fulfilment parsing. `$use` is resolved first so external-ref detection also scans bundled defs.
  const errors: CompileError[] = widgetHtmlSizeErrors(manifest, runtimeBranding);
  const managedCollections = compileManagedCollections(
    manifest.manifestVersion === '2' ? (manifest.server.collections ?? []) : [],
    manifest.tools.map((tool) => tool.name),
    errors,
  );
  const requirements = parseCapabilityRequirements(manifest.requires, errors);
  const seen = new Set<string>();
  const schemasMap = manifest.schemas ?? {};
  const structural: StructuralTool[] = [];
  const state = compileState(manifest, schemasMap, errors);
  const structuralAmbientContext = parseAmbientContext(manifest, schemasMap, errors);
  const contextProviders = manifest.tools.filter(isContextProvider);
  if (contextProviders.length > 1) {
    errors.push({
      code: 'invalid_context_provider',
      path: 'tools',
      message: 'exactly one tool may be designated as the context provider',
    });
  }

  manifest.tools.forEach((tool, i) => {
    if (
      manifest.manifestVersion === '1' &&
      manifest.server.context !== undefined &&
      tool.name === 'noodle_context'
    ) {
      errors.push({
        code: 'reserved_name',
        path: `tools.${i}.name`,
        message: `tool name "${tool.name}" is reserved by the platform`,
      });
    }
    if (seen.has(tool.name)) {
      errors.push({
        code: 'duplicate_name',
        path: `tools.${i}.name`,
        message: `duplicate tool name "${tool.name}"`,
      });
    }
    seen.add(tool.name);

    const input = resolveSchemaUses(tool.inputSchema, schemasMap, `tools.${i}.inputSchema`);
    errors.push(...input.errors);
    if (
      input.schema.properties !== null &&
      typeof input.schema.properties === 'object' &&
      Object.hasOwn(input.schema.properties, '__noodleIntent')
    ) {
      errors.push({
        code: 'reserved_name',
        path: `tools.${i}.inputSchema.properties.__noodleIntent`,
        message: 'input property "__noodleIntent" is reserved for the platform intent adapter',
      });
    }
    const inputExternalRef = findExternalRef(input.schema, `tools.${i}.inputSchema`);
    if (inputExternalRef) errors.push(inputExternalRef);
    if (isContextProvider(tool) && !isZeroInputObjectSchema(input.schema)) {
      errors.push({
        code: 'invalid_context_provider',
        path: `tools.${i}.inputSchema`,
        message: 'a context provider must be a zero-input object tool',
      });
    }

    let outputSchema: JsonSchema | undefined;
    if (tool.outputSchema) {
      const output = resolveSchemaUses(tool.outputSchema, schemasMap, `tools.${i}.outputSchema`);
      errors.push(...output.errors);
      const outputExternalRef = findExternalRef(output.schema, `tools.${i}.outputSchema`);
      if (outputExternalRef) errors.push(outputExternalRef);
      outputSchema = output.schema;
    }

    const fulfilment = parseFulfilment(tool.fulfilment, `tools.${i}.fulfilment`, errors);
    if (!fulfilment) return; // a structural fulfilment error was already recorded
    validateInteractiveFlow(tool, i, manifest.manifestVersion, errors);

    structural.push({
      tool,
      index: i,
      inputSchema: input.schema,
      ...(outputSchema ? { outputSchema } : {}),
      fulfilment,
    });
  });

  // Resources: separate name namespace, unique URIs, `{var}` template classification. Fulfilment may be
  // a steps-less flow (a static constant), so empty flows are allowed.
  const structResources: StructuralResource[] = [];
  const resourceSeen = new Set<string>();
  const resourceUriSeen = new Set<string>();
  (manifest.resources ?? []).forEach((resource, i) => {
    if (resourceSeen.has(resource.name)) {
      errors.push({
        code: 'duplicate_resource',
        path: `resources.${i}.name`,
        message: `duplicate resource name "${resource.name}"`,
      });
    }
    resourceSeen.add(resource.name);

    const parsedUri = parseUriTemplate(resource.uri);
    if (!parsedUri.ok) {
      errors.push({
        code: 'unsupported_uri_template',
        path: `resources.${i}.uri`,
        message: parsedUri.error,
      });
      return;
    }
    if (resourceUriSeen.has(resource.uri)) {
      errors.push({
        code: 'duplicate_resource_uri',
        path: `resources.${i}.uri`,
        message: `duplicate resource uri "${resource.uri}"`,
      });
    }
    resourceUriSeen.add(resource.uri);

    const fulfilment = parseFulfilment(resource.fulfilment, `resources.${i}.fulfilment`, errors);
    if (!fulfilment) return;

    structResources.push({
      resource,
      isTemplate: parsedUri.value.kind === 'template',
      variables: parsedUri.value.kind === 'template' ? parsedUri.value.variables : [],
      fulfilment,
    });
  });

  // Prompts: separate name namespace; fulfilment input scope is the supplied arguments.
  const structPrompts: StructuralPrompt[] = [];
  const promptSeen = new Set<string>();
  (manifest.prompts ?? []).forEach((prompt, i) => {
    if (promptSeen.has(prompt.name)) {
      errors.push({
        code: 'duplicate_prompt',
        path: `prompts.${i}.name`,
        message: `duplicate prompt name "${prompt.name}"`,
      });
    }
    promptSeen.add(prompt.name);

    const fulfilment = parseFulfilment(prompt.fulfilment, `prompts.${i}.fulfilment`, errors);
    if (!fulfilment) return;

    structPrompts.push({ prompt, fulfilment });
  });

  // Widgets (MCP Apps; ADR 0022): each links an existing tool and desugars to a fixed `ui://` resource.
  // Validate name uniqueness, the tool link, one-widget-per-tool, and that the synthesized resource
  // name/uri do not collide with a declared resource (widgets share the resources/list namespace). `seen`
  // holds the tool names accumulated above; `resourceSeen`/`resourceUriSeen` hold the declared resources.
  const widgetSeen = new Set<string>();
  const widgetToolSeen = new Set<string>();
  (manifest.widgets ?? []).forEach((widget, i) => {
    if (widgetSeen.has(widget.name)) {
      errors.push({
        code: 'duplicate_widget',
        path: `widgets.${i}.name`,
        message: `duplicate widget name "${widget.name}"`,
      });
    }
    widgetSeen.add(widget.name);

    if (!seen.has(widget.tool)) {
      // The actionable root cause is the missing tool; do not also flag a "duplicate link" below.
      errors.push({
        code: 'unknown_widget_tool',
        path: `widgets.${i}.tool`,
        message: `widget "${widget.name}" links unknown tool "${widget.tool}"`,
        got: widget.tool,
        ...suggestionFields('unknown_widget_tool', widget.tool, [...seen]),
      });
    } else {
      if (widgetToolSeen.has(widget.tool)) {
        errors.push({
          code: 'duplicate_widget_tool',
          path: `widgets.${i}.tool`,
          message: `tool "${widget.tool}" is already linked to a widget (a tool declares at most one widget)`,
        });
      }
      widgetToolSeen.add(widget.tool);
    }

    if (resourceSeen.has(widget.name)) {
      errors.push({
        code: 'duplicate_resource',
        path: `widgets.${i}.name`,
        message: `widget name "${widget.name}" collides with a declared resource name`,
      });
    }
    resourceSeen.add(widget.name);

    const uri = widgetUri(manifest.server.name, widget.name);
    if (resourceUriSeen.has(uri)) {
      errors.push({
        code: 'duplicate_resource_uri',
        path: `widgets.${i}.name`,
        message: `widget resource uri "${uri}" collides with a declared resource uri`,
      });
    }
    resourceUriSeen.add(uri);

    const linked = structural.find((s) => s.tool.name === widget.tool);
    const output = linked?.fulfilment.kind === 'flow' ? linked.fulfilment.output : undefined;
    if (output && Object.keys(output).length === 0) {
      errors.push({
        code: 'invalid_fulfilment',
        path: `tools.${linked?.index}.fulfilment.output`,
        message: `widget-linked tool "${widget.tool}" must return non-empty output so non-Apps hosts receive useful content`,
      });
    }
  });

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Desugar widgets to fixed `ui://` resources + a `_meta.ui.resourceUri` link on the named tool. The
  // `html` body is emitted as a constant `literal` expression — never run through the expression parser —
  // so inline `<script>` `${...}` in widget HTML stays opaque (it is not our mapping language).
  const widgetResources: ArtifactResource[] = (manifest.widgets ?? []).map((widget) => {
    const uri = widgetUri(manifest.server.name, widget.name);
    const uiMeta = withAssetResourceDomain(resourceUiMeta(widget), assetOrigin);
    const chatGptCsp = openAiWidgetCsp(uiMeta, manifest.handoff?.allowedDomains ?? []);
    // ChatGPT compat aliases on the widget resource `_meta`: the CSP (from `ui.csp`) and the widget
    // description (from the widget's own `description`, which the host reads as `openai/widgetDescription`).
    const chatGptMeta = {
      ...(chatGptCsp !== undefined ? { 'openai/widgetCSP': chatGptCsp } : {}),
      ...(widget.description !== undefined
        ? { 'openai/widgetDescription': widget.description }
        : {}),
    };
    const meta = {
      ...(uiMeta !== undefined ? { ui: uiMeta } : {}),
      ...chatGptMeta,
    };
    return {
      name: widget.name,
      uri,
      ...(widget.title ? { title: widget.title } : {}),
      ...(widget.description ? { description: widget.description } : {}),
      mimeType: MCP_APP_MIME_TYPE,
      isTemplate: false,
      fulfilment: {
        kind: 'flow',
        steps: [],
        output: {
          value: {
            kind: 'literal',
            value: widgetHtml(widget, {
              ...(runtimeBranding !== undefined ? { branding: runtimeBranding } : {}),
              ...(manifest.handoff !== undefined ? { policy: { handoff: manifest.handoff } } : {}),
            }),
          },
        },
      },
      ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
    };
  });
  const toolUiMetaByName = new Map<string, ArtifactMeta>(
    (manifest.widgets ?? []).map((widget) => [
      widget.tool,
      {
        ui: { resourceUri: widgetUri(manifest.server.name, widget.name) },
        'openai/outputTemplate': widgetUri(manifest.server.name, widget.name),
        // Host status copy for the widget-opening tool (ChatGPT reads these off the tool `_meta`).
        ...(widget.invoking !== undefined
          ? { 'openai/toolInvocation/invoking': widget.invoking }
          : {}),
        ...(widget.invoked !== undefined
          ? { 'openai/toolInvocation/invoked': widget.invoked }
          : {}),
      },
    ]),
  );

  // 3. Resolve connector references and emit per-tool fulfilment.
  const {
    artifactAmbientContext,
    artifactTools,
    artifactResources,
    artifactPrompts,
    declared,
    customerEndpoints,
  } = emitCatalogArtifactSurfaces({
    manifest,
    catalog: options.catalog,
    structuralAmbientContext,
    structuralTools: structural,
    structuralResources: structResources,
    structuralPrompts: structPrompts,
    toolUiMetaByName,
    errors,
  });

  errors.push(
    ...validateWebsiteProjection(manifest.server.assistant, {
      tools: artifactTools,
      resources: artifactResources,
      prompts: artifactPrompts,
      knowledge,
    }),
  );

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Widget `ui://` resources are appended after the hand-declared resources; both share the resources
  // surface (resources/list + resources/read), so widgets are served by the existing wire path.
  const allResources = [...artifactResources, ...widgetResources];

  const artifact = assembleRuntimeArtifact({
    manifest,
    options,
    runtimeBranding,
    runtimeShell,
    artifactAmbientContext,
    state,
    artifactTools,
    allResources,
    artifactPrompts,
    packagedAssets,
    requirements,
    declared,
    customerEndpoints,
    ...(knowledge.length > 0 ? { knowledge } : {}),
    ...(managedCollections.length > 0 ? { managedCollections } : {}),
  });

  const warnings = [
    ...brandingWarnings(manifest.server.branding),
    ...widgetCspWarnings(manifest.widgets),
  ];
  const appPackageResult = compileAppPackagePreflighted({
    manifest,
    artifact,
    sourceManifest: parsed.data,
  });
  if (appPackageResult.errors.length > 0) return { ok: false, errors: appPackageResult.errors };
  return {
    ok: true,
    artifact,
    ...(appPackageResult.appPackage === undefined
      ? {}
      : { appPackage: appPackageResult.appPackage }),
    ...(packagedAssets.length > 0 ? { localAssets: packagedAssets } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function rawAgentGuide(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.manifestVersion !== '2') return undefined;
  const server = record.server;
  if (server === null || typeof server !== 'object' || Array.isArray(server)) return undefined;
  return (server as Record<string, unknown>).agentGuide;
}

function appPackageSensitiveFailure(): CompileResult {
  return {
    ok: false,
    errors: [APP_PACKAGE_SENSITIVE_ERROR],
  };
}

/**
 * Non-fatal CSP diagnostics: a widget CSP origin the first-party host renderer will silently drop
 * (see {@link cspOriginFaults}). Emitted as a warning — never an error — so the local author loop
 * (`noodle dev`/`validate`/`test`) still compiles and renders the widget. The deploy route escalates
 * the same faults into a hard block (the one place selecting-to-ship is gated).
 */
function widgetCspWarnings(widgets: Manifest['widgets']): readonly CompileWarning[] {
  return cspOriginFaults(widgets).map((fault) => ({
    code: 'widget_csp_unhonorable_origin',
    path: `widgets.${fault.widgetIndex}.csp.${fault.list}.${fault.index}`,
    message:
      `widget "${fault.widget}" CSP ${fault.list} origin "${fault.value}" is not an absolute ` +
      `https:// origin and the host renderer will drop it` +
      (fault.suggestion !== undefined ? `; use "${fault.suggestion}"` : ''),
  }));
}

function hasReservedModuleKey(raw: unknown): boolean {
  return raw !== null && typeof raw === 'object' && Object.hasOwn(raw, 'modules');
}

/**
 * Step verbs named by the Core v1 spec but reserved for a future version (ADR 0150). `elicit` landed
 * as an additive v1.x verb; `compute` remains rejected here on the raw document with a typed error.
 */
const RESERVED_STEP_VERBS = ['compute'] as const;

function reservedVerbErrors(raw: unknown): CompileError[] {
  const errors: CompileError[] = [];
  if (raw === null || typeof raw !== 'object') return errors;
  const doc = raw as Record<string, unknown>;
  for (const block of ['tools', 'resources', 'prompts'] as const) {
    const items = doc[block];
    if (!Array.isArray(items)) continue;
    items.forEach((item, i) => {
      if (item === null || typeof item !== 'object') return;
      const fulfilment = (item as Record<string, unknown>).fulfilment;
      if (fulfilment === null || typeof fulfilment !== 'object') return;
      const steps = (fulfilment as Record<string, unknown>).steps;
      if (!Array.isArray(steps)) return;
      steps.forEach((step, m) => {
        if (step === null || typeof step !== 'object') return;
        for (const verb of RESERVED_STEP_VERBS) {
          if (Object.hasOwn(step, verb)) {
            errors.push({
              code: 'reserved_for_future_version',
              path: `${block}.${i}.fulfilment.steps.${m}.${verb}`,
              message: `"${verb}" is reserved for a future core version and is not accepted by Core v1`,
            });
          }
        }
      });
    });
  }
  return errors;
}

function parseCapabilityRequirements(
  requires: Manifest['requires'],
  errors: CompileError[],
): readonly CapabilityRequirementName[] {
  if (requires === undefined) return [];
  const requested = new Set<CapabilityRequirementName>();
  for (const [name, enabled] of Object.entries(requires)) {
    if (!enabled) continue;
    if (isCapabilityRequirementName(name)) {
      requested.add(name);
      continue;
    }
    const suggestion = suggestCapabilityRequirementName(name);
    errors.push({
      code: 'invalid_capability_requirement',
      path: `requires.${name}`,
      message: invalidCapabilityRequirementMessage(name),
      got: name,
      expected: CAPABILITY_REQUIREMENT_NAMES.join(', '),
      ...(suggestion !== undefined ? { didYouMean: suggestion } : {}),
    });
  }
  return CAPABILITY_REQUIREMENT_NAMES.filter((name) => requested.has(name));
}

function invalidCapabilityRequirementMessage(name: string): string {
  if ((CAPABILITY_NAMES as readonly string[]).includes(name)) {
    return `capability "${name}" is not a manifest-requirable infrastructure capability`;
  }
  if (name.includes('/') || name.startsWith('@')) {
    return `requires.${name} looks like a module package; manifests may require infrastructure capabilities only`;
  }
  return `unknown capability requirement "${name}"`;
}

function isZeroInputObjectSchema(schema: JsonSchema): boolean {
  if (schema.type !== 'object') return false;
  if (Array.isArray(schema.required) && schema.required.length > 0) return false;
  const properties = schema.properties;
  return (
    properties === undefined ||
    (typeof properties === 'object' && properties !== null && Object.keys(properties).length === 0)
  );
}
