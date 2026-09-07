# Acme Tasks — designed around its top-3 prioritized user flows

A fictional productivity MCP App demonstrating three prioritized flows: **Capture, Prioritize, Complete**.
Each maps to a tool and the shared `TaskList` widget. The design spec and wireframe demonstrate the
`noodle-seed` skill's `references/experience-design.md` workflow: prioritize user flows before building.

This read/write example uses fictional seed data. A real deployment connects the user's account through
[customer authentication](../customer-auth/README.md).

## Design spec (write this before the code)

- **What it is** — an in-chat task manager. Unlike a top-of-funnel app, there is **no handoff**: the value
  is doing the work in place (read the list, add, re-prioritize, complete).
- **Personas** — the quick capturer ("remind me to email the vendor"), the morning triager (re-orders the
  day), the closer (marks things done without leaving chat).
- **Top-3 prioritized user flows** (the heart of this example — build these, defer the rest)
  1. **Capture** (`add_task`) — "add: book flights for the offsite, high priority" → task captured.
  2. **Prioritize** (`list_today` renders the widget; `set_priority` re-orders) — triage today's list.
  3. **Complete** (`complete_task`) — check a task off; the model can also complete on request.
- **Tools** — `list_today` (model-visible, renders the widget), `add_task` and `complete_task`
  (model-visible), `set_priority` (widget-only helper hidden from the model).
- **Widgets + display modes** — `TaskList` as an inline card that expands to fullscreen for a long list.
  No carousel or picture-in-picture — a single list is the right surface.
- **Grounding** — the seeded list in `src/server.ts` stands in for the user's real list; the app never
  invents a task.
- **Two users** — tools are atomic and model-fillable ("high priority" → `priority: "high"`), and each
  returns a spoken-ready status so the model can confirm in one turn.
- **Cross-host confirmation** — `complete_task` keeps `confirm: true`. The server's explicit
  `interactions.confirmationFallback: 'host'` uses Noodle confirmation in capable/embedded hosts and trusts
  ChatGPT's native write approval only when the stateless transport cannot present that form. Backend
  authorization remains independent.

## Wireframe (one screen: the three flows in place)

```html
<div class="phone">                                  <!-- in-app: solid frame -->
  <div class="chatgpt-header">ChatGPT · Acme Tasks</div>
  <div class="msg user">what's on my list today?</div>
  <div class="tool-call">list_today { focus: "today" }</div>
  <div class="wcard">
    <div class="wcard-head">TaskList</div>            <!-- component name = code + spec -->
    <div class="wcard-body">
      <input placeholder="Add a task…" />              <!-- Flow 1: Capture -->
      <div class="task">◻ Email the vendor about the Q3 quote   [high ▾]</div>   <!-- Flow 2 -->
      <div class="task">◻ Review the analytics pull request     [medium ▾]</div>
      <div class="task done">✓ Book flights for the team offsite [low ▾]</div>  <!-- Flow 3 -->
    </div>
  </div>
</div>
```

## Local author loop

```sh
noodle validate
noodle test
noodle dev
```

In another terminal:

```sh
noodle tools list
noodle tools call list_today --args '{"focus":"today"}'
noodle tools call add_task --args '{"title":"Book flights for the offsite","priority":"high"}'
noodle tools call complete_task --args '{"task":"review_pr","title":"Review the analytics pull request"}'
noodle check --target chatgpt
```

## Product agent guide

[`src/agent-guide.ts`](src/agent-guide.ts) expresses the same three prioritized workflows as one host-neutral
`agentGuide`. It supplies product judgment such as grounding and confirmation while the compiler derives
capability schemas, annotations, visibility, and widget relationships from `server.ts`. The guide does not
weaken `complete_task` confirmation or make the app-only `set_priority` tool model-visible.

Preview the generated Codex and Claude Code product skills before installing them:

```sh
noodle agents setup --json
noodle agents setup --write
```

After changing a workflow or capability, regeneration is explicit so a normal Noodle workflow-skill update
cannot overwrite the app product skill or local modifications:

```sh
noodle agents setup --regenerate-app-skill --json
noodle agents setup --write --regenerate-app-skill
noodle agents doctor --json
```

## Deploy

```sh
noodle link --org demo --app acme-tasks
noodle deploy --access owner-only
noodle open
```

## Optional in-product assistant

The default SaaS and widget scaffolds are credential-free. When the product deliberately includes an
assistant, use the existing server tools and add an `assistant` option to the same `server.ts` instead of
creating a second entrypoint or tool set:

```ts
assistant: embeddedAssistant({
  model: openAICompatible({
    baseUrl: variable('ASSISTANT_MODEL_BASE_URL'),
    model: variable('ASSISTANT_MODEL'),
    apiKey: secret('ASSISTANT_MODEL_API_KEY'),
  }),
  access: authenticatedWebsite({ origins: [variable('APP_ORIGIN')] }),
  layout: { mode: 'floating', position: 'bottom-right' },
  labels: { welcomeHeading: 'How can I help with Acme Tasks?' },
}),
```

The assistant automatically inherits this server's existing `branding` block, so its name, accent,
light/dark surfaces, density, and radius match the `TaskList` widget without a second brand declaration.

Bind `APP_ORIGIN` to the exact website origin. Production uses HTTPS; local development may use an exact
loopback HTTP origin. The customer application runs its own development server beside `noodle dev`.

In the existing application, preview the adapter with
`noodle assistant embed --framework nextjs --surface authenticated --dry-run --json`. Review the recipe,
generated contents/hashes and conflicts before rerunning without `--dry-run`. Implement the named
`authenticateAssistantRequest` seam with the application's existing login and server-owned membership.
Follow the installed `NOODLE-INTEGRATION.md` for signed-out, wrong-origin, cross-tenant and browser checks.
Installed files are not integration proof; missing sandbox identities or backend evidence remain unverified.
The generated session route delegates guards, bounded parsing and exchange to
`createAssistantSessionHandler` in `@noodleseed/assistant/server`. Implement the existing-session adapter;
do not copy token-exchange infrastructure. Run the supplied `test/noodle-assistant.test.ts` with Vitest,
then test the adapter against the host application's signed-out and cross-tenant membership fixtures.

The customer backend exchanges its authenticated user through `@noodleseed/assistant/server`; the browser
uses the Web Component or React wrapper and never receives the embed client or model secret. Validate with
`noodle check --target embedded-assistant`, then create the backend credential with
`noodle assistant clients create` after deployment. Model URL/name/key values stay in Noodle managed config;
only the Noodle service URL and assistant client ID/secret belong in the authenticated customer backend.

Install the independently versioned embed SDK with the customer web application's existing package manager;
do not introduce a second lockfile.

This example has no connector secrets and does not include tokens, caller-key mechanisms, or
`.env.noodle` values. All tasks are fictional seed data.

## Collection scope

Schema compilation is not hosted activation. External systems are changed through application tools;
a local read-only replica does not create a second writable authority.
