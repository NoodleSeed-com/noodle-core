# @noodleseed/assistant

Customer-branded embedded assistant surfaces for Noodle Seed deployments.

The package exports the canonical `<noodle-assistant>` managed Web Component, the framework-neutral
`<noodle-app-view>` MCP App host from `@noodleseed/assistant/app-view`, a managed React wrapper and
`NoodleAppView` adapter from `@noodleseed/assistant/react`, a renderer-free React hook from
`@noodleseed/assistant/react/client`, a DOM-free client from `@noodleseed/assistant/client`, and the
backend-only `createAssistantSessionHandler` and lower-level `createAssistantSession` exchange from
`@noodleseed/assistant/server`. The component inherits the
deployed MCP server's brand kit while slots, methods, events, and semantic CSS variables let a SaaS developer
integrate it without depending on internal DOM selectors. Light, dark, automatic host-page matching, and
host-page inversion work without replacing conversation or App DOM.

Never pass an embed client secret, model key, MCP token, or raw application session into the browser
component. Exchange the already-authenticated user from the customer backend and return only the short-lived
assistant session.

The model configuration and SaaS integration credentials have different owners:

| Owner             | Configuration                                                                        | Destination                                                |
| ----------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Noodle deployment | `ASSISTANT_MODEL_BASE_URL`, `ASSISTANT_MODEL`, `ASSISTANT_MODEL_API_KEY`             | Managed with `noodle variables set` / `noodle secrets set` |
| Customer backend  | `NOODLE_SERVICE_URL`, `NOODLE_ASSISTANT_CLIENT_ID`, `NOODLE_ASSISTANT_CLIENT_SECRET` | Backend environment or secret manager only                 |

`access.origins` accepts exact origins. Production origins must be HTTPS; plain HTTP is accepted only for
loopback development origins such as `http://localhost:3000`. Local MCP authoring remains available without
login, but an external browser embed needs an active deployment before its deployment-bound client can be
created.

Runtime requirements: Node.js 20+ for the server helper; the package ships ESM and CommonJS with full
export conditions, so bundlers and plain Node resolve it without aliases or type shims.

The full, always-current integration guide (access modes, session response contract, framework notes, and
troubleshooting) lives at <https://docs.noodleseed.dev/docs/guides/embedded-assistant>. Authoring and deploying
the server itself is `@noodleseed/one` (`npm install -g @noodleseed/one`).

If your page sends a `Content-Security-Policy`, allow the Noodle service origin in `connect-src` (turns and
event streams) **and** `frame-src` (app widgets render inside a hosted sandbox document served from the
service origin, `endpoints.sandbox`, so your `script-src` can stay strict). Details are in the guide's
"Content-Security-Policy on your page" section.

## Quick start

Install the package in the customer web application with that application's existing package manager. For
example:

```bash
npm install @noodleseed/assistant
```

### Author `server.ts`

Put customer identity and colors in the server's top-level `branding` option. Put only assistant-specific
structure and treatment in `embeddedAssistant({ presentation })`:

```ts
import {
  authenticatedWebsite,
  embeddedAssistant,
  openAICompatible,
  secret,
  server,
  tool,
  variable,
  z,
} from "@noodleseed/one";

export default server(
  "acme_support",
  {
    title: "Acme Support",
    version: "1.0.0",
    branding: {
      name: "Acme Assistant",
      accent: "#5B4CF0",
      surface: "#FFFFFF",
      surfaceDark: "#15131A",
      mark: { uri: "https://assets.acme.example/mark.svg", alt: "Acme" },
      colorScheme: "auto",
    },
    assistant: embeddedAssistant({
      model: openAICompatible({
        baseUrl: variable("ASSISTANT_MODEL_BASE_URL"),
        model: variable("ASSISTANT_MODEL"),
        apiKey: secret("ASSISTANT_MODEL_API_KEY"),
      }),
      access: authenticatedWebsite({
        origins: ["http://localhost:3000", "https://app.acme.example"],
      }),
      layout: {
        mode: "floating",
        position: "bottom-center",
        panelWidth: 970,
        panelMinHeight: 540,
        panelMaxHeight: 1025,
        edgeOffset: 20,
      },
      theme: "invert",
      behavior: {
        showTimestamps: true,
        showPoweredBy: false,
        showConfirmationDetails: false,
      },
      labels: {
        welcomeHeading: "How can Acme help?",
        welcomeMessage: "Fast answers from the tools your team already uses.",
        launcherPlaceholder: "Ask Acme anything",
        composerPlaceholder: "Message Acme Support…",
        sessionReady: "Acme support is online",
      },
      presentation: {
        panel: {
          surface: "solid",
          elevation: "dramatic",
          border: "strong",
          radius: 20,
        },
        launcher: {
          style: "bubble",
          icon: "chat",
          size: "lg",
          status: "session",
          effect: "pulse",
        },
        header: {
          mark: "status",
          badge: { text: "Support online", tone: "success", indicator: true },
        },
        composer: {
          leadingIcon: "brand-mark",
          sendIcon: "paper-plane",
          shape: "rounded",
        },
        messages: { userStyle: "accent", assistantStyle: "bubble" },
      },
    }),
  },
  [
    tool("status", {
      description: "Read the support service status.",
      input: z.object({}),
      output: z.object({ status: z.string() }),
      fulfil: () => ({ status: "operational" }),
    }),
  ],
);
```

