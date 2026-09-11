import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { LocalDevtoolsDelegatedCredentialSink } from '@noodle-borg/service/local';
import { handleDevtoolsAuthRoute } from './devtools-auth-routes.js';
import {
  DevtoolsAuthRequiredError,
  DevtoolsAuthSession,
  type DevtoolsCustomerAuth,
} from './devtools-auth-session.js';
import {
  type ChatMessage,
  type ChatProviderId,
  type ChatToolDef,
  DEFAULT_CHAT_MODELS,
  runProviderChatTurn,
} from './devtools-chat.js';
import type { DevtoolsDelegatedExchangeStatus } from './devtools-delegated-exchange-state.js';
import { type DesignRouteContext, handleDesignRoute } from './devtools-design-routes.js';
import {
  calculateRangeProgress,
  harnessHtml,
  openAiShimScript,
  type PreviewDevice,
  type PreviewTheme,
  wrapWidgetHtml,
} from './devtools-harness.js';
import { createDevtoolsRpcForwarder, type RpcLogEntry } from './devtools-rpc-forwarder.js';
import { isAutoSafeTool } from './devtools-tool-safety.js';

/**
 * `noodle devtools` preview server. It boots alongside a `dev` MCP endpoint and:
 *   - serves the three-pane harness shell (HTML/CSS/JS in `devtools-harness.ts`),
 *   - proxies + logs every JSON-RPC call through `/rpc`, capturing request/response for the inspector,
 *   - serves each widget's `ui://` HTML with a same-origin `window.openai` shim injected,
 *   - broadcasts a browser reload over `/reload` when devtools recompiles.
 * The MCP server already inlines the ext-apps bridge; the shim lets a widget's `callServerTool` become a
 * `fetch('/rpc')` the harness proxies and records, without reimplementing the ext-apps host protocol.
 */

export type { PreviewDevice, PreviewTheme };
// Re-exported so `devtools-preview` stays the single import surface for the command and tests.
export { calculateRangeProgress, harnessHtml, openAiShimScript, wrapWidgetHtml };

export interface PreviewOptions {
  readonly accessMode?: 'mixed' | 'customers';
  readonly mcpUrl: string;
  readonly theme: PreviewTheme;
  readonly device: PreviewDevice;
  readonly port?: number;
  readonly protocolVersion?: string;
  /** OpenAI model for the chat playground; falls back to `OPENAI_MODEL` then {@link DEFAULT_CHAT_MODELS}. */
  readonly openaiModel?: string;
  /** Anthropic model for the chat playground; falls back to `ANTHROPIC_MODEL`. */
  readonly anthropicModel?: string;
  /** Gemini model for the chat playground; falls back to `GEMINI_MODEL`. */
  readonly geminiModel?: string;
  /** Trusted local project context for Design Session persistence. Never sourced from browser input. */
  readonly design?: DesignRouteContext;
  /**
   * Isolate untrusted widgets from the credential-owning host. Enabled automatically for authenticated
   * previews; exposed here so the boundary can be tested independently.
   */
  readonly secureWidgets?: boolean;
  /** Sanitized customer-auth projection from the compiled local app. */
  readonly customerAuth?: DevtoolsCustomerAuth;
  /** In-process-only credential bridge supplied by `noodle dev`; never reachable from browser routes. */
  readonly delegatedCredentialSink?: LocalDevtoolsDelegatedCredentialSink;
  /** Live browser-safe local trust/status snapshot; read at request time across successful reloads. */
  readonly localDelegatedExchange?: () => DevtoolsDelegatedExchangeStatus | undefined;
  /** Live authored instructions for the assistant surface under preview. */
  readonly assistantInstructions?: () => string | undefined;
}

const CHAT_SYSTEM_PROMPT =
  'You are an assistant embedded in the Noodle Seed devtools playground. You can call the MCP tools ' +
  'exposed by the local server the developer is previewing. Call a tool whenever it can answer the ' +
  'request or render a widget, then explain the result briefly. Keep answers concise.';

