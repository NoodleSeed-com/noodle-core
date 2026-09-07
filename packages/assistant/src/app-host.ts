import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { AssistantClient, AssistantViewAvailableDetail } from './client.js';

/**
 * Srcdoc fallback for the widget sandbox relay. Pinned byte-for-byte to
 * `contract/v1/assistant-sandbox-document.html`, which the service also serves at
 * `endpoints.sandbox` — prefer that hosted document (it carries its own CSP, so widgets render on
 * CSP-strict embedder pages where `about:srcdoc` frames inherit a blocking `script-src`); this
 * inline copy only covers older services that advertise no sandbox endpoint.
 */
export const PROXY_DOCUMENT = `<!doctype html><meta charset="utf-8"><style>html,body,iframe{border:0;margin:0;width:100%;height:100%;overflow:hidden}body{background:transparent}</style><script>
let inner;
const ready={jsonrpc:'2.0',method:'ui/notifications/sandbox-proxy-ready',params:{}};
// Re-announce until the host acknowledges with the resource: when this document is hosted
// cross-origin, the first announcement can arrive before the host's load handler is listening.
const announce=setInterval(()=>parent.postMessage(ready,'*'),120);
setTimeout(()=>clearInterval(announce),15000);
addEventListener('message',(event)=>{
  if(event.source===parent){
    const message=event.data;
    if(message?.method==='ui/notifications/sandbox-resource-ready'){
      clearInterval(announce);
      if(inner)return;
      inner=document.createElement('iframe');
      inner.setAttribute('sandbox',message.params?.sandbox||'allow-scripts');
      inner.setAttribute('referrerpolicy','no-referrer');
      inner.srcdoc=String(message.params?.html||'');
      document.body.replaceChildren(inner);
      return;
    }
    inner?.contentWindow?.postMessage(message,'*');
  } else if(inner && event.source===inner.contentWindow) {
    parent.postMessage(event.data,'*');
  }
});
parent.postMessage(ready,'*');
</script>`;

