/**
 * Project this session's governed tools to the browser's agent (ADR 0220).
 *
 * WebMCP lets a page register tools an agent acting for the visitor can call. The ecosystem's default
 * shape is a page-local function that borrows whatever session the visitor already has; this bridge is
 * the governed version of the same idea, and it stays governed by construction rather than by care:
 * every call goes back out through `requestApp('tools/call', …)`, which is the same apps-bridge route,
 * session authentication, authorization, schema validation, and confirmation the assistant's own tool
 * calls take. There is no second dispatch path here to keep in agreement with the first.
 *
 * DOM-free and port-shaped on purpose. The browser API is reached only through {@link WebMcpModelContext},
 * so whether an agent may call a governed tool is provable without standing up a browser.
 */

/**
 * The bit of the W3C WebML CG draft (2026-07-28) this bridge depends on, in the shape Chrome documents
 * for its imperative API: registration is asynchronous, returns no handle, and is withdrawn by aborting
 * the signal it was given (developer.chrome.com/docs/ai/webmcp/imperative-api).
 */
export interface WebMcpModelContext {
  registerTool(
    descriptor: WebMcpToolDescriptor,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void> | void;
}

export interface WebMcpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly annotations?: Readonly<Record<string, unknown>>;
  execute(args: Readonly<Record<string, unknown>>): Promise<WebMcpToolResult>;
}

interface WebMcpToolResult {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  readonly isError?: boolean;
  readonly structuredContent?: Readonly<Record<string, unknown>>;
}

/** The slice of `AssistantClient` the bridge uses; narrowed so tests need no session or transport. */
export interface WebMcpBridgeClient {
  requestApp(
    method: string,
    params: Readonly<Record<string, unknown>>,
    options?: { readonly bridge?: string; onSuspended?(): void },
  ): Promise<unknown>;
}

export interface WebMcpBridgePorts {
  readonly client: WebMcpBridgeClient;
  /** Absent in every browser that has not shipped the origin trial — the common case. */
  readonly modelContext?: WebMcpModelContext | undefined;
  /** The deployment's opt-in. Off unless the author asked for it. */
  readonly enabled: boolean;
}

export interface WebMcpBridgeHandle {
  readonly registeredToolNames: readonly string[];
  /** Withdraw every registration. Safe to call more than once. */
  stop(): void;
}

const INERT: WebMcpBridgeHandle = { registeredToolNames: [], stop: () => {} };

export async function startWebMcpBridge(ports: WebMcpBridgePorts): Promise<WebMcpBridgeHandle> {
  const { client, modelContext, enabled } = ports;
  // Both gates before any request: a browser without the API has nobody to register with, and a
  // deployment that did not opt in must not spend a lazily-minted public session discovering that.
  if (!enabled || !modelContext) return INERT;

  let listed: unknown;
  try {
    listed = await client.requestApp('tools/list', {});
  } catch {
    // A page whose assistant is unreachable, expired, or out of budget still renders. Failing to
    // project tools is not an error the host page should have to catch in a lifecycle callback.
    return INERT;
  }

  // One controller for the whole projection, because every registration shares one lifetime: the
  // session's. Withdrawal is the abort, not a handle — Chrome returns none. Before Chrome 153 an abort
  // also cancels that tool's in-flight executions, which costs nothing here: the only caller of `stop()`
  // is a session that has expired or reset, so a call still in flight has already lost its authority.
  const controller = new AbortController();
  const attempts = projectableTools(listed).map(async (tool) => {
    await modelContext.registerTool(
      {
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
        // Passed through, never inferred: an agent may use `readOnlyHint` to decide it can call
        // without asking, so a hint this bridge invented would be a hint nobody authored.
        ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
        execute: (args) => executeThroughAssistant(client, tool.name, args),
      },
      { signal: controller.signal },
    );
    return tool.name;
  });

  // A browser may refuse one registration on its own terms — a name the host page already took, a
  // schema it will not accept. Settle all of them: an unclaimed refusal would otherwise surface as an
  // unhandled rejection on a customer's page, and one refusal must not cost the tools that did register.
  const outcomes = await Promise.allSettled(attempts);
  const registered = outcomes
    .filter((outcome): outcome is PromiseFulfilledResult<string> => outcome.status === 'fulfilled')
    .map((outcome) => outcome.value);

  let stopped = false;
  return {
    get registeredToolNames() {
      return stopped ? [] : [...registered];
    },
    stop() {
      if (stopped) return;
      stopped = true;
      controller.abort();
    },
  };
}

