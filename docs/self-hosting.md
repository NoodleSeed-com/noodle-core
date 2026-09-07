# Self-host Noodle Core

**Owns:** The supported source-built Docker Compose path for a local Noodle Core service.
**Read when:** Running, operating, or evaluating Noodle Core on your own machine.
**Do not put here:** Noodle Seed Cloud operations or private infrastructure procedures.
**Update when:** The generated files, Compose topology, supported self-host capabilities, or operator steps change.

Noodle Core's first supported self-host profile is a single-machine, single-operator beta. It runs from the
source in this repository and does not require a Noodle Seed account, license key, or managed service.

## Prerequisites

- macOS, Linux, or WSL2
- Docker with the `docker compose` v2 command
- Node.js 24 or newer to run the published CLI
- access to npm and the container registry during the first build

Before initialization, verify that the Compose plugin is installed and the Docker daemon is available to your
current shell:

```sh
docker compose version
docker info
```

On Fedora, follow Docker's [official Fedora installation guide](https://docs.docker.com/engine/install/fedora/).
For native Linux permissions and daemon setup, follow Docker's
[Linux post-install guidance](https://docs.docker.com/engine/install/linux-postinstall/). After adding your user
to the `docker` group, refresh the session with a full logout/login or the documented `newgrp docker` method,
then rerun both checks. Membership in the `docker` group grants root-equivalent privileges; use it only on a
machine and daemon you trust. Do not make the Docker socket world-writable or disable SELinux or a firewall as a
blanket workaround.

If a check fails, use its symptom before changing Noodle configuration:

- `docker: command not found` means the Docker CLI is missing.
- `docker: unknown command: docker compose` means the Compose plugin is missing. An `unknown flag: --build`
  error from the startup line can be the same incomplete installation rather than an invalid Compose option.
- A daemon connection error means Docker Engine is stopped or unreachable; follow the platform installation
  guide to start it, then rerun `docker info`.
- `permission denied` for the Docker socket means the current shell lacks access. Follow the Linux post-install
  guide and refresh the login session; do not weaken the socket permissions.

The published `@noodleseed/one` package contains the initializer. Anyone with a compatible Noodle Core
checkout can run it globally, through `npx`, or from an existing local installation. Before writing anything,
the command checks this checkout's `noodleCore.composeInitVersion` marker. An incompatible CLI fails without
creating `.self-host/` and tells you to use a matching pinned CLI version.

The complete environment and secret classification lives in [configuration](configuration.md). The generated
values are sufficient for the public first-deploy path; optional owner authentication is never enabled silently.

## Start the stack

From a fresh clone:

```sh
git clone https://github.com/NoodleSeed-com/noodle-core.git
cd noodle-core
npx @noodleseed/one@latest service init --profile open-core --compose
docker compose up --build --wait postgres noodle && docker compose run --build --rm bootstrap
```

The first command creates protected local state. The second line builds the service and CLI from this exact
checkout, starts PostgreSQL and Noodle, waits for both health boundaries, and then creates the `noodle-local`
organization through the normal CLI/API path. Running both commands again is safe: generated secrets remain
byte-identical and organization creation is idempotent.

Noodle listens only on `http://127.0.0.1:8787`. PostgreSQL has no host port.

## What initialization creates

| Path | Mode | Purpose |
| :--- | :--- | :--- |
| `.self-host/` | `0700` | Ignored operator state. |
| `.self-host/.env` | `0600` | Canonical operator environment with random PostgreSQL, encryption, administrator, and asset-identity secrets plus optional portable OAuth settings. |
| `.self-host/.env.postgres` | `0600` | Generated PostgreSQL-only environment; do not edit or back it up separately. |
| `.self-host/.env.noodle` | `0600` | Generated Noodle-service environment; do not edit or back it up separately. |
| `.self-host/.env.operator` | `0600` | Generated bootstrap/CLI administrator environment; do not edit or back it up separately. |
| `.self-host/compose.generated.yaml` | `0644` | Generated PostgreSQL, Noodle, and bootstrap topology; it contains no secret values. |
| `noodle.service.yaml` | `0644` | The selected `open-core` service profile. |

The tracked `compose.yaml` includes the generated fragment. Writes are atomic, symlink targets are rejected,
and command output contains paths and next steps—not secret values or the rendered database URL.

Initialization always derives the three service-specific environment files from canonical `.self-host/.env`,
so ambient shell variables cannot replace the generated stack credentials and each container receives only
the values it needs. Edit only canonical `.self-host/.env`, then rerun the initialization command to reconcile
the derived files. `--force` replaces changed non-secret templates but never rotates `.self-host/.env`. Do not use
`--replace-secrets` on a stack with data you need: it rotates every generated secret, including the key that
protects persisted configuration. For a disposable reset, stop the stack, remove its volumes and `.self-host/`,
then initialize again.

## What runs

| Service | Role | Persistent state |
| :--- | :--- | :--- |
| `postgres` | Control-plane, deployment, configuration, and audit durability. | `postgres-data` named volume |
| `noodle` | Dual-era Streamable HTTP MCP service and deployment API. | `asset-data` named volume plus PostgreSQL |
| `bootstrap` | Short-lived CLI container that idempotently creates the `noodle-local` organization. | None |
| `cli` | Opt-in operator CLI used with `docker compose run --build --rm cli …`; it carries the local administrator credential only inside Compose. | Ephemeral bounded `.noodle` state for the one command |

All containers run as non-root with a read-only root filesystem, dropped Linux capabilities,
`no-new-privileges`, and bounded temporary filesystems. Noodle can write only to `/tmp` and its named asset
volume. Both application images are built from the same repository revision; this beta does not pull a
separately versioned Noodle image. Installation and runtime packaging preserve the checked-in dependency
lockfile, including peer dependencies, so a later registry publication cannot silently change the packaged
React and React DOM pair.

## Deploy and call an app

The default Compose profile deliberately has no end-user identity provider. Use `--access public` for a first
local deployment. The CLI image contains the curated examples from the same source revision, so deployment does
not require a host Node.js install or exposing the administrator token to the host shell:

```sh
docker compose run --build --rm cli deploy /app/examples/hello/src/server.ts \
  --org noodle-local --app hello --env prod --access public
```

The deploy command prints the MCP endpoint. The administrator token is valid only for control-plane operations;
it is not accepted as an end-user MCP bearer token. The `cli` service is under the `tools` Compose profile, so it
does not become a long-running container during normal startup; explicitly targeting it with `compose run` enables
it for that one command.

In [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector), choose Streamable HTTP, paste the
printed endpoint, connect, list the available tools, and invoke `greet` with `{"name":"Ada"}`. The result includes
`Hello, Ada!`. The endpoint is an MCP transport, not a dashboard URL, and this first public Hello deployment does
not need an end-user bearer token. The administrator bearer remains invalid on the data plane. Noodle Core
includes no managed account or web Console.

### Use Noodle Seed Cloud and Noodle Core side by side

The published `@noodleseed/one` package supplies the `noodle` command for both products; there is no separate
Core executable. Keep an installed host command signed in to Noodle Seed Cloud, and run Core operator commands
through Compose. The host command keeps using its saved Cloud service and login:

```sh
noodle status --org acme --app hosted-app --env prod
```

Host `noodle dev` starts a separate local development runtime for the source on your host; it does not deploy to
the PostgreSQL-backed Compose service. Use the Compose CLI `deploy` command above when you want the app served by
the self-hosted stack. Containerized development profiles, source mounts, and host-network workarounds are not
part of this supported startup path.

Core commands use the service URL and administrator credential isolated inside Compose:

```sh
docker compose run --build --rm cli status \
  --org noodle-local --app hello --env prod
docker compose run --build --rm cli smoke \
  --org noodle-local --app hello --env prod
docker compose logs --follow noodle
```

This also guarantees that Core operations use the CLI built from the same checkout as the running service. Avoid
pointing the host command at Core with only `--service`: CLI settings resolve as flag, then environment, then saved
configuration, so a saved Cloud credential could otherwise be selected with the local service URL. The Compose
command supplies the local service and its administrator credential as one isolated pair without exposing the
credential to the host shell.

Run client-connection commands on the host because they update that host's MCP-client configuration. This does not
change the CLI's saved Cloud target:

```sh
npx @noodleseed/one@latest connect claude-code \
  --endpoint http://127.0.0.1:8787/o/noodle-local/hello/v1/mcp
```

Noodle Core has no web dashboard or managed Console. Operate deployments with the Compose CLI commands above and
open the printed MCP endpoint only from an MCP client. Noodle Seed Cloud deployments continue to print and support
their project dashboard URL.

For an `owner-only` deployment, configure either an external OAuth issuer and JWKS URL or the complete portable
Google-federated OAuth group in `.self-host/.env`, rerun initialization to update `.env.noodle`, recreate the Noodle container, and bind the intended OAuth
subject with `--owner-subject`. Keep the administrator as the real deploy/audit actor. The self-host process
rejects partial OAuth configuration and rejects the private WorkOS platform-auth variables.

- External issuer: `NOODLE_OAUTH_ISSUER` and `NOODLE_OAUTH_JWKS_URI`.
- Google federation: `NOODLE_OAUTH_ISSUER`, `NOODLE_OAUTH_SIGNING_KEY_BASE64` (canonical base64 PKCS#8),
  `NOODLE_OAUTH_GOOGLE_CLIENT_ID`, `NOODLE_OAUTH_GOOGLE_CLIENT_SECRET`, and
  `NOODLE_OAUTH_GOOGLE_REDIRECT_URI`; `NOODLE_OAUTH_ALLOWED_EMAIL_DOMAIN` is optional.

Non-loopback OAuth URLs must use HTTPS. After changing canonical `.self-host/.env`, run
`noodle service init --profile open-core --compose` and then rerun the canonical startup line so Compose
recreates the affected container.

## Restart, inspect, and reset

```sh
docker compose ps --all
docker compose logs --follow noodle
docker compose down
docker compose up --build --wait postgres noodle && docker compose run --build --rm bootstrap
```

`docker compose down` preserves the named PostgreSQL and asset volumes. Follow the
[manual backup and restore procedure](backup-and-restore.md) to capture PostgreSQL and assets together while
protecting `.self-host/.env` separately; losing the encryption key can make persisted secrets unusable.
`docker compose down --volumes` deletes the local database and packaged assets and should be used only for an
intentional reset.

## What this beta includes

- TypeScript authoring, validation, compilation, and the CLI
- deploy, preflight, status, inspection, access changes, history, and rollback through typed API/CLI paths
- tools, resources, prompts, Apps artifacts, and both supported MCP protocol eras
- PostgreSQL deployment/configuration durability and restart recovery
- encrypted local managed secrets and durable filesystem-packaged assets
- local administrator control-plane authentication
- optional external-issuer or portable Google-federated owner authentication

## What it does not include

- Noodle Seed Cloud, the managed Console, billing, subscriptions, or commercial policy modules
- WorkOS platform identity, managed KMS/key custody, Noodle Seed-hosted credential custody, or hosted signup
- hosted GitHub builds and deploy automation, cloud/edge asset delivery, or managed distribution channels
- a published production image, automatic upgrades, backups, TLS, DNS, monitoring, high availability, or support SLA
- a production security posture for public internet exposure

You own deployment and operations beyond this local reference stack. Before exposing it outside loopback, add a
TLS-terminating reverse proxy, restrict network access, configure a real `PUBLIC_BASE_URL`, choose and test the
end-user OAuth boundary, test the documented backup/restore procedure for your environment, establish an upgrade
procedure, and monitor both PostgreSQL and Noodle.
The filesystem asset store is a single-host boundary; multi-node operation needs a shared asset adapter.

Read the [security boundary](security.md) and [compatibility policy](compatibility-and-upgrades.md) before going
beyond evaluation. For community help, see [SUPPORT.md](../SUPPORT.md). Report vulnerabilities through
[SECURITY.md](../SECURITY.md), never in a public issue.
