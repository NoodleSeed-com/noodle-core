import { describe, expect, it, vi } from 'vitest';
import {
  startWebMcpBridge,
  type WebMcpBridgeClient,
  type WebMcpModelContext,
  type WebMcpToolDescriptor,
} from '../src/webmcp-bridge.js';

/**
 * The bridge is deliberately DOM-free and port-shaped, for the same reason the client is: whether a
 * browser agent may call a governed tool is a decision that should be provable without a browser.
 * `packages/cli/test/webmcp-browser.test.ts` proves the real `document.modelContext` wiring.
 */

interface RecordedCall {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly options: Readonly<Record<string, unknown>> | undefined;
}

/** A `tools/list` result in the shape `mapToolsList` actually returns, `_meta` included. */
function toolsList(...tools: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { tools };
}

function tool(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    description: `does ${name}`,
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    ...extra,
  };
}

/**
 * Chrome's documented imperative API, which is the shape the bridge has to survive:
 * `await document.modelContext.registerTool(tool, { signal })`, resolving to nothing, with withdrawal
 * through the `AbortController` whose signal was passed in
 * (developer.chrome.com/docs/ai/webmcp/imperative-api, read 2026-09-06). No registration handle exists
 * anywhere in that surface, so a bridge that withdraws through one withdraws nothing.
 */
function fakeModelContext(refuse?: (name: string) => boolean): WebMcpModelContext & {
  readonly registered: WebMcpToolDescriptor[];
  /** The names a browser agent would still find registered right now. */
  live(): readonly string[];
} {
  const registered: WebMcpToolDescriptor[] = [];
  const live = new Set<string>();
  return {
    registered,
    live: () => [...live],
    async registerTool(descriptor, options) {
      if (refuse?.(descriptor.name)) throw new Error(`cannot register ${descriptor.name}`);
      registered.push(descriptor);
      live.add(descriptor.name);
      options?.signal?.addEventListener('abort', () => live.delete(descriptor.name));
    },
  };
}

function fakeClient(
  respond: (call: RecordedCall, options: RequestOptions | undefined) => Promise<unknown>,
): WebMcpBridgeClient & { readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    requestApp(method, params, options) {
      const call = {
        method,
        params,
        options: options?.bridge ? { bridge: options.bridge } : undefined,
      };
      calls.push(call);
      return respond(call, options);
    },
  };
}

interface RequestOptions {
  readonly bridge?: string;
  onSuspended?(): void;
}

const listOnly = (result: Record<string, unknown>) => async (call: RecordedCall) => {
  if (call.method === 'tools/list') return result;
  throw new Error(`unexpected method ${call.method}`);
};

