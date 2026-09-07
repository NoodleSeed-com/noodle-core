import type {
  ArtifactPrompt,
  ArtifactResource,
  ArtifactTool,
  RuntimeArtifact,
} from '@noodle-borg/compiler';
import { splitResultMeta } from '@noodle-borg/runtime';
import {
  artifactDeclaresContext,
  assertNoContextToolCollision,
  CONTEXT_TOOL_DESCRIPTOR,
} from './context-tool.js';
import { projectIntentCaptureInput } from './intent-capture.js';
import type { JsonRpcErrorObject } from './jsonrpc.js';
import { filterAuthorizedTools, type ToolAuthorizationCaller } from './tool-authorization.js';
import {
  projectWidgetResourceMeta,
  type WidgetDomainProjection,
} from './widget/domain-projection.js';
import { injectWidgetBridge } from './widget/inject.js';

/**
 * Artifact → MCP wire mapping. The official `@modelcontextprotocol/sdk` owns JSON-RPC framing and
 * version negotiation; these helpers translate a resolved artifact's tools and a tool-execution outcome
 * into the SDK's result shapes (`tools/list`, `tools/call`). They are version-agnostic — the same
 * mapping serves any protocol version the SDK negotiates.
 */

/** An MCP tool descriptor (the `tools/list` item shape). */
export interface ToolDescriptor {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly annotations?: Record<string, unknown>;
  /** MCP `_meta` extension bag (e.g. MCP Apps `{ ui: { resourceUri } }` linking the tool to its widget). */
  readonly _meta?: Record<string, unknown>;
}

export interface ToolsListResult {
  readonly tools: readonly ToolDescriptor[];
  readonly nextCursor?: string;
}

/** An MCP text content block. Phase 1 emits only text blocks. */
export interface TextContent {
  readonly type: 'text';
  readonly text: string;
}

export interface ToolsCallResult {
  readonly content: readonly TextContent[];
  readonly structuredContent?: unknown;
  readonly isError: boolean;
  readonly _meta?: Record<string, unknown>;
}

/** A `tools/call` either yields a tool result (possibly `isError`) or a JSON-RPC protocol error. */
export type CallToolOutcome =
  | { readonly result: ToolsCallResult }
  | { readonly error: JsonRpcErrorObject };

export { mapExecutionError } from './execution-error-mapping.js';

/** Map a resolved artifact tool to an MCP tool descriptor (carrying its `_meta` extension bag, if any). */
export function mapTool(
  tool: ArtifactTool,
  options?: { readonly intentCapture?: boolean },
): ToolDescriptor {
  return {
    name: tool.name,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    description: tool.description,
    inputSchema: projectIntentCaptureInput(
      withPortableInteractionInput(tool),
      options?.intentCapture === true,
    ),
    ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
    ...(tool._meta !== undefined ? { _meta: tool._meta } : {}),
  };
}

const PORTABLE_INTERACTION_INPUT_SCHEMA = {
  type: 'object',
  title: 'Guided-input continuation',
  description:
    'Internal host adapter. Supply only when retrying an interaction_unavailable result from this exact tool.',
  properties: {
    responses: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['accept', 'decline', 'cancel'] },
          content: {},
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
  },
  required: ['responses'],
  additionalProperties: false,
} as const;

function withPortableInteractionInput(tool: ArtifactTool): Record<string, unknown> {
  if (
    tool.fulfilment.kind !== 'flow' ||
    !tool.fulfilment.steps.some((step) => step.kind === 'elicit')
  ) {
    return tool.inputSchema;
  }
  const properties =
    tool.inputSchema.properties !== null && typeof tool.inputSchema.properties === 'object'
      ? tool.inputSchema.properties
      : {};
  if (Object.hasOwn(properties, '__noodleInteraction')) return tool.inputSchema;
  return {
    ...tool.inputSchema,
    properties: {
      ...properties,
      __noodleInteraction: PORTABLE_INTERACTION_INPUT_SCHEMA,
    },
  };
}

