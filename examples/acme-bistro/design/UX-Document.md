# Acme Bistro ChatGPT App — User Flow & Experience Document

**Prepared by:** Noodle Seed
**Scope:** Diners browse the Acme Bistro menu, build and confirm an order inside ChatGPT, then hand off once to a signed checkout link to pay — the card never touches the app.
**Status:** Design specification (v1)
**Funnel boundary:** IN the app — menu, order building, order confirmation, and the checkout hand-off, all in-chat. OFF-app — **payment only**, on Acme Bistro's PCI-scoped checkout at `pay.acme.example`. **No per-user OAuth in this app**; the connector runs on Acme's own service credentials, and the diner authenticates (if at all) only on the payment page.

---

## 0. The One-Paragraph Thesis

A hungry diner opens ChatGPT and types *"order me two margheritas and a lemon tart from Acme Bistro."* Today that intent scatters across a search, a delivery-app download, a menu scroll, and a checkout form. Acme Bistro collapses it into one conversation: the model reads the live menu, parses the order out of plain language, renders a running cart the diner can nudge with a tap or a sentence, and — only when the order is right — mints a **signed, expiring payment link** that opens Acme's own checkout. We own the entire pre-payment experience; Acme owns the money. That split is deliberate and it is the product: the app never sees a card number, so Acme's PCI scope never grows, yet the diner completes a real, paid-intent order without leaving the chat. For a single restaurant, this is the cheapest possible storefront on the fastest-growing surface — one `server.ts`, no app to install, and every order arrives at Acme's checkout already built. If you can convincingly finish this order in a sentence, you have out-competed every tap-driven ordering app on the one axis they cannot copy: language.

---

## 1. Acme Bistro Product Overview (Knowledge Base)

**Acme Bistro is a single fictional neighbourhood restaurant** offering a short, curated menu for pickup ordering. Unlike a marketplace aggregator, there is one kitchen, one menu, and one checkout — which makes the conversational surface tight and the guardrails simple. The ChatGPT App is Acme's storefront on ChatGPT: it shows the menu, builds the order, and passes a ready cart to Acme's payment page.

### 1.1 The Menu (authoritative — the app must know this exactly)

| Item | ID | Price (USD) | Course |
|------|-----|-------------|--------|
| Stone-baked Margherita | `stone_pizza` | $14 | Mains |
| Harvest Roast Bowl | `roast_bowl` | $13 | Mains |
| House Garden Salad | `house_salad` | $11 | Starters |
| Lemon Tart | `lemon_tart` | $8 | Desserts |
| Sparkling Water | `sparkling` | $4 | Drinks |

Prices are whole-dollar and fixed for v1. The **backend owns pricing** — the widget sums line items for display, but the amount that reaches checkout is recomputed and re-validated by Acme at `pay.acme.example`. The menu is small enough to render in a single inline widget with no pagination.

### 1.2 The End-to-End Model (the defining choice)

Every other decision follows from one line: **the order is built and confirmed in chat; only payment hands off.** There is no in-chat card capture, no wallet, no stored payment method. When the diner is ready, the app calls `create_checkout`, which returns a **signed deep link** carrying a url-safe cart token and the numeric total; ChatGPT opens it, and Acme's checkout takes the card. The MCP server is never in the payment path.

### 1.3 Business Model & Why Acme Wants This

Acme's bottleneck is reach, not kitchen capacity: a neighbourhood restaurant has no realistic way onto a conversational surface without building an app. The ChatGPT App removes that bottleneck for the cost of one authored server. **Attribution is built in** — every checkout link carries `src=chatgpt`, so Acme can measure exactly how much revenue the conversational storefront drives against their existing web orders.

---

## 2. Competitive Landscape — Food Ordering on ChatGPT

