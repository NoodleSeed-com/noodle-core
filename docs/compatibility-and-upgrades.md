# Compatibility and upgrades

**Owns:** The public toolchain, protocol, database compatibility, and `0.x` upgrade/downgrade policy.
**Read when:** Installing a revision, changing versions, restoring data, or evaluating compatibility claims.
**Do not put here:** Release announcements, deployment rollback instructions, or managed rollout procedures.
**Update when:** A supported runtime, protocol era, schema policy, or upgrade guarantee changes.

Noodle Core is a `0.x` single-node beta. Pin the source revision and CLI version for repeatable operation; do not
interpret a successful build from `main` as a stable production compatibility promise.

## Supported baseline

| Surface | Current public contract |
| :--- | :--- |
| Node.js | 24 or newer; the repository pins the active major. |
| pnpm | 11; use the version in `packageManager`. |
| Docker | Docker with the Compose v2 command. |
| PostgreSQL | PostgreSQL 16 in the generated reference stack. |
| MCP | Legacy `2025-11-25` and modern stateless `2026-07-28` through one protocol seam. |
| Operating model | Source-built, single-node, single-operator self-host beta. |

Legacy MCP retirement is not scheduled. A client should negotiate and exercise the era it actually uses; the
exact projected-tree acceptance journey covers both. Other repository packages or experimental surfaces are not
automatically certified by being present in source.

## Upgrade policy

The initial beta permits additive startup DDL and forward repair within a supported revision. Before changing
revisions:

1. read the public changelog and pin the intended source commit;
2. create and verify a PostgreSQL/assets backup plus the separately protected master key;
3. test the change against a disposable restore of production-like data;
4. build both service and CLI images from the same checkout; and
5. verify health, a prior MCP deployment, a packaged asset, and operator inspection before deleting the backup.

There is currently no ordered public migration ledger, previous-release-to-current certification, compatibility
SLA, or automatic rollback of database changes. A later stable release must add those proofs before claiming
stable upgrade support.

## No downgrade guarantee

There is no downgrade guarantee for runtime binaries or PostgreSQL state. Starting older code against data touched
by a newer revision can fail or corrupt operator expectations. Restore a backup taken at the matching old revision
instead of pointing old code at a newer database.

Deployment rollback is different: `noodle deploy rollback` selects an earlier application deployment while the
running Noodle Core binary and database schema stay at the current revision. It is not a binary, schema, or data
downgrade.

The [backup and restore guide](backup-and-restore.md) is same-revision by default. If future release notes define
a cross-version procedure, that explicit procedure takes precedence only for the named versions.
