# @noodleseed/one

**Agent connectivity infrastructure for software teams.**

Build the headless, agent-accessible version of your product for ChatGPT, Claude, Codex, embedded
assistants, and any MCP-compatible client—without rebuilding your backend for every agent surface.

Noodle Seed turns your existing APIs, application logic, and data into typed, governed capabilities that
agents can discover and use. Author one TypeScript `server.ts`, then validate, test, deploy, and operate the
resulting agent connectivity layer with the `noodle` CLI.

## What is Noodle Seed?

Noodle Seed is the infrastructure layer between your software and AI agents. You keep your backend,
business logic, data, and customer experience; Noodle Seed provides one governed connectivity layer across
agent surfaces.

Instead of building and maintaining a separate integration for each agent host, your team describes the
capabilities agents may access, connects them to existing systems, and deploys one MCP surface with explicit
schemas, credential boundaries, tenancy, and policy.

## What is headless software?

Headless software makes the capabilities of a product available through typed, authenticated interfaces
independently of its original graphical interface. Users and agents can access the same product through
ChatGPT, Claude, coding agents, embedded assistants, or other MCP clients.

Headless does not mean UI-free. Every capability remains complete for agents that render no interface,
while MCP Apps and widgets can add focused visual experiences where a host supports them.

## What `@noodleseed/one` provides

This package contains both the TypeScript authoring SDK and the `noodle` command-line interface:

- **Author** typed tools, resources, prompts, connectors, and optional widgets in TypeScript.
- **Validate and test** the compiled MCP surface locally without an account.
- **Preview** headless results and MCP Apps before deployment.
- **Deploy** an authenticated, tenant-scoped MCP endpoint through Noodle Seed Cloud.
- **Operate** deployments with agent-readable JSON output, diagnostics, logs, metrics, and rollback
  commands.
- **Export** the portable manifest compiled from your TypeScript source.

```text
Your product and APIs
        ↓
One TypeScript server.ts
        ↓
Noodle Seed connectivity layer
        ↓
ChatGPT · Claude · Codex · embedded assistants · MCP clients
```

## Quickstart

Create and run a local project without a Noodle Seed account:

```sh
npx --yes @noodleseed/one@latest init my-noodle-app
cd my-noodle-app
npm run agent:check # rerun after adapting the application
```

The generated project contains a normal TypeScript entrypoint, tests, npm scripts, `noodle.json`, and
project-local instructions for supported coding agents. Init installs exact compatible local tooling and
checks context, compilation, behavior and types. Choose `--package-manager npm|pnpm|yarn` consistently with
existing locks; `--no-install` prepares files only. Yarn installation is unsupported by the current bundled
runtime format and fails explicitly without switching managers. Failed setup reports a safe resume command,
preserving edited files. Interactive new-project setup can offer an installed agent; JSON/plugin runs never
launch one. It remains your project: edit it with your existing
tools, commit it to your repository, and run it locally before deciding to deploy.
The default SaaS starter is embedded-first and explicitly synthetic: its tests check a useful local result
and invalid-input rejection without customer credentials or live backends. Bind the names in `.env.example`
before `npm run dev`; wire the generated integration seams to your existing application before claiming
customer authentication or saved business changes. `--template hello` needs no configuration.

For frequent CLI use, you can install the same package globally:

```sh
npm install -g @noodleseed/one@latest
noodle --version
```

The zero-install `npx @noodleseed/one@latest <command>` path remains available when you do not want a global
installation.

## Author one TypeScript server

`src/server.ts` is the public authoring surface:

```ts
import { annotations, server, tool, z } from '@noodleseed/one';

export default server('acme_status', { title: 'Acme Status', version: '1.0.0' }, [
  tool('get_status', {
    description: 'Read the current Acme service status.',
    input: z.object({}),
    output: z.object({ status: z.string() }),
    annotations: annotations.readOnly(),
    fulfil: () => ({ status: 'operational' }),
  }),
]);
```

From there, connect tools to your own APIs and application logic with typed connectors and explicit input
and output schemas. Noodle Seed compiles the TypeScript definition into its portable runtime representation;
you do not author manifest JSON, connector YAML, or generated runtime artifacts.

## Validate, test, and preview locally

The local authoring loop requires no Noodle account. An app that declares customer auth still exercises that
customer sign-in in Devtools:

```sh
npm run validate
npm test
npm run dev
```

- `noodle validate` compiles the TypeScript source and reports structured, field-level errors.
- `noodle test` compiles the server and exercises its loopback MCP endpoint.
- `noodle dev` runs the local MCP server with hot reload.
- `noodle check` adds host and MCP Apps readiness checks when your project uses widgets or an embedded
  assistant.

Coding agents can discover the complete machine-readable command contract with:

```sh
npx noodle commands --json
```

## Deploy

Sign in only when you are ready to use the hosted control plane:

```sh
npx noodle login
npm run deploy
```

The first deployment can infer the signed-in organization and initialized project name, or you can select an
explicit organization, app, and environment. The deployed MCP endpoint can then be connected to supported
agent hosts and embedded product surfaces.

See the [hosted quickstart](https://docs.noodleseed.dev/docs/quickstart) for account setup, access modes,
deployment targets, and host connection instructions.

## What you can build

- A headless version of an existing SaaS product
- An MCP server over an existing API
- A ChatGPT or Claude app with focused widgets
- A customer-branded embedded assistant
- Governed internal tools for coding agents
- Agent-accessible workflows across existing systems

The same tool result remains complete in a headless client. Widgets are a progressive enhancement, not a
second business-logic surface.

## Package surfaces

Author the server and its capabilities from the root package:

```ts
import { connector, server, tool, z } from '@noodleseed/one';
```

Build optional host-neutral React views with the React entrypoint and semantic stylesheet:

```ts
import { Action, Frame } from '@noodleseed/one/react';
import '@noodleseed/one/react/styles.css';
```

Platform helpers are available from `@noodleseed/one/platform`. The installed executable is `noodle`.
Use the [generated CLI reference](https://docs.noodleseed.dev/docs/_generated/cli) for the complete command,
flag, JSON-envelope, and exit-code catalog.

## Runtime support

`@noodleseed/one` requires Node.js 24 or newer. The full CLI is supported on macOS and on Windows through
WSL2 with Ubuntu. Native Windows Node.js, PowerShell, and Command Prompt are not CLI execution environments;
the CLI prints a WSL2 handoff when invoked there.

## Security and ownership

- Inbound MCP or OAuth bearer tokens are not forwarded directly to business backends. Validated identity is
  exchanged for a downstream-scoped credential at the connector boundary.
- Secrets stay outside source, manifests, logs, widget payloads, and generated runtime artifacts.
- Hosted requests are authenticated and tenant-scoped before capability execution.
- Local authoring, validation, testing, and preview work without a Noodle Seed account.
- Your TypeScript source remains yours. `noodle export manifest` also emits the portable manifest compiled
  from that source for inspection and self-hosting workflows.

## Documentation and support

- [Quickstart](https://docs.noodleseed.dev/docs/quickstart)
- [CLI reference](https://docs.noodleseed.dev/docs/_generated/cli)
- [Noodle Core public repository](https://github.com/NoodleSeed-com/noodle-core)
- [Issues and feature requests](https://github.com/NoodleSeed-com/noodle-core/issues)
- [Security policy](https://github.com/NoodleSeed-com/noodle-core/security)
- [Apache-2.0 license](https://github.com/NoodleSeed-com/noodle-core/blob/main/LICENSE)