| Pattern | Examples | Strength | Gap Acme fills |
|---------|----------|----------|----------------|
| **Marketplace aggregators** | Large delivery apps | Vast networks, delivery logistics | Menu markups, no single-restaurant intimacy, heavy handoff to a separate app |
| **Reservation / discovery** | Booking + reviews apps | Strong discovery inventory | No ordering, no checkout |
| **Acme Bistro (this app)** | — | One kitchen, honest single-menu pricing, full order built in chat, payment on Acme's own PCI checkout | — |

**Acme's position:** Acme is not trying to be a marketplace. Its advantage inside ChatGPT is **directness** — a diner who already wants Acme's food gets from craving to a paid-ready cart in one conversation, with the restaurant's own prices and the restaurant's own checkout. The single-restaurant scope is a feature: no ranking to game, no cross-restaurant carts, no ambiguity about whose menu the model is grounding on.

---

## 3. Target User Personas

### Persona A — "The Regular"
Orders from Acme every week and knows the menu. Wants the shortest possible path: *"the usual — two margheritas and a sparkling water."* Values speed and an accurate cart over discovery.

### Persona B — "The Craver"
Arrives with an appetite, not a specific dish: *"something light from Acme"* or *"what mains do you have?"* Needs the menu surfaced fast and an opinionated nudge toward the roast bowl or the salad.

### Persona C — "The Careful Orderer"
Has a dietary constraint and asks before adding: *"is the garden salad vegetarian?"* Needs honest, non-guessing answers grounded only in what the menu data actually states — and a clear defer-to-restaurant when it doesn't.

### Persona D — "The Group Coordinator"
Ordering for two or three people with a running budget: *"add a margherita, a roast bowl, a salad, and a lemon tart — what's the total?"* Needs a live, legible cart total and easy quantity edits before committing to pay.

---

## 4. Conversational User Flow

### 4.1 Entry Points

Natural phrases that should trigger the app:

```
"Show me the Acme Bistro menu"
"Order two margheritas and a lemon tart from Acme"
"I want something light from Acme Bistro"
"What mains does Acme have?"
"Add a sparkling water to my Acme order"
"What's my Acme total?"
"Check out and pay for my Acme order"
```

### 4.2 Flow Architecture

```
┌──────────────────────────────────────────────┐
│              USER ENTERS CHAT                  │
│           (natural-language prompt)            │
└───────────────────────┬────────────────────────┘
                        │
                        ▼
          ┌─────────────────────────────┐
          │      show_menu (widget)      │
          │  MenuCart renders: 5 items,  │
          │  steppers, live total, CTA   │
          └──────────────┬───────────────┘
                        │
        ┌───────────────┼────────────────┐
        ▼               ▼                ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ add_to_cart  │ │remove_from_  │ │  taps in     │
│ (NL: "two    │ │cart (NL or   │ │  the widget  │
│  margheritas")│ │  − button)  │ │  (+ / −)     │
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘
        └────────────────┼────────────────┘
                        ▼
          ┌─────────────────────────────┐
          │   Live cart + running total  │
          │   (summed in the widget)     │
          └──────────────┬───────────────┘
                        │  "check out & pay"
                        ▼
          ┌─────────────────────────────┐
          │       create_checkout        │
          │  → signed, expiring link to  │
          │     pay.acme.example         │
          └──────────────┬───────────────┘
                        ▼  (OFF-APP)
          ┌─────────────────────────────┐
          │  Acme PCI checkout · card    │
          │  entered here, never in chat │
          └─────────────────────────────┘
```

### 4.3 Detailed Conversational Scenarios

#### Scenario 1 — Natural-language order (Persona A/D)

