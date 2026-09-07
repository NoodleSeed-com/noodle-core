# Noodle Core Contributor Instructions

**Owns:** Public contributor working rules for the projected Noodle Core repository.
**Read when:** Changing code, tests, documentation, or examples in `noodle-core`.
**Do not put here:** Private Noodle Seed infrastructure, strategy, credentials, or monorepo-only workflow.
**Update when:** Public contribution gates, supported tooling, or synchronization behavior changes.

Use Node.js 24 and pnpm 11. Write focused tests before behavior changes, keep public APIs explicitly typed, and
run `pnpm build`, `pnpm typecheck`, `pnpm test`, and `pnpm lint` before offering a change for future upstream
integration. Do not add credentials, customer information, private infrastructure, or proprietary Noodle Seed
implementation details.

Upstream pull requests and automated contribution integration are paused during the initial beta. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the current disclosure and the future DCO/review process. The private
source-of-truth repository remains authoritative, and reviewed exports update public `main`.
