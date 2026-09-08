# Noodle Core

[![CI](https://github.com/NoodleSeed-com/noodle-core/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/NoodleSeed-com/noodle-core/actions/workflows/ci.yml?query=branch%3Amain+event%3Apush)

Noodle Core is the Apache-2.0 TypeScript authoring SDK, compiler, runtime, CLI, and self-host service behind
Noodle Seed. This repository is a single-node, single-operator beta that you can run locally without a
Noodle Seed account or license key.

Contribution intake is paused during this initial beta. See the current disclosure in
[CONTRIBUTING.md](CONTRIBUTING.md); public issues remain available for reproducible bugs and feedback.

## Run the self-hosted stack

You need Node.js 24+, a working Docker Engine and Compose plugin, and access to npm during the first build. Run
`docker compose version` and `docker info` first; the [prerequisite guide](docs/self-hosting.md#prerequisites)
covers installation and permission failures. The canonical clean-clone path is:

```sh
git clone https://github.com/NoodleSeed-com/noodle-core.git
cd noodle-core
npx @noodleseed/one@latest service init --profile open-core --compose
docker compose up --build --wait postgres noodle && docker compose run --build --rm bootstrap
docker compose run --build --rm cli deploy /app/examples/hello/src/server.ts --org noodle-local --app hello --env prod --access public
```

Noodle binds to `http://127.0.0.1:8787`; PostgreSQL is not exposed on the host. The final command prints the
deployed MCP endpoint. Noodle Core has no web dashboard; use the Compose CLI for Core while keeping an installed
host CLI signed in to Noodle Seed Cloud. The [self-hosting guide](docs/self-hosting.md#use-noodle-seed-cloud-and-noodle-core-side-by-side)
owns that side-by-side workflow. Read the rest of the guide before changing authentication, exposing the service
outside loopback, or relying on its data.

## What is here

- normal TypeScript `server.ts` authoring, validation, compilation, and local development;
- typed deploy, status, access, history, and rollback operations through the CLI and service API;
- tools, resources, prompts, packaged MCP Apps, Streamable HTTP, and both supported MCP eras;
- PostgreSQL-backed operator/application state and durable local filesystem assets; and
- a source-built Docker Compose reference with local administrator authentication.

This is not Noodle Seed Cloud. It does not include the managed Console, billing, hosted identity, managed
key custody, GitHub deployment automation, cloud asset delivery, TLS, backups, high availability, monitoring,
or a support SLA. See [architecture](docs/architecture.md) for the exact public/commercial boundary and
[compatibility and upgrades](docs/compatibility-and-upgrades.md) for the `0.x` guarantees.

## Build an app or explore changes

Install the published CLI, then scaffold and run a TypeScript app:

```sh
npm install -g @noodleseed/one
noodle init my-app --template hello
cd my-app
noodle dev
```

If you prefer not to install it globally, replace each `noodle` invocation with
`npx @noodleseed/one@latest`.

Start with the [documentation index](docs/README.md), then read [CONTRIBUTING.md](CONTRIBUTING.md). Connector
changes have a focused [contribution guide](docs/connector-contributions.md). Report vulnerabilities through
[SECURITY.md](SECURITY.md), and review [TRADEMARKS.md](TRADEMARKS.md) before naming a fork or hosted service.

## Repository model

Noodle Seed develops Noodle Core in a larger private monorepo and deterministically projects the Apache-2.0
surface here. Public issues are available now; upstream pull requests and automated contribution integration are
paused for the initial beta. [CONTRIBUTING.md](CONTRIBUTING.md) owns the current disclosure, and
[governance](docs/governance.md) explains repository authority and the future reviewed Copybara round trip.
