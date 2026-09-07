# Noodle Core architecture

**Owns:** The public self-host composition, data flow, certified capability set, and commercial boundary.
**Read when:** Evaluating what runs locally or deciding where a contribution belongs.
**Do not put here:** Step-by-step operation, environment values, or Noodle Seed Cloud implementation details.
**Update when:** The public composition, persistence boundary, or certified default capability changes.

Noodle Core follows a “TypeScript authoring, thin internal representation, fat runtime” model. Developers write
one normal `server.ts`. The compiler validates and records that intent as system-owned data; the shared service
stores, activates, and serves it. Generated manifests are not a second public authoring format.

## Reference composition

The source-built local stack has four roles:

| Component | Responsibility | Durable state |
| :--- | :--- | :--- |
| TypeScript SDK and compiler | Define tools, resources, prompts, Apps, connectors, schemas, and flows; validate a deployable artifact. | Source remains developer-owned. |
| `apps/self-host` service | Compose the portable control plane, runtime, dual-era MCP transport, authorization seams, audit, and local assets. | PostgreSQL plus the asset volume. |
| PostgreSQL 16 | Store organizations, applications, environments, deployments, configuration, encrypted secrets, state handles, request events, and basic audit data. | `postgres-data` volume. |
| Bootstrap/operator CLI | Create the local organization and perform typed deploy, access, inspection, history, and rollback operations. | Ephemeral command state only. |

The service is stateless outside PostgreSQL and the asset volume. Packaged widget bytes are content-addressed,
served from the same origin, and remain stable across service replacement. The reference is single-node: the
filesystem asset provider is not a shared multi-node store.

## Identity boundaries

The generated administrator token authenticates only control-plane operations and maps to a fixed auditable
`self-host-admin` actor. It is injected into one-shot Compose CLI containers and is never a data-plane bearer
token. A public deployment needs no end-user identity. Owner/authenticated modes require an explicitly configured
external issuer or portable Google-federated OAuth group; the deploy actor and the bound deployment owner remain
separate identities.

## Certified default versus source-only code

The local Docker journey certifies TypeScript authoring, validation, deployment, rollback, tools/resources/prompts,
packaged Apps, Streamable HTTP, both supported MCP eras, PostgreSQL recovery, filesystem assets, basic audit and
redacted lifecycle logs. Other Apache packages in the repository are reusable building blocks, not a claim that
each is active in the default container. A capability becomes part of the certified self-host product only when
the composition and exact projected-tree journey prove it.

## Noodle Seed Cloud boundary

Noodle Seed Cloud uses the same portable engine contracts but adds a private production composition: managed
identity and recovery, Cloud SQL/KMS and hosted asset adapters, billing and commercial policy, GitHub deployment
automation, fleet operations, managed distribution, the web Console, support systems, and release promotion.
Those implementations and customer operations are not present here. Apache-2.0 still permits forks, competing
modules, and hosted services; [TRADEMARKS.md](../TRADEMARKS.md) governs branding rather than technical use.

Continue with [self-hosting](self-hosting.md) for the runnable path and [security](security.md) before changing
the local-only exposure model.