`presentation` is a closed set of semantic primitives for the panel, launcher, header, composer, and
messages. The Atlas-style product treatment above is the maximum supported customization level: it can
change geometry, status decoration, controls, and message treatment without replacing the assistant's
structure. It has no raw HTML, CSS, inline SVG, class-name, or callback field;
markup-looking text stays text. `presentation.panel.radius` is a bounded panel-specific geometry override,
not a second color or identity source. An HTTPS or packaged SVG referenced by `branding.logo`, `branding.mark`, or
`branding.avatar` is a bounded asset, not inline renderer markup.

With UI overrides omitted, the complete managed baseline remains: a bottom-center frosted launcher pill that
morphs into a prompt input before opening; a 970px outer desktop shell with 20px side padding, 85vh height,
1025px maximum height, and a 24px panel using the built-in `#F8F8F8` light and `#0C0A09` dark surfaces;
bottom prompt chips and pill composer; plain assistant messages and 85%-wide user bubbles; a Noodle Seed
attribution row; and safe-area-aware mobile fullscreen. The fullscreen mobile layout is a real modal: it
marks the page behind it inert, traps focus, closes on Escape, and returns focus to the element that opened
it. Wider floating panels and inline layouts remain nonmodal.
The generic prompt chips ship as defaults, while an authored list—including `[]`—replaces them. Set
`presentation.launcher.style` to `bubble` for a direct-open 44px launcher. The baseline does not include the
“Available on ChatGPT” promotion. Partial configuration objects merge with the remaining defaults;
`presentation.panel.surface: "glass"` remains available when a translucent panel is intentional.

`behavior.showConfirmationDetails` defaults to `false`, so the built-in confirmation card presents the tool
title, description, complete schema-projected business fields, Confirm, and Don't proceed without exposing
connector mechanics. Set it to `true` only when the audience needs the collapsed Additional details
disclosure. The option changes only the managed Web Component's presentation: `confirm: true` still suspends
execution, the connector still runs only after acceptance, and decline/cancel still stop. Public `embedId`
and authenticated `sessionEndpoint` React mounts both honor the deployed value without a client prop.
Headless/BYO renderers keep the unchanged `data-confirmation` part and choose their own presentation.

### Configure and deploy

Configure the model through Noodle managed config, validate, and deploy the assistant-enabled server before
creating the embed client:

```bash
noodle variables set ASSISTANT_MODEL_BASE_URL --scope env --org acme --app support --env prod --value https://model.example/v1
noodle variables set ASSISTANT_MODEL --scope env --org acme --app support --env prod --value your-model
noodle secrets set ASSISTANT_MODEL_API_KEY --scope env --org acme --app support --env prod --from-env ASSISTANT_MODEL_API_KEY
noodle check --target embedded-assistant
noodle deploy --org acme --app support --env prod
```

Then create the deployment-bound client:

```bash
noodle assistant clients create --name web --org acme --app support --env prod
```

The command saves `{ clientId, clientSecret }` to a mode-`0600` file and prints its path, never the secret.
Move those values to the customer backend's secret manager without printing or committing them. A framework
route can use the maintained same-origin handler. Generate the route, authentication adapter, mount and
contract tests with `noodle assistant embed --framework nextjs --surface authenticated` in the existing
application. Implement only `authenticateAssistantRequest` using its existing session and membership checks:

