# Shopify MCP / UCP Capabilities — Factual Implementation Handoff

**Owns:** A dated factual reference for Shopify-provided MCP and UCP capabilities, access conditions, payload semantics, and documented limitations.
**Read when:** You are evaluating Shopify-native MCP/UCP surfaces or reconciling the storefront flagship with Shopify's documented capabilities.
**Do not put here:** Noodle Seed architecture decisions, current implementation status, merchant credentials, customer data, or claims that have not been verified against Shopify's official documentation.
**Update when:** The reference is re-researched against official Shopify documentation or a cited Shopify capability materially changes.

**Research date:** 2026-08-24\
**Purpose:** Factual inventory of Shopify-provided MCP/UCP capabilities, interfaces, access conditions, payload semantics, and documented limitations. This document intentionally does not prescribe an application architecture or product strategy.

## 1. Terminology and server surfaces

Shopify publishes commerce capabilities through MCP servers that implement the Universal Commerce Protocol (UCP). Calls use JSON-RPC 2.0. UCP requests carry capability negotiation metadata and UCP responses return structured content plus business-outcome messages.

### 1.1 Store-specific Storefront MCP

For a particular merchant, Shopify documents these endpoint families:

| Endpoint | Scope / documented purpose | Authentication stated by Shopify |
|---|---|---|
| `https://{shop}.myshopify.com/api/ucp/mcp` | UCP Catalog, UCP Cart, UCP Checkout, and UCP Order capabilities | Depends on capability/tool; see sections below |
| `https://{shop}.myshopify.com/api/mcp` | Standard Storefront MCP tools: legacy cart operations and `search_shop_policies_and_faqs` | No authentication for the standard Storefront MCP endpoint |
| Customer Accounts endpoint discovered via `https://{shopDomain}/.well-known/customer-account-api` | Customer-specific account and order actions | OAuth 2.0 access token, authorization code + PKCE |

Shopify documentation currently describes both legacy Storefront cart tools at `/api/mcp` and UCP Cart tools at `/api/ucp/mcp`. Shopify announced that Storefront MCP cart tools are being deprecated in favor of UCP Cart MCP. Implementations should discover available tools with `tools/list` and use the returned live schema rather than assuming a fixed union of tools.

### 1.2 Global Catalog MCP

Shopify also provides Global Catalog MCP for cross-merchant discovery. It uses the same UCP catalog tool names (`search_catalog`, `lookup_catalog`, `get_product`) but searches across Shopify merchants rather than one merchant. It is distinct from Storefront Catalog MCP, which is restricted to one merchant.

### 1.3 UCP capability negotiation

For UCP endpoints, requests require a `meta` object and `meta["ucp-agent"].profile`, a URL to an agent profile hosted at a well-known URL such as `https://agent.example/.well-known/ucp`. The capabilities/tools exposed can depend on the capabilities declared by the agent profile. Use `tools/list` against the target server/session to obtain the applicable JSON schemas before generating a request.

## 2. Storefront Catalog MCP

**Scope:** One merchant’s catalog.\
**Endpoint:** `https://{shop}.myshopify.com/api/ucp/mcp`\
**Tool names:** `search_catalog`, `lookup_catalog`, `get_product`.

### 2.1 `search_catalog`

**Function:** Search the merchant’s catalog using a free-text query.

**Documented request inputs** (inside a required `catalog` wrapper):

| Input | Availability / semantics |
|---|---|
| `query` | Free-text query string |
| `context.address_country` | Buyer signal for relevance/localization |
| `context.language` | Buyer language signal |
| `context.currency` | Buyer currency signal |
| `context.intent` | Free-text buyer-intent signal |
| `filters` | Category and price-range filtering documented in Storefront MCP overview; exact live schema should be discovered |
| `pagination.cursor` | Opaque cursor from prior response |
| `pagination.limit` | Integer, min 1, default 10, maximum 250 for Storefront Catalog |

**Documented response information:** UCP envelope; products; title; description; product URL/handle; categories; price range in minor currency units; media; product options; variants; variant SKU/title/description/price/availability/options/tags; ratings where available; merchant-supplied metadata where available; and cursor pagination (`cursor`, `has_next_page`, `total_count`).

