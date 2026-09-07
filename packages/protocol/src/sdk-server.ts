import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { RequestId, RequestMeta } from '@modelcontextprotocol/sdk/types.js';
import type { AppPackageSnapshotV1 } from '@noodle-borg/app-package';
import type { RuntimeArtifact } from '@noodle-borg/compiler';
import type {
  CallerIdentity,
  ExecuteDeps,
  InvocationContext,
  ToolDispatchDecision,
} from '@noodle-borg/runtime';
import { assertNoContextToolCollision } from './context-tool.js';
import { registerPrompts } from './handlers/prompts.js';
import { registerResources } from './handlers/resources.js';
import { registerTools } from './handlers/tools.js';
import type { ProtocolObservation } from './observation.js';
import { buildProtocolRequestDeps } from './request-deps.js';
import type { ConfirmationNonceLedger, RequestStateManager } from './request-state.js';
import type { WidgetDomainProjection } from './widget/domain-projection.js';

/**
 * A resolved artifact plus the execution dependencies (connector registry + credential broker) needed
 * to serve it. This is the unit the transport routes to — the wire layer holds no state of its own; a
 * fresh {@link Server} is built per request (see {@link handleStatelessHttp}).
 */
export interface ServedArtifact {
  readonly artifact: RuntimeArtifact;
  readonly deps: ExecuteDeps;
  /** Exact deployment sibling used by host-distribution projections; never part of RuntimeArtifact. */
  readonly appPackageSnapshot?: AppPackageSnapshotV1;
}

export interface ProtocolRequestContext {
  readonly caller?: CallerIdentity;
  /** Origin-wide readiness for the complete OAuth client-credentials lifecycle. */
  readonly oauthClientCredentialsReady?: boolean;
  /** Request-host-specific widget metadata projection; never persisted into the served artifact. */
  readonly widgetDomain?: WidgetDomainProjection;
  /** Private verified customer IdP issuer; never copied into caller-facing hooks or output. */
  readonly customerIssuer?: string;
  /** Private auth-derived connector route claims; never copied into caller-facing hooks or output. */
  readonly customerRouting?: Readonly<Record<string, string>>;
  /** One request-scoped snapshot resolved by the hosting plane before protocol execution. */
  readonly invocationContext?: InvocationContext;
  /** Stable hosted deployment binding for modern sealed request state. */
  readonly deploymentId?: string;
  /** Shared AEAD request-state manager; hosted serving injects the operator-key-derived instance. */
  readonly requestState?: RequestStateManager;
  /** Durable atomic single-use storage required only for confirmation rounds. */
  readonly confirmationNonceLedger?: ConfirmationNonceLedger;
  /**
   * Whether this transport can carry a server request and route the client's later response back to
   * the pending call. Stateless JSON-response HTTP explicitly sets this to `unavailable`; linked or
   * session-coordinated transports may omit it or set `bidirectional`.
   */
  readonly formElicitationTransport?: 'bidirectional' | 'unavailable';
  /** Tool-only usage admission hook; wrapped once per valid `tools/call` before it reaches the runtime. */
  readonly beforeToolDispatch?: ProtocolToolDispatchHook;
  /** Request-scoped operator setting; omitted/off means descriptors remain unchanged. */
  readonly intentCapture?: { readonly enabled: boolean };
  /** Analytics observation hook; must never affect request behavior (failures are swallowed). */
  readonly observe?: (observation: ProtocolObservation) => void;
}

/** Validated request facts exposed only when a governed tool call first consumes usage admission. */
export interface ProtocolToolDispatchContext {
  readonly toolName: string;
  readonly toolArguments: unknown;
  readonly requestId: RequestId;
  /** SDK-owned request cancellation signal; never derived from client payload fields. */
  readonly signal: AbortSignal;
  readonly sessionId?: string;
  /** Verified sealed-state nonce shared by every round of one modern invocation. */
  readonly invocationId?: string;
  /** Verified sealed-state round, recorded as observation metadata but excluded from usage identity hashes. */
  readonly invocationRound?: number;
  readonly requestMeta?: RequestMeta;
}

export type ProtocolToolDispatchHook = (
  context: ProtocolToolDispatchContext,
) => ToolDispatchDecision | Promise<ToolDispatchDecision>;

/**
 * Build an official `@modelcontextprotocol/sdk` {@link Server} bound to a resolved artifact. The SDK
 * owns the wire (JSON-RPC framing, capability negotiation, protocol-version handling); this function is
 * the thin gateway that registers handlers translating each MCP method to the version-agnostic
 * execution plane via our mapping helpers. The execution core never sees a JSON-RPC frame.
 */
export function buildMcpServer(
  { artifact, deps }: ServedArtifact,
  context: ProtocolRequestContext = {},
): Server {
  assertNoContextToolCollision(artifact);
  const hasResources = (artifact.resources?.length ?? 0) > 0;
  const hasPrompts = (artifact.prompts?.length ?? 0) > 0;
  const requestDeps = buildProtocolRequestDeps(artifact, deps, context);

  const server = new Server(
    { name: artifact.server.name, title: artifact.server.title, version: artifact.server.version },
    {
      capabilities: {
        tools: {},
        ...(hasResources ? { resources: {} } : {}),
        ...(hasPrompts ? { prompts: {} } : {}),
      },
      // Returned verbatim in the `initialize` result (SDK `ServerOptions.instructions`).
      ...(artifact.server.instructions !== undefined
        ? { instructions: artifact.server.instructions }
        : {}),
    },
  );

  registerTools(server, artifact, requestDeps, context);
  if (hasResources) registerResources(server, artifact, requestDeps, context);
  if (hasPrompts) registerPrompts(server, artifact, requestDeps, context);

  return server;
}