```ts
import { createAssistantSessionHandler } from "@noodleseed/assistant/server";
import { authenticateAssistantRequest } from "../../../../lib/noodle-assistant-auth";

export const POST = createAssistantSessionHandler({
  serviceUrl: process.env.NOODLE_SERVICE_URL,
  clientId: process.env.NOODLE_ASSISTANT_CLIENT_ID,
  clientSecret: process.env.NOODLE_ASSISTANT_CLIENT_SECRET,
  origin: process.env.PUBLIC_APP_ORIGIN,
  authenticate: authenticateAssistantRequest,
});
```

The handler owns exact-Origin and JSON checks, signed-out JSON 401, bounded context/body parsing, no-store
responses, a 15-second deadline, and sanitized exchange failures without retries or redirects. Your adapter
returns `AssistantSessionIdentity | null`; its `user`, claims, preferences and routing must be backend-verified.
Keep stricter application CSRF middleware. Run the generated contract suite and your real identity/tenant
acceptance tests; synthetic contract tests alone do not verify your login implementation.

For a connector that uses `customerEndpoint("customer_api", ...)`, the authenticated backend may also pass
`routing: { endpoints: { customer_api: account.clusterApiBaseUrl } }`. Resolve the URL from server-owned
user/account membership after authentication; never accept it from the browser, page context, session
claims, or tool input. The endpoint key must match the authored name. Noodle validates and stores the route
only in private short-lived session state, and an omitted route leaves only dependent tools unavailable.
Mint a new session when the user's selected account or cluster changes.

#### Public website embeds

Everything above serves a signed-in user through your backend. A `publicWebsite(...)` surface serves the
same assistant to anonymous visitors — a marketing site, docs, or landing page — with a **required**
capability allowlist, per-surface daily budgets, and a kill switch. `noodle deploy` provisions a stable
embed id and prints a one-line snippet; the embed id is deliberately not a credential:

```ts
assistant: embeddedAssistant({
  model,
  access: publicWebsite({
    origins: ["https://www.example.com"],
    capabilities: [answerProductQuestion],
  }),
  behavior: { showConfirmationDetails: false },
}),
```

```html
<script src="https://cloud.noodleseed.dev/v1/assistant/embed.js"
        data-embed-id="pub_7f2q4k9x" async></script>
```

In a bundled app, the same public surface mounts through the element or React wrapper with `embedId`
instead of `sessionEndpoint` — the two are mutually exclusive, and a public embed needs no backend route:

```tsx
<AssistantWidget embedId="pub_7f2q4k9x" serviceUrl="https://cloud.noodleseed.dev" />
```

A public embed opens its session on **first open**, never on mount — every mount would otherwise spend
one of the surface's daily admission budget. While that first session is resolving, the launcher remains as
a loading affordance and the panel stays hidden. The panel's first visible frame therefore already carries
the deployment's compiled name, labels, presentation, and light/dark brand tokens instead of flashing the
built-in defaults. Add `signIn: true` to the surface and it becomes **mixed**:
anonymous visitors start immediately, and identity-dependent capabilities raise the sign-in flow below.
Before shipping, preflight the host with `noodle assistant embed --check --surface public` (or `mixed`) —
it verifies `script-src` too, the one CSP directive whose failure runs no widget code at all.

#### Mid-conversation sign-in (mixed surfaces)

On a `publicWebsite({ signIn: true })` surface, an anonymous visitor who reaches an identity-dependent
capability sees a "Sign in to continue" card, and the widget raises `assistant-sign-in-requested` with a
single-use `signInTicket` in its detail. The page signs the visitor in however it already does, then its
backend spends the ticket with the **same** helper and its own client credentials — same endpoint, same
`user` shape, plus the ticket:

```ts
const session = await createAssistantSession({
  serviceUrl: process.env.NOODLE_SERVICE_URL!,
  clientId: process.env.NOODLE_ASSISTANT_CLIENT_ID!,
  clientSecret: process.env.NOODLE_ASSISTANT_CLIENT_SECRET!,
  origin: process.env.PUBLIC_APP_ORIGIN!,
  user: { id: user.id, email: user.email, roles: user.roles },
  signInTicket, // from the widget's assistant-sign-in-requested event, via your page
});
```

