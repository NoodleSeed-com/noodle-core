# hello — minimal TypeScript quickstart

The smallest deployable Noodle app: a single `greet` tool authored in TypeScript with no
connectors, secrets, flows, widgets, or handoff policy. It still uses the current server options form
so new authors see where server-level branding belongs. Use it for a local read or first deploy.
For a new project, `noodle init --template hello` also supplies isolated behavior tests: compilation,
tool discovery, an expected greeting and invalid-input rejection. Init installs pinned local tooling and runs
those checks; use `npm run agent:check` after edits. `--no-install` prepares files without verified readiness.
If setup fails, repair its reported stage and repeat the safe resume command; do not overwrite your edits.

Protocol negotiation deliberately does not appear in `src/server.ts` or `noodle.json`. MCP versions
are platform-owned: the same deployed app automatically serves compatible legacy clients and modern
clients from its existing endpoint, without an app setting or redeploy.

When an installed Noodle Developer plugin drives this example, its skill performs mapped lifecycle
steps through the supported `noodle-readiness` tools and reports only stable public `noodle ...`
commands as recovery text. Do not install or update a global CLI: the coding agent writes and tests
this source while Noodle guides and operates the validate, preview, deploy, inspect, and debug workflow.
Plugin sign-in uses one compact consent for the Developer MCP resource; it does not ask the user to
choose organizations or environments. For remote inspection, the agent calls `get_context`, resolves
the intended organization from the request or this project, and passes that explicit `org` to every
scoped tool. The local CLI may keep its own default organization for command convenience.
For an approved implementation plan, the installed `executing-noodle-plans` skill owns the
test-first task, review, recovery, and final-verification loop.
If that agent discovers a Noodle Seed product gap while working, the installed skill prepares a
sanitized `noodle feedback` proposal, discovers current fields from `noodle commands --json`, and
previews the exact normalized submission, diagnostics, and private destination through the typed
plugin function or `--dry-run --json`. It includes its known `--agent` and `--model` identity without
guessing unavailable values, keeps those fields structured, and submits once only after explicit user
approval of that exact preview; it never composes a shell wrapper, auto-logs in, or retry-loops.
Every `--json` command writes its canonical success or failure envelope to stdout and leaves stderr
empty. One-shot commands write one envelope; streaming commands write NDJSON snapshot, event, and
terminal-failure envelopes so agents can parse each line independently.

```sh
noodle test examples/hello/src/server.ts --tool greet --args '{"name":"Ada"}' --json
noodle dev examples/hello/src/server.ts --app hello
noodle deploy examples/hello/src/server.ts --org acme --app hello
```

`noodle export manifest examples/hello/src/server.ts` compiles the same entrypoint locally and prints
the portable, vendor-neutral manifest JSON — the eject path: your `server.ts` plus this manifest is
the whole app, yours to read, diff, and keep.

It is also the fixture for `pnpm smoke:dev` and the e2e harness, so keep its tool surface stable.
