# Four-store Shopify rollout

**Owns:** The operator checklist for deploying one immutable Shopify storefront source to four isolated
prospective-customer stores and proving the wrapped MCP, widgets, assistant, and checkout handoff.
**Read when:** A human has approved the exact four Shopify development/customer stores and their canary bounds.
**Do not put here:** Customer names, real domains, tokens, customer data, payment credentials, or completed live
evidence.
**Update when:** The Shopify binding names, validation journey, or rollback procedure changes.

The repository test fixture uses four synthetic stores (`customer-a` through `customer-d`). A live rollout
requires explicit approval for each real store, identity, credential, request budget, and rollback target.
Until then, run the hermetic four-binding and end-to-end MCP fixture tests only.

## 1. Freeze one source revision

- [ ] Record one clean Git revision of `examples/shopify-storefront/src/server.ts` and its supporting files.
- [ ] Run `pnpm test`, `noodle validate`, `noodle test`, and `noodle check --min-severity warn` from this example.
- [ ] Confirm the public surface contains `ask_store`, the two product views, and no upstream tool metadata.
- [ ] Confirm the connector catalog contains only the frozen Shopify MCP operation
  `search_shop_policies_and_faqs`; it contains no credential value and no runtime discovery instruction.
- [ ] Do not continue if any store would require a source edit. Add an operator binding or stop for design review.

## 2. Prepare four isolated targets

Use four distinct app/environment targets, even when one operator owns them. Complete and validate one row before
starting the next.

| Slot | App/environment | Store origin | MCP endpoint | Storefront token | Preflight |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Customer A | `<customer-a-app>/prod` | `https://<shop-a>.myshopify.com` | `<origin>/api/mcp` | Broker secret only | [ ] |
| Customer B | `<customer-b-app>/prod` | `https://<shop-b>.myshopify.com` | `<origin>/api/mcp` | Broker secret only | [ ] |
| Customer C | `<customer-c-app>/prod` | `https://<shop-c>.myshopify.com` | `<origin>/api/mcp` | Broker secret only | [ ] |
| Customer D | `<customer-d-app>/prod` | `https://<shop-d>.myshopify.com` | `<origin>/api/mcp` | Broker secret only | [ ] |

For each row, bind the exact same source:

```sh
noodle link --org <org> --app <customer-app> --env prod
noodle variables set SHOPIFY_STORE_ORIGIN --scope env --value https://<shop>.myshopify.com
noodle variables set SHOPIFY_STOREFRONT_MCP_ENDPOINT --scope env \
  --value https://<shop>.myshopify.com/api/mcp
noodle secrets set SHOPIFY_STOREFRONT_PRIVATE_TOKEN --scope env
```

Validate that the MCP endpoint's origin exactly equals `SHOPIFY_STORE_ORIGIN`; paths, wildcards, credentials,
fragments, and redirects fail closed. Never paste a token into a command argument, source file, test, snapshot,
ticket, or evidence log. The source uses `noodleManaged()`: before deploying, a Noodle operator must enroll
that exact org/app/environment for hosted inference. There is no merchant model endpoint, model name, or model
secret to bind.

## 3. Owner-only canary, one store at a time

For Customer A, then B, C, and D independently:

- [ ] Deploy with `noodle deploy --access owner-only` and record the immutable deployment revision.
- [ ] In a text-only client, list the Noodle tools and call `ask_store` with a harmless published-policy question.
- [ ] Confirm the response uses only Shopify's supplied answer and that no upstream tool name, `_meta`, or widget
  URI is present.
- [ ] In Noodle Devtools or an approved Apps host, confirm the Noodle-owned store-answer widget renders in light
  and dark themes and degrades to the same structured/text answer when Apps are unavailable.
- [ ] Through the embedded assistant on the exact store origin, complete product search, one focused detail view,
  variant selection, explicit checkout review, one `cartCreate`, and allowlisted Shopify checkout handoff.
- [ ] Run `pnpm smoke:shopify:semantic -- --service <url> --origin <origin> --org <org> --app <app> --env prod`
  and retain its bounded JSON summary. Confirm the original query plus at most one materially different
  zero-result rewrite, no hard-constraint relaxation, at most one recommendation view, honest no-result and
  `not_found` answers, and no checkout tool call.
- [ ] Confirm product discovery performed zero cart writes and final continuation created exactly one cart.
- [ ] Verify logs/audit contain the intended tenant/deployment/tool result only, with no header, token, request body,
  cart ID, customer data, continuation state, or cross-store origin.
- [ ] Repeat a request using another slot's origin and credentials; it must fail before upstream egress.
- [ ] Roll back that slot to its recorded prior immutable deployment, repeat one harmless read, then restore the
  candidate and repeat it again. The first pointer change must report `alreadyActive: false`; only an immediate
  repeat against the same deployment may report `alreadyActive: true`.
- [ ] Mark the row complete only after all checks and rollback/restore pass for that store.

## 4. Cross-store isolation proof

- [ ] Run the same harmless query concurrently against all four targets and correlate four independent traces.
- [ ] Confirm each result, handoff URL, widget state, and assistant origin belongs to exactly its bound store.
- [ ] Revoke or replace Customer B's Storefront token; A, C, and D must remain healthy and B must fail safely.
- [ ] Make Customer C's MCP endpoint unavailable; GraphQL-backed product/checkout behavior remains independently
  attributable, while `ask_store` fails without fallback claims or data from another store.
- [ ] Restore B and C and repeat their harmless reads.

## 5. Widening and rollback

Public or customer-visible access is a separate human decision per store. Do not infer it from a green owner-only
canary. Before widening, record rate/spend limits, support owner, alert destination, data-handling copy, abort
criteria, and the prior immutable rollback target. A rollback is proven only after executing it and then restoring
the candidate; reviewing the command is not evidence.