The visitor keeps the same conversation with a new token; the anonymous token dies at that moment —
and by default **the assistant answers the pending question itself**: the service re-attempts the
intercepted tool under the signed-in principal and streams the result as the session's first turn,
so the panel's first content after sign-in is the answer the visitor asked for. It is one-shot
(consumed by that turn, or mooted the moment the visitor types first), confirm-gated tools stop at
their normal confirmation card — sign-in is never implicit consent for a write — and the turn counts
against the surface's daily budget like any other. Pass `resume: false` beside the ticket if your
application provides its own post-login affordance.
`signInTicket` and `context` are mutually exclusive — an elevation continues an existing session.
`routing` IS accepted here, and this is the moment to send it: elevation is the first authenticated
exchange, so it is the only chance a routed connector's session gets its backend-verified customer
routes. Possession of a ticket alone elevates nothing:
spending it also requires your client credentials, and the service checks your tenant owns that
conversation. (The ticket is deliberately **not** called a continuation: the server-held interaction
continuation described below must never reach browser code, while this value's whole job is to travel
through the page.)

A refused spend throws `AssistantSessionExchangeError`; branch on `error.elevationRefusal`:

| Code | What happened | What to do |
| :-- | :-- | :-- |
| `elevation_ticket_expired` | The visitor took too long (tickets live 10 minutes) | Re-prompt; the widget raises a fresh ticket when they retry the action |
| `elevation_ticket_invalid` | Stale, spent, or double-submitted ticket | Same recovery; log it — a burst is a replay signal |
| `elevation_tenant_mismatch` | Your credentials do not own that conversation | Alert someone; never retry |
| `elevation_already_signed_in` / `elevation_session_unavailable` | The conversation moved on | Ask the visitor to refresh |

`error.detail.serviceCode === "elevation_unavailable"` (a 503) means the deployment has no elevation
store configured — page the operator, not the visitor. Failures without a code (fresh-mint refusals,
proxy errors) carry `error.detail.status`, and `error.detail.retryable` is `true` only for
infrastructure 5xx responses.

Then add the framework-neutral element:

```ts
import "@noodleseed/assistant";
```

```html
<noodle-assistant
  session-endpoint="/api/assistant/session"
  theme="auto"
></noodle-assistant>
```

That single element is the complete managed assistant in React, Vue, Angular, or plain DOM. The
default pill expands into a prompt first; set `presentation.launcher.style: "bubble"` in `server.ts` when the
launcher should open the panel directly. Frameworks must treat `noodle-assistant` as a custom element.

When the host needs an authenticated fetch wrapper, assign complex values as properties before connecting
the element so the first session exchange already carries the application's credentials:

```ts
import type { NoodleAssistantElement } from "@noodleseed/assistant";

const assistant = document.createElement("noodle-assistant") as NoodleAssistantElement;
assistant.fetch = authenticatedFetch;
assistant.sessionEndpoint = "/api/assistant/session";
document.body.append(assistant);
```

Or use React:

```tsx
import { NoodleAssistant } from "@noodleseed/assistant/react";

<NoodleAssistant sessionEndpoint="/api/assistant/session" theme="auto" />;
```

Or keep the Noodle backend and own every rendered element in React:

```tsx
"use client";

import { useNoodleAssistant } from "@noodleseed/assistant/react/client";
import { YourChatUI } from "./your-chat-ui";

export function CustomAssistant({ principalKey }: { principalKey: string }) {
  const { client, messages, status, error } = useNoodleAssistant({
    sessionEndpoint: "/api/assistant/session",
    principalKey,
  });

  return (
    <YourChatUI
      messages={messages}
      status={status}
      error={error}
      onSend={(text) => client.sendMessage(text)}
      onStop={() => client.abort()}
      onRespond={(id, response) => client.respond(id, response)}
    />
  );
}
```

`useNoodleAssistant` owns client lifetime and React subscription only. It renders no Noodle markup,
registers no custom element, and returns `{ client, messages, status, error }`. `client` remains the one
command surface for messages, interactions, context, Apps requests, session resets, and aborts. A
customer-owned renderer must present every interaction it supports, await or catch command promises, and
preserve the typed part semantics; it must not invent user messages when an accepted, declined, or cancelled
interaction streams a continuation. `principalKey` is browser-local and never sent to Noodle. Change it
whenever the authenticated user or tenant changes so the hook aborts and clears the previous session and
transcript.

If the product deliberately sends a first turn on mount, make the effect cleanup-aware. React Strict Mode
discards the provisional effect, so a persistent "already sent" ref can suppress the stable remount:

```tsx
import { useEffect } from "react";

useEffect(() => {
  let active = true;
  queueMicrotask(() => {
    if (active) settle(client.sendMessage(initialMessage));
  });
  return () => {
    active = false;
  };
}, [client, initialMessage]);
```

`settle` must await or catch the command promise as in the complete example; the same structured failure
also appears in the hook's `error` state.

When the customer-owned transcript should render the linked MCP App itself, pass the typed `data-view`
payload and the same client to the supported host component:

```tsx
import { NoodleAppView } from "@noodleseed/assistant/react";

if (part.type === "data-view") {
  return (
    <NoodleAppView
      key={`${part.data.id}:${part.data.resourceUri}`}
      client={client}
      view={part.data}
      theme={resolvedTheme}
      onError={(failure) => reportAssistantError(failure)}
    />
  );
}
```

`<noodle-app-view>` owns the double iframe and AppBridge; `NoodleAppView` delegates to it. Its lifecycle identity is the supplied client plus
`view.id` plus `view.resourceUri`: ordinary parent rerenders and fresh view/callback objects retain the
iframe, while a semantic view replacement or unmount requests standard App teardown and closes the bridge.
Do not also key an ancestor by the whole view object or a callback. Pass the embedding application's
resolved `"light"` or `"dark"` theme; later changes are published through MCP Apps host context without
replacing the iframe.

App views stay inline by default. The host advertises only inline presentation and rejects an untrusted
App's fullscreen request, so stale or third-party widget code cannot take over the embedding application's
viewport. If fullscreen is an intentional part of the customer-owned experience, opt in explicitly with
`allowFullscreen` on `NoodleAppView` or `allow-fullscreen` on `<noodle-app-view>`; do not enable it merely
because a widget requests it. After an accepted fullscreen request, the host displays an accessible exit
control in the top-right corner. It returns the same mounted App to inline mode without resetting its state.

A conforming inline App reports its content size through the Apps bridge. The host grows the iframe with
that content, up to a 16,384px safety bound, so the conversation transcript remains the only vertical scroll
area and stays anchored to the latest reply while the App grows. Apps that need more space should compact
their inline view or use an explicitly allowed fullscreen presentation.

Vue, Angular, and plain DOM renderers use the same host without installing React. Import its dedicated entry
once, then assign the complex values as element properties. In Vue, the explicit `.prop` modifier makes that
boundary unambiguous:

```vue
<script setup lang="ts">
import "@noodleseed/assistant/app-view";
</script>

<template>
  <noodle-app-view
    :client.prop="assistant"
    :view.prop="part.data"
    :theme="resolvedTheme"
    @assistant-error="reportAssistantError"
  />
</template>
```

Configure Vue's `isCustomElement` for `noodle-app-view`. Angular uses the same element with `[client]`,
`[view]`, and `[theme]` property bindings. Do not serialize `client` or `view` into attributes.

`<noodle-app-view>` is the canonical host; `NoodleAppView` delegates to it. Both use the
service-advertised sandbox URL, route App calls through the supplied client, publish theme changes without
replacing the iframe, and request standard teardown on semantic replacement, disconnect, or an App teardown
request.

The App document owns its action intent: it calls standard `tools/call` after connecting and never relies on
native form navigation. If that call needs input or confirmation, the same `client` publishes the normal
pending interaction part for either managed or customer-owned rendering. The original App call stays pending
and receives its MCP result after `client.respond(...)`; applications must not retry or translate the click.

Outside React, subscribe to the DOM-free AI SDK `UIMessage` state without touching browser storage. The
client itself registers no element; import `/app-view` only when the transcript renders linked MCP Apps:

```ts
import { createAssistantClient } from "@noodleseed/assistant/client";

const assistant = createAssistantClient({
  sessionEndpoint: "/api/assistant/session",
  clientContext: () => ({
    locale: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }),
});

assistant.updateModelContext({
  content: [{ type: "text", text: "The time-off form is mounted." }],
  structuredContent: { widget: { name: "time-off", lifecycle: "mounted" } },
});

const unsubscribe = assistant.subscribeChat((state) => {
  renderUIMessageState(state);
  for (const message of state.messages) {
    for (const part of message.parts) {
      if (part.type === "data-confirmation" && part.data.status === "pending") {
        renderConfirmation(part.data, (response) =>
          assistant.respond(part.data.id, response),
        );
      }
      if (part.type === "data-view") {
        renderRegisteredView(part.data.resourceUri, part.data.result);
      }
    }
  }
});
await assistant.sendMessage("Book next Thursday and Friday off");

unsubscribe();
```