describe('startWebMcpBridge', () => {
  it('does nothing at all when the browser exposes no WebMCP API', async () => {
    const client = fakeClient(listOnly(toolsList(tool('search'))));

    const bridge = await startWebMcpBridge({
      client,
      modelContext: undefined,
      enabled: true,
    });

    // Not even a tools/list: an absent API means there is nobody to register with, and a session
    // that has not been opened must not be spent discovering that.
    expect(client.calls).toEqual([]);
    expect(bridge.registeredToolNames).toEqual([]);
    expect(() => bridge.stop()).not.toThrow();
  });

  it('does nothing when the deployment has not opted in, even where the API exists', async () => {
    const client = fakeClient(listOnly(toolsList(tool('search'))));
    const modelContext = fakeModelContext();

    const bridge = await startWebMcpBridge({ client, modelContext, enabled: false });

    expect(client.calls).toEqual([]);
    expect(modelContext.registered).toEqual([]);
    expect(bridge.registeredToolNames).toEqual([]);
  });

  it('registers only tools that are both app-callable and model-visible', async () => {
    const client = fakeClient(
      listOnly(
        toolsList(
          // Omitted visibility means ['model','app'] — the common case.
          tool('search'),
          tool('book', { _meta: { ui: { visibility: ['model', 'app'] } } }),
          // App-only widget helper: tools/call would accept it, but it is deliberately hidden from
          // the model surface, and a browser agent is a model-shaped caller.
          tool('widget_refresh', { _meta: { ui: { visibility: ['app'] } } }),
          // Model-only: the apps bridge would 404 it, so registering it advertises a dead tool.
          tool('model_only', { _meta: { ui: { visibility: ['model'] } } }),
        ),
      ),
    );
    const modelContext = fakeModelContext();

    const bridge = await startWebMcpBridge({ client, modelContext, enabled: true });

    expect(bridge.registeredToolNames).toEqual(['search', 'book']);
    expect(modelContext.registered.map((entry) => entry.name)).toEqual(['search', 'book']);
  });

  it('passes the projected schema and readOnly annotation through without inventing either', async () => {
    const client = fakeClient(
      listOnly(
        toolsList(
          tool('search', { annotations: { readOnlyHint: true, destructiveHint: false } }),
          tool('book'),
        ),
      ),
    );
    const modelContext = fakeModelContext();

    await startWebMcpBridge({ client, modelContext, enabled: true });

    const [search, book] = modelContext.registered;
    expect(search?.inputSchema).toEqual({
      type: 'object',
      properties: { q: { type: 'string' } },
    });
    expect(search?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    // No annotations on the projected tool means none on the registration — never a fabricated
    // readOnlyHint, which a browser agent may use to decide it can call without asking.
    expect(book?.annotations).toBeUndefined();
  });

  it('executes through the apps bridge, marked so the call can be attributed', async () => {
    const client = fakeClient(async (call) => {
      if (call.method === 'tools/list') return toolsList(tool('search'));
      return { content: [{ type: 'text', text: 'two results' }], isError: false };
    });
    const modelContext = fakeModelContext();

    await startWebMcpBridge({ client, modelContext, enabled: true });
    const result = await modelContext.registered[0]?.execute({ q: 'shoes' });

    expect(client.calls[1]).toEqual({
      method: 'tools/call',
      params: { name: 'search', arguments: { q: 'shoes' } },
      options: { bridge: 'webmcp' },
    });
    expect(result).toEqual({
      content: [{ type: 'text', text: 'two results' }],
      isError: false,
    });
  });

  it('surfaces a confirmation instead of answering it, and never auto-accepts', async () => {
    const client = fakeClient(async (call, options) => {
      if (call.method === 'tools/list') return toolsList(tool('refund'));
      // What `requestApp` really does for a confirm-gated tool: raise the interaction so the panel
      // renders the confirmation card, then leave the promise pending until a human resolves it.
      options?.onSuspended?.();
      return new Promise<never>(() => {});
    });
    const modelContext = fakeModelContext();
    const respond = vi.fn();

    await startWebMcpBridge({ client, modelContext, enabled: true });
    const result = (await modelContext.registered[0]?.execute({ orderId: 'A1' })) as {
      isError?: boolean;
      content: readonly { readonly text: string }[];
    };

    // The agent gets a prompt answer rather than a hung tool call, and the human still decides.
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/confirmation required/i);
    expect(respond).not.toHaveBeenCalled();
  });

  it('reports a refused call as a tool error rather than throwing into the browser agent', async () => {
    const client = fakeClient(async (call) => {
      if (call.method === 'tools/list') return toolsList(tool('search'));
      throw new Error('Assistant app request failed (429)');
    });
    const modelContext = fakeModelContext();

    await startWebMcpBridge({ client, modelContext, enabled: true });
    const result = (await modelContext.registered[0]?.execute({})) as { isError?: boolean };

    expect(result.isError).toBe(true);
  });

  /**
   * Regression: the bridge used to watch the client's event stream, so any `tool_proposed` — from
   * another bridge call, or from the visitor's own conversation in the panel — satisfied every call
   * in flight. Correlation now runs through the per-request `onSuspended` callback.
   */
  it("answers each call from its own suspension, not another call's confirmation", async () => {
    const suspend: (() => void)[] = [];
    const client = fakeClient(async (call, options) => {
      if (call.method === 'tools/list') return toolsList(tool('refund'), tool('search'));
      if (call.params.name === 'refund') {
        if (options?.onSuspended) suspend.push(options.onSuspended);
        return new Promise<never>(() => {});
      }
      return { content: [{ type: 'text', text: 'two results' }], isError: false };
    });
    const modelContext = fakeModelContext();

    await startWebMcpBridge({ client, modelContext, enabled: true });
    const refund = modelContext.registered[0]?.execute({});
    const search = modelContext.registered[1]?.execute({});
    // The confirm-gated call suspends; the read-only call running alongside it must be unaffected.
    for (const resume of suspend) resume();

    expect(await search).toEqual({
      content: [{ type: 'text', text: 'two results' }],
      isError: false,
    });
    expect((await refund) as { isError?: boolean }).toMatchObject({ isError: true });
  });

  /**
   * Regression (#1464): the bridge modeled registration as returning a handle carrying `unregister()`.
   * Chrome returns no such handle, so `stop()` withdrew nothing and an expired session's tools stayed
   * visible to a browser agent until the page navigated.
   */
  it('withdraws every registration through its abort signal when the session is reset', async () => {
    const client = fakeClient(listOnly(toolsList(tool('search'), tool('book'))));
    const modelContext = fakeModelContext();

    const bridge = await startWebMcpBridge({ client, modelContext, enabled: true });
    expect(modelContext.live()).toEqual(['search', 'book']);

    bridge.stop();

    expect(modelContext.live()).toEqual([]);
    expect(bridge.registeredToolNames).toEqual([]);
  });

  it('reports only what the browser actually accepted, and rejects nothing into the page', async () => {
    const client = fakeClient(listOnly(toolsList(tool('search'), tool('book'))));
    // A browser may refuse one registration on its own terms — a name already taken by the host page,
    // a schema it will not accept. Registration is async there, so an unclaimed refusal would surface
    // as an unhandled rejection on a customer's page, which is exactly what this bridge must not do.
    const modelContext = fakeModelContext((name) => name === 'search');

    const bridge = await startWebMcpBridge({ client, modelContext, enabled: true });

    expect(bridge.registeredToolNames).toEqual(['book']);
    expect(modelContext.live()).toEqual(['book']);
  });

  it('stays silent when the session cannot list tools', async () => {
    const client = fakeClient(async () => {
      throw new Error('session expired');
    });
    const modelContext = fakeModelContext();

    const bridge = await startWebMcpBridge({ client, modelContext, enabled: true });

    // A page that cannot reach its assistant must not throw out of a lifecycle callback.
    expect(bridge.registeredToolNames).toEqual([]);
    expect(modelContext.registered).toEqual([]);
  });
});