export interface PreviewHandle {
  readonly url: string;
  readonly log: readonly RpcLogEntry[];
  /** Tell connected browsers to reload (refresh the tool list + re-fetch the open widget). */
  signalReload(): void;
  /** Rebind auth after a successful source reload; changing auth hard-reloads connected browsers. */
  updateCustomerAuth(auth: DevtoolsCustomerAuth | undefined): void;
  close(): Promise<void>;
}

const CHAT_PROVIDERS = ['openai', 'anthropic', 'gemini'] as const;
const CHAT_PROVIDER_CONFIG = {
  openai: {
    envName: 'OPENAI_API_KEY',
    modelEnvName: 'OPENAI_MODEL',
    baseUrlEnvName: 'OPENAI_BASE_URL',
  },
  anthropic: {
    envName: 'ANTHROPIC_API_KEY',
    modelEnvName: 'ANTHROPIC_MODEL',
    baseUrlEnvName: 'ANTHROPIC_BASE_URL',
  },
  gemini: {
    envName: 'GEMINI_API_KEY',
    modelEnvName: 'GEMINI_MODEL',
    baseUrlEnvName: 'GEMINI_BASE_URL',
  },
} as const;

function isChatProvider(value: unknown): value is ChatProviderId {
  return typeof value === 'string' && CHAT_PROVIDERS.includes(value as ChatProviderId);
}

/** Infer the provider from the API-key formats developers already recognize, without adding a picker. */
function detectChatProvider(key: string): ChatProviderId {
  if (key.startsWith('sk-ant-')) return 'anthropic';
  if (key.startsWith('AIza')) return 'gemini';
  return 'openai';
}