/** Return a normalized app link only when the server explicitly allowlists its HTTPS origin. */
export function isAllowedAppLink(
  value: string,
  allowedDomains: readonly string[],
  baseUrl: string,
): string | undefined {
  try {
    const parsed = new URL(value, baseUrl);
    if (parsed.protocol !== 'https:') return undefined;
    const allowed = allowedDomains.some((candidate) => {
      try {
        return new URL(candidate).origin === parsed.origin;
      } catch {
        return false;
      }
    });
    return allowed ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

export interface AssistantAppHostActions {
  readonly client: AssistantClient;
  readonly sendMessage: (message: string) => Promise<void>;
  readonly updateModelContext: AssistantClient['updateModelContext'];
  readonly theme: 'light' | 'dark';
}

type AssistantAppDisplayMode = 'inline' | 'fullscreen';

export function createAssistantAppHostContext(
  theme: 'light' | 'dark',
  allowFullscreen = false,
  displayMode: AssistantAppDisplayMode = 'inline',
) {
  return {
    theme,
    displayMode:
      allowFullscreen && displayMode === 'fullscreen'
        ? ('fullscreen' as const)
        : ('inline' as const),
    availableDisplayModes: allowFullscreen
      ? (['inline', 'fullscreen'] as const)
      : (['inline'] as const),
    platform: 'web' as const,
  };
}

export interface AssistantAppHostOptions {
  /**
   * Permit an untrusted App to request fullscreen presentation. Inline-only is the secure default;
   * the embedding application must deliberately opt in to the larger customer-owned surface.
   */
  readonly allowFullscreen?: boolean;
  /** Hosted sandbox document URL from the session; the srcdoc proxy is used when absent/invalid. */
  readonly sandboxUrl?: string;
  /** Supplies fresh payloads without replacing the mounted iframe or bridge. */
  readonly getDetail?: () => AssistantViewAvailableDetail;
  /** Reports a widget that never finished its bridge handshake (shown as a visible fallback). */
  readonly onRenderFailure?: (failure: {
    readonly code: 'view_render_timeout';
    readonly retryable: false;
  }) => void;
  /** Lets the owning renderer retire its mount when the App asks the host to tear it down. */
  readonly onTeardownRequest?: () => void;
}

/** How long a mounted widget may stay handshake-silent before the card shows a fallback note. */
export const APP_RENDER_TIMEOUT_MS = 10_000;
/** Prevent an untrusted App from allocating an unbounded inline surface. */
export const MAX_INLINE_APP_HEIGHT = 16_384;
const APP_TEARDOWN_TIMEOUT_MS = 1_000;

interface AssistantAppMount {
  readonly destroy: () => Promise<void>;
  readonly updateTheme: (theme: 'light' | 'dark') => void;
}

const mountedApps = new WeakMap<HTMLElement, AssistantAppMount>();

/** Only an http(s) sandbox document may host widget frames; anything else falls back to srcdoc. */
function resolveSandboxUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/** Mount one self-contained MCP App behind the SDK's standard host bridge and a double iframe. */
export function mountAssistantApp(
  detail: AssistantViewAvailableDetail,
  actions: AssistantAppHostActions,
  options: AssistantAppHostOptions = {},
): HTMLElement | undefined {
  if (!detail.html) return undefined;
  const card = document.createElement('section');
  card.className = 'noodle-app-card';
  if (detail.title) {
    const title = document.createElement('div');
    title.className = 'noodle-app-title';
    title.textContent = detail.title;
    card.append(title);
  }
  const exitFullscreen = document.createElement('button');
  exitFullscreen.className = 'noodle-app-fullscreen-exit';
  exitFullscreen.type = 'button';
  exitFullscreen.setAttribute('aria-label', 'Exit fullscreen');
  exitFullscreen.title = 'Exit fullscreen';
  exitFullscreen.hidden = true;
  card.append(exitFullscreen);
  const frame = document.createElement('iframe');
  frame.className = 'noodle-app-frame';
  frame.title = detail.title ?? detail.tool;
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('scrolling', 'no');
  const sandboxUrl = resolveSandboxUrl(options.sandboxUrl);
  if (sandboxUrl) frame.src = sandboxUrl;
  else frame.srcdoc = PROXY_DOCUMENT;
  card.append(frame);

  // A blank widget must never be signal-free: if the handshake (proxy ready → app initialized)
  // does not complete — blocked frame-src, unreachable sandbox document, a widget script that
  // never connects — replace the frame with a visible note and surface an assistant error.
  let mountedBridge: AppBridge | undefined;
  let mountedTransport: PostMessageTransport | undefined;
  let destroyed = false;
  let initialized = false;
  let currentTheme = actions.theme;
  let displayMode: AssistantAppDisplayMode = 'inline';
  let hostContext = createAssistantAppHostContext(
    currentTheme,
    options.allowFullscreen === true,
    displayMode,
  );
  let destroyPromise: Promise<void> | undefined;
  const applyDisplayMode = (requestedMode: AssistantAppDisplayMode): AssistantAppDisplayMode => {
    displayMode =
      requestedMode === 'fullscreen' && options.allowFullscreen === true ? 'fullscreen' : 'inline';
    card.toggleAttribute('data-fullscreen', displayMode === 'fullscreen');
    exitFullscreen.hidden = displayMode !== 'fullscreen';
    hostContext = createAssistantAppHostContext(
      currentTheme,
      options.allowFullscreen === true,
      displayMode,
    );
    if (initialized) mountedBridge?.setHostContext(hostContext);
    return displayMode;
  };
  exitFullscreen.addEventListener('click', () => {
    if (destroyed) return;
    applyDisplayMode('inline');
    frame.focus();
  });
  const renderTimer = setTimeout(() => {
    if (initialized || !frame.isConnected) return;
    const note = document.createElement('div');
    note.className = 'noodle-app-fallback';
    note.textContent = 'This app view could not be displayed.';
    frame.replaceWith(note);
    options.onRenderFailure?.({ code: 'view_render_timeout', retryable: false });
  }, APP_RENDER_TIMEOUT_MS);

  frame.addEventListener(
    'load',
    () => {
      if (destroyed) return;
      const target = frame.contentWindow;
      if (!target) return;
      const bridge = new AppBridge(
        null,
        { name: 'Noodle Seed Embedded Assistant', version: '1.0.0' },
        {
          openLinks: {},
          serverTools: {},
          serverResources: {},
          updateModelContext: { text: {}, structuredContent: {} },
          message: { text: {} },
        },
        {
          hostContext,
        },
      );
      mountedBridge = bridge;
      bridge.onsandboxready = () => {
        if (destroyed) return;
        const current = options.getDetail?.() ?? detail;
        void bridge.sendSandboxResourceReady({
          html: current.html as string,
          sandbox: 'allow-scripts',
          ...(current.resourceMeta ?? {}),
        });
      };
      bridge.onsizechange = ({ height }) => {
        if (destroyed) return;
        if (typeof height === 'number' && Number.isFinite(height)) {
          frame.style.height = `${Math.min(MAX_INLINE_APP_HEIGHT, Math.max(120, Math.ceil(height)))}px`;
        }
      };
      bridge.onmessage = async ({ content }) => {
        if (destroyed) return {};
        const text = content
          .flatMap((part: { type: string; text?: string }) =>
            part.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
          )
          .join('\n')
          .trim();
        if (text) await actions.sendMessage(text);
        return {};
      };
      bridge.onupdatemodelcontext = async (update) => {
        if (destroyed) return {};
        actions.updateModelContext(update);
        return {};
      };
      bridge.onrequestteardown = () => {
        if (destroyed) return;
        options.onTeardownRequest?.();
        void destroy();
      };
      bridge.onopenlink = async ({ url }) => {
        if (destroyed) return { isError: true };
        const current = options.getDetail?.() ?? detail;
        const allowed = isAllowedAppLink(
          url,
          current.allowedOpenDomains ?? [],
          globalThis.location?.href ?? 'https://invalid.example',
        );
        if (!allowed) return { isError: true };
        globalThis.open?.(allowed, '_blank', 'noopener,noreferrer');
        return {};
      };
      bridge.onrequestdisplaymode = async ({ mode }) => {
        if (destroyed) return { mode: displayMode };
        return { mode: applyDisplayMode(mode) };
      };
      bridge.oncalltool = async (params) => {
        if (destroyed) {
          return {
            content: [{ type: 'text', text: 'App view is closing.' }],
            isError: true,
          } as Awaited<ReturnType<NonNullable<typeof bridge.oncalltool>>>;
        }
        return (await actions.client.requestApp('tools/call', params)) as Awaited<
          ReturnType<NonNullable<typeof bridge.oncalltool>>
        >;
      };
      bridge.onlistresources = async (params) => {
        if (destroyed) {
          return { resources: [] } as Awaited<
            ReturnType<NonNullable<typeof bridge.onlistresources>>
          >;
        }
        return (await actions.client.requestApp('resources/list', params ?? {})) as Awaited<
          ReturnType<NonNullable<typeof bridge.onlistresources>>
        >;
      };
      bridge.onreadresource = async (params) => {
        if (destroyed) {
          return { contents: [] } as Awaited<ReturnType<NonNullable<typeof bridge.onreadresource>>>;
        }
        return (await actions.client.requestApp('resources/read', params)) as Awaited<
          ReturnType<NonNullable<typeof bridge.onreadresource>>
        >;
      };
      bridge.oninitialized = () => {
        if (destroyed) return;
        initialized = true;
        clearTimeout(renderTimer);
        bridge.setHostContext(hostContext);
        const current = options.getDetail?.() ?? detail;
        void bridge.sendToolInput({ arguments: current.arguments ?? {} });
        void bridge.sendToolResult({
          content: [{ type: 'text', text: JSON.stringify(current.result) }],
          ...(typeof current.result === 'object' &&
          current.result !== null &&
          !Array.isArray(current.result)
            ? { structuredContent: current.result }
            : {}),
        });
      };
      const transport = new PostMessageTransport(target, target);
      mountedTransport = transport;
      void bridge.connect(transport).catch(() => {
        void destroy();
      });
    },
    { once: true },
  );

  const updateTheme = (theme: 'light' | 'dark'): void => {
    if (destroyed) return;
    currentTheme = theme;
    hostContext = createAssistantAppHostContext(
      currentTheme,
      options.allowFullscreen === true,
      displayMode,
    );
    if (initialized) mountedBridge?.setHostContext(hostContext);
  };

  const destroy = (): Promise<void> => {
    if (destroyPromise) return destroyPromise;
    destroyed = true;
    clearTimeout(renderTimer);
    destroyPromise = (async () => {
      try {
        if (initialized) {
          await mountedBridge?.teardownResource({}, { timeout: APP_TEARDOWN_TIMEOUT_MS });
        }
      } catch {
        // Teardown is best-effort; the transport must still close and release its listener.
      }
      await mountedTransport?.close().catch(() => {});
      card.remove();
      mountedApps.delete(card);
    })();
    return destroyPromise;
  };

  mountedApps.set(card, { destroy, updateTheme });
  return card;
}

/** Publish the embedding application's resolved theme to a mounted App without replacing its bridge. */
export function updateAssistantAppTheme(card: HTMLElement, theme: 'light' | 'dark'): void {
  mountedApps.get(card)?.updateTheme(theme);
}

/** Dispose a private App mount. Public consumers use `<noodle-app-view>` or its React adapter. */
export function unmountAssistantApp(card: HTMLElement): Promise<void> {
  return mountedApps.get(card)?.destroy() ?? Promise.resolve();
}