**Facts/constraints:**
- The API accepts free-text `query` and a free-text `context.intent` signal.
- It is catalog retrieval, not a separately documented `recommend_gift`, `compare`, `explain`, or user-profile recommendation tool.
- Product response quality is bounded by the merchant’s catalog data and returned fields.
- Pagination uses opaque cursors.

### 2.2 `lookup_catalog`

**Function:** Resolve product and/or variant identifiers.

**Documented inputs:**
- `catalog.ids`: required identifier array, up to 10 IDs for Storefront Catalog.
- Optional localization context and post-resolution filters.

**Documented behavior:** Returns resolved product/variant information. Variants can contain `inputs` correlation indicating how an input matched. Unresolved IDs appear as `not_found` messages.

### 2.3 `get_product`

**Function:** Obtain detailed information for one product or variant and support option selection.

**Documented inputs:**

| Input | Semantics |
|---|---|
| `catalog.id` | Required product or variant GID |
| `catalog.selected` | Optional option selections, e.g. `[{"name":"Color","label":"Blue"}]` |
| `catalog.preferences` | Option names ordered by relaxation priority (documented in UCP catalog reference) |
| `catalog.context` | Localization/relevance signals |
| `catalog.filters` | Category/price and, where supported, availability-related constraints |

**Documented response information:** Product detail, effective `selected` values, options, option values with `available` and/or `exists` signals, narrowed variants, variant price and availability, media, ratings where available, and product metadata where available.

**What this explicitly supports:** Interactive variant selection and availability-aware product detail views.

## 3. Standard Storefront policy / FAQ capability

**Endpoint:** `https://{shop}.myshopify.com/api/mcp`\
**Tool:** `search_shop_policies_and_faqs`

**Function:** Retrieve answers to questions about store policies, products, and services.

**Inputs:**
- `query` (required): question text.
- `context` (optional): additional context, for example the currently viewed product.

**Documented constraint:** Shopify advises clients to use only the supplied answer when responding and not blend in external information that may be inaccurate.

**Not documented as provided by this tool:** A general store knowledge-base CRUD API, policy authoring API, or a guarantee that all product-specific questions have an answer.

## 4. UCP Cart MCP

**Scope:** Pre-checkout cart construction, iteration, price/total estimation, localization context, and optional buyer information.\
**Endpoint:** `https://{shop-domain}/api/ucp/mcp`\
**Authentication:** Cart tools accept unauthenticated requests. A UCP agent profile is still required.

**Tools:** `create_cart`, `get_cart`, `update_cart`, `cancel_cart`.

### 4.1 Cart facts

- A cart is a pre-checkout container for line items, localization context, and optional buyer data.
- Carts have a long TTL for browsing/exploration; the API returns `expires_at`.
- Cart responses return a merchant-assigned cart GID and a `continue_url` that can hand the buyer to the merchant storefront.
- Monetary values use integer minor units; do not assume decimal display values.
- Cart `context` can include country, region, and postal code as estimates for pricing, availability, and currency. Shopify explicitly states this context is **not authoritative shipping-address data**.
- Cart API outcomes such as inventory availability or adjusted quantity are returned in `result.structuredContent.cart.messages`; a successful JSON-RPC result can still contain a business-level warning/error outcome.

### 4.2 `create_cart`

**Required:** `cart.line_items`; each line contains `quantity` and a product-variant GID under `item.id`.

**Optional documented fields:**
- `cart.context`: `address_country`, `address_region`, `postal_code`.
- `cart.attribution`: `referring_domain`, click/activity ID tags and values, and UTM campaign/source/medium/content/term.
- `cart.buyer`: optional buyer information for personalized estimates.
- `cart.signals`: optional platform/environment signals for authorization and abuse prevention.

**Return shape includes:** validated lines, estimates/totals, `continue_url`, `expires_at`, messages, and attribution when set.

### 4.3 `get_cart`

**Input:** top-level `id` (cart GID), plus mandatory UCP metadata.

**Use/response:** Fresh current cart state, estimates, totals, and `continue_url`. An expired or missing cart is represented as a business outcome: successful JSON-RPC response with an unrecoverable `not_found` message.

