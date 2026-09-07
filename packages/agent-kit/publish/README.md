# @noodleseed/agent-kit

Self-checking, self-updating **agent skills** for the [Noodle Seed](https://noodleseed.dev) CLI.

This package is the **canonical, independently-versioned skills artifact** the `noodle` CLI fetches and
verifies. It is **not** meant to be imported directly by apps — it is shipped as data the CLI reconciles
into a project's `.agents/` and `.claude/` skill directories via `noodle agents setup --write`.

## Contents

- `skills/codex/` — Codex skill trees: the compatibility front door at the target root and independently
  discoverable sibling skills in named subdirectories, with supporting `references/*.md` where needed.
- `skills/claude-code/` — the same registered behavior system for Claude Code.
- `manifest.json` — schema v2 registry metadata plus every file's skill identity, version, host, publish
  path, installed path, and sha256. The CLI verifies every
  file's sha256 against this manifest before writing it into a user's project; a mismatch refuses the
  write. The manifest and generated skill files are produced during System Release and are available for
  inspection in the published npm archive.

## How the CLI uses it

The installed `noodle` CLI bundles a skills snapshot at its release version. On interactive runs it
also checks `@noodleseed/agent-kit@latest` on the npm registry and, when newer, prompts:

```
Skills updated in vX — run `noodle agents setup --write` to refresh.
```

`noodle agents setup --write` then fetches this package, sha256-verifies it against the manifest, and
writes the fresh skill tree into the project (the managed `AGENTS.md`/`CLAUDE.md` block stays bundled,
since it is project-specific). Offline or on verification failure it falls back to the bundled snapshot.
Run `noodle agents doctor` to see installed vs registry skill versions and detect local edits to bundled
reference files.

## License

Apache-2.0. This package is generated and published from the
[`noodle-core`](https://github.com/NoodleSeed-com/noodle-core) repository; the renderer is the
`@noodle-borg/agent-kit` workspace package.
