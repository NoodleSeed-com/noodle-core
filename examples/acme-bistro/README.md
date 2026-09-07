# Acme Bistro — end-to-end ordering with payment-only handoff

A Noodle MCP App for **Acme Bistro**, a fictional restaurant. It is the flagship for the **end-to-end
transaction** pattern: the customer browses the menu and builds the order *in chat*, and the order
completes in chat — only **payment** hands off, via a signed checkout deep link (the card never touches
the app). It pairs a view-backed `tool` menu/cart with app-only `tool` cart helpers and a model-visible
`create_checkout` tool backed by `handoff.allowedDomains`.

It also declares a reusable `guest_requests` managed-collection schema. In this foundation slice the
declaration compiles schema intent only: storage lifecycle, access, and a public submit route are bound by
the hosting service separately, and no submit tool is generated.

Capability slot: **end-to-end in-chat transaction + payment-only handoff**, plus a worked **design-first**
deliverable set (`design/` — a UX Document, a single-file HTML wireframe with an embedded OpenAI Apps SDK
compliance audit, and a Recommended API contract). It sets the quality bar the `noodle-seed` skill's
`references/experience-design.md` and `references/app-directory-compliance.md` teach. (Distinct from
`food-ordering`, which is the broad widget-composition proof; this one owns the design-first end-to-end +
compliance exemplar.)

## Design deliverables (the standard to match)

- [`design/UX-Document.md`](design/UX-Document.md) — the house-style UX Document.
- [`design/wireframe.html`](design/wireframe.html) — the single-file wireframe (open in a browser) with the
  embedded OpenAI Apps SDK compliance audit.
- [`design/api-contract.md`](design/api-contract.md) — the Recommended API shapes for the partner's kitchen/
  ordering backend.

## Local author loop

```sh
noodle validate
noodle test
noodle dev
```

In another terminal:

```sh
noodle tools list
noodle tools call show_menu --args '{"customer":"Asha"}'
noodle tools call create_checkout --args '{"customer":"Asha","cartToken":"cart_1","total":36}'
noodle check --target chatgpt
```

## Deploy

```sh
noodle link --org demo --app acme-bistro
noodle deploy --access owner-only
noodle open
```

This example has no connector secrets and does not include tokens, caller-key mechanisms, or
`.env.noodle` values. The menu, prices, and URLs are fictional; payment is handled off-app on
`acme.example`, never in chat.