### 4.4 `update_cart`

**Input:** top-level cart `id`, required full `cart` object.

**Critical semantic:** `update_cart` has **PUT/replacement semantics**. It replaces the whole cart state. Omitted fields (including `line_items`, `context`, or `attribution`) are removed. It is not a patch/merge API. Send the complete intended state.

### 4.5 `cancel_cart`

**Input:** top-level cart `id`; required `meta["idempotency-key"]` UUID in addition to UCP agent profile.

**Effect:** Cancels/removes the active cart. Subsequent lookup returns cart not found.

## 5. UCP Checkout MCP

**Scope:** Purchase session management after a buyer is ready to buy.\
**Endpoint:** `https://{shop-domain}/api/ucp/mcp`\
**Tools:** `create_checkout`, `get_checkout`, `update_checkout`, `complete_checkout`, `cancel_checkout`.

### 5.1 Authentication and access

- All Checkout MCP calls require authenticated or signed requests; anonymous access is not available.
- Shopify documents Dev Dashboard client credentials exchanged at `https://api.shopify.com/auth/access_token` using client-credentials grant. Tokens are Bearer JWTs; docs state a 60-minute TTL for JWTs created from Dev Dashboard credentials.
- Shopify also documents HTTP Message Signatures as a possible platform authentication mechanism.
- Tool access and rate limits vary by trust/authentication tier.
- Checkout MCP has stricter rate limiting than Cart MCP.

### 5.2 `create_checkout`

**Function:** Creates a checkout session from direct checkout data or optionally converts a Cart MCP cart.

**Inputs:**
- `cart_id` optional. When it is supplied, Shopify uses the cart’s `line_items`, `context`, `buyer`, and attribution and ignores overlapping checkout payload fields.
- Without `cart_id`, `checkout.currency`, `checkout.line_items`, and `checkout.buyer` are required.
- Buyer contact requires email or phone number, depending on merchant configuration.
- `checkout.context` accepts provisional intent/localization/eligibility signals: country, region, postal code, intent, language, currency, eligibility.
- `checkout.fulfillment` supports fulfillment methods and shipping destinations.
- `checkout.payment` carries available/selected payment configuration and is used when attempting direct completion.
- `checkout.attribution` supports the same documented referring/click/activity/UTM fields as Cart MCP.

**Cart-conversion facts:**
- Cart contents win over overlapping checkout fields.
- Cart discount codes are **not assumed to carry forward automatically**; Shopify says to forward them in `checkout.discounts.codes`.
- If an incomplete checkout already exists for that cart, the API returns the existing session; conversion is documented as idempotent.
- `cart_id` is accepted but is not returned on checkout objects; store it independently if needed.

### 5.3 `get_checkout`

**Input:** top-level checkout GID.

**Returns:** current checkout state, line items, totals, fulfillment data, payment instruments where applicable, messages, status, `continue_url`, and expiry.

### 5.4 `update_checkout`

**Input:** top-level checkout GID and a required full `checkout` object.

**Critical semantic:** This also has **PUT/replacement semantics**. Omitted fields are removed. Response-only fields must be removed before sending an update. Shopify specifically notes `buyer.country_code` and payment-instrument `display` data are response-only.

### 5.5 `complete_checkout`

**Function:** Submit payment/finalize a checkout and create an order when allowed.

**Inputs:** checkout GID, full appropriate payment credential/instrument from a trusted UI, UCP agent profile, and a required UUID `meta["idempotency-key"]`.

**Important access behavior:**
- Under general access, Shopify documents that `create_checkout`, `get_checkout`, and `update_checkout` generally return `status: requires_escalation` with `continue_url`; the buyer completes checkout on Shopify’s merchant storefront.
- Direct in-application completion is available only when the checkout reaches `ready_for_complete` and the agent has the applicable trusted access/payment setup.
- A `requires_escalation` response must lead the buyer to `continue_url`; it is not a signal that a client can silently complete payment.

### 5.6 `cancel_checkout`

Cancels an active checkout. Requires a checkout GID and UUID idempotency key. Canceled checkouts cannot be resumed.

### 5.7 Checkout state model

