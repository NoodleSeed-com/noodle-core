# Contributing to Noodle Core

You can inspect, clone, modify, fork, and run Noodle Core under Apache-2.0. Upstream pull requests and automated contribution integration are paused during this initial beta. Public issues remain available for reproducible bugs and feedback. We will announce contribution intake after its safety verification is complete.

You may develop changes in your own fork. For now, use a public issue to report a reproducible bug, offer focused
feedback, or discuss a substantial behavior or contract proposal. Do not attach secrets or vulnerability details;
follow [SECURITY.md](SECURITY.md) for private disclosure.

## Future contribution requirements

When upstream contribution intake opens, it will use these requirements:

1. Add or update the smallest owning-layer test first.
2. Keep changes within the Apache paths documented in [LICENSE-SCOPE.md](LICENSE-SCOPE.md).
3. Run focused checks while editing and `pnpm verify` once before requesting integration.
4. Sign every commit with `git commit -s` for the
   [Developer Certificate of Origin 1.1](https://developercertificate.org/).

Connector work is a useful way to explore the code in a fork. Follow the
[connector contribution guide](docs/connector-contributions.md), which covers the public TypeScript surface,
credentials, network boundaries, examples, and tests. Issues labelled
[`good first issue`](https://github.com/NoodleSeed-com/noodle-core/labels/good%20first%20issue) are intended to be
self-contained; [`help wanted`](https://github.com/NoodleSeed-com/noodle-core/labels/help%20wanted) marks work
maintainers would genuinely welcome.

## Future pull-request process

This process is not active during the initial beta. After contribution intake is announced, Noodle Core's
synchronized projection will use this flow instead of direct GitHub merges:

1. Public CI validates the exact head revision and DCO metadata.
2. Review happens on your public pull request. Maintainers explain requests and accept/reject decisions there.
3. A green, approved revision is imported as a draft internal change without making the public repository an
   engineering or release authority.
4. The exact transformed revision passes isolated validation before it can join the internal merge queue.
5. After internal merge, the accepted change is exported to public `main`, with your authorship restored and
   integration feedback posted on the original pull request.

The exported commit has a different hash because Copybara transforms and integrates it. A new public head needs
fresh review and validation, and integration can take longer than a direct GitHub merge. Public review remains
the canonical record even when maintainers need additional private-system validation.

The [governance guide](docs/governance.md) explains maintainer authority, decision transparency, licensing,
and the future round trip in more detail. Report vulnerabilities through [SECURITY.md](SECURITY.md), never through
a public issue.
