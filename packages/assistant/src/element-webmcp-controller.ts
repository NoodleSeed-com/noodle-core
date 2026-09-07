import {
  startWebMcpBridge,
  type WebMcpBridgeClient,
  type WebMcpBridgeHandle,
  type WebMcpModelContext,
} from './webmcp-bridge.js';

/**
 * The element's WebMCP lifetime (ADR 0220).
 *
 * Separate from `element.ts` for the same reason the other controllers are: the element owns rendering,
 * and this owns "when does a browser agent get to see this session's tools". The answer is narrow —
 * after a session exists, until it does not — and it stays testable without a renderer.
 *
 * Everything here is inert unless the deployment opted in *and* the browser shipped the API, which as of
 * Chrome's origin trial is a small minority of visitors. Off is the overwhelmingly common path, so it
 * costs one property read.
 */
export class AssistantElementWebMcpController {
  #enabled = false;
  #bridge: WebMcpBridgeHandle | undefined;
  /** Guards against a late `startWebMcpBridge` resolving after the session it belonged to is gone. */
  #generation = 0;

  /** Called when resolved configuration arrives; the server already resolved surface over deployment. */
  configure(enabled: boolean): void {
    this.#enabled = enabled;
    if (!enabled) this.stop();
  }

  start(client: WebMcpBridgeClient | undefined): void {
    if (!this.#enabled || !client) return;
    const modelContext = browserModelContext();
    if (!modelContext) return;
    this.stop();
    const generation = ++this.#generation;
    void startWebMcpBridge({ client, modelContext, enabled: true }).then((bridge) => {
      // A session that reset while the tool list was in flight must not leave registrations behind
      // pointing at a client that no longer has a session.
      if (generation === this.#generation) this.#bridge = bridge;
      else bridge.stop();
    });
  }

  stop(): void {
    this.#generation += 1;
    this.#bridge?.stop();
    this.#bridge = undefined;
  }
}

/**
 * The origin trial renamed this from `navigator.modelContext` to `document.modelContext` mid-flight, so
 * read it defensively and let an absent API mean "no bridge" rather than an error on a customer's page.
 */
function browserModelContext(): WebMcpModelContext | undefined {
  if (typeof document === 'undefined') return undefined;
  const host = document as Document & { modelContext?: WebMcpModelContext };
  return typeof host.modelContext?.registerTool === 'function' ? host.modelContext : undefined;
}