| Status | Shopify-documented meaning |
|---|---|
| `incomplete` | Required data missing; inspect messages and use `update_checkout` when recoverable |
| `requires_escalation` | Buyer input/review is required outside available API flow; use `continue_url` |
| `ready_for_complete` | All information collected; direct completion may be possible or hand off via `continue_url` |
| `complete_in_progress` | Completion processing is ongoing |
| `completed` | Order placed; order object is confirmation signal |
| `canceled` | Checkout invalid/expired; create a new one |

## 6. UCP Order MCP

**Scope:** Current-state read access for orders created through the calling agent’s checkout flow.\
**Endpoint:** `https://{shop-domain}/api/ucp/mcp`\
**Tool:** `get_order`.

### 6.1 Access conditions

- Requires Token-tier access and a Global API JWT with `read_global_api_orders`.
- The UCP profile must declare `dev.ucp.shopping.order` for the tool to appear.
- Shopify states only orders placed **through the agent** are accessible.
- It cannot retrieve orders placed through other applications or direct merchant storefront orders.
- Buyer-identity linking and cross-channel order-history lookup are not supported in v1.

### 6.2 `get_order`

**Input:** top-level Shopify Order GID.

**Returns current state:** buyer-facing label; permalink; presentment currency; totals; line items; line state/quantities; fulfillment expectations and event timeline; carrier/tracking fields when present; and committed post-purchase adjustments such as refunds, returns, exchanges, cancellations, and edits.

**Order data facts:**
- Response is a current-state snapshot, not a historical version series.
- Shopify recommends order webhooks as the primary change channel and `get_order` for buyer-initiated fresh views or reconciliation of missed delivery; it says not to schedule-poll `get_order`.
- Shopify notes to allow roughly 10 seconds after completion before first retrieval for propagation.
- For precise timing and return/refund initiation, Shopify identifies `permalink_url` as authoritative.
- Monetized fields are signed minor-unit integers. Negative adjustments represent money back to buyer.
- Event `type` and several enum-like fields should be treated as open strings.

## 7. Customer Accounts MCP

**Scope:** Authenticated, customer-specific actions such as account details and customer order management.\
**Endpoint discovery:** `https://{shopDomain}/.well-known/customer-account-api`, which returns `mcp_api` (documented example: `https://{shopDomain}/customer/api/mcp`).

### 7.1 Preconditions

- Merchant store must have a custom domain configured.
- App must meet Shopify protected-customer-data requirements.
- Integration steps must be completed; Shopify documents Level 2 protected customer data/PII access approval.
- OAuth authorization-code flow with PKCE is required.

### 7.2 OAuth facts

- Discover OAuth endpoints from `https://{shopDomain}/.well-known/openid-configuration`.
- Use application App ID as OAuth client ID, configured redirect URI, `response_type=code`, a PKCE S256 challenge, and state for CSRF protection.
- Example required scope documented: `customer-account-mcp-api:full`.
- Customer Accounts MCP calls use a customer OAuth 2.0 access token.

### 7.3 Tool inventory caveat

Shopify’s Customer Accounts MCP documentation says the server’s exact available tools must be discovered via `tools/list`, which returns live JSON schemas. The documentation describes customer-specific order management and account details/preferences, but the authoritative exact tool names, input fields, and response shapes are the runtime `tools/list` output for the installed store/app/session.

## 8. Global Catalog MCP

**Scope:** Cross-merchant discovery across Shopify merchants. Uses the UCP catalog tool names.

### 8.1 Global `search_catalog`

Beyond free-text query/context/pagination, Shopify documents these Global Catalog search inputs:

| Input | Documented behavior |
|---|---|
| `catalog.like` | Similarity source: item reference or image; may combine text query + image for multimodal query; image alone supports visual similarity |
| `filters.available` | Defaults true; false includes unavailable items |
| `filters.ships_to` | Country, region, postal code destination filter |
| `filters.ships_from` | Merchant origin country array (OR) |
| `filters.price` | Minor-unit integer min/max |
| `filters.condition` | `new` / `secondhand`, OR across values |
| `filters.shops` | Up to 1,000 shop GIDs |
| `filters.attributes` | Shopify taxonomy attributes; documented supported names: Color, Size, Target gender; entries AND, values within entry OR; unsupported names reported as messages |
| `filters.rating` | Variant rating minimum and review-count minimum |
| `filters.price_tier` | `low`, `medium`, `high`, relative to category |
| `filters.categories` | Taxonomy IDs, OR across categories |
| `view` | `offer` documented for comparison shopping |
| `placements` | Optional promoted placement types, including `affiliate`; without it, only relevance-ranked organic results |
| `saved_catalog_slug` | Saved Dev Dashboard catalog configuration; saved filters set request boundaries and saved query prefix is prepended |

