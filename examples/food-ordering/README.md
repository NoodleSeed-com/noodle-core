# Food Ordering

**Owns:** The flagship consumer ordering MCP App example: React view authoring, app-only helper tools,
caller-scoped cart state handles, invocation context, model-visible widget state/lifecycle, packaged image
assets, portable structured elicitation, checkout handoff policy, host actions, CSP/permissions metadata,
product-agent guidance, host-neutral distribution metadata, and widget preview coverage.

Food Ordering is a generic, synthetic version of a live marketplace ordering app. It lets a user search
stores, browse menus, customize an item, build a multi-line cart, review the order, and hand off checkout to
an allowlisted example domain. It does not use real restaurant APIs, real checkout, customer credentials, or
private customer data.

## What It Shows

| Capability | Example |
| :--- | :--- |
| Public entry tool | `open_ordering` returns structured fallback content and renders the React widget |
| Product and distribution projections | `agentGuide` supplies grounded cross-capability guidance; `distribution` supplies listing, publisher, legal, image, and review facts separately from the runtime manifest |
| App-only helper tools | `search_stores`, `load_menu`, `load_item`, `read_cart`, `sync_cart`, `prepare_checkout`; mutating widget-owned helpers use `confirm: false` (equivalent to omission) and execute directly because action hints alone never gate |
| Durable cart state | `server(..., { state: { handles: { cart } }, use: { state } })` with caller scope, revision checks, and explicit ticket-bound adoption when an anonymous visitor authenticates |
| React app runtime kit | `@noodleseed/one/react` supplies app flow, shell/nav/view, async state, form, quantity, choice, and handoff primitives |
| Multi-step widget flow | One React shell navigates stores, menu, item customization, cart, review, and handoff views through `useAppFlow` |
| Invocation context | `server.context` sets locale/time-zone defaults, derives an ambient service area/date, and exposes optional host-supplied coordinates to tools and the reserved `noodle_context` MCP adapter; location is an untrusted convenience hint, never an authorization signal or a substitute for explicit input |
| Structured missing input | `plan_order` uses `ctx.elicit` to collect a fulfilment method and date through embedded/headless forms, standard bidirectional elicitation, a linked MCP App form, or an exact structured conversational retry on stateless hosts |
| Model-visible widget state | `useUpdateModelContext` publishes one cohesive replacement snapshot when supported; `useWidgetLifecycle` auto-publishes mounted/cancelled/dismissed and reports author-owned submitted milestones for future context (not host-presentation proof), while the user-triggered submit pairs `useSendFollowUpMessage` for an immediate reply |
| Handoff | `handoff.allowedDomains` allows only `https://orders.example.com` checkout URLs |
| Progressive enhancement | Non-Apps hosts still receive stores, featured items, and a readable fallback summary |
| Fail-closed hydration | The React view treats only the unhydrated, pre-result `{}` envelope as pending; a hydrated empty success remains distinct. It surfaces `isError`, validates required records and identifiers, and withholds ordering actions from malformed results |
| Upstream MCP composition | This synthetic example keeps its data local. For the canonical frozen-tool import, governed upstream invocation, response normalization, and Noodle-owned widget pattern, use the repository's `shopify-storefront` flagship rather than copying another composition surface here |

The example is intentionally richer than the generated starter, but each inline view still follows the
same default: one immediate purpose, one primary action, at most one subordinate action, and progressive
disclosure for the rest. Preview it at 280px before adding navigation or local CSS; loading, empty, stale,
error/retry, and success states must remain readable without nested vertical scrolling.

Like the comprehensive default `noodle init my-app` scaffold, this flagship keeps the server feature-rich
while making each individual widget view focused; server capability breadth and screen density are separate.
The compiled initial widget should normally remain under the 1 MiB performance recommendation; Noodle Seed's
hard ceilings are 10 MiB per compiled widget and 20 MiB across one deployment. Run `noodle check` to see raw
and gzip-estimated sizes. Deploy requests are gzip-compressed as one stream so repeated self-contained React
runtime bytes deduplicate on the wire without a cross-tenant CDN. Keep menu images or large live datasets in assets/resources and app-only tools
rather than embedding them into the initial HTML bundle.

## Local Author Loop

```sh
noodle validate
noodle test
noodle dev
```

The same `server.ts` declares `distribution` metadata for host adapters. It references real packaged images
and keeps listing copy, support/legal URLs, and positive/negative review scenarios outside the canonical App
Package and Runtime Artifact. Explicit OpenAI and Claude adapters project those facts with the generated
product skill; installable plugin archives and directory-submission dossiers remain separate outputs.

In another terminal:

```sh
noodle tools list
noodle tools call open_ordering --args '{"customer":"Asha","query":"noodles"}'
noodle tools call summarize_ordering_options --args '{}'
```

When a developer finalizes visual feedback in the local Design experience, a coding agent can inspect the
latest project-local brief without a path or session id:

```sh
noodle design inspect --latest --json
```

The agent should locate the captured elements in this example's authored React source, preserve the listed
behavior and accessibility constraints, and verify every acceptance check before changing unrelated UI.

