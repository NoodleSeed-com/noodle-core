# Contributing to Noodle Core

You can inspect, clone, modify, fork, and run Noodle Core under Apache-2.0. This repository does not accept pull requests: Noodle Seed's CI runs only code its own team authors. Public issues remain open for reproducible bugs, feedback, and change proposals.

You may develop changes in your own fork. Use a public issue to report a reproducible bug, offer focused
feedback, or propose a behavior or contract change, and link your fork's branch when you have one. Do not attach
secrets or vulnerability details; follow [SECURITY.md](SECURITY.md) for private disclosure.

## Preparing a proposal

A change proposed from a fork is easiest to evaluate when it follows these practices:

1. Add or update the smallest owning-layer test first.
2. Keep changes within the Apache paths documented in [LICENSE-SCOPE.md](LICENSE-SCOPE.md).
3. Run focused checks while editing and `pnpm verify` once before linking the branch.
4. Sign every commit with `git commit -s` for the
   [Developer Certificate of Origin 1.1](https://developercertificate.org/).

Connector work is a useful way to explore the code in a fork. Follow the
[connector contribution guide](docs/connector-contributions.md), which covers the public TypeScript surface,
credentials, network boundaries, examples, and tests. Issues labelled
[`good first issue`](https://github.com/NoodleSeed-com/noodle-core/labels/good%20first%20issue) are intended to be
self-contained; [`help wanted`](https://github.com/NoodleSeed-com/noodle-core/labels/help%20wanted) marks work
maintainers would genuinely welcome.

## How an accepted change lands

Discussion and the accept or reject decision happen on the public issue. When maintainers accept a change, a
Noodle Seed team member re-authors it in Noodle Seed's private engineering repository, where it goes through
normal review and CI. It reaches public `main` through the next synchronized export, and the maintainer links the
exported commit on the issue.

The [governance guide](docs/governance.md) explains maintainer authority, decision transparency, and licensing
in more detail. Report vulnerabilities through [SECURITY.md](SECURITY.md), never through
a public issue.
