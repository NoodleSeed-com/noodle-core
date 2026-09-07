# Acme Getaways ChatGPT App — User Flow & Experience Document

**Prepared by:** Noodle Seed
**Scope:** Top-of-funnel destination discovery & trip-shaping inside ChatGPT → signed, attributable handoff to finish booking on Acme's own site
**Status:** Design specification (v1)
**Funnel boundary:** Everything up to "this is the getaway I want and roughly when I'm going." Discovery, shortlisting, and shaping the trip (vibe · month · travelers) happen inside ChatGPT; **booking, dates, and payment happen off-app at `book.acme.example`** via a signed deep link that carries the trip. No per-user OAuth in this app.

> The funnel-boundary line above is the contract. Every scope debate resolves against it: **shape the trip in chat, transact on Acme.**

---

## 0. The One-Paragraph Thesis

A traveler deciding *where* to go doesn't start on a booking site — they start with a fuzzy feeling: "somewhere warm and walkable in June, just the two of us, not too expensive." That deliberation increasingly happens in ChatGPT, where they can think out loud and be talked through options. But base ChatGPT can only guess at places and prices; it doesn't know Acme's actual catalog, what a trip *starts from*, or which months are right. The Acme Getaways app brings Acme's **own curated destinations** — Coral Bay, Monte Alto, Old Quarter, Harbor City, each with a real starting price, best-months window, and an honest one-line reason it fits — into that same conversation, rendered as a discovery carousel the traveler can scan, shortlist, and shape. We own the **discovery and configuration** loop; Acme owns the **booking, dates, inventory, and payment** that happen on `book.acme.example`. The handoff *is* the product: the moment the traveler is excited about a specific place, one tap carries the shaped trip to Acme's site with a `src=chatgpt` attribution tag — so Acme measures, and pays for, exactly the demand ChatGPT sent. Acme never has to build or maintain a chat surface; Noodle Seed never has to touch payments.

---

## 1. Acme Getaways Product Overview (Knowledge Base)

### 1.1 What is Acme Getaways?

**Acme Getaways** is a fictional curated-travel brand that sells a small, hand-picked catalog of getaway destinations rather than an infinite metasearch index. Its edge is *curation*: every destination is chosen, described, and priced by Acme, and every trip is booked and fulfilled on Acme's own platform at `acme.example` (booking flow at `book.acme.example`). Because the catalog is small and Acme-owned, it is the ideal thing to ground a ChatGPT app on — the app can be authoritative about every place it shows, because Acme is the source of truth for all of them.

### 1.2 The Catalog (what the app helps discover)

The curated catalog is **static, Acme-owned data the app returns verbatim** — the app never invents a destination, a price, or a best-months window.

