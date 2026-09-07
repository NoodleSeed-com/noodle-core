import type { RuntimeArtifact } from '@noodle-borg/compiler';
import { injectWidgetBridge } from '@noodle-borg/protocol';

const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

/** Safe renderer-facing identity for a completed tool that has a linked MCP App resource. */
export interface AssistantViewAvailableData {
  readonly id: string;
  readonly tool: string;
  readonly resourceUri: string;
  readonly title?: string;
  /** Already bounded/redacted public tool output. Never pass a raw runtime result here. */
  readonly result: unknown;
  readonly arguments?: unknown;
  /** Self-contained MCP App document, with the standard bridge injected by the protocol runtime. */
  readonly html: string;
  readonly resourceMeta?: Readonly<Record<string, unknown>>;
  readonly allowedOpenDomains?: readonly string[];
  readonly replayed?: true;
}

/** Persisted renderer descriptor: bounded public data only, never HTML or a resource body. */
export interface AssistantRecoverableView {
  readonly id: string;
  readonly tool: string;
  readonly result: unknown;
  readonly arguments?: unknown;
}

export function recoverableAssistantView(
  view: Pick<AssistantViewAvailableData, 'id' | 'tool' | 'result' | 'arguments'>,
): AssistantRecoverableView {
  return {
    id: view.id,
    tool: view.tool,
    result: structuredClone(view.result),
    ...(view.arguments === undefined ? {} : { arguments: structuredClone(view.arguments) }),
  };
}

/** A declared widget the completed tool could not surface — reported so the drop is never silent. */
export interface AssistantViewUnresolved {
  readonly tool: string;
  readonly resourceUri: string;
  readonly reason: 'resource_not_found' | 'resource_not_renderable';
}

/**
 * Resolve a self-contained, statically compiled MCP App document for the embedded host. The linked
 * resource must be present in the same compiled artifact and carry the MCP App MIME type; arbitrary
 * tool metadata therefore cannot turn this event into a browser navigation. A tool with no declared
 * `ui.resourceUri` resolves to `undefined` silently (no widget intended); a *declared* widget that
 * cannot be resolved additionally invokes `onUnresolved` so callers can log the drop — a blank or
 * missing widget must never be signal-free.
 */
export function assistantViewAvailableData(
  artifact: RuntimeArtifact,
  input: {
    readonly id: string;
    readonly tool: string;
    readonly result: unknown;
    readonly arguments?: unknown;
    readonly replayed?: true;
  },
  onUnresolved?: (failure: AssistantViewUnresolved) => void,
): AssistantViewAvailableData | undefined {
  const tool = artifact.tools.find((candidate) => candidate.name === input.tool);
  const resourceUri = tool?._meta?.ui?.resourceUri;
  if (typeof resourceUri !== 'string' || !resourceUri.startsWith('ui://')) return undefined;
  const resource = artifact.resources?.find(
    (candidate) => candidate.uri === resourceUri && candidate.mimeType === MCP_APP_MIME_TYPE,
  );
  if (!resource) {
    onUnresolved?.({ tool: input.tool, resourceUri, reason: 'resource_not_found' });
    return undefined;
  }
  const output = resource.fulfilment.kind === 'flow' ? resource.fulfilment.output.value : undefined;
  if (output?.kind !== 'literal' || typeof output.value !== 'string') {
    onUnresolved?.({ tool: input.tool, resourceUri, reason: 'resource_not_renderable' });
    return undefined;
  }
  return {
    id: input.id,
    tool: input.tool,
    resourceUri,
    ...(resource.title ? { title: resource.title } : {}),
    result: input.result,
    ...(input.arguments === undefined ? {} : { arguments: input.arguments }),
    html: injectWidgetBridge(resource.mimeType, output.value),
    ...(resource._meta?.ui === undefined
      ? {}
      : {
          resourceMeta: resource._meta.ui as unknown as Readonly<Record<string, unknown>>,
        }),
    ...(artifact.server.handoff === undefined
      ? {}
      : { allowedOpenDomains: [...artifact.server.handoff.allowedDomains] }),
    ...(input.replayed ? { replayed: true } : {}),
  };
}
