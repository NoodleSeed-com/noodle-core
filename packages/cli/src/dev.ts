import { createHash, randomBytes } from 'node:crypto';
import { type FSWatcher, readFileSync, watch } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import {
  Client,
  type InputResponse,
  type ProtocolEra,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { publicSurfaceOf } from '@noodle-borg/assistant-gateway/portable';
import { compileConnectors } from '@noodle-borg/connector-defs';
import { prepareKnowledgeDocumentsForDeploy } from '@noodle-borg/deploy-client';
import {
  type ConfirmationNonceLedger,
  MODERN_MCP_PROTOCOL_VERSION,
  RequestStateManager,
  requestStateSecretBox,
} from '@noodle-borg/protocol';
import {
  type LocalDevtoolsDelegatedCredentialSink,
  type LocalDevtoolsDelegatedExchangeBindingProjection,
  projectLocalDevtoolsDelegatedExchangeBindings,
  type RunningService,
  resolveConfigScope,
  resolveTenantBridgeAuthVariables,
  serveService,
  type TenantAuthConfig,
  type TenantBridgeAuthConfig,
} from '@noodle-borg/service/local';
import type { JSONWebKeySet } from 'jose';
import { manifestDeclaresServerAuth, readDeployInput, slug } from './deploy.js';
import { createDevLocalRuntime } from './dev-local-runtime.js';
import type { DevtoolsCustomerAuth } from './devtools-auth-session.js';
import {
  createLocalDevtoolsDelegatedExchangeAuthority,
  LocalDevtoolsDelegatedExchangeAuthorityError,
} from './devtools-delegated-exchange-authority.js';
import {
  createDevtoolsDelegatedExchangeState,
  type DevtoolsDelegatedExchangeStatus,
} from './devtools-delegated-exchange-state.js';
import { createLocalDevConfigStore } from './local-config.js';
import { reactWidgetWatchDirectories } from './react-widget-build.js';
import { startSpinner } from './status.js';

const protocolEraByOrigin = new Map<string, ProtocolEra>();

class LocalConfirmationNonceLedger implements ConfirmationNonceLedger {
  readonly #consumed = new Map<string, number>();

  async consume(nonce: string, expiresAt: number): Promise<boolean> {
    const now = Date.now();
    for (const [candidate, expiry] of this.#consumed) {
      if (expiry <= now) this.#consumed.delete(candidate);
    }
    if (expiresAt <= now || this.#consumed.has(nonce)) return false;
    this.#consumed.set(nonce, expiresAt);
    return true;
  }
}

export interface DevOptions {
  /** Local access override; declared auth defaults to customers. */
  readonly accessMode?: 'mixed' | 'customers';
  readonly manifestPath: string;
  readonly connectorsPath?: string;
  readonly org?: string;
  readonly app?: string;
  readonly env?: string;
  /** Local port; default `0` (OS-assigned). */
  readonly port?: number;
  /** Enable the readline "exercise a tool" prompt; defaults to whether stdin is a TTY. */
  readonly interactive?: boolean;
  /** Watch the input files and hot-reload on change; default `true`. Tests disable it and call `reload()`. */
  readonly watch?: boolean;
  /** Output sink; defaults to `console.log`. */
  readonly log?: (message: string) => void;
  /** Exact project root used for local `.env` fallback; defaults to the invocation directory. */
  readonly projectRoot?: string;
  /** Internal test/self-host seam for an HTTP loopback customer issuer. */
  readonly customerVerifierAllowInsecureLocalhost?: boolean;
  /** Internal test seam for locally signed Firebase ID tokens. */
  readonly customerVerifierFirebaseJwks?: JSONWebKeySet;
  /** Internal child-process test seam for a loopback Firebase JWKS endpoint. */
  readonly customerVerifierFirebaseJwksUri?: string;
}

export interface DevReloadResult {
  readonly ok: boolean;
  /** Tool names exposed after a successful reload. */
  readonly toolNames?: readonly string[];
  /** Process-local public embed id when the active app declares a public assistant surface. */
  readonly embedId?: string;
  /** Compile errors when the reload failed (the prior good server keeps serving). */
  readonly errors?: ReadonlyArray<{
    code: string;
    path: string;
    message: string;
    didYouMean?: string;
  }>;
}

export interface DevHandle {
  /** The tenant MCP URL the dev server serves. */
  readonly url: string;
  /** The local service origin. */
  readonly origin: string;
  /**
   * The result of the initial (boot) deploy. When `ok` is false the endpoint serves nothing — most
   * commonly because a connector `secret(...)` was unresolved (`missing_secret`), which otherwise
   * surfaces only as an opaque `-32600 "not found"` on the loopback. Callers inspect this to report the
   * real cause instead of a generic smoke failure.
   */
  readonly boot: DevReloadResult;
  /** Recompile + re-serve the manifest. */
  reload(): Promise<DevReloadResult>;
  /** Current credential-host-only customer-auth projection for the attached Devtools preview. */
  customerAuth(): DevtoolsCustomerAuth | undefined;
  /** Current authored assistant-surface instructions for a faithful local chat preview. */
  assistantInstructions(): string | undefined;
  /** In-process-only delegated credential sink for the attached preview auth session. */
  delegatedCredentialSink(): LocalDevtoolsDelegatedCredentialSink | undefined;
  /** Browser-safe local delegated-exchange setup/status, absent when the app has no such binding. */
  localDelegatedExchange(): DevtoolsDelegatedExchangeStatus | undefined;
  /** Stop watching, close the prompt, and shut the local server down. */
  close(): Promise<void>;
}

/** A default app slug that prefers the containing directory when the file is a generic `manifest`/`server`. */
function defaultApp(manifestPath: string): string {
  const base = basename(manifestPath, extname(manifestPath));
  if (base === 'manifest' || base === 'server' || base === 'index') {
    const dir = dirname(resolve(manifestPath));
    return basename(basename(dir) === 'src' ? dirname(dir) : dir);
  }
  return base;
}

function buildMcpUrl(origin: string, org: string, app: string, env: string): string {
  return env === 'prod' ? `${origin}/o/${org}/${app}/mcp` : `${origin}/o/${org}/${app}/${env}/mcp`;
}

/** One automatically-negotiated MCP operation against the local dev endpoint. */
export async function localMcpCall(
  endpoint: string,
  method: string,
  params: Record<string, unknown>,
): Promise<{
  status: number;
  body: { result?: unknown; error?: unknown } | undefined;
  protocol?: { readonly era: ProtocolEra; readonly version: string };
}> {
  const origin = new URL(endpoint).origin;
  const knownEra = protocolEraByOrigin.get(origin);
  const client = new Client(
    { name: 'noodle-author-loop', version: '1.0.0' },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: {
        mode:
          knownEra === 'modern'
            ? { pin: MODERN_MCP_PROTOCOL_VERSION }
            : knownEra === 'legacy'
              ? 'legacy'
              : 'auto',
      },
      inputRequired: { autoFulfill: false },
    },
  );
  const transport = new StreamableHTTPClientTransport(new URL(endpoint));
  try {
    await client.connect(transport);
    const era = client.getProtocolEra();
    const version = client.getNegotiatedProtocolVersion();
    if (era) protocolEraByOrigin.set(origin, era);
    const protocol = era && version ? { era, version } : undefined;
    const result = await localOperation(client, method, params);
    return { status: 200, body: { result }, ...(protocol ? { protocol } : {}) };
  } catch (error) {
    const value = error as {
      readonly code?: unknown;
      readonly message?: unknown;
      readonly data?: unknown;
    };
    return {
      status: 400,
      body: {
        error: {
          code: typeof value.code === 'number' ? value.code : -32603,
          message: typeof value.message === 'string' ? value.message : 'MCP operation failed',
          ...(value.data !== undefined ? { data: value.data } : {}),
        },
      },
    };
  } finally {
    await client.close().catch(() => {});
  }
}

async function localOperation(
  client: Client,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (method === 'initialize') {
    return {
      protocolVersion: client.getNegotiatedProtocolVersion(),
      serverInfo: client.getServerVersion(),
      capabilities: client.getServerCapabilities(),
    };
  }
  if (method === 'tools/list') return client.listTools();
  if (method === 'tools/call') {
    const requestState = params.requestState;
    const inputResponses = params.inputResponses;
    return client.callTool(
      {
        name: stringParam(params, 'name'),
        arguments: recordParam(params, 'arguments'),
        ...(typeof requestState === 'string' ? { requestState } : {}),
        ...(isRecord(inputResponses)
          ? {
              inputResponses: inputResponses as Readonly<Record<string, InputResponse>>,
            }
          : {}),
      },
      { allowInputRequired: true },
    );
  }
  if (method === 'resources/list') return client.listResources();
  if (method === 'resources/templates/list') return client.listResourceTemplates();
  if (method === 'resources/read') {
    return client.readResource({ uri: stringParam(params, 'uri') });
  }
  if (method === 'prompts/list') return client.listPrompts();
  if (method === 'prompts/get') {
    return client.getPrompt({
      name: stringParam(params, 'name'),
      arguments: stringRecordParam(params, 'arguments'),
    });
  }
  throw new Error(`Unsupported local MCP method: ${method}`);
}

function stringParam(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function recordParam(params: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = params[name];
  return isRecord(value) ? value : {};
}

function stringRecordParam(params: Record<string, unknown>, name: string): Record<string, string> {
  const value = recordParam(params, name);
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== 'string')) {
    throw new Error(`${name} values must be strings`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Boot the Noodle runtime **in-process** on loopback (auth-open, in-memory — no Postgres, no master key),
 * serve a single manifest at a stable local MCP URL, and hot-reload it on file change. The optional readline
 * prompt exercises **this** dev server (a single in-process MCP call); it
 * is not a general client. Designed for the author inner loop — `wrangler dev` for Noodle servers.
 */
export async function dev(options: DevOptions): Promise<DevHandle> {
  const log = options.log ?? ((m: string) => console.log(m));
  const org = slug(options.org ?? 'local');
  const app = slug(options.app ?? defaultApp(options.manifestPath));
  const env = slug(options.env ?? 'dev');
  const projectRoot = options.projectRoot ?? process.cwd();
  const configStore = createLocalDevConfigStore(projectRoot);
  const delegatedExchangeAuthority = createLocalDevtoolsDelegatedExchangeAuthority(projectRoot);
  const delegatedExchangeState = createDevtoolsDelegatedExchangeState();
  const configScope = resolveConfigScope({ org, app, env });
  const allowInsecureCustomerIssuer =
    options.customerVerifierAllowInsecureLocalhost === true ||
    process.env.NOODLE_CUSTOMER_IDP_ALLOW_INSECURE_LOCALHOST === '1' ||
    process.env.NOODLE_CUSTOMER_IDP_ALLOW_INSECURE_LOCALHOST === 'true';
  const firebaseJwksUri =
    options.customerVerifierFirebaseJwksUri ??
    (allowInsecureCustomerIssuer ? process.env.NOODLE_CUSTOMER_FIREBASE_JWKS_URI : undefined);
  const localRuntime = createDevLocalRuntime();

  // Branded boot spinner — only for the default stdout sink on an interactive TTY (injected-log callers unaffected).
  const bootStatus =
    options.log === undefined && process.stdout.isTTY === true
      ? startSpinner('Starting dev server…')
      : undefined;

  const service: RunningService = await serveService({
    host: '127.0.0.1',
    port: options.port ?? 0,
    configStore,
    localDevtoolsDirectFirebaseAuth: true,
    localDevtoolsDirectMicrosoftAuth: true,
    localDevtoolsDelegatedExchange: {
      resolve: () => delegatedExchangeAuthority.resolve(),
      onAttempt: (event) => delegatedExchangeState.recordAttempt(event),
      onSuccess: (event) => delegatedExchangeState.markVerified(event),
    },
    localDevtoolsResolveBridgeAuth: async (auth) =>
      resolveTenantBridgeAuthVariables(
        auth,
        await configStore.resolveConfigValues('variable', configScope),
      ),
    ...(allowInsecureCustomerIssuer ? { customerVerifierAllowInsecureLocalhost: true } : {}),
    ...(options.customerVerifierFirebaseJwks === undefined
      ? {}
      : { customerVerifierFirebaseJwks: options.customerVerifierFirebaseJwks }),
    ...(firebaseJwksUri === undefined ? {} : { customerVerifierFirebaseJwksUri: firebaseJwksUri }),
    mcpRequestState: new RequestStateManager(requestStateSecretBox(randomBytes(32))),
    mcpConfirmationNonceLedger: new LocalConfirmationNonceLedger(),
    runtime: localRuntime.serviceOptions,
  });
  service.registry.setLocalAssetOptions({
    rootDir: dirname(resolve(options.manifestPath)),
    publicOrigin: service.url,
  });
  const url = buildMcpUrl(service.url, org, app, env);
  let activeCustomerAuth: DevtoolsCustomerAuth | undefined;
  let activeAssistantInstructions: string | undefined;
  let activeWidgetWatchDirectories: readonly string[] = [];

  async function deployOnce(): Promise<DevReloadResult> {
    let manifest: string;
    let connectors: string | undefined;
    try {
      const input = await readDeployInput(options.manifestPath);
      activeWidgetWatchDirectories = reactWidgetWatchDirectories(input.manifest, {
        rootDir: input.rootDir,
      });
      manifest = input.manifest;
      connectors =
        options.connectorsPath !== undefined
          ? readFileSync(options.connectorsPath, 'utf8')
          : input.connectors;
      await prepareKnowledgeDocumentsForDeploy({
        manifest,
        rootDir: input.rootDir,
        service: service.url,
        org,
        app,
        env,
        fetchImpl: localKnowledgeFetch(localRuntime, { org, app, env }),
      });
    } catch (error) {
      return {
        ok: false,
        errors: [{ code: 'read_error', path: '', message: (error as Error).message }],
      };
    }

    const authDeclared = manifestDeclaresServerAuth(manifest);
    if (options.accessMode === 'customers' && !authDeclared)
      return {
        ok: false,
        errors: [
          {
            code: 'server_auth_required',
            path: 'server.auth',
            message: 'customers access mode requires server.auth',
          },
        ],
      };
    let result: Awaited<ReturnType<typeof service.registry.deploy>>;
    try {
      result = await service.registry.deploy({ org, app, env }, manifest, {
        connectors,
        accessMode: options.accessMode ?? (authDeclared ? 'customers' : 'mixed'),
        ...(authDeclared
          ? {
              actor: {
                subject: 'local-devtools',
                email: 'local-devtools@localhost',
                superAdmin: false,
              },
            }
          : {}),
      });
    } catch (error) {
      if (error instanceof LocalDevtoolsDelegatedExchangeAuthorityError) {
        return {
          ok: false,
          errors: [{ code: error.code, path: error.path, message: error.message }],
        };
      }
      throw error;
    }
    if (!result.ok) {
      if ('superseded' in result) {
        return {
          ok: false,
          errors: [
            {
              code: 'run_superseded',
              path: '',
              message: 'deployment was superseded by a newer GitHub run',
            },
          ],
        };
      }
      if ('conflict' in result) {
        return {
          ok: false,
          errors: [{ code: result.code, path: '', message: result.message }],
        };
      }
      return {
        ok: false,
        errors: result.errors as ReadonlyArray<{
          code: string;
          path: string;
          message: string;
          didYouMean?: string;
        }>,
      };
    }
    let delegatedExchangeProjections: readonly LocalDevtoolsDelegatedExchangeBindingProjection[] =
      [];
    if (connectors !== undefined && connectors.trim() !== '') {
      const compiledConnectors = compileConnectors(connectors);
      if (!compiledConnectors.ok) {
        throw new Error('successful registry deploy produced invalid connector projections');
      }
      delegatedExchangeProjections = [
        ...projectLocalDevtoolsDelegatedExchangeBindings(
          compiledConnectors.secretBindings,
          await configStore.resolveConfigValues('variable', configScope),
        ),
      ];
    }
    const delegatedExchangeTrust =
      delegatedExchangeProjections.length === 0
        ? undefined
        : delegatedExchangeAuthority.trustDocument();
    if (delegatedExchangeProjections.length > 0 && delegatedExchangeTrust === undefined) {
      throw new Error('successful delegated-exchange deploy did not resolve public trust');
    }
    const target = await service.registry.getActiveByTenant({ org, app, env });
    const artifact = target?.served.artifact;
    const customerAuth = await projectDevtoolsCustomerAuth(
      artifact?.server.auth,
      allowInsecureCustomerIssuer,
      async () =>
        Promise.all([
          configStore.resolveConfigValues('variable', configScope),
          configStore.resolveConfigValues('secret', configScope),
        ]),
    );
    delegatedExchangeState.replace(
      delegatedExchangeTrust,
      delegatedExchangeProjections,
      target === undefined || target.deploymentId === undefined
        ? undefined
        : {
            tenant: `${target.org}/${target.app}/${target.environment}`,
            deployment: target.deploymentId,
          },
    );
    activeCustomerAuth = customerAuth;
    const embedId = await localRuntime.ensurePublicEmbed(service.registry, { org, app, env });
    activeAssistantInstructions = devtoolsAssistantInstructions(artifact?.server.assistant);
    return {
      ok: true,
      toolNames: artifact?.tools.map((tool) => tool.name) ?? [],
      ...(embedId === undefined ? {} : { embedId }),
    };
  }

  function printErrors(errors: DevReloadResult['errors']): void {
    log(`  ✗ ${errors?.length ?? 0} error(s):`);
    for (const e of errors ?? []) {
      log(`    ${e.code}${e.path ? ` at ${e.path}` : ''}: ${e.message}`);
      if (e.didYouMean !== undefined) log(`      did you mean "${e.didYouMean}"?`);
    }
  }

  // Hot-reload on file change (debounced — fs.watch fires multiple events per save).
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  function scheduleReload(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void reload();
    }, 120);
  }

  function resetWatchers(report: boolean): void {
    for (const watcher of watchers.splice(0)) watcher.close();
    const targets = [
      options.manifestPath,
      ...(options.connectorsPath === undefined ? [] : [options.connectorsPath]),
      ...activeWidgetWatchDirectories,
    ];
    const uniqueTargets = [...new Set(targets.map((target) => resolve(target)))];
    for (const target of uniqueTargets) {
      try {
        watchers.push(
          activeWidgetWatchDirectories.includes(target)
            ? watch(target, { recursive: true }, scheduleReload)
            : watch(target, scheduleReload),
        );
      } catch {
        /* a missing optional file is fine */
      }
    }
    if (report && uniqueTargets.length > 0) {
      log(
        `Watching ${uniqueTargets.length} input path(s) — edit and save to reload. Ctrl-C to stop.`,
      );
    }
  }

  async function reload(): Promise<DevReloadResult> {
    const r = await deployOnce();
    if (options.watch !== false) resetWatchers(false);
    if (r.ok) log(`↻ reloaded — tools: ${(r.toolNames ?? []).join(', ') || '(none)'}`);
    else {
      log('↻ reload failed — keeping the last good server:');
      printErrors(r.errors);
    }
    return r;
  }

  // Initial deploy.
  const first = await deployOnce();
  if (bootStatus) bootStatus.succeed(`Noodle dev server listening at ${service.url}`);
  else log(`Noodle dev server listening at ${service.url}`);
  log(`MCP endpoint:  ${url}`);
  if (first.ok) {
    log(`Tools:         ${(first.toolNames ?? []).join(', ') || '(none)'}`);
    if (first.embedId !== undefined) {
      log(`Embed ID:     ${first.embedId}`);
      log(
        `Embed script: <script src="${service.url}/v1/assistant/embed.js" data-embed-id="${first.embedId}" async></script>`,
      );
    }
  } else {
    printErrors(first.errors);
  }

  if (options.watch !== false) {
    resetWatchers(true);
  }

  // Interactive "exercise this dev server" prompt (TTY only; never a general client).
  let rl: Interface | undefined;
  if (options.interactive ?? Boolean(process.stdin.isTTY)) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
    log('Type "<tool> <jsonArgs>" to call a tool, or an empty line to list tools.');
    rl.on('line', (line) => {
      const trimmed = line.trim();
      void (async () => {
        if (trimmed === '') {
          const r = await localMcpCall(url, 'tools/list', {});
          const tools =
            (r.body?.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? [];
          log(`tools: ${tools.map((t) => t.name).join(', ') || '(none)'}`);
          return;
        }
        const sp = trimmed.indexOf(' ');
        const name = sp === -1 ? trimmed : trimmed.slice(0, sp);
        const argText = sp === -1 ? '{}' : trimmed.slice(sp + 1).trim() || '{}';
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(argText) as Record<string, unknown>;
        } catch (error) {
          log(`  invalid JSON arguments: ${(error as Error).message}`);
          return;
        }
        const r = await localMcpCall(url, 'tools/call', { name, arguments: args });
        if (r.body?.error !== undefined) log(`  error: ${JSON.stringify(r.body.error)}`);
        else {
          const result = r.body?.result as
            | { structuredContent?: unknown; content?: unknown }
            | undefined;
          log(
            `  ${JSON.stringify(result?.structuredContent ?? result?.content ?? result, null, 2)}`,
          );
        }
      })();
    });
    // Bridge a prompt Ctrl-C to a process SIGINT so the runner's shutdown path fires once.
    rl.on('SIGINT', () => {
      process.emit('SIGINT');
    });
  }

  return {
    url,
    origin: service.url,
    boot: first,
    reload,
    customerAuth: () => activeCustomerAuth,
    assistantInstructions: () => activeAssistantInstructions,
    delegatedCredentialSink: () => service.localDevtoolsDelegatedCredentials,
    localDelegatedExchange: () => delegatedExchangeState.snapshot(),
    close: async () => {
      if (timer) clearTimeout(timer);
      for (const w of watchers) w.close();
      rl?.close();
      await service.close();
    },
  };
}