`subscribeChat` immediately emits a detached `{ messages, status, error? }` snapshot and then emits as the
AI SDK `UIMessage.parts` change. Assistant text uses `text`; confirmations, structured input requests, tool
results, and linked MCP Apps use `data-confirmation`, `data-input-request`, `data-tool-result`, and
`data-view`. Interaction data moves through `pending`, `submitting`, `accepted`, `declined`, or `cancelled`.
Use the lower-level `subscribe(...)` event stream only for transport and session lifecycle observations that
do not belong in the transcript. The package uses the headless `ai` runtime only; React remains an optional
peer isolated to the `/react` and `/react/client` entries.

For a custom progress surface, raw `tool_started` carries the direct invocation's call `id` and technical
`tool` name before execution. Map known tools through a finite application-owned label table and use a
neutral fallback such as "Working"; never turn an internal identifier into customer copy mechanically.
Keep one reserved region with `role="status"` and `aria-live="polite"` from submitted/thinking through tool
activity and the linked-view skeleton. `view_available` makes that view ready; a raw `error` event or chat
`error` state replaces the skeleton with `role="alert"`. Keep the skeleton's dimensions stable, mark its
decorative shapes `aria-hidden="true"`, and disable shimmer/transition animation under
`@media (prefers-reduced-motion: reduce)`.

The transport identity of a view is exactly `view.id + view.resourceUri`; different call IDs are distinct
invocations and must not be collapsed automatically. If the product intentionally owns one current panel
for a known resource, define an explicit application-owned slot map and replace only that slot:

```ts
const viewSlots = new Map([["ui://workspace/current", "current-workspace"]]);
const renderKey = viewSlots.get(view.resourceUri) ?? `${view.id}:${view.resourceUri}`;
```

`clientContext` contains untrusted locale/timezone presentation hints and is evaluated for every turn.
The client resolves a turn or interaction only after exactly one valid terminal `done` event followed by
stream EOF. A truncated or malformed stream, duplicate `done`, or any frame after `done` is
`invalid_response`; it never emits `message_completed` or `interaction_completed` for that response.
`updateContext` remains the separate untrusted page-context channel used on the next session exchange.
`updateModelContext({ content, structuredContent })` replaces the complete renderer snapshot attached to each
later message turn without starting a turn itself; updates do not merge with prior fields. The same method is
available on `<noodle-assistant>` for cohesive surface snapshots such as mounted, submitted, cancelled, or
dismissed. Model context is untrusted, per-turn data: it is not conversation history or authorization input,
and credential-shaped or unbounded updates are rejected.
Backend `preferences` are the signed-in user's saved locale/time-zone choices and outrank those hints. Only
message turns retry once after an expired session; the client never auto-retries interaction decisions. A
`tool_proposed` event carries a complete schema-projected review of the tool input and collected answers. For
a connector-backed tool it also identifies the exact connector version, operation, and resolved arguments;
Core v1 confirmable flows contain at most that one connector operation. Core v2 may route among candidate
actions and perform disclosed later reads, but exactly one action may be eligible. Sensitive fields may be redacted, but any
other truncation or omission fails closed. Accept is bound to that server-held action and claims one
execution attempt; drift fails closed, while decline/cancel resolve without execution. Normal terminal
outcomes scrub private arguments and continuations immediately. Only an accepted action still in the
`executing` state retains them during its one-hour unknown-outcome recovery window; expiry records a bounded
`interaction_outcome_unknown` result and scrubs the payload. Without downstream idempotency this is not an
exactly-once business-effect guarantee. A caller may explicitly repeat the same id and decision to retrieve
the durable stored outcome without another execution attempt.
At the manifest/runtime boundary, only `confirm: true` enables this gate; omitted or `false` preserves direct
execution and standard annotations remain hints. TypeScript action helpers likewise require
`{ confirm: true }`; action/destructive/open-world hints alone never enforce approval. Capable bidirectional
MCP transports render the same gate as standard form elicitation and fail closed when that exchange is
unavailable.
An `input_requested` event carries the message and portable form schema recorded by `ctx.elicit`. After the
turn stream completes, a headless renderer answers it with
`respond(id, { action: 'accept', content })`, or stops it with decline/cancel. The Web Component renders the
same primitive as native controls. Accepted content is schema-validated before the runtime resumes, and the
server-held continuation is never exposed to browser code. Schema-invalid content returns `arg_invalid` and
leaves the same input interaction pending so the renderer can submit a corrected answer. Every interactive
flow collects all elicited input before its first connector operation.