/**
 * Map the artifact's tools to a `tools/list` result. App-only widget helpers remain discoverable here with
 * `_meta.ui.visibility: ['app']` so MCP Apps hosts can hide them from the model surface while still brokering
 * iframe-originated `callServerTool` requests. Visibility is not authorization; hosted policy gates the call.
 */
export function mapToolsList(
  artifact: RuntimeArtifact,
  caller?: ToolAuthorizationCaller,
  options?: { readonly knowledgeTools?: boolean; readonly intentCapture?: boolean },
): ToolsListResult {
  assertNoContextToolCollision(artifact);
  return {
    tools: [
      ...filterAuthorizedTools(artifact.tools, caller).map((tool) => mapTool(tool, options)),
      ...(artifactDeclaresContext(artifact) ? [CONTEXT_TOOL_DESCRIPTOR] : []),
      ...(options?.knowledgeTools === true
        ? knowledgeToolDescriptors(artifact, options?.intentCapture === true)
        : []),
    ],
  };
}

/** Generated `search_<name>` descriptors (ADR 0202 D4); listed only when the port is live. */
function knowledgeToolDescriptors(
  artifact: RuntimeArtifact,
  intentCapture = false,
): ToolsListResult['tools'] {
  return (artifact.server.knowledge ?? []).map((component) => ({
    name: component.generatedTool.name,
    description: component.generatedTool.description,
    inputSchema: projectIntentCaptureInput(
      component.generatedTool.inputSchema as Record<string, unknown>,
      intentCapture,
    ),
    outputSchema: component.generatedTool.outputSchema as Record<string, unknown>,
    // The generated tool only queries this deployment's bounded managed index. Classify it explicitly so
    // trusted clients can distinguish it from an unclassified or live open-web tool.
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }));
}

/**
 * Map a successful tool output to a `tools/call` result. Structured (object) output is returned as
 * `structuredContent` and also serialized into a text block (the spec asks for both, for clients
 * that do not read structured content).
 */
export function mapToolOutput(output: unknown): ToolsCallResult {
  const { visible, meta } = splitResultMeta(output);
  const text = typeof visible === 'string' ? visible : JSON.stringify(visible);
  const structured = visible !== null && typeof visible === 'object' && !Array.isArray(visible);
  return structured
    ? {
        content: [{ type: 'text', text }],
        structuredContent: visible,
        isError: false,
        ...(meta !== undefined ? { _meta: meta } : {}),
      }
    : {
        content: [{ type: 'text', text }],
        isError: false,
        ...(meta !== undefined ? { _meta: meta } : {}),
      };
}

const RESULT_META_KEY = '__noodleResultMeta';

export function redactWidgetLinkedOutput(output: unknown): unknown {
  return redactValue(output, 'value');
}

const SENSITIVE_KEY =
  /(?:authorization|bearer|token|refresh|secret|api[_-]?key|apikey|password|private[_-]?key|credential|cookie|set-cookie)/i;
const SENSITIVE_VALUE =
  /(?:Bearer\s+[A-Za-z0-9._~+/=-]+|sk-[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const REDACTED = '[REDACTED]';

function redactValue(value: unknown, key: string): unknown {
  if (SENSITIVE_KEY.test(key)) return REDACTED;
  if (typeof value === 'string') return SENSITIVE_VALUE.test(value) ? REDACTED : value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, key));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] =
        childKey === RESULT_META_KEY ||
        isSafeMissingSecretNames(childKey, childValue) ||
        isModelAuthoredDraftDocument(childKey, childValue)
          ? childValue
          : redactValue(childValue, childKey);
    }
    return out;
  }
  return value;
}

function isSafeMissingSecretNames(key: string, value: unknown): boolean {
  return (
    key === 'missingSecrets' &&
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && /^[A-Z0-9_]+$/.test(item))
  );
}

/**
 * Allowlist the string-valued draft documents `manifest` and `connectors` from value-level redaction.
 * These are documents the MODEL itself authored and round-trips back through set_draft — the model channel
 * is not a secrecy boundary for content the model wrote. Without this, prose like 'uses Bearer token auth'
 * inside a manifest matches the SENSITIVE_VALUE Bearer pattern and the WHOLE document collapses to
 * '[REDACTED]', which the model then writes back, destroying the draft. SENSITIVE_KEY redaction is
 * unchanged: a key actually named token/secret/apiKey/etc. is still redacted regardless of this allowlist
 * (it only spares the exact keys `manifest`/`connectors` when their value is a string).
 */