| Destination | Region | Vibe | From (per person) | Best months | Why (Acme's own line) |
|-------------|--------|------|-------------------|-------------|------------------------|
| **Coral Bay** | Adriatic coast | beach | **$890** | May–Sep | Calm swimming coves and a walkable old town — easy for a relaxed first trip. |
| **Monte Alto** | Northern Alps | mountains | **$1,120** | Dec–Mar | Ski-in village with beginner slopes and long groomed runs. |
| **Old Quarter** | Central Europe | culture | **$640** | Apr–Oct | Dense museum district and food halls, all reachable on foot. |
| **Harbor City** | Pacific rim | city | **$980** | Sep–Nov | Waterfront nightlife and day-trip islands a short ferry away. |

**"From" prices are per-person starting figures**, not quotes — the real, dated price is computed on Acme's site once the traveler picks dates and party size. The app is careful to say "from $X," never "$X."

### 1.3 The Trip Shape (the three inputs the app configures)

Discovery is parameterized by three model-fillable inputs the traveler expresses in natural language: **vibe** (`beach` · `mountains` · `culture` · `city`), **month** (a calendar month, defaulting to June), and **travelers** (party size, default 2). These are exactly the values that survive the handoff, so the trip a traveler shapes in chat is the trip Acme's site opens to. Nothing else is configured in chat — no dates, no rooms, no payment; those belong to Acme.

### 1.4 The Booking Platform (what lives after the handoff)

`book.acme.example` is Acme's real booking flow: live inventory, exact dates, party pricing, and checkout. It is **off-app by design** — it needs the traveler's account, real availability, and a payment method, none of which belong in a chat surface. The ChatGPT app's job ends the instant the traveler is ready to book; it hands the shaped trip across a signed deep link and never sees a card number.

### 1.5 Business Model / Why Acme Wants This

Acme earns on completed bookings. Its bottleneck is **top-of-funnel demand** — reaching travelers at the "where should we go?" moment, before they've defaulted to a metasearch site. That moment now happens in ChatGPT. This app moves Acme **upstream** into the deliberation itself, and — critically — makes the demand **attributable**: every handoff carries `src=chatgpt`, so Acme can measure ChatGPT-sourced sessions, handoffs, and downstream bookings, and Noodle Seed can be paid for the funnel it fills. Acme gets qualified, pre-shaped travelers landing on its booking flow; it does not have to build, staff, or moderate a conversational surface.

---

## 2. Competitive Landscape — Travel Discovery on ChatGPT

### 2.1 What exists today

Travel discovery inside ChatGPT today is **ungrounded**: the model will happily suggest destinations, but it can't tell you what *Acme* actually sells, what a trip starts from, or which months are right for a specific place — and it can't hand you off to book. Travelers bounce out to metasearch tabs, lose the context they built up in chat, and re-explain everything. Generic travel apps that do exist optimize for the *booking* transaction, not the *deliberation* — they assume you already know where you're going.

### 2.2 Acme's unique position in ChatGPT

The wedge is **"a fuzzy feeling in, a specific shortlisted getaway out — grounded in a real catalog, ready to book in one tap."** Differentiators:

- **Grounded catalog.** Every place, price, best-month, and reason comes from Acme's own data, shown in the carousel — never the model's guess.
- **Shaped, not just suggested.** The trip carries a vibe, a month, and a party size, so the handoff opens Acme's site to *this* trip, not a blank search.
- **Honest top-of-funnel.** The app is explicit that booking and payment happen on Acme, never in chat — no fake in-chat checkout, no invented availability.
- **Attributable by construction.** The `src=chatgpt` tag on the handoff makes the funnel measurable from day one.

---

## 3. Target User Personas (traveler-centric)

**Persona A — "The Weekend Deliberator."** Knows the vibe and the rough month, not the place. "Somewhere warm and walkable, early June, two of us." Wants 3–4 credible options with a reason each, fast. High intent, low patience. Handoff target: **book the shortlisted place on Acme.**

**Persona B — "The Budget-First Traveler."** Starts from a number, not a place. "What's the cheapest getaway that isn't miserable?" Scans on the "from" price, reads the reason, shortlists. Handoff target: **Acme, once the price/place feels right.**

**Persona C — "The Season Chaser."** Has a fixed window and wants the place that's *right then*. "Where's good in December?" Cares most about the best-months fit. Handoff target: **Acme, for the in-season pick.**

**Persona D — "The Vibe Switcher."** Came in for the beach, talks themselves into culture or a city break mid-conversation. Re-runs discovery with a new vibe; the carousel re-renders. Handoff target: **Acme, once the vibe settles.**

**Persona E — "The Group Coordinator."** (Edge.) Shaping a trip for 4–6 people; party size matters for how the trip reads and what carries across. Same loop; the `travelers` value is the one they care about surviving the handoff.

> **The single adaptive behavior:** the app infers vibe · month · travelers from natural language, re-runs discovery when any of them changes, and only ever offers **one deliberate exit — book on Acme.** There is no second track; the handoff is singular.

---

## 4. Conversational User Flow

### 4.1 Entry Points

1. **Vibe + month:** "Where should we go for a beach trip in June?"
2. **Budget-first:** "Cheapest getaway you'd actually recommend for two?"
3. **Season-first:** "Somewhere good in December?"
4. **Named vibe switch:** "Actually, more of a city break — options?"
5. **Party-shaped:** "A culture trip for four in October."

### 4.2 Flow Architecture

```
                 ┌─────────────────────────────────────────┐
                 │            ENTRY / INTENT                 │
                 │  vibe · month · travelers (from language) │
                 └──────────────────────┬────────────────────┘
                                        │
                              discover_getaways  ★
                                        │
                          ┌─────────────▼──────────────┐
                          │      DiscoveryCarousel      │
                          │  4 grounded options: name,  │
                          │  from-price, best-months,   │
                          │  region, Acme's "why" line  │
                          └─────────────┬──────────────┘
                                        │
             ┌──────────────────────────┼──────────────────────────┐
             │                          │                           │
      shortlist_getaway          re-run discovery            (browse / narrate)
      (tap a card → mark)        (change vibe/month/pax)      model explains fit
             │                          │                           │
             └──────────────────────────┼───────────────────────────┘
                                        │
                          ┌─────────────▼──────────────┐
                          │   "Continue on Acme" CTA    │
                          │        create_handoff  ★    │
                          └─────────────┬──────────────┘
                                        │
             ┌──────────────────────────▼───────────────────────────┐
             │           HANDOFF (the funnel boundary)                │
             │  book.acme.example/plan?dest=…&month=…&pax=…&src=chatgpt│
             │        (dates · inventory · payment happen OFF-APP)    │
             └────────────────────────────────────────────────────────┘
```

The defining property: **the discovery loop is fast, grounded, and account-free; the handoff is a single deliberate exit to Acme.** Nothing is sold, dated, or paid for inside ChatGPT.

### 4.3 Detailed Conversational Scenarios

#### Scenario 1 — "Beach trip in June" (vibe + month → carousel)

> **Traveler:** Where should we go for a beach trip in June? Just the two of us.

App calls `discover_getaways(vibe="beach", month="June", travelers=2)`.

> **ChatGPT:** Here are Acme's getaways shaped for a beach trip in June, for two —
> *[renders `DiscoveryCarousel`]*
> **Coral Bay** stands out for a relaxed June trip: calm swimming coves and a walkable old town, from **$890**, and June sits right in its May–Sep window. Tap **Shortlist** on any you like, and I'll hold it. When you're ready, **Continue on Acme** to pick dates and book.

**Subtlety:** the model *narrates which fit* (Coral Bay for beach), but the carousel shows Acme's full catalog — the tool returns all four; it never filters on the input (that's the honest, grounded behavior, §6). Prices are shown "from," never as quotes.

