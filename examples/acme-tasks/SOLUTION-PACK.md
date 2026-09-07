# Acme Tasks Private-Solution Activation Blueprint

**Owns:** The reusable delivery and trust-boundary brief demonstrated by the fictional Acme Tasks example.
**Read when:** Evaluating this example as the starting proof for a customer-facing SaaS product workflow.
**Do not put here:** Current publication status, customer data, real credentials, commercial prices, or
customer-specific scope.
**Update when:** The example's reusable workflow, configuration seams, trust boundary, or proof requirements
change.

This brief maps Acme Tasks to Noodle Seed's durable customer-authored application model for B2B SaaS
product teams. It is a reference application, not a managed SaaS vertical. Publication state is
intentionally outside this portable blueprint. This file does not grant public or launch clearance.

## Reusable job

Give a SaaS customer a small, permissioned product surface inside an agent without moving product authority
into the agent runtime.

Acme Tasks demonstrates three related user jobs:

1. capture a task;
2. inspect and re-prioritize today's work; and
3. complete a task with confirmation.

The reusable pattern is not task management itself. It is the combination of one model-visible read path,
bounded product writes, an app-only interaction helper, explicit confirmation, and one inline product view.

## Standard blueprint boundary

| Layer | Reusable in the blueprint | Supplied by the customer |
| :--- | :--- | :--- |
| Workflow | Read, create, update, and confirmed-complete pattern | Product-specific actions and acceptance rules |
| Tool design | Bounded schemas, visibility, annotations, status output | Product terminology, identifiers, and validation |
| Experience | One list/detail widget family and app-only helper | Brand tokens, labels, and product-specific interaction choices |
| Identity | Runtime integration seam and authorization test plan | Identity issuer, user mapping, tenant membership, and scopes |
| Data | Synthetic fixtures and bounded output shape | Customer API, records, business rules, and system of record |
| Policy | Confirmation and least-authority defaults | Customer authorization rules, quotas, and consequential-action policy |
| Operations | Validation, test, deploy, and handoff checklist | Environment access, named operators, escalation, and acceptance owner |

The customer's application remains authoritative for users, tenants, records, permissions, and business
rules. Noodle Seed supplies the governed agent-facing runtime and delivery path around those decisions.

## Tool and interaction map

| Capability | Tool | Visibility | Authority posture |
| :--- | :--- | :--- | :--- |
| Show today's work | `list_today` | Model and app | Read-only, output capped at 20 records |
| Capture work | `add_task` | Model and app | Non-destructive local action |
| Complete work | `complete_task` | Model and app | Explicitly confirmed write |
| Re-prioritize in the widget | `set_priority` | App only | Narrow helper, not exposed to model planning |

The `TaskList` view provides only the interaction needed for those jobs. It does not recreate the customer's
full product UI inside the conversation.

## Configuration seams

A customer-derived implementation may configure only bounded product differences:

- application name, accent, surfaces, density, and radius;
- product nouns and user-facing status text;
- record identifiers and validated input/output schemas;
- customer API operation mappings;
- identity, tenant, and authorization bindings;
- write confirmation requirements;
- widget fields and supported product actions; and
- deployment environment and allowed origins.

Changes that introduce a second authoring path, embed credentials, move business authority into the widget,
or bypass customer authorization are outside the blueprint and must not be accepted as configuration.

## Required customer inputs

Before a production timebox starts, the customer supplies:

- one named user and one measurable workflow outcome;
- stable API documentation and a reachable test environment;
- test users representing allowed, denied, and cross-tenant cases;
- the identity, tenant, role, and scope rules that remain authoritative;
- a named product owner and technical owner;
- the consequential-action and confirmation policy;
- approved brand assets and user-facing language; and
- an acceptance path with an owner empowered to sign off.

If those inputs are incomplete, discovery can continue but production delivery has not started.

## Proof matrix

Any customer-derived implementation must prove the behavior that applies to its workflow:

| Proof | Expected evidence |
| :--- | :--- |
| Happy path | A named user completes the agreed read and write journey |
| Invalid input | Schemas reject malformed, excessive, or unsupported values |
| Permission denial | An unauthorized user or scope cannot perform the action |
| Tenant isolation | One tenant cannot address or infer another tenant's records |
| Confirmation | Consequential writes pause for the approved human or host confirmation path |
| Output bounds | Lists and result payloads remain explicitly bounded |
| Backend failure | Timeouts and upstream errors fail safely without invented success |
| Secret handling | Credentials stay in the brokered server boundary and out of payloads and logs |
| Host variance | Supported hosts receive an honest compatible interaction, not an identical-UI promise |
| Handoff | Customer operators can validate, deploy, observe, and roll back the workflow |

The existing example tests prove the synthetic manifest shape. A real delivery adds integration and security
tests against the customer's authoritative identity and API boundaries.

## Commercial-offer fit

The same activation blueprint can support several fixed offers without becoming a new SKU:

- **Discovery Sprint:** select and demonstrate one of the product actions with synthetic or test data.
- **Production Launch:** connect up to the standard tool limit, configure authorization, verify, deploy, and
  hand off one workflow.
- **Branded Experience:** add the bounded TaskList-style widget family and host compatibility checks.
- **Multi-Workflow Bundle:** combine several related product actions under one identity, policy, and operating
  model.

Current prices, timeboxes, and public acceptance boundaries live at
[noodleseed.dev/launch](https://noodleseed.dev/launch). The developer-marketing host redirects to the
dot-com route after the consolidated-site cutover.

## Production delta

This example intentionally uses fictional seeded data. Production work must replace or supply:

- the real connector or customer API operations;
- end-user identity and downstream-scoped credential exchange;
- tenant and record-level authorization;
- persistence and concurrency behavior owned by the customer system;
- production-safe CSP and exact allowed origins;
- structural audit and observability fields with redaction;
- upstream error, timeout, retry, and idempotency behavior; and
- customer acceptance, operator, rollback, and incident procedures.

Do not describe the synthetic example as a deployable customer integration until those boundaries exist and
the customer-specific proof matrix passes.

## Public-example gate

Before this proof shape can become a canonical public private-solution example, its owner must verify:

- production proof with a safely generalized pattern;
- removal of every customer-specific name, endpoint, rule, fixture, and asset;
- redistribution rights for all code, packages, fonts, images, and brand elements;
- success, denial, isolation, confirmation, and failure-path tests;
- no credentials, private URLs, account identifiers, or raw operational evidence;
- approved Apache-2.0 scope, notices, contribution route, and trademark language;
- public projection safety, freshness, and self-containment; and
- explicit human launch clearance through the existing private-authority/public-projection process.

Until those gates pass, the internal example can inform delivery but must not be advertised as a canonical
public starter. Managed vertical definitions never derive from this repository pattern.