```
USER: Order me two margheritas and a lemon tart from Acme Bistro.

APP:  [tool: show_menu {customer:"Guest"}]  → renders MenuCart
      [tool: add_to_cart {item:"stone_pizza", quantity:2}]
      [tool: add_to_cart {item:"lemon_tart",  quantity:1}]

      Here's your Acme Bistro order — two Stone-baked Margheritas
      and a Lemon Tart. That's $36 so far. Want a drink or a side,
      or shall I take you to checkout to pay?

      [MenuCart widget]
      ┌────────────────────────────────────────────┐
      │ 🍽  Acme Bistro          2 in cart          │
      │ Stone-baked Margherita  Mains   $14  [−]2[+]│
      │ Harvest Roast Bowl      Mains   $13  [−]0[+]│
      │ House Garden Salad      Starters$11  [−]0[+]│
      │ Lemon Tart              Desserts $8  [−]1[+]│
      │ Sparkling Water         Drinks   $4  [−]0[+]│
      │ ──────────────────────────────────────────  │
      │ Total  $36        [ 💳 Check out & pay ]     │
      │ Payment happens on acme.example — your card  │
      │ is never entered in chat.                    │
      └────────────────────────────────────────────┘
```

#### Scenario 2 — Add and edit (Persona D)

```
USER: Add a sparkling water too.

APP:  [tool: add_to_cart {item:"sparkling", quantity:1}]
      Added a Sparkling Water — your total is $40 for four items.

USER: Actually drop one margherita.

APP:  [tool: remove_from_cart {item:"stone_pizza"}]
      Done — one Margherita, one Lemon Tart, one Sparkling Water.
      New total $26. Ready to pay whenever you are.
```

#### Scenario 3 — Dietary question, honest answer (Persona C)

```
USER: Is the garden salad vegetarian?

APP:  The House Garden Salad is on our Starters menu at $11. I can
      tell you what's on the menu, but I can't confirm ingredient-
      level details like preparation or cross-contact — for
      allergy or dietary certainty, please check with Acme Bistro
      directly before ordering. Want me to add it anyway, or show
      you the other starters and mains?
```

#### Scenario 4 — Checkout handoff (all personas)

```
USER: Check out and pay.

APP:  [tool: create_checkout {customer:"Guest",
        cartToken:"stone_pizzax2-lemon_tartx1-sparklingx1", total:40}]

      Your order's ready — two Margheritas, a Lemon Tart, and a
      Sparkling Water, $40 total. I've opened Acme's secure
      checkout to take payment. Your card is entered on
      acme.example, never here in chat.

      [opens https://pay.acme.example/checkout?cart=
       stone_pizzax2-lemon_tartx1-sparklingx1&total=40&src=chatgpt]
```

---

## 5. UI Widget Specifications

> The widget is authored as a Noodle Seed React `view` (`tool` → `MenuCart`), styled with **vanilla CSS cascade layers** so it inherits the host's light/dark theme and adapts to ChatGPT's surface. Compliance is verified with `noodle check --target chatgpt`.

### 5.1 Design System Compliance

Acme authors **one** brand surface through the server `branding` tokens; everything else defers to host-provided semantic tokens (text, background, border, success/warning), so the widget looks native in ChatGPT.

| Category | Source | Value |
|----------|--------|-------|
| Text / background / border | Host semantic tokens (via cascade layers) | Host-provided, theme-aware |
| Brand accent | `branding.accent` | `#B91C1C` (Acme red) — **primary CTA + logo mark only** |
| Surface (light) | `branding.surface` | `#FEF3F2` |
| Surface (dark) | `branding.surfaceDark` | `#1A1211` |
| Radius / density | `branding.radius` / `branding.density` | `lg` / `comfortable` |

**Enforced rules:** system font stack; monochromatic outlined icons (the plate mark, the card glyph); WCAG AA contrast on all text/surface pairs (Acme red is used only as a fill behind light text or as a 1px mark, never as body text on white); no nested scroll (the 5-item menu fits without an inner scroller); brand accent restricted to the primary **Check out & pay** button and the header mark.

### 5.2 Display Mode Strategy

| User intent | Display mode | Rationale |
|-------------|--------------|-----------|
| Browse the menu / build an order | **Inline Card** (`MenuCart`) | Five items + steppers + total fit an inline card; no drill-in, no pagination |
| Confirm total & pay | **Inline Card** (same widget, primary CTA) | The CTA opens the off-app checkout; no in-chat payment surface |
| Payment | **None (off-app browser)** | Deliberately not a widget — card capture stays on Acme's PCI page |