#### Scenario 2 — "Cheapest you'd recommend" (budget-first)

> **Traveler:** Honestly, what's the cheapest one you'd actually recommend for two?

App calls `discover_getaways(vibe="culture", month="June", travelers=2)` (model maps "cheapest, recommend" to browsing the catalog).

> **ChatGPT:** *[renders `DiscoveryCarousel`]*
> On price, **Old Quarter** starts lowest at **from $640** — a dense museum district and food halls, all walkable, best Apr–Oct so June works well. It's the value pick without feeling like a compromise. Shortlist it, or want me to lean warmer/beachier?

**Subtlety:** the recommendation is tied to Acme's real starting prices ($640 Old Quarter < $890 Coral Bay < $980 Harbor City < $1,120 Monte Alto), stated honestly as "from," and the model offers to re-shape the vibe rather than pretend to filter.

#### Scenario 3 — "Somewhere good in December" (season-first)

> **Traveler:** We've got a week in December — where's actually good then?

App calls `discover_getaways(vibe="mountains", month="December", travelers=2)`.

> **ChatGPT:** *[renders `DiscoveryCarousel`]*
> December points straight at **Monte Alto** — it's the one destination whose best-months window is **Dec–Mar** (ski-in village, beginner slopes, long groomed runs), from **$1,120**. The others read better in warmer months. Want me to shortlist Monte Alto and get you to Acme to check December dates?

