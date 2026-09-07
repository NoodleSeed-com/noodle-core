# Acme Getaways — top-of-funnel discovery → handoff

A Noodle MCP App for **Acme Getaways**, a fictional travel brand. It is the flagship for the
**top-of-funnel discovery → handoff** pattern: discovery and configuration happen inside ChatGPT; the
booking/transaction happens off-app on Acme's own site, reached through a signed, attributable handoff
deep link. It pairs a `tool` discovery carousel with a model-visible `create_handoff` tool and
server-level `handoff.allowedDomains`.

Capability slots: top-of-funnel funnel discipline, discovery carousel widget, `create_handoff` deep-link
handoff with attribution, `handoff.allowedDomains`, the **public website assistant surface** with its
**WebMCP browser-agent bridge** on a real demo page (`site/index.html`), and a worked
**design-first** artifact (the UX spec + wireframe below). It shows the "design the experience, then build
it" flow the `noodle-seed` skill's `references/experience-design.md` teaches.

## The same tools on Acme's own website

The funnel does not only start in ChatGPT. The `assistant` block projects these same tools onto
Acme's marketing site for a visitor with **no account and no session backend** — as a **mixed**
surface, so the visitor can also sign in mid-conversation:

```ts
access: [
  publicWebsite({
    origins: ['https://getaways.acme.example'],
    capabilities: [destinations, discoverGetaways, createHandoff, shortlistGetaway, captureLead, myTrips],
    signIn: true, // my_trips reads ${user}; reaching it raises the sign-in card
    instructions:
      'Be a friendly, consultative travel guide, never pushy. Help visitors narrow a getaway before suggesting the next useful step.',
  }),
  authenticatedWebsite({
    origins: ['https://account.acme.example'],
    capabilities: [destinations, discoverGetaways, createHandoff, myTrips],
    instructions: 'The traveler is signed in. Help them plan from their saved trips.',
  }),
],
```

There is no second tool set and no second app — one `server.ts`, projected onto its front doors.
The flagship selects `model: noodleManaged()`, so a billing-attributed hosted deployment needs no customer
model endpoint, name, or key and its artifact remains provider-neutral. The sponsored beta is available by
default with pooled billing-account and platform-wide daily limits; `openAICompatible(...)` remains the BYO
alternative.
The surface `instructions` add only the website-specific voice and goal; shared product truth stays in
`server.instructions`. This public guidance is injected into that surface's assistant turns, never MCP
`initialize` or another assistant surface.
`capabilities` is the entire externally reachable surface per front door, so it stays short enough to
review at a glance and closed by default: a tool added to this server later is unreachable from the
website until someone lists it.

## Sign in mid-conversation, land in the account

`signIn: true` makes the marketing surface **mixed**: `my_trips` stays visible so the assistant can
offer it, and an anonymous visitor who reaches for it sees a branded card — *Sign in* plus, because
`labels.signUpAction` is authored, *Create free account*. Both raise `assistant-sign-in-requested`
with a single-use `signInTicket`; the detail's `intent` tells the page whether to route its login or
its registration. Acme's page signs the visitor in exactly as it already does, its backend spends the
ticket with `createAssistantSession({ ..., signInTicket })`, and the **same conversation continues**
on whichever origin the backend designates:

- landing back on `getaways.acme.example` keeps the mixed surface's projection with identity attached;
- landing on `account.acme.example` rebinds the conversation to the authenticated surface — its
  capabilities and its voice — and the widget repaints the visible transcript and auto-answers the
  intercepted `my_trips` ask under the new identity.

The ticket spend after account creation is identical to the one after sign-in; the service never
operates a login of its own.

## Browser agents on Acme's page

`site/index.html` is the marketing page itself: static markup, four listings, and the one line a
customer pastes.

```html
<script src="https://cloud.noodleseed.dev/v1/assistant/embed.js" data-embed-id="pub_…"></script>
```

Because the marketing surface sets `webmcp: { enabled: true }`, that same line does a second job in a
browser that supports WebMCP: the embed registers the session's projected tools with
`document.modelContext`, so a browser agent — Gemini-in-Chrome, Claude-in-Chrome — can call
`discover_getaways` or `create_handoff` without a human typing in the panel.

What it does **not** do is widen anything. A bridged call carries exactly the embed session's
authority: the surface's six-capability allowlist, the same policy and budgets, the same audit trail,
and the same confirmation card on `capture_lead` — the visitor still approves the lead in the panel,
because a browser agent's consent is not the visitor's. The switch governs *discovery*, not
permission: it decides whether an agent learns the tools are there. The signed-in account surface
below leaves it off, which is the point of setting it per surface.

Browsers without `document.modelContext` are unaffected; the page and the panel behave exactly as
they did before.

To run it:

```sh
noodle dev                 # the server, in one terminal
npx serve site             # the page, in another (any static server works)
```

