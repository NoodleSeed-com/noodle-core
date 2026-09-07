export interface DevtoolsToolLike {
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly openWorldHint?: boolean;
  };
}

export interface WidgetToolCallMessage {
  readonly requestId: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/**
 * Only tools that explicitly opt into every safety hint may be exposed to the playground's automatic
 * model loop. Missing hints are intentionally unsafe-by-default.
 */
export function isAutoSafeTool(tool: DevtoolsToolLike): boolean {
  const annotations = tool.annotations;
  return (
    annotations?.readOnlyHint === true &&
    annotations.destructiveHint === false &&
    annotations.openWorldHint === false
  );
}

/** Validate the narrow postMessage contract accepted from an untrusted widget frame. */
export function parseWidgetToolCallMessage(value: unknown): WidgetToolCallMessage | undefined {
  const isRecord = (candidate: unknown): candidate is Record<string, unknown> => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate))
      return false;
    const prototype = Object.getPrototypeOf(candidate);
    return prototype === Object.prototype || prototype === null;
  };
  if (!isRecord(value) || value.type !== 'noodle:tool-call') return undefined;
  if (
    typeof value.requestId !== 'string' ||
    value.requestId.length < 1 ||
    value.requestId.length > 128 ||
    typeof value.name !== 'string' ||
    value.name.length < 1 ||
    value.name.length > 256 ||
    !isRecord(value.arguments)
  ) {
    return undefined;
  }
  try {
    if (JSON.stringify(value.arguments).length > 65_536) return undefined;
  } catch {
    return undefined;
  }
  return {
    requestId: value.requestId,
    name: value.name,
    arguments: value.arguments,
  };
}