For Apps metadata conformance, start `noodle dev`, copy the loopback MCP endpoint, then run:

```sh
npx @mcpjam/cli@latest apps conformance --url http://127.0.0.1:<port>/o/demo/food-ordering/mcp --quiet --format json
```

## Export an OpenAI plugin

This flagship includes the guided workflows, listing metadata, review cases, and image assets needed to test
OpenAI export. See the public [product-agent guide](https://docs.noodleseed.dev/docs/guides/product-agent-guides#export-an-openai-package)
for the current package workflow and boundaries.

Against its deployed MCP URL, generate the Food Ordering submission candidate with:

```sh
noodle export plugin openai \
  --state submission \
  --mcp-url https://food-ordering.noodleseed.app/mcp \
  --category "Food & Drink" \
  --output food-ordering-openai.zip
```

Extract `food-ordering-openai.zip` before using the portal. Upload
`submission/chatgpt-app-submission.json` to the Codex-assisted import field and
`submission/food-ordering-skill.zip` to **With MCP → Skills**. The outer ZIP is the complete review kit and
is not itself a valid skill upload; `submission/README.md` repeats the portal steps.

After registering that same URL in ChatGPT developer mode, substitute its real technical ID to generate the
Food Ordering local test package:

```sh
noodle export plugin openai \
  --state local \
  --mcp-url https://food-ordering.noodleseed.app/mcp \
  --category "Food & Drink" \
  --registered-app-id plugin_asdk_app_0123456789abcdef0123456789abcdef \
  --output food-ordering-openai-local.zip
```

## Export for Claude

Claude Code plugin packaging and Anthropic Connector Directory review are separate outputs. Generate the
installable plugin repository with:

```sh
noodle export plugin claude \
  --mcp-url https://food-ordering.noodleseed.app/mcp \
  --output food-ordering-claude.zip
```

Generate the credential-free operator dossier for the remote Connector Directory with:

```sh
noodle export connector claude \
  --mcp-url https://food-ordering.noodleseed.app/mcp \
  --auth none \
  --category "Food & Drink" \
  --output food-ordering-anthropic-connector.zip
```

The dossier is deliberately marked `portalUploadable: false`: it gathers the listing, tool annotations,
use cases, allowed-link candidates, test-account guidance, and MCP App screenshot evidence, but a human must
verify ownership/compliance and enter the final answers in Anthropic's portal. The plugin ZIP does not
contain this dossier.

## Client Setup

Use the CLI to print the exact setup flow for your MCP client:

```sh
noodle connect claude
noodle connect chatgpt
noodle connect inspector
```

## Deploy

```sh
noodle deploy --org demo --app food-ordering --env prod --access owner-only
noodle open
```

That one deploy command preflights the complete target, creates a missing app/environment, and verifies
hosted readiness. If it is interrupted, rerun the same command to resume the unfinished operation without a
duplicate deployment. Use `--access org-members` for an org-wide internal demo. This example has no
connector secrets and does not include tokens, caller-key mechanisms, or `.env.noodle` values.

### Publish an immutable host archive

Only when this demo is intentionally being prepared for an external directory, deploy it with exact public
access and use the returned deployment ID to publish the matching local source:

```sh
noodle deploy --org demo --app food-ordering --env prod --access public
noodle distributions publish <deployment-id> src/server.ts --target openai --category "Food & Drink"
noodle distributions list <deployment-id> --target openai
noodle distributions readiness <distribution-id> --status ready --note "Archive and review evidence checked"
noodle distributions release <distribution-id> --visibility private
noodle distributions grant <distribution-id> --expires-in 900
noodle distributions download <distribution-id> --output food-ordering-openai.zip
```

Publish fails if local `src/server.ts` no longer compiles to that deployment's package snapshot. Readiness is
an explicit operator claim, the private release keeps anonymous discovery off, and the grant prints one
sensitive exact-version reviewer URL. Record `noodle distributions review` only after a human observes the
real portal state. Public Noodle delivery, rollback, deprecation, and terminal revocation are separate explicit
actions; none submits to a directory or claims acceptance.

## Demo Assets

The packaged demo images live under `assets/`. The current app uses `assets/noodle-bowl.jpg` as the server
branding image. Its three distribution screenshots are real, response-only MCP App captures from Noodle
Devtools at 2× device scale; each is 1640×970 PNG and has the producing user prompt next to its `asset(...)`
reference in `server.ts`.

Image sources:

- `assets/noodle-bowl.jpg` — Unsplash photo
  [`IRv8V9Hb8gI`](https://unsplash.com/photos/IRv8V9Hb8gI), downloaded from Unsplash.
- `assets/food-ordering-stores.png` — store-discovery state produced by “Help me build a noodle order for
  pickup.”
- `assets/food-ordering-menu.png` — Harbor Noodles menu state produced by “Show me the Harbor Noodles
  menu.”
- `assets/food-ordering-handoff.png` — checkout-handoff state produced by “Review my spicy miso bowl order
  before checkout.”

The Unsplash branding photo is free to use under the [Unsplash License](https://unsplash.com/license);
attribution is not required, but the source note is kept here for provenance.