`noodle dev` serves the MCP endpoint, not HTML, so the page needs its own server. For a real
end-to-end run, `noodle deploy` this example, paste the minted `pub_…` id into `site/index.html`, and
add the origin you serve the page from to the `publicWebsite` `origins` list — the session exchange
refuses any origin that is not listed. WebMCP itself ships behind an origin trial in Chrome 149+, so
a browser without the trial enabled shows the assistant panel and no bridge.

## The consultative sales gateway

When a visitor's plans firm up but they would rather not sign up, the assistant may — with explicit
confirmation — take their details and deliver them to Acme's own sink. The recipe is a composition of
existing primitives, not a platform feature:

- `capture_lead` is an ordinary tool with `annotations.action({ confirm: true })`: the confirmation
  card, showing every field, is the visitor's consent moment.
- Delivery is a declarative HTTP connector whose endpoint is `variable('LEAD_SINK_URL')` and whose
  credential is `secret('LEAD_SINK_TOKEN')` — the operator supplies values with
  `noodle variables set` / `noodle secrets set`; the example stays credential-free and one authored
  class serves any business.
- The request mapping sets `source: 'website-assistant'` itself, so Acme's sink can trust the
  attribution; the model never supplies it.
- The lead rests only in Acme's own system. The platform stores no lead, and a vendor sink is just
  different data: Resend/Postmark are `auth: { kind: 'apiKey', … }`, a HubSpot private app is
  `auth: { kind: 'bearer', … }` — never a named vendor package.

## Design spec (write this before the code)

- **Funnel boundary** — Discover and shortlist a getaway in ChatGPT. Booking, payment, and the account
  live on `acme.example`, reached only after the handoff. No payment or per-user auth in chat.
- **Personas** — the undecided browser ("somewhere warm in June?"), the near-decided planner (has a vibe
  and month, wants options and a fast handoff).
- **Top-3 prioritized user flows**
  1. **Discover** — "warm beach trip in June for 2" → `discover_getaways` renders the carousel.
  2. **Shortlist** — pick a destination in the widget → `shortlist_getaway` (widget-only) records it.
  3. **Handoff** — "Continue on Acme" → `create_handoff` emits the deep link → opens off-app.
- **Tools** — `discover_getaways` (model-visible, renders the widget), `create_handoff` (model-visible,
  emits the deep link), `shortlist_getaway` (widget-only helper, hidden from the model).
- **Widgets + display modes** — `DiscoveryCarousel` as an inline card that expands to fullscreen for
  browsing. No picture-in-picture (nothing is live/ongoing).
- **Grounding sources** — the destination catalog in `src/server.ts` is Acme's own data; the widget never
  invents a place, price, or best-month.
- **Handoff domains** — `https://book.acme.example`, `https://acme.example` (the server
  `handoff.allowedDomains`; the deep link carries `dest`, `month`, `pax`, and `src=chatgpt` for
  attribution).

## Wireframe (one screen, then the off-app destination)

The carousel screen is in-app (solid frame); the booking screen is off-app (dashed frame) and reached
only after the handoff — it is Acme's own page, never wireframed as if it were in chat.

```html
<div class="phone">                                  <!-- in-app: solid frame -->
  <div class="chatgpt-header">ChatGPT · Acme Getaways</div>
  <div class="msg user">somewhere warm in June, 2 of us</div>
  <div class="tool-call">discover_getaways { vibe: "beach", month: "June", travelers: 2 }</div>
  <div class="wcard">
    <div class="wcard-head">DiscoveryCarousel</div>   <!-- component name = code + spec -->
    <div class="wcard-body">
      <div class="dest">Coral Bay · from $890 · best May–Sep  [Shortlist]</div>
      <div class="dest">Harbor City · from $980 · best Sep–Nov [Shortlist]</div>
      <a class="cta">Continue on Acme · Coral Bay</a>   <!-- one primary action -->
    </div>
  </div>
</div>
<div class="phone offapp">                            <!-- off-app: dashed frame -->
  <div class="browser-header">book.acme.example/plan?dest=coral_bay&month=June&pax=2&src=chatgpt</div>
  <div class="offapp-body">Acme booking — payment & account live here.</div>
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
noodle tools call discover_getaways --args '{"vibe":"beach","month":"June","travelers":2}'
noodle tools call create_handoff --args '{"destination":"coral_bay","destinationName":"Coral Bay","month":"June","travelers":2}'
noodle check --target chatgpt
```

## Deploy

```sh
noodle link --org demo --app acme-discovery
noodle deploy --access owner-only
noodle open
```

This example has no connector or model secrets and does not include tokens, caller-key mechanisms, or
`.env.noodle` values. Hosted `noodleManaged()` inference is available by default to billing-attributed
deployments and remains subject to sponsored daily limits; local validation and tool calls do not use the
hosted model. All destinations, prices, and URLs are fictional.