**Pagination:** Global limit is 1–50 and depth is capped at 1,000 results. `total_count` is explicitly an estimate, not an exact count.

### 8.2 Global `lookup_catalog` and `get_product`

- `lookup_catalog` accepts 1–50 identifiers; accepted forms include Shopify Universal Product ID, ProductVariant GID, and Shopify product URL.
- It supports localization and availability/shipping/condition/shop filters.
- `get_product` supports selected option values, preferences for option-relaxation ordering, localization, availability/shipping/condition/shop filters, and a `summary` view.
- Result variants can include checkout URL, seller identity/domain/links, rating, availability status, and requirements such as shipping, selling plan, and components.

### 8.3 Inferred global fields

Shopify marks some Global Catalog response fields as **Inferred** rather than merchant-authored: description, options, metadata attributes (such as material/style/occasion), technical specs, top features, unique selling points, and variant condition. Shopify says they can be absent and vary in accuracy depending on available source data. Treat them as discovery/merchandising signals, not merchant-authored facts.

### 8.4 Personalized global search

Shopify documents personalized Global Catalog search as **coming soon**, using a buyer-linked token and a catalog search read scope. It should not be treated as presently available functionality.

## 9. UI, widgets, and MCP Apps

Shopify’s commerce MCP/UCP tool documentation describes machine-readable tools and structured results; it does not define a Shopify-native catalog of interactive widgets attached to the catalog/cart/checkout tools.

The separate MCP Apps extension is a general MCP proposal for servers to return interactive UI resources associated with tools. UI support is host/client dependent. Shopify’s older MCP-UI work likewise describes embedded interactive UI resources as an MCP extension. Therefore, an implementation may associate application-owned MCP App/widget resources with its own tools, but the following are not Shopify-provided guarantees:

- A Shopify-supplied product-card, variant-picker, gift quiz, comparison table, or cart widget.
- Universal MCP-host rendering support for a widget/resource extension.
- A Shopify API that chooses which UI element should be rendered for a tool result.

## 10. Errors, idempotency, and response handling

### 10.1 Two outcome categories

UCP distinguishes:
- **Protocol errors:** Authentication, rate-limit, transport, or availability failures. These arrive as JSON-RPC errors (Shopify documentation gives `-32000`, and `-32001` for discovery errors).
- **Business outcomes:** The server processed the request, but application-level outcomes exist (e.g. unavailable merchandise, invalid shipping address, expiration, quantity changed). These arrive as a successful JSON-RPC result with `structuredContent` and a `messages` array.

Always inspect `messages`, not only JSON-RPC success/failure.

### 10.2 Idempotency

Shopify documents required UUID `meta["idempotency-key"]` for:
- `cancel_cart`
- `complete_checkout`
- `cancel_checkout`

### 10.3 Rate limiting

- Rate limits are tier-dependent.
- Cart and Checkout have separate rate limits; Checkout is more restrictive.
- Token tier has highest limits, signed tier lower limits, anonymous tier lowest; Checkout is not available to anonymous calls.
- Shopify says to honor HTTP `Retry-After`; if absent, apply exponential backoff with jitter.

## 11. Shopify-provided capabilities vs. non-provided capabilities

### 11.1 Provided (subject to the stated endpoint, tool, access, and merchant configuration)