/**
 * Which projected tools may be registered.
 *
 * `_meta.ui.visibility` (SEP-1865) defaults to `['model','app']`. Two exclusions, for different
 * reasons: a tool that is not `app`-visible would be refused by `tools/call`, so registering it
 * advertises a dead tool; a tool that is not `model`-visible is an App-only widget helper that
 * `tools/list` still returns so an MCP Apps host can broker it while hiding it from the model — and a
 * browser agent is a model-shaped caller, so it stays hidden here too.
 */
interface ProjectableTool {
  readonly name: string;
  readonly description: string | undefined;
  readonly inputSchema: Record<string, unknown> | undefined;
  readonly annotations: Record<string, unknown> | undefined;
}

function projectableTools(listed: unknown): readonly ProjectableTool[] {
  const tools = isRecord(listed) && Array.isArray(listed.tools) ? listed.tools : [];
  const projectable: ProjectableTool[] = [];
  for (const tool of tools) {
    if (!isRecord(tool) || typeof tool.name !== 'string' || tool.name.length === 0) continue;
    const visibility = readVisibility(tool);
    if (visibility !== undefined && !(visibility.includes('app') && visibility.includes('model'))) {
      continue;
    }
    projectable.push({
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : undefined,
      inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : undefined,
      annotations: isRecord(tool.annotations) ? tool.annotations : undefined,
    });
  }
  return projectable;
}

function readVisibility(tool: Record<string, unknown>): readonly string[] | undefined {
  const meta = isRecord(tool._meta) ? tool._meta : undefined;
  const ui = meta && isRecord(meta.ui) ? meta.ui : undefined;
  const visibility = ui?.visibility;
  return Array.isArray(visibility)
    ? visibility.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
}

async function executeThroughAssistant(
  client: WebMcpBridgeClient,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<WebMcpToolResult> {
  // `requestApp` answers a confirm-gated tool by raising the interaction — which opens the panel's
  // confirmation card — and then leaving its promise pending until a human resolves it. `onSuspended`
  // fires for THIS request only, synchronously, before that promise can settle: racing the two is
  // therefore deterministic rather than timing-based, and cannot be satisfied by a confirmation
  // belonging to another bridge call or to the visitor's own conversation in the panel.
  let suspend!: () => void;
  const suspended = new Promise<void>((resolve) => {
    suspend = resolve;
  });

  try {
    const call = client.requestApp(
      'tools/call',
      { name, arguments: args },
      // Attribution only: anyone holding the session token could send this, and it selects a
      // *narrower* budget than the unmarked path, so declaring it can only cost the declarer.
      { bridge: 'webmcp', onSuspended: suspend },
    );
    // A suspended call settles later, when a human answers the card, with nobody waiting on it here.
    // Claim it so that resolution can never surface as an unhandled rejection on the page.
    void call.catch(() => {});
    const outcome = await Promise.race([
      call.then((value) => ({ kind: 'result' as const, value })),
      suspended.then(() => ({ kind: 'confirmation' as const })),
    ]);
    return outcome.kind === 'confirmation' ? CONFIRMATION_REQUIRED : toToolResult(outcome.value);
  } catch (error) {
    // Refusals are ordinary here — a spent budget, an expired session, a forbidden tool. An agent
    // reads a tool error; it must never receive an exception from the page's own bridge.
    return textResult(error instanceof Error ? error.message : 'tool call failed', true);
  }
}

/**
 * The bridge never accepts on the agent's behalf. Browser consent, where a user agent implements any,
 * is additive and is not relied upon: a confirm-gated tool still needs the human in the panel.
 */
const CONFIRMATION_REQUIRED: WebMcpToolResult = {
  content: [
    {
      type: 'text',
      text: 'confirmation required: open the assistant panel on this page to approve this action',
    },
  ],
  isError: true,
};

function toToolResult(value: unknown): WebMcpToolResult {
  // The apps route already answers in MCP tool-result shape; pass it through rather than re-wrapping,
  // so an agent sees exactly what any other MCP client would.
  if (isRecord(value) && Array.isArray(value.content)) return value as unknown as WebMcpToolResult;
  return textResult(JSON.stringify(value ?? null), false);
}

function textResult(text: string, isError: boolean): WebMcpToolResult {
  return { content: [{ type: 'text', text }], isError };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