function isModelAuthoredDraftDocument(key: string, value: unknown): boolean {
  return (key === 'manifest' || key === 'connectors') && typeof value === 'string';
}

// ─── Resources ─────────────────────────────────────────────────────────────────

interface ResourceDescriptor {
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
  /** MCP `_meta` extension bag (e.g. a widget UI resource's `{ ui: { csp, permissions } }`). */
  readonly _meta?: Record<string, unknown>;
}

export interface ResourcesListResult {
  readonly resources: readonly ResourceDescriptor[];
}

interface ResourceTemplateDescriptor {
  readonly uriTemplate: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly _meta?: Record<string, unknown>;
}

export interface ResourceTemplatesListResult {
  readonly resourceTemplates: readonly ResourceTemplateDescriptor[];
}

export interface ResourceContent {
  readonly uri: string;
  readonly mimeType?: string;
  readonly text?: string;
  readonly blob?: string;
  /** The owning resource's `_meta` (hosts read widget CSP/domain here on `resources/read`). */
  readonly _meta?: Readonly<Record<string, unknown>>;
}

export interface ReadResourceResult {
  readonly contents: readonly ResourceContent[];
}

function descriptorFields(r: ArtifactResource): Omit<ResourceDescriptor, 'uri' | 'name'> {
  return {
    ...(r.title !== undefined ? { title: r.title } : {}),
    ...(r.description !== undefined ? { description: r.description } : {}),
    ...(r.mimeType !== undefined ? { mimeType: r.mimeType } : {}),
    ...(r._meta !== undefined ? { _meta: r._meta } : {}),
  };
}

/** Map the artifact's fixed (non-templated) resources to a `resources/list` result. */
export function mapResourcesList(artifact: RuntimeArtifact): ResourcesListResult {
  const resources = (artifact.resources ?? [])
    .filter((r) => !r.isTemplate)
    .map((r) => ({ uri: r.uri, name: r.name, ...descriptorFields(r) }));
  return { resources };
}

/** Map the artifact's templated resources to a `resources/templates/list` result. */
export function mapResourceTemplatesList(artifact: RuntimeArtifact): ResourceTemplatesListResult {
  const resourceTemplates = (artifact.resources ?? [])
    .filter((r) => r.isTemplate)
    .map((r) => ({ uriTemplate: r.uri, name: r.name, ...descriptorFields(r) }));
  return { resourceTemplates };
}

/**
 * Map an executed resource's output to `resources/read` contents. The fulfilment output is the
 * single-key `{ value }` wrapper (the authoring convention); `value` is interpreted as: a string → a
 * text content with the resource's mime type; an object with `text` or `blob` → that content verbatim;
 * anything else → a JSON-serialized text content.
 */
