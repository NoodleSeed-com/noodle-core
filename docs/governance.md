# Noodle Core governance

**Owns:** Public decision-making, maintainership, contribution integration, DCO, and repository authority.
**Read when:** Proposing a material change, reviewing maintainer authority, or understanding how a proposed change lands.
**Do not put here:** Private company operations, current roadmap status, or release-specific implementation logs.
**Update when:** Review authority, contribution flow, licensing, or community decision policy changes.

Public issues are available for reproducible bugs, feedback, and change proposals. The repository does not accept
pull requests; [CONTRIBUTING.md](../CONTRIBUTING.md) owns how an accepted proposal lands.
Security disclosures are the exception and follow [SECURITY.md](../SECURITY.md).

## Repository authority

Noodle Seed's private engineering monorepo is the source and release authority. This repository is a deterministic
Apache-2.0 projection designed to be independently buildable, testable, and forkable; it is not a second release
authority or an independently edited implementation.

The repository does not accept pull requests, and Noodle Seed's CI runs only code its own team authors. A change
travels one way:

1. a contributor proposes it in a public issue, linking a fork branch when there is one;
2. maintainers discuss it in public and record the accept or reject decision there;
3. a Noodle Seed team member re-authors an accepted change in the private engineering repository, where normal
   review and CI preserve the commercial dependency boundary; and
4. the next synchronized export carries the result to public `main`, and the maintainer links it on the issue.

The exported commit has a different commit hash. The public issue and the exported content are the continuity record.

## Maintainers and decisions

Maintainers seek technical consensus and may delegate review areas, but Noodle Seed retains final responsibility
for project direction, releases, security response, trademarks, and the public/commercial boundary. There is no
automatic path from contribution count to maintainer or release authority during the beta. A future maintainer
program must define selection, conflicts, removal, and release permissions publicly before granting them.

Substantial public API, compatibility, security-boundary, governance, or licensing changes should begin with an
issue that states the user value, alternatives, risks, and acceptance evidence. The resulting public issue/PR
records the durable rationale; community members do not need access to private design documents to understand the
decision.

## Contribution terms

Original public code is Apache-2.0 as described in [LICENSE-SCOPE.md](../LICENSE-SCOPE.md). Forks do not need
upstream approval. Commits in a branch linked from a proposal should carry a Developer Certificate of Origin
sign-off; contributors retain copyright and certify they have the right to submit the work. Third-party
dependencies must permit commercial use and preserve required notices. Apache-2.0 permits
forks and competing hosted services, while [TRADEMARKS.md](../TRADEMARKS.md) prevents confusing use of Noodle Seed
branding.

Community support is best-effort. Governance participation does not create an employment, partnership, support,
security-response, or service-level commitment.