**Subtlety:** the app grounds the seasonal call in the catalog's actual `bestMonths` values; it doesn't invent weather claims. Real availability for December is Acme's to confirm — the app says so.

#### Scenario 4 — "Shortlist that one" (widget-only write)

> **Traveler:** Shortlist Coral Bay.

Inside the widget, tapping **Shortlist** calls `shortlist_getaway(destination="Coral Bay")`.

> **ChatGPT:** *[carousel updates the card to "Shortlisted"; status line reads "Shortlisted Coral Bay."]*
> Held. Coral Bay's your pick — shortlist another to compare, or **Continue on Acme** when you're ready to book it for June, for two.

**Subtlety:** shortlisting is a **local, non-destructive write** (widget state), not a booking or an account action. It's the "I like this one" gesture that sets up the handoff; nothing leaves the app.

#### Scenario 5 — "Actually, a city break" (vibe switch → re-run)

> **Traveler:** Hmm, actually more of a city break. What've you got?

App re-calls `discover_getaways(vibe="city", month="June", travelers=2)`; the carousel re-renders.

> **ChatGPT:** *[renders `DiscoveryCarousel`]*
> Switching to a city vibe — **Harbor City** is the fit: waterfront nightlife and day-trip islands a short ferry away, from **$980**, best Sep–Nov (so June's shoulder-season, still lively). Shortlist it, or keep exploring?

**Subtlety:** the trip **re-shapes on a natural-language change** — the model updates the `vibe` input and re-invokes discovery. Month and party size persist so the traveler isn't re-asked.

#### Scenario 6 — "Continue on Acme" (HANDOFF — the funnel boundary)

> **Traveler:** Let's do Coral Bay. Book it.

Inside the widget, **Continue on Acme** calls `create_handoff(destination="coral_bay", destinationName="Coral Bay", month="June", travelers=2)`, then opens the returned URL.

> **ChatGPT:** *[opens `https://book.acme.example/plan?dest=coral_bay&month=June&pax=2&src=chatgpt`]*
> Opening Acme with Coral Bay, June, two travelers pre-filled — pick your exact dates and finish booking there. Booking and payment happen on Acme, never in chat.

**This is the funnel boundary.** The deep link carries the shaped trip (`dest` · `month` · `pax`) plus the `src=chatgpt` attribution. Acme's site takes it from there: real dates, live inventory, payment. The app's job — turning a fuzzy feeling into a specific, shaped, ready-to-book getaway — is done.

---

## 5. UI Widget Specifications (OpenAI Apps SDK Compliant)

> The app has **one** widget, `DiscoveryCarousel`, authored as a React `view` on the `discover_getaways` `tool`. It follows the OpenAI Apps SDK UI Guidelines (system fonts, monochrome outlined icons, WCAG AA, ≤2 actions per card, no nested scroll). Styling uses Noodle Seed's server-level `branding` tokens and CSS cascade layers — not app-specific global CSS. Acme's accent teal is restricted to the primary CTA, the logo mark, and the "Shortlisted" state only.

### 5.1 Design System Compliance

Branding is declared once, server-side, and the runtime injects it into the widget as semantic tokens:

```ts
branding: {
  name: 'Acme Getaways',
  accent: '#0EA5A4',        // teal — CTAs / logo / "Shortlisted" ONLY
  surface: '#F0FDFA',        // light surface tint
  surfaceDark: '#0B1B1B',    // dark-mode surface
  radius: 'lg',
  density: 'comfortable',
}
```

| Category | Source | Notes |
|----------|--------|-------|
| Text / background / border | Host system tokens (light + dark) | Neutral ChatGPT surface; the widget reads `theme` from `useLayout()` |
| Accent | `branding.accent` (`#0EA5A4`) | **Primary CTA + logo mark + "Shortlisted" badge ONLY** |
| Surface | `branding.surface` / `surfaceDark` | Light/dark card tint; no full-bleed brand gradient |
| Radius / density | `branding.radius: lg` / `density: comfortable` | System scale, comfortable spacing |
| Icons | Monochrome outlined (compass, external-link) | Inline SVG, single stroke, no fills |

**Rules enforced:** system fonts only; monochrome outlined icons; WCAG AA contrast in light *and* dark; no nested scroll (the carousel is a single horizontal track, no scroll-within-scroll); **≤2 actions per card** (each card has one **Shortlist** toggle; the shell has one **Continue on Acme** primary); prices always shown as **"from $X"**, never as a quote; the standing line **"Booking and payment happen on acme.example — never inside chat."** is always visible. Verify all of this with `noodle check --target chatgpt` before submission.

### 5.2 Display Mode Strategy

| User Intent | Display Mode | Compliance Note |
|-------------|-------------|-----------------|
| Discover / shortlist getaways | **Inline Carousel** (`DiscoveryCarousel`) | Horizontal track of ≤4 cards; 1 action/card; auto-fit inline |
| Scan the full catalog at once | **Fullscreen** (same component, `displayMode="fullscreen"`) | The component reads `displayMode` and shows a "Fullscreen" chip; same data, roomier layout |

> **No Picture-in-Picture, no in-chat checkout.** There is no live session to pin and no transaction in-app, so PiP is unnecessary and a payment/checkout widget is deliberately **not** built — booking is off-app by design. Fullscreen is the same carousel component, not a second widget.

### 5.3 Widget Specification

#### `DiscoveryCarousel` — Inline Carousel  ★ core (the only widget)
**Purpose:** Turn a shaped trip (vibe · month · travelers) into a scannable set of grounded Acme destinations the traveler can shortlist and then carry to Acme to book.

| Spec | Value |
|------|-------|
| Header | Compass logo mark, "Acme Getaways" title, status subtitle (e.g. "Shortlisted Coral Bay."), a mode chip ("Discover" / "Fullscreen") |
| Per card | Destination **name**, **from $price**, **region · best {months}**, Acme's **"why"** line (grounded copy), one **Shortlist** toggle (→ "Shortlisted" when active) |
| Shell action | One primary **Continue on Acme · {selected}** CTA (opens the handoff), disabled while pending ("Opening Acme…") |
| Actions per card | **1** (Shortlist) — well within the ≤2 inline limit |
| Standing note | "Booking and payment happen on acme.example — never inside chat." (always shown) |
| Model context | A `data-llm` summary line ("Acme Getaways discovery: N options for {month}, {travelers} traveler(s); shortlisted {name}") so the model can narrate accurately |
| Edge states | Empty catalog → status prompts "Pick a getaway to continue."; pending handoff → CTA shows "Opening Acme…"; dark mode → `surfaceDark` tint |

---

## 6. Tool Definitions (App Backend)

Three tools, all thin and deterministic over Acme's **own** catalog data. No tool requires a user credential, and **no tool invents a place, price, or best-month** — the catalog is returned verbatim.

### Tool 1: `discover_getaways`  ★  (tool with widget)
- **In:** `vibe ("beach"|"mountains"|"culture"|"city", default "beach")`, `month (calendar month, default "June")`, `travelers (int ≥1, default 2)`
- **Out:** `{ status, vibe, month, travelers, options[] }` where each option is `{ id, name, region, vibe, priceFrom, bestMonths, why }`
- **Behavior:** returns the **full curated catalog** verbatim and renders `DiscoveryCarousel`; the model narrates which options fit the stated vibe. It deliberately does **not** filter on the input — filtering a returned catalog on an input value is connector/flow work, not a tool's job, and returning everything keeps the app honest and lets the traveler switch vibe without a dead end. `read-only` annotation. Host status copy: "Finding getaways…" → "Getaways ready".

### Tool 2: `shortlist_getaway`  (tool for widget)
- **In:** `destination (string)`, `note (string, default "")`
- **Out:** `{ status, destination, note }`
- **Behavior:** records the traveler's shortlisted destination from inside the carousel. Widget-only (called by the view, not opened by the model). `local-action`, non-destructive — it's a "hold this one" gesture in widget state, not a booking or an account write.

### Tool 3: `create_handoff`  ★  (open-link tool)
- **In:** `destination (url-safe id slug, e.g. "coral_bay")`, `destinationName (display name)`, `month (calendar month)`, `travelers (int ≥1)`
- **Out:** `{ status, destination, summary, handoffUrl }`
- **Behavior:** builds the signed Acme booking deep link carrying the shaped trip:
  `https://book.acme.example/plan?dest=${destination}&month=${month}&pax=${travelers}&src=chatgpt`
  Every value is already URL-safe (id slug · month enum · integer), so it is substituted directly — the tool never URL-encodes, transforms, or filters an input. `open-action` annotation; the domain is declared in `handoff.allowedDomains` so ChatGPT opens it without a safe-link warning. See §9.

> **No live inventory, no pricing math, no AI in the tool path.** Discovery returns static curated data; the handoff is string substitution. The model does the language and the routing; the tools supply grounded truth and the signed link.

---

## 7. Conversation Design Principles

### 7.1 Tone of Voice
Warm, concise, and honest — a well-traveled friend who knows Acme's catalog cold. It makes a real recommendation ("Old Quarter is the value pick"), names the trade-off, and is candid about what it *can't* do (confirm December dates, quote an exact price) because that's Acme's job. No hype, no invented superlatives.

### 7.2 Guardrails (non-negotiable)
- **Never invent a destination, price, or best-month.** Only the four catalog entries exist; all values are Acme's, shown verbatim.
- **Always say "from $X," never "$X."** Starting prices are not quotes; the dated price is computed on Acme.
- **Never imply an in-chat booking, date, or payment.** The standing note is always visible; the CTA always says "Continue on Acme."
- **Ground seasonal claims in `bestMonths` only** — no fabricated weather or crowd claims.
- **Attribution is honest, not hidden.** The `src=chatgpt` tag measures the funnel; it carries no PII.

### 7.3 Memory Strategy
Lightweight, per-conversation: the current trip shape (vibe · month · travelers, so suggestions stay consistent), the shortlisted destination, and rejected vibes. No PII, no account linkage. The `chosen` selection lives in widget view-state so it survives re-renders within the session.

### 7.4 Multi-Turn Intelligence
Discovery is iterative. The app holds the trip shape across turns; **re-runs `discover_getaways` when vibe, month, or party size changes**; persists the values the traveler didn't change; and proactively offers the next step (shortlist → continue on Acme). The model routes and phrases; the tools supply the catalog and the link.

---

## 8. End-to-End User Journey Map

**Phase 1 — Frame the feeling (first 10–20s).** Traveler states a fuzzy intent; `discover_getaways` returns four grounded options. *Emotional beat: "these are real places, with real reasons."*

**Phase 2 — Compare & shortlist (20–60s).** Traveler scans on price / best-months / reason, switches vibe if the mood changes, taps **Shortlist**. *Emotional beat: "this one — I like this one."*

**Phase 3 — Decide (10–20s).** The shortlisted getaway, shaped with month and party size, is the thing to act on. *Emotional beat: confidence in the pick.*

**Phase 4 — Handoff (1 tap).** **Continue on Acme** opens the booking flow pre-filled. *Emotional beat: "and now I just pick dates."*

**Phase 5 — Off-app.** Dates, inventory, and payment on `book.acme.example`. **Outside our scope by design.**

**Phase 6 — Return (next trip).** A new conversation re-frames a new feeling; the loop repeats for the next getaway.

---

## 9. Handoff Architecture (Deep Dive) ★

The handoff *is* the product boundary — and here it is a **single, signed, attributable deep link**, not a two-track decision. Simplicity is the point.

### 9.1 What must be true of the handoff

1. **Zero credentials cross the boundary.** ChatGPT never holds an Acme login or a payment method. The traveler authenticates and pays on Acme.
2. **The shaped trip is preserved.** `dest` (id slug), `month`, and `pax` (party size) travel in the URL so nothing is re-typed on Acme.
3. **Attribution is attached.** `src=chatgpt` lets Acme credit the session, the handoff, and the downstream booking to the ChatGPT funnel — the commercial heart of the deal, and it carries no PII.
4. **The domain is allow-listed.** `book.acme.example` (and `acme.example`) are declared in `handoff.allowedDomains`; the compiler derives ChatGPT's redirect domains from that list, so the link opens without a safe-link interstitial.
5. **Values are already URL-safe.** The id slug, month enum, and integer party size need no encoding — the tool substitutes them directly (encoding an input would break substitution).

### 9.2 The URL pattern

```
https://book.acme.example/plan?dest=coral_bay&month=June&pax=2&src=chatgpt
```

`dest` = catalog id slug · `month` = calendar month · `pax` = party size · `src=chatgpt` = attribution. One pattern, every destination.

### 9.3 Recommendation & open questions for Acme

Ship against Acme's **existing** `book.acme.example/plan` entry point so nothing blocks launch. In parallel, confirm with Acme:

- The **attribution parameter** name/format (we assume `src=chatgpt`) and whether a finer campaign/session tag is wanted.
- Whether `book.acme.example/plan` should **pre-select dates** from `month` or just default the month filter (today the app passes the month; Acme owns exact dates).
- Whether a **deep-linked destination page** (`/plan/coral_bay`) is preferred over a query param — a config change, not a UX rework.

> **Design stance:** `create_handoff` emits a `url` + `summary`. Upgrading the query param to a path, or adding a session tag, is a config change — the unknowns don't block the build.

### 9.4 Edge cases at the boundary

- **Destination sold out / month unavailable:** Acme's site owns this; the app never asserts availability, only "from" pricing and best-months.
- **Mobile:** the deep link opens Acme's site/app; the shaped trip carries regardless.
- **No shortlist yet:** the CTA continues with the currently-selected (first) card, so the handoff always has a destination.

---

## 10. Demo Scope Recommendation

### 10.1 MVP demo features (priority order)
1. `discover_getaways` + `DiscoveryCarousel` — fuzzy feeling → four grounded options (the "these are real" moment).
2. `shortlist_getaway` — tap to hold a getaway (the "this one" moment).
3. Re-run discovery on a vibe switch — beach → city, carousel re-renders (the "it adapts" moment).
4. `create_handoff` — Continue on Acme, signed link with `src=chatgpt` (the funnel boundary).

### 10.2 Demo script (≈90 seconds)
1. "Beach trip in June, two of us." → `DiscoveryCarousel`: Coral Bay leads, from $890, May–Sep fit. *(discovery)*
2. "What's the cheapest you'd recommend?" → model points to Old Quarter, from $640. *(grounded recommendation)*
3. "Actually, a city break." → carousel re-renders to feature Harbor City. *(vibe switch)*
4. Tap **Shortlist** on Harbor City → status "Shortlisted Harbor City." *(the pick)*
5. **Continue on Acme** → opens `book.acme.example/plan?dest=harbor_city&month=June&pax=2&src=chatgpt`. *(the handoff — the whole point)*

The demo's arc: *a vague mood → four real, priced, reasoned getaways → one shortlisted → one tap to book on Acme.*

---

## 11. Technical Architecture (High Level)

```
ChatGPT ──tool calls──►  Noodle Seed runtime (server 'acme_discovery')
                              │  app-owned curated catalog (static data)
                              ├──► discover_getaways   (tool → DiscoveryCarousel)
                              ├──► shortlist_getaway    (tool, local write)
                              ├──► create_handoff       (open-link → signed Acme deep link)
                              └──► React view bundle (DiscoveryCarousel, branding tokens, CSP)
                                             │
                                  (traveler taps Continue) ──► book.acme.example/plan?…&src=chatgpt
                                                                (dates · inventory · payment on Acme)
```

- **Stateless hot path.** Discovery returns static curated data; the handoff is string substitution. No AI in the tool path.
- **Grounding discipline.** Every place/price/best-month is Acme's own data, returned verbatim; the model narrates, it never invents.
- **CSP.** The widget's `connectDomains` / `resourceDomains` / `frameDomains` are scoped to `acme.example`; the handoff domains are declared in `handoff.allowedDomains`.
- **Attribution.** `src=chatgpt` injected at `create_handoff`, logged (PII-free) for funnel analytics.

---

## 12. Success Metrics

| Metric | What it tells us |
|--------|------------------|
| **Discovery rate** (session → carousel rendered) | Top-of-funnel reach |
| **Shortlists per session** | Engagement with the core gesture |
| **Vibe re-runs per session** | Depth of deliberation (the loop working) |
| **Handoff rate** (session → Continue on Acme) | In-app funnel conversion |
| **`src=chatgpt` bookings on Acme** | The revenue number — bookings attributed to the ChatGPT funnel |
| **Handoff→booking rate** (Acme-side) | Quality of the shaped demand we send |

The cleanest experiment: measure **ChatGPT-attributed handoffs → completed Acme bookings** — the conversion that justifies the app and prices the funnel.

---

## 13. Future Enhancements (Post-Launch)

- **Deep-linked destination pages** (`/plan/coral_bay`) if Acme prefers a path over a query param (§9.3).
- **Month → date pre-selection** on Acme once the booking flow accepts a target window.
- **Richer shortlist** — hold multiple getaways and compare them side by side before the handoff.
- **Live catalog feed** — swap the static catalog for an Acme feed so new destinations and "from" prices update without a redeploy.
- **Seasonal nudges** — surface the in-season destination first when the stated month maps cleanly to one `bestMonths` window.
- **Fullscreen catalog browse** — a roomier grid of the full catalog (same component, `displayMode="fullscreen"`) for "show me everything."

---

## Appendix A — Funnel Boundary Cheat-Sheet

| Stage | Where it happens | Auth needed? |
|-------|------------------|--------------|
| Frame the feeling (vibe · month · travelers) | ChatGPT (model) | No |
| Discover getaways | App → `discover_getaways` | No |
| Shortlist a getaway | App → `shortlist_getaway` (widget state) | No |
| Re-shape the trip (change vibe/month/pax) | App → re-run `discover_getaways` | No |
| **Handoff** | App → `create_handoff` (signed deep link) | No |
| Pick dates / check availability | **Acme** (`book.acme.example`) | **Yes (at Acme)** |
| Pay & confirm booking | **Acme** | **Yes (at Acme)** |

Everything above the bold line is ours and runs without a single user credential. Everything below is Acme's. The **Continue on Acme** CTA is the line — and it points one way: *book it on Acme.*

---

## Appendix B — Source Notes (for the build team)

Acme Getaways is a **fictional** brand; the catalog, prices, best-months, and regions in this document are the app's own curated data and are internally consistent with `src/server.ts` and the `DiscoveryCarousel` view. "From" prices are per-person starting figures, not quotes — the `create_handoff` deep link exists precisely so exact dates and pricing are always resolved on Acme's own booking flow, never asserted in chat. Tool names (`discover_getaways`, `shortlist_getaway`, `create_handoff`), the widget name (`DiscoveryCarousel`), and the handoff domain (`book.acme.example`) match the implementation exactly; verify Apps SDK compliance with `noodle check --target chatgpt` at build time.
