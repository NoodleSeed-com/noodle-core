# Noodle Seed for Shopify

**Owns:** The reusable Shopify commerce flagship: live Shopify search, curated Storefront MCP policy/FAQ,
Noodle-owned conversational views, published store knowledge, a public embedded assistant, one-item checkout
review, one `cartCreate`, and safe hosted-checkout handoff.
**Read when:** You are deploying one Noodle Seed application for one or many Shopify businesses without
copying their catalogs or editing source per store.
**Do not put here:** Real storefront tokens, Shopify cart IDs, customer credentials, payment data, private
customer implementation details, a tenant-specific origin, or a product synchronization layer.
**Update when:** The Storefront API version, GraphQL queries, tool or mini-widget surface,
managed-origin boundary, assistant projection, checkout boundary, or capability slot changes.

Capability slot: **reusable live Shopify discovery → knowledge → checkout**. One `server.ts` serves every
Shopify business. The deployment operator supplies an exact storefront origin and private Storefront API
token for each environment; no merchant forks the source.

For Shopify's dated, factual MCP/UCP surface inventory—not this example's implementation contract—see
[Shopify MCP / UCP capabilities](documentation/shopify-mcp-ucp-capabilities.md).

For another upstream MCP API, use the [connector import guide](https://docs.noodleseed.dev/docs/guides/connectors#upstream-mcp-connectors)
in a separate project. Its generated `src/server.ts` and offline test establish a contract, not this
flagship's reviewed live commerce behavior; do not import over the curated Shopify implementation.

## What ships out of the box

| Shopper need | Noodle Seed capability |
| :-- | :-- |
| Clarify broad requests | The assistant asks one natural-language question with no tool or widget, preserving the conversation instead of forcing a generic menu. |
| Find products | `search_products` uses Shopify's native natural-language relevance and partial-prefix behavior. It tries one concise query and, only after no relevant result, one materially different rewrite; one final `show_product_recommendations` call re-fetches and renders at most three live matches. |
| Review a product | `get_product` verifies details headlessly; `show_product` renders only one selected product and its explicit next step. |
| Compare named products | `get_product` verifies each item; the assistant compares only the requested criteria in concise prose with product links instead of showing ordinary recommendation cards. |
| Ask store questions | The embedded assistant has one `ask_store` knowledge tool. It selects the shop profile, one exact canonical policy kind, FAQ-first answer, or explicit guide path through typed input instead of choosing between adjacent tools. Direct MCP clients retain `get_store_information`. |
| Ask a natural-language store question | For ordinary questions, `ask_store` checks Shopify's headless FAQ answer first, then deterministically searches published pages and articles only when that source returns `not_found`. |
| Search published guides | The assistant calls `ask_store` with `source: "published_guides"` for explicit guide, care, sizing, brand, page, or article searches. Direct MCP clients can still call the lower-level `search_published_guides` tool independently. |
| Shop conversationally | The same reviewed tools are projected into a public embedded assistant on the merchant's exact origin. |
| Continue safely | After the shopper chooses one variant and reviews its quantity, one confirmed `create_checkout` call returns Shopify-authoritative totals and an exact allowlisted checkout URL. |

The solution does not need a shadow catalog, sync job, vector database, or Shopify Admin API. Shopify stays
authoritative for products, publication, search behavior, availability, price, policies, cart validation,
discounts, tax, shipping, payment, and checkout.

The current implementation keeps Storefront GraphQL as the one product-retrieval path. Do not add a second
UCP search pass or blend two result sets. Reconsider Shopify UCP Catalog only after the same live prompt matrix
shows a material relevance gap and a single UCP path proves equal or better hard-constraint fidelity, required
product/variant fields, bounded latency, pagination, tenant isolation, and operational simplicity. The dated
[MCP/UCP capability reference](documentation/shopify-mcp-ucp-capabilities.md) owns the factual surface; this
example owns the implementation choice.

## Configure one merchant environment

Follow the complete [Shopify guide](https://docs.noodleseed.dev/docs/guides/shopify-checkout) to install the
Shopify Headless sales channel, create a storefront, grant the minimum Storefront scopes, publish products,
and copy the private server-side Storefront access token.

Link the reusable app, then bind the merchant rather than editing `src/shopify-config.ts`:

```sh
noodle link --org <org> --app shopify --env dev
noodle variables set SHOPIFY_STORE_ORIGIN --scope env \
  --value https://your-shop.myshopify.com
noodle variables set SHOPIFY_STOREFRONT_MCP_ENDPOINT --scope env \
  --value https://your-shop.myshopify.com/api/mcp
noodle secrets set SHOPIFY_STOREFRONT_PRIVATE_TOKEN --scope env
```

`SHOPIFY_STORE_ORIGIN` must be one canonical bare HTTPS origin—no path, trailing slash, credentials, or
wildcard. That one value drives connector egress, assistant origin checks, checkout handoff authority, and
widget redirect metadata. Deployment fails closed if it is missing or malformed.

The source selects `noodleManaged()`, so merchants do not configure or receive a provider endpoint, model
identifier, or model key. Hosted inference fails closed until Noodle enrolls the exact org/app/environment;
that enrollment is operator state rather than a source or merchant binding.

For local development, put only the values—not source edits—in an ignored project-root `.env`:

```dotenv
SHOPIFY_STORE_ORIGIN=https://your-shop.myshopify.com
SHOPIFY_STOREFRONT_MCP_ENDPOINT=https://your-shop.myshopify.com/api/mcp
SHOPIFY_STOREFRONT_PRIVATE_TOKEN=replace-with-your-private-storefront-token
```

## Local author loop

```sh
pnpm test
noodle validate
noodle check --min-severity warn
noodle dev
```

In Devtools, call `search_products` with:

```json
{"query":"gifts","first":12,"unavailableProducts":"HIDE"}
```

Verify the three-result visual cap, natural conversational clarification, Shopify-native natural-language
relevance and price ordering, partial-prefix search, at most one distinct zero-result rewrite, availability handling, selected-product details, policy/page/article answers,
variant completeness, cursor pagination, light and dark themes, unavailable merchandise, checkout
confirmation/errors, and final allowlisted handoff. Product discovery must not call Shopify `cartCreate`;
the final explicit checkout action creates exactly one cart. Any number of headless search pages must still
produce exactly one recommendation widget. Clarification stays in prose and calls no tool; recommendation
and single-product views permit only their documented one-sentence action cue. Summaries, tool narration,
repeated view contents, generic priority menus, and internal prompt language fail.
Named comparisons also fail if they render a recommendation widget without explaining the requested
differences.

For a repeatable live assistant proof, use the current CLI login to create and revoke one temporary client:

```sh
pnpm smoke:shopify:semantic -- \
  --service <deployed-noodle-service-url> \
  --origin https://your-shop.myshopify.com \
  --org <org> --app shopify --env dev
```

The runner gives every case a fresh session and checks general no-tool answers, semantic product discovery,
exact-name zero results, one-tool canonical policy routing, deterministic FAQ-to-content composition, explicit content search, the two-search
ceiling, the single recommendation view, and the absence of checkout calls. It prints only a bounded JSON
summary. Use `--expectations <ignored-private-json>` to add exact live product-title expectations without
committing store-specific data; the file contains merchant data and must remain private. Use
`--client-credentials-file <0600-json>` to reuse a pre-provisioned client.

For a top-three result that Shopify's selected sort order already proves, request three products and stop
after the first page. Do not call `get_product` for routine recommendation lists: the presentation tool
re-fetches the final IDs authoritatively. Reserve detail fetches and pagination for claims or client-side
constraints that truly require them.

The public guide owns the complete
[answer-quality golden prompt matrix](https://docs.noodleseed.dev/docs/guides/shopify-checkout#answer-quality-golden-prompts).
Treat one unsupported product or policy claim as a failed answer even when the prose is fluent.

For four independent prospective-customer deployments from this exact source, follow the
[four-store rollout runbook](documentation/four-store-rollout.md). Store-specific values stay in operator
bindings; no customer receives a source fork.

## Deploy

Start owner-only for the live-store smoke test:

```sh
noodle deploy --access owner-only
noodle open
```

Install the exact one-line assistant snippet printed by `noodle deploy` immediately before `</body>` in the
active Shopify theme's `layout/theme.liquid`. The complete
[Shopify guide](https://docs.noodleseed.dev/docs/guides/shopify-checkout#9-deploy-safely) owns the merchant
installation and verification steps.

After the catalog, policy, assistant, and checkout smoke tests pass, review store traffic expectations,
abuse controls, product publication, privacy copy, and customer-facing access before widening exposure.

## Security and non-goals

- The private Storefront token is brokered server-side and never reaches the widget or model.
- Shopify's standard Storefront MCP endpoint is unauthenticated, but it is still constrained to the exact
  operator-bound store origin; runtime never runs `tools/list` or forwards Shopify `_meta`/widgets.
- A Shopify cart ID contains a secret key. The mutation never selects it, the normalizer drops unknown
  upstream fields, and tests prove an injected cart ID cannot reach tool output.
- Widget state contains only the selected variant ID and quantity.
- Checkout URLs open only on the operator-bound exact storefront origin.
- Customer login, orders, Admin API writes, persistent/resumable carts, a separate semantic catalog index, and
  marketplace installation are deliberate extensions, not hidden setup requirements.

Resumable carts require an encrypted server-side vault behind an opaque non-secret handle. Never place a
Shopify cart ID in widget state, tool results, model context, logs, or ordinary state handles.