function devtoolsAssistantInstructions(assistant: unknown): string | undefined {
  const publicInstructions = publicSurfaceOf(assistant)?.instructions?.trim();
  if (publicInstructions) return publicInstructions;
  const surfaces = (assistant as { surfaces?: unknown } | undefined)?.surfaces;
  if (!Array.isArray(surfaces)) return undefined;
  for (const surface of surfaces) {
    const instructions = (surface as { instructions?: unknown }).instructions;
    if (typeof instructions === 'string' && instructions.trim() !== '') return instructions.trim();
  }
  return undefined;
}

function localKnowledgeFetch(
  localRuntime: ReturnType<typeof createDevLocalRuntime>,
  tenant: { readonly org: string; readonly app: string; readonly env: string },
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (init?.method === 'POST' && url.pathname.endsWith('/knowledge/preflight')) {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as {
        readonly components?: readonly {
          readonly documents?: readonly { readonly sha256?: string }[];
        }[];
      };
      const missing = Array.from(
        new Set(
          (body.components ?? []).flatMap((component) =>
            (component.documents ?? []).flatMap((document) =>
              document.sha256 === undefined ? [] : [document.sha256],
            ),
          ),
        ),
      );
      return Response.json({ ok: true, missing });
    }
    const match = /\/knowledge\/documents\/([0-9a-f]{64})$/u.exec(url.pathname);
    if (init?.method === 'PUT' && match?.[1] !== undefined) {
      const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
      await localRuntime.stageKnowledgeDocument({ tenant, sha256: match[1], bytes });
      return Response.json({ ok: true, sha256: match[1] });
    }
    return Response.json({ error: 'unsupported local knowledge request' }, { status: 400 });
  }) as typeof fetch;
}