Modes deliberately **not** used: no Carousel (a single flat menu doesn't need one), no Fullscreen (five items don't warrant it), no Picture-in-Picture (there is no live-tracking phase in v1 — fulfilment happens after payment on Acme's side).

### 5.3 Widget Specifications

#### ★ `MenuCart` — Inline Card
**Purpose:** the entire in-chat experience — menu, order building, live total, and the checkout hand-off — in one widget.

| Spec | Value |
|------|-------|
| Header | Plate mark, "Acme Bistro" title, status subtitle, cart chip (`N in cart` / `Fullscreen`) |
| Menu rows | One per item: name, course, price, and a `[− qty +]` stepper |
| Total | Live subtotal summed in React from the session-local cart |
| Primary action | **Check out & pay** (brand red) — disabled while the cart is empty or checkout is pending; opens the signed link via `openExternal` |
| Reassurance | Fine-print note: "Payment happens on acme.example — your card is never entered in chat." |
| Edge states | Empty cart (CTA disabled), pending checkout ("Opening checkout…"), dark theme variant |

**Two-users note:** every row is model-fillable — the model reflects *"two margheritas"* into `add_to_cart {item:"stone_pizza", quantity:2}`, and the same widget a human taps updates identically.

---

## 6. Tool Definitions (App Backend)

### ★ Tool 1: `show_menu` — `tool`
**Input:** `{ customer?: string = "Guest" }`
**Output:** `{ status, customer, items[] }` where each item is `{ id, name, price, kind }`.
**Renders:** the `MenuCart` widget.
**Annotations:** read-only.
**Triggers:** any menu / ordering intent ("show me Acme's menu", "order from Acme").

### Tool 2: `add_to_cart` — `tool`
**Input:** `{ customer?, item: <menu id> = "stone_pizza", quantity?: int ≥1 = 1, notes?: string }`
**Output:** `{ status, item, quantity, notes }`.
**Annotations:** local write (non-destructive).
**Triggers:** natural-language additions ("add two margheritas", "and a lemon tart"). Widget-facing helper — reflects NL selections into the visible cart.

### Tool 3: `remove_from_cart` — `tool`
**Input:** `{ customer?, item: <menu id> = "stone_pizza" }`
**Output:** `{ status, item }`.
**Annotations:** local write (non-destructive).
**Triggers:** "drop one margherita", "remove the salad", or the widget's `−` button.

### ★ Tool 4: `create_checkout` — model-visible `tool`
**Input:** `{ customer?, cartToken: string = "cart", total: number ≥0 = 0 }`
**Output:** `{ status, summary, checkoutUrl }`.
**Annotations:** open-link (external action).
**Behaviour:** returns a signed deep link — `https://pay.acme.example/checkout?cart=<cartToken>&total=<total>&src=chatgpt`. The card never reaches this app. `handoff.allowedDomains` includes `pay.acme.example`, so the compiler derives the ChatGPT redirect domain and the link opens without a safe-link warning.
**Triggers:** "check out", "pay", "I'm done".

Tools are atomic and model-friendly: `show_menu` reads, the two cart tools write locally, `create_checkout` opens the one external link. There is no `submit_order` or `capture_payment` tool by design — order fulfilment and payment are Acme's, past the boundary.

---

## 7. Conversation Design Principles

### 7.1 Tone of Voice
Warm, concise, and restaurant-first — like a counter host who knows the menu. State prices and totals as plain facts ("that's $36 so far"), recommend when it helps ("the roast bowl is the heartier main"), and never oversell.

### 7.2 Guardrails (non-negotiable)
- **Never invent menu items or prices.** Ground every dish and amount in the `show_menu` data — only the five items, only their listed prices.
- **Never confirm allergen or dietary safety.** State what the menu says (course, name, price); for ingredient-level or cross-contact questions, defer to Acme Bistro directly. Never assert "this is vegetarian/gluten-free" without a menu flag that says so.
- **Never take payment in chat.** No card numbers, no CVV, no wallet. Payment is the one off-app step; if a user pastes card details, decline and point them to the checkout link.
- **Never promise fulfilment the app can't see.** The app builds and hands off the order; pickup timing and order status live on Acme's side after payment.
- **Always show the honest total before checkout**, and restate that payment happens on `acme.example`.

### 7.3 Memory Strategy
Remember the diner's in-session cart and name. There is no cross-session account (no per-user auth) — a returning diner starts a fresh order, though the model may recall a prior order *within the same conversation* to speed a reorder.

### 7.4 Multi-Turn Intelligence
The model infers item + quantity from language ("a couple of margheritas" → `quantity:2`), keeps a running total in view, and asks only when genuinely ambiguous ("did you mean the margherita or the roast bowl?"). It never asks for a field it can default.

---

## 8. End-to-End User Journey Map

**Phase 1 — Menu (first 5–10s):** user names Acme or asks for the menu → `show_menu` renders `MenuCart`.
**Phase 2 — Build (10–40s):** natural-language adds/removes (`add_to_cart` / `remove_from_cart`) and/or widget steppers; the total updates live.
**Phase 3 — Confirm (5–10s):** the app restates the cart and total in plain language; user says "pay".
**Phase 4 — Hand off (2–5s):** `create_checkout` mints the signed link; ChatGPT opens it.
**Phase 5 — Pay (off-app):** the diner enters their card on `pay.acme.example`; the app's job is done. Fulfilment is Acme's.

---

## 9. Handoff Architecture (Deep Dive)

**What must be true of the handoff:**
1. **Context survives the jump.** The cart token encodes every line (`stone_pizzax2-lemon_tartx1-sparklingx1`) plus the total, so Acme's checkout rehydrates the exact order without a second round-trip.
2. **The link is signed and attributable.** Acme signs the checkout URL server-side and carries `src=chatgpt` for attribution. `handoff.allowedDomains: ['https://pay.acme.example', 'https://acme.example']` lets the compiler emit the redirect domain so the link opens cleanly.
3. **State is re-validated past the boundary.** Acme recomputes pricing, checks inventory, and enforces the total at checkout — the widget's sum is display-only and never authoritative.
4. **The link expires.** Checkout URLs carry an `expires_at`; a stale link lands on a "cart expired — start again" page rather than charging an out-of-date total.

**URL pattern:** `https://pay.acme.example/checkout?cart={cartToken}&total={total}&src=chatgpt`

**Why payment is the only handoff:** keeping card capture on Acme's PCI-scoped checkout means the MCP server never enters payment scope — no card data, no stored methods, no compliance burden added by the ChatGPT surface. The app is the storefront; Acme is the register.

**Open questions for Acme engineering:**
- Signing scheme + default expiry window (proposed: 15 minutes)?
- Should the cart token be opaque (server-minted) instead of the human-readable `idxN-idxN` form, to prevent client-side total tampering before re-validation?
- Post-payment visibility (webhook / polling) so a later chat turn can confirm "your order is ready" — out of scope for v1?

---

## 10. Demo Scope Recommendation

**MVP (build in this order):**
1. `show_menu` + `MenuCart` — menu renders, steppers work, total sums live.
2. `add_to_cart` / `remove_from_cart` — natural-language and button edits both reflect in the cart.
3. `create_checkout` — signed link opens Acme's checkout with the cart pre-loaded.

**2-minute demo script:**
```
NARRATOR: "A diner wants dinner from their neighbourhood spot,
Acme Bistro, without leaving ChatGPT."

USER: "Order two margheritas and a lemon tart from Acme Bistro."
[show_menu renders MenuCart; add_to_cart ×2 fills the cart — $36]

USER: "Add a sparkling water."
[add_to_cart — total ticks to $40]

USER: "What's my total?"
[MenuCart shows Total $40, four items]

USER: "Check out and pay."
[create_checkout mints the signed link; ChatGPT opens
 pay.acme.example — card entered there, never in chat]

NARRATOR: "Built and confirmed in one conversation; paid on Acme's
own secure checkout. The app never saw a card number."
```

---

## 11. Technical Architecture (High Level)

```
┌───────────────────────────────────────────────┐
│                 ChatGPT Client                  │
│   MenuCart widget (Noodle Seed React view)      │
│   cascade-layer CSS · host theme tokens         │
└───────────────────────┬─────────────────────────┘
                        │ tool calls
                        ▼
┌───────────────────────────────────────────────┐
│      Acme Bistro MCP server (Noodle Seed)       │
│   show_menu · add_to_cart · remove_from_cart    │
│   create_checkout                               │
│   branding tokens · handoff.allowedDomains      │
│   (static menu data; no per-user auth)          │
└───────────────────────┬─────────────────────────┘
                        │ signed checkout link (no card data)
                        ▼
┌───────────────────────────────────────────────┐
│   Acme Bistro checkout — pay.acme.example       │
│   PCI-scoped card capture · pricing/inventory   │
│   validation · order fulfilment                 │
└───────────────────────────────────────────────┘
```

Menu data is static in v1 (authored in `server.ts`). Session cart state lives in the widget (React). No database, no per-user credentials, no card data in the MCP server — the smallest possible surface for a single-restaurant storefront.

---

## 12. Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Menu render → first add | 55%+ of `show_menu` sessions add ≥1 item | `add_to_cart` call rate |
| Cart with ≥1 item → `create_checkout` | 60%+ | Tool-call funnel |
| Checkout link opened → paid (on Acme) | Acme-side; joined via `src=chatgpt` | Acme checkout analytics |
| End-to-end (entry → paid order) | 15%+ | Funnel + Acme attribution |
| Average order value | $30+ | Cart totals at `create_checkout` |
| Time to checkout hand-off | Under 60s | Session duration |

**Attribution mechanics:** every `create_checkout` link carries `src=chatgpt`, so Acme can attribute paid revenue to the ChatGPT storefront and compare it against their existing web channel.

---

## 13. Future Enhancements (Post-Launch)

- **Item notes at scale** — surface the `notes` field in the widget for per-item requests ("no basil").
- **Modifier groups** — sizes / add-ons if the menu grows beyond flat items (would introduce an item-detail widget).
- **Live inventory** — mark sold-out items unavailable from Acme's kitchen system.
- **Post-payment confirmation** — an Acme webhook so a later chat turn can confirm "your order is ready for pickup."
- **Returning-diner reorder** — opt-in, if Acme later adds per-user accounts (would move this app off the no-auth model deliberately).
- **Scheduled pickup** — choose a pickup window before the checkout hand-off.
- **Second location** — a lightweight location picker if Acme opens another kitchen (keeps single-menu simplicity per location).

---

### Appendix A — Funnel Boundary Cheat-Sheet

| User request | Handled in the app? | Where it lands |
|--------------|---------------------|----------------|
| "Show me the menu" | ✅ In-chat | `show_menu` → `MenuCart` |
| "Add two margheritas" | ✅ In-chat | `add_to_cart` |
| "Drop the salad" | ✅ In-chat | `remove_from_cart` |
| "What's my total?" | ✅ In-chat | Live widget total |
| "Check out / pay" | ✅ In-chat → hand-off | `create_checkout` mints signed link |
| Enter card & pay | ❌ OFF-APP | `pay.acme.example` (Acme PCI checkout) |
| Pickup timing / order status | ❌ OFF-APP | Acme's side, post-payment |
| Account / saved cards | ❌ Not in v1 | No per-user auth by design |

---

*This document is the master spec for the Acme Bistro ChatGPT App. Acme Bistro, its menu, and its domains are illustrative. All tool names, widget names, menu items, and prices match the runnable Noodle Seed app exactly; the checkout link shape and pricing/inventory validation are owned by Acme's backend past the funnel boundary.*
