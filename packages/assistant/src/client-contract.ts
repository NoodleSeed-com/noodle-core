import type { AssistantChatState } from './chat-state.js';
import type { AssistantClientEvent } from './events.js';
import type {
  AssistantJsonValue,
  AssistantModelContextUpdate,
  AssistantPageContext,
} from './model-context.js';
import type { AssistantSession } from './server.js';
import type { AssistantSessionSourceOptions } from './session-source.js';
import type { AppRequestOptions } from './transport.js';

export type AssistantContextValue = string | number | boolean | null;
export type AssistantContext = Readonly<Record<string, AssistantContextValue>>;

export interface AssistantClientContext {
  readonly locale?: string;
  readonly timeZone?: string;
}

export type AssistantInteractionResponse =
  | { readonly action: 'accept'; readonly content?: AssistantJsonValue }
  | { readonly action: 'decline' | 'cancel' };

export type AssistantSessionResponse = AssistantSession;

interface AssistantClientBehaviorOptions<
  TPageContext extends AssistantPageContext = AssistantContext,
> {
  readonly fetch?: typeof fetch;
  /** Untrusted page context sent only when exchanging a session. */
  readonly context?: AssistantContext;
  /** Untrusted presentation hints evaluated for every turn request. */
  readonly clientContext?: AssistantClientContext | (() => AssistantClientContext | undefined);
  /** Typed, untrusted application context evaluated for every turn request. */
  readonly pageContext?: TPageContext | (() => TPageContext | undefined);
  /** Latest renderer-selected summary included as untrusted data on every message turn. */
  readonly modelContext?: AssistantModelContextUpdate;
}

/**
 * How the client is mounted: through the customer's backend (`sessionEndpoint`) or, on a public page
 * with no backend at all, straight to the service with a non-secret `embedId`. The two are exclusive —
 * see `session-source.ts` for why they are not merged.
 */
export type CreateAssistantClientOptions<
  TPageContext extends AssistantPageContext = AssistantContext,
> = AssistantClientBehaviorOptions<TPageContext> & AssistantSessionSourceOptions;

export interface AssistantClient<TPageContext extends AssistantPageContext = AssistantContext> {
  subscribe(listener: (event: AssistantClientEvent) => void): () => void;
  /** Subscribe to detached AI SDK UIMessage state; the listener receives the current state immediately. */
  subscribeChat(listener: (state: AssistantChatState) => void): () => void;
  /** Read a detached snapshot suitable for a framework-owned renderer. */
  getChatState(): AssistantChatState;
  connect(): Promise<void>;
  hasSession(): boolean;
  /** A request holds the single-flight slot. Optional so external implementations stay valid. */
  isBusy?(): boolean;
  sendMessage(message: string): Promise<void>;
  /** Request the session's idempotent initial prompts when effective config omitted them. */
  loadInitialSuggestions?(): Promise<void>;
  respond(id: string, response: AssistantInteractionResponse): Promise<void>;
  updateContext(context: AssistantContext): void;
  updatePageContext(context: TPageContext): void;
  updateModelContext(update: AssistantModelContextUpdate): void;
  requestApp(
    method: string,
    params: Readonly<Record<string, unknown>>,
    options?: AppRequestOptions,
  ): Promise<unknown>;
  /** Hosted sandbox document URL for widget frames, when the active session advertises one. */
  appSandboxUrl?(): string | undefined;
  resetSession(): void;
  abort(): void;
}
