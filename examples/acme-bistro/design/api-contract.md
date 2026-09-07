# Acme Bistro — Recommended API Shapes

**For Acme Bistro Engineering.** Concrete request/response JSON for each tool the ChatGPT App calls, so your backend can implement exactly what the app needs. These are a starting point for the contract, not a final spec — field names and envelopes can shift to match Acme's platform conventions, as long as the semantics below are preserved.

> **The backend owns pricing, inventory, and payment.** The widget sums line items for *display only*; the amount that reaches checkout is recomputed and enforced by Acme at `pay.acme.example`. The MCP server never sees a card number, a CVV, or a stored payment method — payment is the single off-app step. Keep pricing, availability, and the signed checkout link server-side.

The app maps to four tools:

| Tool | Kind | Job |
|------|------|-----|
| `show_menu` | `tool` (read-only) | Return the menu + render the `MenuCart` widget |
| `add_to_cart` | `tool` (local write) | Reflect a natural-language addition into the visible cart |
| `remove_from_cart` | `tool` (local write) | Remove one unit of an item |
| `create_checkout` | model-visible `tool` (open-link) | Mint the signed, expiring payment link |

Menu item IDs are the stable enum: `stone_pizza`, `roast_bowl`, `house_salad`, `lemon_tart`, `sparkling`.

---

## 1. `show_menu` — menu + widget

The one read. Returns the full menu (small enough to render without pagination) plus a status line the model can speak.

**Request**
```json
{
  "customer": "Guest"
}
```

**Response**
```json
{
  "status": "Acme Bistro menu is ready for Guest. Build the order here; pay at checkout.",
  "customer": "Guest",
  "items": [
    { "id": "stone_pizza", "name": "Stone-baked Margherita", "price": 14, "kind": "Mains" },
    { "id": "roast_bowl",  "name": "Harvest Roast Bowl",     "price": 13, "kind": "Mains" },
    { "id": "house_salad", "name": "House Garden Salad",      "price": 11, "kind": "Starters" },
    { "id": "lemon_tart",  "name": "Lemon Tart",              "price": 8,  "kind": "Desserts" },
    { "id": "sparkling",   "name": "Sparkling Water",         "price": 4,  "kind": "Drinks" }
  ]
}
```

**Notes.**
- `price` is a whole-dollar USD number in v1. If Acme moves to cents or a currency field, keep one canonical numeric price per item so the widget's sum and the checkout total agree.
- `items[]` is the authoritative menu — the model must not invent dishes or prices outside this list.
- **Extensibility:** Acme may add fields (`description`, `available`, `dietary_tags`, `image_url`) without breaking the app, as long as `id`, `name`, `price`, and `kind` remain. If `available: false` is added, the widget should disable that row's `+` button.

---

## 2. `add_to_cart` — reflect a natural-language addition

Called when the diner says *"add two margheritas"* — the model fills `item` and `quantity` from language. The cart is session-local in the widget; this tool echoes the resolved selection so the model can speak it back.

**Request**
```json
{
  "customer": "Guest",
  "item": "stone_pizza",
  "quantity": 2,
  "notes": ""
}
```

**Response**
```json
{
  "status": "Added 2 × stone_pizza for Guest.",
  "item": "stone_pizza",
  "quantity": 2,
  "notes": ""
}
```

**Notes.**
- `quantity` is an integer ≥ 1 (defaults to 1). `item` must be one of the five menu IDs; reject unknown IDs.
- `notes` is a free-text per-item request ("no basil"); optional, defaults to empty.
- **If Acme makes this server-authoritative** (rather than widget-local), return the updated line and a running subtotal so the frontend can render without a second call — e.g. add `line_total` and `cart_subtotal`. For v1 the widget owns the running total, so the minimal echo above is sufficient.

---

## 3. `remove_from_cart` — remove one unit

Called by the widget's `−` button or by language ("drop a margherita"). Removes one unit of the item.

**Request**
```json
{
  "customer": "Guest",
  "item": "stone_pizza"
}
```

**Response**
```json
{
  "status": "Removed stone_pizza for Guest.",
  "item": "stone_pizza"
}
```

**Notes.**
- Removing decrements by one; the widget deletes the line when its quantity reaches zero.
- No error if the item isn't in the cart — the operation is idempotent from the model's view (the widget guards the `−` button when quantity is 0).

---

## 4. `create_checkout` — mint the signed payment link

The one handoff. The widget computes the total (live React) and passes a url-safe cart token plus the numeric total; the tool returns a **signed, expiring** deep link to Acme's PCI-scoped checkout. **No card data is exchanged here** — the diner enters their card on `pay.acme.example`.

**Request**
```json
{
  "customer": "Guest",
  "cartToken": "stone_pizzax2-lemon_tartx1-sparklingx1",
  "total": 40
}
```

**Response**
```json
{
  "status": "Ready to pay for Guest's order.",
  "summary": "Guest's Acme Bistro order · 40 USD",
  "checkoutUrl": "https://pay.acme.example/checkout?cart=stone_pizzax2-lemon_tartx1-sparklingx1&total=40&src=chatgpt",
  "expires_at": "2026-07-09T18:15:00-07:00"
}
```

**Notes.**
- **`checkoutUrl` must be signed server-side.** The `cart` and `total` query params are a convenience for rehydration and display — Acme's checkout must **recompute pricing from the cart token and enforce its own total**, never trusting the client-supplied `total`. Treat the incoming `total` as a display hint to reconcile, not as the charge amount.
- **`expires_at`** bounds the link (proposed 15-minute window). An expired link should land on a "cart expired — start again" page, not charge a stale total. The runnable app returns `status`, `summary`, and `checkoutUrl`; adding `expires_at` is the recommended production extension so the model can tell the diner how long the link is good for.
- **`src=chatgpt`** is the attribution parameter — carry it through to Acme's order record so ChatGPT-sourced revenue is measurable against the web channel.
- **Cart token format.** The app emits a human-readable `<id>x<qty>-<id>x<qty>` token. For production, consider an **opaque server-minted token** (the client passes a cart handle; Acme resolves it to the authoritative lines) to remove any incentive to tamper with the token or `total` before re-validation.
- **`handoff.allowedDomains`** in the server (`https://pay.acme.example`, `https://acme.example`) is what lets the compiler derive the ChatGPT redirect domain, so the link opens without a safe-link warning. Any new payment domain must be added there.

---

## Validation & ownership summary

The backend must own and enforce:

1. **Pricing** — the authoritative per-item price and the order total; the widget sum is display-only.
2. **Inventory** — item availability at menu-read and at checkout; a sold-out item should not reach a paid order.
3. **Payment** — all card capture on `pay.acme.example`, inside Acme's PCI scope. The MCP server is never in the payment path.
4. **Link integrity** — server-side signing of `checkoutUrl`, an enforced `expires_at`, and recomputation of the total from the cart token before charging.

Everything before payment — menu, cart, total, and minting the link — is the ChatGPT App's job. Everything at and after payment is Acme's.

---

## Open questions for Acme engineering

1. **Cart token shape** — keep the readable `idxN-idxN` form, or move to an opaque server handle to prevent client-side tampering?
2. **Signing scheme & expiry** — HMAC, JWT, or signed query params, and what default expiry window (proposed 15 min)?
3. **Currency & precision** — stay whole-dollar USD, or introduce cents / a `currency` field? The widget and checkout total must agree.
4. **Server-authoritative cart** — should `add_to_cart` / `remove_from_cart` become backend-owned (returning subtotals), or stay widget-local for v1?
5. **Post-payment visibility** — expose a webhook or polling endpoint so a later chat turn can confirm order status? Out of scope for v1.
