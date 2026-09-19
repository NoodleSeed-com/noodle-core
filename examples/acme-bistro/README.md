# Acme Bistro — ordering with payment handoff

Fictional [menu/cart](src/server.ts): payment stays outside the app. Native `guest_requests` demonstrate
status, field exposure, notes and optional-field removal with `unset: ['guestReference']`.
`GUEST_EXPERIENCE` supplies typed business settings. Submission records a request, not a reservation.

## Design deliverables

- [UX Document](design/UX-Document.md)
- [Browser wireframe and compliance audit](design/wireframe.html)
- [Partner API contract](design/api-contract.md)

## Run

Use `noodle validate`, `noodle test`, and `noodle dev` for the local menu/cart.
Native submission requires installed storage, grants and public intake.
An Owner/Admin reviews preservation in Business settings or `noodle solutions records lifecycle`.
Only after confirmation do available/future records remain until erased, within storage limits.
Expired records stay unavailable; assistant history is separate. Tools do not choose expiry.