export function mapResourceContents(
  uri: string,
  mimeType: string | undefined,
  output: unknown,
  meta?: Readonly<Record<string, unknown>>,
  widgetDomain?: WidgetDomainProjection,
): ReadResourceResult {
  const value = unwrap(output);
  // Hosts read widget capability metadata (`ui.csp`, `ui.domain`, `openai/widgetCSP`) from the read
  // contents item, not only the resources/list entry — ChatGPT treats a read result without it as
  // "CSP not set" — so the resource's `_meta` rides on every contents item.
  const projectedMeta =
    meta === undefined ? undefined : projectWidgetResourceMeta(meta, widgetDomain);
  const withMeta = (content: ResourceContent): ResourceContent =>
    projectedMeta !== undefined ? { ...content, _meta: projectedMeta } : content;
  // For an MCP Apps widget (`text/html;profile=mcp-app`), inject the ext-apps client bridge into the body
  // so the host renders it (a no-op for every other mime type). See ./widget/inject.ts.
  const withMime = (text: string): ResourceContent => {
    const body = injectWidgetBridge(mimeType, text);
    return withMeta(mimeType !== undefined ? { uri, mimeType, text: body } : { uri, text: body });
  };

  if (typeof value === 'string') return { contents: [withMime(value)] };
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.text === 'string') return { contents: [withMime(o.text)] };
    if (typeof o.blob === 'string') {
      const mt = typeof o.mimeType === 'string' ? o.mimeType : mimeType;
      return {
        contents: [
          withMeta(mt !== undefined ? { uri, mimeType: mt, blob: o.blob } : { uri, blob: o.blob }),
        ],
      };
    }
    // A `fulfil` that returns the MCP read-result wrapper `{ contents: [...] }` double-wraps: the
    // runtime already maps the return INTO `contents`, so JSON-stringifying this shape would put the
    // whole `{"contents":[...]}` blob into contents[0].text. Fail loudly instead. Scoped to an array
    // `contents` so a plain data object with a scalar `contents` field stays JSON-serialized.
    if (Array.isArray(o.contents)) {
      throw new Error(
        'resource fulfil returned a { contents: [...] } wrapper; return the bare content entry ' +
          '`{ uri, mimeType, text }` or a plain string — the runtime maps your return into `contents`.',
      );
    }
  }
  return { contents: [withMime(JSON.stringify(value))] };
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

interface PromptArgumentDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly required?: boolean;
}

interface PromptDescriptor {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly arguments?: readonly PromptArgumentDescriptor[];
}

export interface PromptsListResult {
  readonly prompts: readonly PromptDescriptor[];
}

export interface PromptMessage {
  readonly role: 'user' | 'assistant';
  readonly content: { readonly type: 'text'; readonly text: string };
}

export interface GetPromptResult {
  readonly description?: string;
  readonly messages: readonly PromptMessage[];
}

/** Map the artifact's prompts to a `prompts/list` result. */
export function mapPromptsList(artifact: RuntimeArtifact): PromptsListResult {
  const prompts = (artifact.prompts ?? []).map((p: ArtifactPrompt) => ({
    name: p.name,
    ...(p.title !== undefined ? { title: p.title } : {}),
    ...(p.description !== undefined ? { description: p.description } : {}),
    ...(p.arguments
      ? {
          arguments: p.arguments.map((a) => ({
            name: a.name,
            ...(a.description !== undefined ? { description: a.description } : {}),
            ...(a.required !== undefined ? { required: a.required } : {}),
          })),
        }
      : {}),
  }));
  return { prompts };
}

/**
 * Map an executed prompt's output to `prompts/get` messages. `value` (unwrapped from `{ value }`) is
 * interpreted as: a string → one `user` text message; an array of `{ role, text }` (or wire-shaped
 * messages) → those messages; an object with `messages` → those; otherwise → one `user` JSON message.
 */
export function mapPromptMessages(output: unknown, description?: string): GetPromptResult {
  const messages = toMessages(unwrap(output));
  return description !== undefined ? { description, messages } : { messages };
}

function toMessages(value: unknown): PromptMessage[] {
  if (typeof value === 'string') return [userText(value)];
  if (Array.isArray(value)) return value.map(normalizeMessage);
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (Array.isArray(o.messages)) return o.messages.map(normalizeMessage);
    if (typeof o.text === 'string') return [userText(o.text)];
  }
  return [userText(JSON.stringify(value))];
}

function normalizeMessage(raw: unknown): PromptMessage {
  const m = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const role = m.role === 'assistant' ? 'assistant' : 'user';
  const content = m.content as { text?: unknown } | undefined;
  const text =
    typeof m.text === 'string'
      ? m.text
      : typeof content?.text === 'string'
        ? content.text
        : JSON.stringify(raw);
  return { role, content: { type: 'text', text } };
}

function userText(text: string): PromptMessage {
  return { role: 'user', content: { type: 'text', text } };
}

/** Unwrap the `{ value }` fulfilment-output wrapper used by resources/prompts; pass through otherwise. */
function unwrap(output: unknown): unknown {
  if (
    output !== null &&
    typeof output === 'object' &&
    !Array.isArray(output) &&
    'value' in output
  ) {
    return (output as { value: unknown }).value;
  }
  return output;
}
