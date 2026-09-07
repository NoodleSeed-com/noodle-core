# Acme Bistro — ordering with payment handoff

Fictional [`menu/cart`](src/server.ts) with off-app payment: card data stays outside the app.

`SERVICE_NOTICE` settings and native `guest_requests` demonstrate status, field exposure and notes. `submit_guest_request` requires an authorized installation and returns a receipt
for staff review. The installed skill's `references/authoring-workflow.md` owns setup and source contracts.
External collections declare a bounded connector scan; provider changes remain ordinary tools.

Staff can clear optional `guestReference` in Portal or an authored
`connectors.records.updateRecord({ collection: 'guest_requests', id, expectedRevision, patch: {}, unset: ['guestReference'] })`.
Required fields cannot be removed; `null` is a value, not deletion.

## Design deliverables

- [UX Document](design/UX-Document.md)
- [Browser wireframe and compliance audit](design/wireframe.html)
- [Partner API contract](design/api-contract.md)

## Run

Use `noodle validate`, `noodle test`, and `noodle dev` for the local menu/cart.
Native submission requires installed storage, grants and public intake.