/** Parse the `/widget?args=` query param (a JSON object) into tool-call arguments; `{}` on absent/invalid. */
function parseArgsParam(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Parse a JSON request body only when its top-level value is an object. */
function parseJsonObject(raw: Buffer): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function startPreview(options: PreviewOptions): Promise<PreviewHandle> {
  const initialTheme: 'light' | 'dark' = options.theme === 'dark' ? 'dark' : 'light';
  let customerAuth = options.customerAuth;
  let secureWidgets = customerAuth !== undefined || options.secureWidgets === true;
  let rpcCapability = randomBytes(32).toString('base64url');
  let authCallbackPath = authCallbackPathFor(customerAuth);
  const log: RpcLogEntry[] = [];
  const subscribers = new Set<ServerResponse>();
  const reloadSubscribers = new Set<ServerResponse>();
  let localDelegatedExchangeRequired = options.localDelegatedExchange?.() !== undefined;
  let previewOrigin = '';
  let authSession: DevtoolsAuthSession | undefined;

  // Provider keys live ONLY in this server process (session) or the env, never in the browser. Authenticated
  // previews sandbox widget frames and require the parent-only capability on credential-using routes.
  const sessionApiKeys: Partial<Record<ChatProviderId, string>> = {};
  const sessionModels: Partial<Record<ChatProviderId, string>> = {};
  let activeChatProvider: ChatProviderId | undefined;
  function resolveApiKey(provider: ChatProviderId): string | undefined {
    return sessionApiKeys[provider] ?? process.env[CHAT_PROVIDER_CONFIG[provider].envName];
  }
  function apiKeySource(provider: ChatProviderId): 'session' | 'env' | 'none' {
    if (sessionApiKeys[provider]) return 'session';
    if (process.env[CHAT_PROVIDER_CONFIG[provider].envName]) return 'env';
    return 'none';
  }
  function configuredModel(provider: ChatProviderId): string {
    const optionModel =
      provider === 'openai'
        ? options.openaiModel
        : provider === 'anthropic'
          ? options.anthropicModel
          : options.geminiModel;
    return (
      sessionModels[provider] ??
      optionModel ??
      process.env[CHAT_PROVIDER_CONFIG[provider].modelEnvName] ??
      DEFAULT_CHAT_MODELS[provider]
    );
  }
  function providerStatus(provider: ChatProviderId) {
    return {
      hasKey: Boolean(resolveApiKey(provider)),
      source: apiKeySource(provider),
      envName: CHAT_PROVIDER_CONFIG[provider].envName,
      model: configuredModel(provider),
    };
  }
  function configuredChatProviders(): ChatProviderId[] {
    return CHAT_PROVIDERS.filter((provider) => providerStatus(provider).hasKey);
  }
  function resolveActiveChatProvider(): ChatProviderId | undefined {
    if (activeChatProvider && providerStatus(activeChatProvider).hasKey) {
      return activeChatProvider;
    }
    const configured = configuredChatProviders();
    if (configured.length === 1) return configured[0];
    if (configured.length === 0) return 'openai';
    return undefined;
  }
  function ambiguousProviderError():
    | { readonly code: 'ambiguous_provider'; readonly message: string }
    | undefined {
    if (resolveActiveChatProvider() !== undefined) return undefined;
    return {
      code: 'ambiguous_provider',
      message:
        'Multiple provider keys are configured. Paste one API key to choose this chat session.',
    };
  }

  function record(entry: RpcLogEntry): void {
    log.push(entry);
    if (log.length > 500) log.shift();
    const line = `data: ${JSON.stringify(entry)}\n\n`;
    for (const res of subscribers) res.write(line);
  }

  const forward = createDevtoolsRpcForwarder({
    mcpUrl: options.mcpUrl,
    ...(options.protocolVersion === undefined ? {} : { protocolVersion: options.protocolVersion }),
    authSession: () => authSession,
    optionalAuth: options.accessMode === 'mixed',
    record,
  });

  function signalReload(): void {
    // The setup panel is conditional shell markup, so only adding/removing it needs a page reload. Changes
    // within an existing delegated setup are read live from the status route and can preserve the widget.
    const nextLocalDelegatedExchangeRequired = options.localDelegatedExchange?.() !== undefined;
    const event =
      nextLocalDelegatedExchangeRequired === localDelegatedExchangeRequired ? 'reload' : 'hard';
    localDelegatedExchangeRequired = nextLocalDelegatedExchangeRequired;
    for (const res of reloadSubscribers) res.write(`data: ${event}\n\n`);
  }

  function updateCustomerAuth(auth: DevtoolsCustomerAuth | undefined): void {
    if (JSON.stringify(auth) === JSON.stringify(customerAuth)) return;
    authSession?.clear();
    customerAuth = auth;
    secureWidgets = auth !== undefined || options.secureWidgets === true;
    rpcCapability = randomBytes(32).toString('base64url');
    authCallbackPath = authCallbackPathFor(auth);
    authSession =
      auth === undefined
        ? undefined
        : new DevtoolsAuthSession({
            required: options.accessMode !== 'mixed',
            resource: options.mcpUrl,
            redirectUri: authRedirectUri(previewOrigin, authCallbackPath, auth),
            auth,
            ...(options.delegatedCredentialSink === undefined
              ? {}
              : { delegatedCredentialSink: options.delegatedCredentialSink }),
          });
    for (const res of reloadSubscribers) res.write('data: hard\n\n');
  }

  function hasExactHostCapability(req: IncomingMessage): boolean {
    const supplied = req.headers['x-noodle-devtools-capability'];
    if (typeof supplied !== 'string') return false;
    const expectedBytes = Buffer.from(rpcCapability);
    const suppliedBytes = Buffer.from(supplied);
    return (
      expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
    );
  }

  function hasHostCapability(req: IncomingMessage): boolean {
    return !secureWidgets || hasExactHostCapability(req);
  }

  function requiresHostCapability(method: string | undefined, pathname: string): boolean {
    if (method === 'GET') {
      return pathname === '/widget' || pathname === '/chat/status' || pathname === '/auth/status';
    }
    if (method !== 'POST') return false;
    return (
      pathname === '/rpc' ||
      pathname === '/chat' ||
      pathname === '/chat/key' ||
      pathname === '/auth/start' ||
      pathname === '/auth/logout'
    );
  }

  async function readWidget(
    toolNameParam: string,
    toolArguments: Record<string, unknown> = {},
  ): Promise<string> {
    const list = await forward({ method: 'tools/list', id: 'list', params: {} });
    if (list.httpStatus === 401) throw new DevtoolsAuthRequiredError();
    const tools = (list.json?.result?.tools as Array<Record<string, unknown>> | undefined) ?? [];
    const tool = tools.find((t) => t.name === toolNameParam);
    const uri = (tool?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri;
    if (uri === undefined) return '<!doctype html><p>No widget resource for this tool.</p>';
    const read = await forward({ method: 'resources/read', id: 'read', params: { uri } });
    if (read.httpStatus === 401) throw new DevtoolsAuthRequiredError();
    const contents =
      (read.json?.result?.contents as Array<Record<string, unknown>> | undefined) ?? [];
    const widgetHtml = typeof contents[0]?.text === 'string' ? (contents[0].text as string) : '';
    const call = await forward({
      method: 'tools/call',
      id: 'call',
      params: { name: toolNameParam, arguments: toolArguments },
    });
    if (call.httpStatus === 401) throw new DevtoolsAuthRequiredError();
    const toolResult = call.json?.result ?? null;
    const toolOutput = toolResult?.structuredContent ?? null;
    const toolResponseMetadata = (toolResult?._meta as Record<string, unknown> | undefined) ?? null;
    const shim = openAiShimScript({
      toolInput: toolArguments,
      toolOutput,
      toolResponseMetadata,
      toolResult,
      theme: initialTheme,
      // Keep one tool-call path in every preview so modern input-required continuations work
      // identically with and without the authenticated iframe sandbox.
      hostMediated: true,
    });
    return wrapWidgetHtml(widgetHtml, shim);
  }

  /** Project the live tool list into chat tool defs (carrying widget resourceUri for inline rendering). */
  async function chatToolDefs(): Promise<ChatToolDef[]> {
    const list = await forward({ method: 'tools/list', id: 'chat-list', params: {} });
    const tools = (list.json?.result?.tools as Array<Record<string, unknown>> | undefined) ?? [];
    return tools.filter(isAutoSafeTool).map((t) => {
      const resourceUri = (t._meta as { ui?: { resourceUri?: string } } | undefined)?.ui
        ?.resourceUri;
      return {
        name: String(t.name),
        ...(typeof t.description === 'string' ? { description: t.description } : {}),
        ...(t.inputSchema && typeof t.inputSchema === 'object'
          ? { inputSchema: t.inputSchema as Record<string, unknown> }
          : {}),
        ...(typeof resourceUri === 'string' ? { resourceUri } : {}),
      };
    });
  }

  /** Run one chat-playground turn against the local tools; the API key is read fresh and never logged. */
  async function handleChat(
    provider: ChatProviderId,
    incoming: ChatMessage[],
    apiKey: string,
    model?: string,
  ): Promise<unknown> {
    const authoredInstructions = options.assistantInstructions?.()?.trim();
    const systemPrompt =
      authoredInstructions === undefined || authoredInstructions === ''
        ? CHAT_SYSTEM_PROMPT
        : `${CHAT_SYSTEM_PROMPT}\n\nAssistant surface instructions:\n${authoredInstructions}`;
    const messages: ChatMessage[] =
      incoming[0]?.role === 'system'
        ? [
            {
              role: 'system',
              content: `${systemPrompt}\n\nAdditional playground instructions:\n${incoming[0].content}`,
            },
            ...incoming.slice(1),
          ]
        : [{ role: 'system', content: systemPrompt }, ...incoming];
    const baseUrl = process.env[CHAT_PROVIDER_CONFIG[provider].baseUrlEnvName];
    return runProviderChatTurn({
      provider,
      messages,
      tools: await chatToolDefs(),
      apiKey,
      model: model?.trim() || configuredModel(provider),
      ...(baseUrl ? { baseUrl } : {}),
      callTool: async (name, args) => {
        const request = {
          method: 'tools/call',
          id: 'chat-call',
          params: { name, arguments: (args as Record<string, unknown>) ?? {} },
        };
        let call = await forward(request);
        if (call.httpStatus === 401 && authSession && (await authSession.requestSignIn()))
          call = await forward(request);
        const result = call.json?.result ?? call.json?.error ?? null;
        const isError =
          call.json?.error !== undefined ||
          (call.json?.result as { isError?: boolean } | undefined)?.isError === true;
        return { result, isError };
      },
    });
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const delegatedExchangeStatusRoute =
      req.method === 'GET' && url.pathname === '/delegated-exchange/status';
    if (delegatedExchangeStatusRoute && !hasExactHostCapability(req)) {
      res.writeHead(403, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end('forbidden');
      return;
    }
    if (requiresHostCapability(req.method, url.pathname) && !hasHostCapability(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('forbidden');
      return;
    }
    if (delegatedExchangeStatusRoute) {
      const status = options.localDelegatedExchange?.();
      if (status === undefined) {
        res.writeHead(404, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      res.end(
        JSON.stringify({
          issuer: status.issuer,
          jwks: publicJwks(status.jwks),
          tenant: status.tenant,
          deployment: status.deployment,
          customerSignedIn: authSession?.status().state === 'signed_in',
          trustChanged: status.trustChanged,
          bindings: status.bindings.map((binding) => ({
            bindingKey: binding.bindingKey,
            connectorId: binding.connectorId,
            ...(binding.operation === undefined ? {} : { operation: binding.operation }),
            audience: binding.audience,
            verified: binding.verified,
          })),
        }),
      );
      return;
    }
    if (handleDevtoolsAuthRoute(req, res, url, authSession, previewOrigin, authCallbackPath)) {
      return;
    }
    if (!secureWidgets && handleDesignRoute(req, res, url, options.design)) return;
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        harnessHtml({
          ...options,
          rpcCapability,
          secureWidgets,
          authRequired: customerAuth !== undefined && options.accessMode !== 'mixed',
          authAvailable: customerAuth !== undefined,
          localDelegatedExchangeRequired: options.localDelegatedExchange?.() !== undefined,
        }),
      );
      return;
    }
    if (req.method === 'GET' && url.pathname === '/widget') {
      const name = url.searchParams.get('name') ?? '';
      readWidget(name, parseArgsParam(url.searchParams.get('args')))
        .then((html) => {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(html);
        })
        .catch((error: unknown) => {
          res.writeHead(error instanceof DevtoolsAuthRequiredError ? 401 : 502, {
            'content-type': 'text/html; charset=utf-8',
          });
          res.end('<!doctype html><p>Failed to load widget.</p>');
        });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/rpc/log') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.flushHeaders(); // open the stream immediately (headers otherwise wait for the first write)
      for (const entry of log) res.write(`data: ${JSON.stringify(entry)}\n\n`);
      subscribers.add(res);
      req.on('close', () => subscribers.delete(res));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/reload') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.flushHeaders(); // open the stream immediately so the client connects before the first event
      reloadSubscribers.add(res);
      req.on('close', () => reloadSubscribers.delete(res));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/chat/status') {
      // Report only whether each key is available, plus non-secret configuration. Never return a key.
      const activeProvider = resolveActiveChatProvider();
      const error = ambiguousProviderError();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          activeProvider: activeProvider ?? null,
          requiresKey: Boolean(error),
          error,
          providers: Object.fromEntries(
            CHAT_PROVIDERS.map((provider) => [provider, providerStatus(provider)]),
          ),
        }),
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/chat/key') {
      // Store the browser-supplied key in this process only (loopback). Set '' to clear it. Never logged.
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const body = parseJsonObject(Buffer.concat(chunks));
        if (!body) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'invalid_json', message: 'invalid JSON' } }));
          return;
        }
        const submittedKey = typeof body.key === 'string' ? body.key.trim() : '';
        const provider =
          submittedKey === ''
            ? (body.provider ?? resolveActiveChatProvider())
            : detectChatProvider(submittedKey);
        const ambiguity = ambiguousProviderError();
        if (submittedKey === '' && ambiguity) {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ambiguity }));
          return;
        }
        if (!isChatProvider(provider)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ error: { code: 'invalid_provider', message: 'invalid provider' } }),
          );
          return;
        }
        if (body.key !== undefined) {
          if (submittedKey === '') delete sessionApiKeys[provider];
          else sessionApiKeys[provider] = submittedKey;
        }
        const model = typeof body.model === 'string' ? body.model.trim() : '';
        if (model) sessionModels[provider] = model;
        if (resolveApiKey(provider)) activeChatProvider = provider;
        else if (activeChatProvider === provider) activeChatProvider = undefined;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, provider, ...providerStatus(provider) }));
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/chat') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const body = parseJsonObject(Buffer.concat(chunks));
        if (!body) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'invalid_json', message: 'invalid JSON' } }));
          return;
        }
        const requestedProvider = body.provider;
        if (requestedProvider !== undefined && !isChatProvider(requestedProvider)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ error: { code: 'invalid_provider', message: 'invalid provider' } }),
          );
          return;
        }
        const ambiguity = ambiguousProviderError();
        if (ambiguity) {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: ambiguity }));
          return;
        }
        const provider = resolveActiveChatProvider();
        if (!provider) {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                code: 'ambiguous_provider',
                message: 'Paste one API key to choose this chat session.',
              },
            }),
          );
          return;
        }
        if (requestedProvider !== undefined && requestedProvider !== provider) {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                code: 'provider_mismatch',
                message: 'The chat provider does not match the connected API key.',
              },
            }),
          );
          return;
        }
        // The key and inferred provider live server-side. The browser can only use the bound provider.
        const apiKey = resolveApiKey(provider);
        if (!apiKey) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                code: 'no_api_key',
                message: `No key set for this provider. Add one in Chat or set ${CHAT_PROVIDER_CONFIG[provider].envName}.`,
              },
            }),
          );
          return;
        }
        handleChat(
          provider,
          Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : [],
          apiKey,
          typeof body.model === 'string' ? body.model : undefined,
        )
          .then((result) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(result));
          })
          .catch((error: unknown) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                error: {
                  code: 'chat_failed',
                  message: error instanceof Error ? error.message : 'chat failed',
                },
              }),
            );
          });
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/rpc') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        let body: { method: string; id: unknown; params?: Record<string, unknown> };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON' }));
          return;
        }
        forward(body)
          .then(({ httpStatus, json }) => {
            res.writeHead(httpStatus, { 'content-type': 'application/json' });
            res.end(JSON.stringify(json ?? { error: 'empty response' }));
          })
          .catch((error: unknown) => {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: body.id,
                error: { message: error instanceof Error ? error.message : 'proxy error' },
              }),
            );
          });
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  await new Promise<void>((resolve, reject) => {
    // Reject on a bind failure (port in use, permission) so it surfaces as a catchable error instead of an
    // unhandled 'error' event that crashes the CLI and leaves this promise pending. Drop the listener on bind.
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  previewOrigin = `http://127.0.0.1:${port}`;
  if (customerAuth !== undefined) {
    authSession = new DevtoolsAuthSession({
      required: options.accessMode !== 'mixed',
      resource: options.mcpUrl,
      redirectUri: authRedirectUri(previewOrigin, authCallbackPath, customerAuth),
      auth: customerAuth,
      ...(options.delegatedCredentialSink === undefined
        ? {}
        : { delegatedCredentialSink: options.delegatedCredentialSink }),
    });
  }
  return {
    url: `${previewOrigin}/`,
    log,
    signalReload,
    updateCustomerAuth,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const res of subscribers) res.end();
        for (const res of reloadSubscribers) res.end();
        subscribers.clear();
        reloadSubscribers.clear();
        authSession?.clear();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

const PUBLIC_JWK_FIELDS = new Set([
  'kty',
  'use',
  'key_ops',
  'alg',
  'kid',
  'x5u',
  'x5c',
  'x5t',
  'x5t#S256',
  'crv',
  'x',
  'y',
  'n',
  'e',
]);

function publicJwks(jwks: DevtoolsDelegatedExchangeStatus['jwks']): { keys: object[] } {
  return {
    keys: jwks.keys.map((key) =>
      Object.fromEntries(Object.entries(key).filter(([field]) => PUBLIC_JWK_FIELDS.has(field))),
    ),
  };
}

function authCallbackPathFor(auth: DevtoolsCustomerAuth | undefined): string {
  return auth?.kind === 'microsoft'
    ? '/auth/callback/microsoft'
    : `/auth/callback/${randomBytes(24).toString('base64url')}`;
}

function authRedirectUri(
  previewOrigin: string,
  callbackPath: string,
  auth: DevtoolsCustomerAuth,
): string {
  if (auth.kind !== 'microsoft') return `${previewOrigin}${callbackPath}`;
  const preview = new URL(previewOrigin);
  return `http://localhost:${preview.port}${callbackPath}`;
}