/** Strip every verifier/bridge field that the local credential-owning host does not need. */
async function projectDevtoolsCustomerAuth(
  auth: TenantAuthConfig | undefined,
  allowInsecureLocalhost: boolean,
  resolveBridgeConfig: () => Promise<
    readonly [Readonly<Record<string, string>>, Readonly<Record<string, string>>]
  >,
): Promise<DevtoolsCustomerAuth | undefined> {
  if (auth === undefined) return undefined;
  if (auth.kind === undefined || auth.kind === 'oidc') {
    return {
      kind: 'oidc',
      issuer: auth.issuer,
      configurationKey: createHash('sha256')
        .update(
          JSON.stringify({
            issuer: auth.issuer,
            audience: auth.audience,
            claims: auth.claims,
            routing: auth.routing,
          }),
        )
        .digest('base64url'),
      ...(allowInsecureLocalhost ? { allowInsecureLocalhost: true } : {}),
    };
  }
  if (auth.kind === 'federatedOidc') {
    return {
      kind: 'federatedOidc',
      issuers: auth.issuers.map(({ issuer }) => issuer),
      configurationKey: createHash('sha256').update(JSON.stringify(auth)).digest('base64url'),
      ...(allowInsecureLocalhost ? { allowInsecureLocalhost: true } : {}),
    };
  }
  if (auth.kind === 'bridge') {
    const [variables, secrets] = await resolveBridgeConfig();
    const resolvedAuth = resolveTenantBridgeAuthVariables(auth, variables);
    if (
      resolvedAuth.provider === 'firebase' &&
      resolvedAuth.projectId !== undefined &&
      resolvedAuth.apiKey !== undefined
    ) {
      return {
        kind: 'firebase',
        projectId: resolvedAuth.projectId,
        apiKey: resolvedAuth.apiKey,
        ...(resolvedAuth.authDomain === undefined ? {} : { authDomain: resolvedAuth.authDomain }),
        ...(resolvedAuth.appId === undefined ? {} : { appId: resolvedAuth.appId }),
        ...(resolvedAuth.tenantId === undefined ? {} : { tenantId: resolvedAuth.tenantId }),
        ...(resolvedAuth.authorizeUrl === undefined
          ? {}
          : { authorizeUrl: resolvedAuth.authorizeUrl }),
        configurationKey: configurationKey(resolvedAuth),
        ...(allowInsecureLocalhost ? { allowInsecureLocalhost: true } : {}),
      };
    }
    if (
      resolvedAuth.provider === 'microsoft' &&
      resolvedAuth.tenantId !== undefined &&
      resolvedAuth.clientId !== undefined &&
      resolvedAuth.clientSecret !== undefined
    ) {
      const clientSecret = secrets[resolvedAuth.clientSecret];
      if (clientSecret === undefined) return { kind: 'unsupported', method: 'microsoft' };
      return {
        kind: 'microsoft',
        tenantId: resolvedAuth.tenantId,
        clientId: resolvedAuth.clientId,
        clientSecret,
        ...(resolvedAuth.authorizeUrl === undefined
          ? {}
          : { authorizeUrl: resolvedAuth.authorizeUrl }),
        ...(resolvedAuth.tokenUrl === undefined ? {} : { tokenUrl: resolvedAuth.tokenUrl }),
        ...(resolvedAuth.scopes === undefined ? {} : { scopes: resolvedAuth.scopes }),
        ...(resolvedAuth.authMethod === undefined ? {} : { authMethod: resolvedAuth.authMethod }),
        configurationKey: configurationKey(resolvedAuth, clientSecret),
        ...(allowInsecureLocalhost ? { allowInsecureLocalhost: true } : {}),
      };
    }
    return { kind: 'unsupported', method: resolvedAuth.provider };
  }
  return { kind: 'unsupported', method: 'configured auth' };
}

function configurationKey(auth: TenantBridgeAuthConfig, secret?: string): string {
  return createHash('sha256')
    .update(JSON.stringify(secret === undefined ? auth : { auth, secret }))
    .digest('base64url');
}