A completed widget-linked tool emits typed `view_available` data with its call/interaction id, tool,
`ui://` resource identity, optional title, bounded/redacted public result, and—on current services—the
self-contained App document. This is an availability signal, not proof of rendering. A customer-owned
renderer either mounts the actual App with `<noodle-app-view>` (or its React `NoodleAppView` adapter) or deliberately substitutes a component already
trusted by the application and selected by `resourceUri`/tool. The JSON `result` is data for a native
component; serializing it is not a rendering of the linked App. Never fetch the `ui://` URI, inject
`part.data.html`, or assign it to `srcdoc` yourself. The standard element also forwards the same detail as a
DOM event:

```ts
element.addEventListener("assistant-view-available", (event) => {
  renderRegisteredView(event.detail.resourceUri, event.detail.result);
});
```

#### Readiness and call ordering

`assistant-ready` fires **once per element lifetime**, when the element's shadow DOM is rendered and its
imperative API (`sendMessage`, `confirmTool`, …) is callable. It does **not** mean a session exists — that
is the `assistant-event` with `event: 'session_started'`. A DOM move (router reparent, portal) re-runs the
element's connection lifecycle but never re-fires the event. The React wrapper's `onReady` mirrors this:
at most once per component instance, whether the element upgraded before or after the component mounted;
the first callback identity wins, and a `console.debug('[noodle-assistant] ready')` breadcrumb marks the
moment for field diagnosis.

`sendMessage` awaits an in-flight eager session exchange and never opens a second session — a message sent
while the panel is still connecting is delivered on the session that exchange produces. It does **not**
queue: a `sendMessage` issued while another send or response is in flight rejects with a retryable
`request_in_progress` error before touching the transcript.

Assistant text renders as provider deltas arrive. If a turn finds an expired session, the component calls
the same authenticated session endpoint and retries that unprocessed message once. Confirmations never
replay across sessions. React applications may observe recovery and structured failures:

```tsx
<NoodleAssistant
  sessionEndpoint="/api/assistant/session"
  onSessionExpired={() => reportAssistantRecovery()}
  onError={({ code, status, retryable }) =>
    reportAssistantError({ code, status, retryable })
  }
/>
```

`createAssistantSession` returns the opaque token, expiry, resolved non-secret configuration, and explicit
turn/interaction endpoint URLs. Forward that response unchanged to the component or headless client.

The MCP server's top-level `branding` block is the portable deployment source for identity and colors shared
by widgets and the assistant. The embedding application may use the typed `appearance` object when it needs
exact control over assistant-specific roles:

```tsx
<NoodleAssistant
  sessionEndpoint="/api/assistant/session"
  theme={resolvedTheme}
  appearance={{
    light: {
      panel: {
        surface: "var(--app-surface)",
        text: "var(--app-text)",
        border: "var(--app-border)",
      },
      composer: {
        surface: "var(--app-input)",
        text: "var(--app-text)",
        border: "var(--app-border)",
      },
      confirmation: { surface: "#F8FAFC", text: "#101828", border: "#CBD5E1" },
      primaryButton: { surface: "#635BFF", text: "#FFFFFF" },
    },
  }}
  onAppearanceWarning={(warning) => reportThemeWarning(warning)}
/>
```

The same object is available as `element.appearance`. CSS custom properties inherit through the assistant
host into its shadow tree, so `var(--app-token)` references reuse the embedding application's existing
tokens without copying literal colors. Exact parseable literal colors are preserved and checked;
insufficient contrast emits the typed `assistant-appearance-warning` event. Contrast for unresolved CSS
references remains the host application's responsibility.

The complete typed appearance role map is:

| Appearance role | Public CSS custom properties |
| --- | --- |
| `canvas` | `--ns-assistant-canvas` |
| `text` | `--ns-assistant-text` |
| `mutedText` | `--ns-assistant-muted-text` |
| `link` | `--ns-assistant-link` |
| `focus` | `--ns-assistant-focus` |
| `success` | `--ns-assistant-success` |
| `warning` | `--ns-assistant-warning` |
| `danger` | `--ns-assistant-danger` |
| `panel` | `--ns-assistant-panel`, `--ns-assistant-panel-text`, `--ns-assistant-panel-border` |
| `header` | `--ns-assistant-header`, `--ns-assistant-header-text`, `--ns-assistant-header-border` |
| `assistantMessage` | `--ns-assistant-assistant-message`, `--ns-assistant-assistant-message-text`, `--ns-assistant-assistant-message-border` |
| `userMessage` | `--ns-assistant-user-message`, `--ns-assistant-user-message-text`, `--ns-assistant-user-message-border` |
| `composer` | `--ns-assistant-composer`, `--ns-assistant-composer-text`, `--ns-assistant-composer-border` |
| `suggestion` | `--ns-assistant-suggestion`, `--ns-assistant-suggestion-text`, `--ns-assistant-suggestion-border` |
| `confirmation` | `--ns-assistant-confirmation`, `--ns-assistant-confirmation-text`, `--ns-assistant-confirmation-border` |
| `primaryButton` | `--ns-assistant-primary-button`, `--ns-assistant-primary-button-text`, `--ns-assistant-primary-button-border` |
| `secondaryButton` | `--ns-assistant-secondary-button`, `--ns-assistant-secondary-button-text`, `--ns-assistant-secondary-button-border` |
| `launcher` | `--ns-assistant-launcher`, `--ns-assistant-launcher-text`, `--ns-assistant-launcher-border` |
| `code` | `--ns-assistant-code`, `--ns-assistant-code-text`, `--ns-assistant-code-border` |
| `app` | `--ns-assistant-app`, `--ns-assistant-app-text`, `--ns-assistant-app-border` |

Stable public CSS variables also remain available directly for stylesheet-based integration:

```css
noodle-assistant {
  --ns-assistant-accent: var(--app-primary);
  --ns-assistant-font-family: var(--app-font);
  --ns-assistant-panel-width: 440px;
}
```

Embedding pages can keep a floating pill compact in constrained layouts without changing its accessible
name or its expansion behavior. Set `--ns-assistant-collapsed-launcher-width` and
`--ns-assistant-collapsed-launcher-label-display` inside the embedding page's own media query; once the
visitor activates the launcher, the normal prompt-input width takes over.

For each matching region or token, precedence is the typed host appearance object, then host-provided slot
content or a public CSS custom property, then the saved environment operator override, compiled server
`presentation`/`branding`, and built-in defaults. The public slots are `launcher-icon`,
`header-leading`, `header-actions`, `empty-state`, `composer-leading`, `composer-trailing`, and
`conversation-footer`; slotted host DOM replaces the renderer fallback for that region. Slots are a trusted
embedding-page integration API, not a way to put HTML or callbacks in deployment configuration. Internal
shadow-DOM selectors and classes are not public API.

The Console **Assistant** tab and `noodle assistant appearance show|apply|reset` manage that environment
override. Existing embed code does not change: public elements load its non-secret configuration before
first paint without spending a session mint, while authenticated elements receive it from session exchange.
Each new session pins one resolved revision; an open conversation remains visually stable.

`theme="auto"` follows an explicit `light`/`dark` host-page class or data attribute, then the browser's
operating-system preference; `theme="invert"` selects the opposite host mode. When the embedding application has
its own theme toggle, pass its resolved `"light"` or `"dark"` value to `NoodleAssistant` and every
`<noodle-app-view>`/`NoodleAppView`. Updates change the assistant in place and notify mounted MCP Apps through standard host
context.

Server branding controls customer name, themed logo/mark/avatar assets, semantic light/dark colors, density,
radius, typography, and automatic theme. `embeddedAssistant(...)` controls theme selection,
floating/inline/drawer layout, position and dimensions, mobile and launcher/header/avatar/timestamp/attribution/confirmation-detail behavior, visible labels, suggested
prompts, privacy/terms links, locale, and text direction.
Named slots cover launcher/header/composer/footer extensions. Public methods include `open`, `close`,
`toggle`, `focusComposer`, `sendMessage`, `stop`, `reconnect`, `updateContext`, `updateModelContext`, `respond`, `confirmTool`, and `resetSession`;
lifecycle properties include `sessionEndpoint`, `embedId`, `serviceUrl`, `fetch`, and `appearance`;
lifecycle, message, tool-proposal, interaction-resolution, view-availability, context, and error events
support application integration. `confirmTool(id)` remains the compatibility shorthand for
`respond(id, { action: 'accept' })`.