- Single-merchant product search and product/variant lookup.
- Free-text product query and buyer intent/localization context input.
- Product categories, descriptions, media, options, variant availability, price range, variant price, and ratings/metadata where present.
- Variant narrowing and selection-state retrieval.
- Store policy/FAQ answer retrieval.
- Anonymous cart creation, reading, whole-cart replacement, cancellation, estimate/totals retrieval, and storefront cart handoff.
- Authenticated/signed checkout lifecycle: create, retrieve, whole-checkout replacement, cancellation, and potentially direct completion for eligible/trusted agents.
- Merchant storefront checkout handoff via `continue_url`.
- Agent-originated-order current state retrieval with Token-tier authorization.
- UCP order webhooks for current order state/lifecycle updates.
- Authenticated Customer Accounts MCP access, subject to custom domain, OAuth PKCE, installed app configuration, and protected-customer-data approval.
- Cross-merchant Global Catalog search, including documented global filters and image/similarity query capability.

### 11.2 Not documented by Shopify as a native capability of these MCP servers

- A dedicated gift-recommendation endpoint or recipient/occasion recommendation model.
- A general “best product” scoring/explanation API, recommendation confidence, or controllable semantic-ranking model.
- Persistent cross-session shopper preference memory or arbitrary shopper-profile storage.
- Full cross-channel customer order history through UCP Order MCP v1.
- Searching/reading an order created by a different agent, a different app, or directly on a storefront via UCP Order MCP.
- General return-initiation, refund-initiation, exchange-initiation, or order-edit mutation tool in the documented UCP Order MCP (it only documents `get_order`).
- Merchant admin/catalog-write operations, inventory management, product authoring, fulfillment operations, discount authoring, or analytics reporting through the documented storefront/UCP MCP surfaces.
- A Shopify-provided general-purpose frontend component/widget library for MCP tool outputs.
- Guaranteed direct, in-agent payment completion for all merchants, checkouts, and agents; general access uses `continue_url` escalation/handoff.
- Guaranteed availability of every tool on every store; Shopify says some stores may restrict access and tool availability is negotiated/discovered.
- Merchant-authored factual status for Global Catalog fields explicitly marked Inferred.

## 12. Raw integration requirements checklist

1. Implement JSON-RPC 2.0 and request `tools/list` for live schemas.
2. Host an agent UCP profile at a durable `.well-known/ucp` URL.
3. Include `meta.ucp-agent.profile` on UCP calls.
4. Model raw IDs as Shopify GIDs, not human-facing product/order labels.
5. Treat monetary amounts as integer minor units paired with ISO currency.
6. Store cart and checkout IDs; Shopify does not return `cart_id` on checkout response objects after conversion.
7. Treat cart/checkout update as full replacement, not partial patch.
8. Implement business-outcome `messages` handling even on successful JSON-RPC responses.
9. Use required idempotency keys for cancellation and checkout completion operations.
10. Implement rate-limit handling using `Retry-After` plus exponential backoff/jitter.
11. Support checkout escalation and display/navigate to Shopify `continue_url` when returned.
12. Use Customer Accounts discovery and OAuth PKCE rather than assuming a static endpoint or public customer access.
13. Use UCP order webhooks for proactive updates; use `get_order` only for agent-originated orders and buyer-initiated/reconciliation reads.
14. Treat Global Catalog inferred fields as non-authoritative discovery signals.

## 13. Primary official sources

- Shopify Storefront MCP server: https://shopify.dev/docs/apps/build/storefront-mcp/servers/storefront
- Shopify Storefront Catalog MCP: https://shopify.dev/docs/agents/catalog/storefront-catalog
- Shopify Cart MCP: https://shopify.dev/docs/agents/carts-and-checkout/cart-mcp
- Shopify Checkout MCP: https://shopify.dev/docs/agents/carts-and-checkout/checkout-mcp
- Shopify Order MCP: https://shopify.dev/docs/agents/orders/order-mcp
- Shopify Customer Accounts MCP: https://shopify.dev/docs/apps/build/storefront-mcp/servers/customer-account
- Shopify Global Catalog MCP: https://shopify.dev/docs/agents/catalog/global-catalog
- Shopify commerce agents overview: https://shopify.dev/docs/agents
- Shopify Storefront MCP cart deprecation announcement: https://shopify.dev/changelog/storefront-mcp-cart-tools-are-being-deprecated-in-favour-of-ucp-cart-mcp
- MCP Apps proposal: https://blog.modelcontextprotocol.io/posts/2025-11-21-mcp-apps/
