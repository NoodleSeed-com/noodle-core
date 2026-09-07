# Noodle Core governance

**Owns:** Public decision-making, maintainership, contribution integration, DCO, and repository authority.
**Read when:** Proposing a material change, reviewing maintainer authority, or understanding the future pull-request round trip.
**Do not put here:** Private company operations, current roadmap status, or release-specific implementation logs.
**Update when:** Review authority, contribution flow, licensing, or community decision policy changes.

Public issues are available for reproducible bugs and feedback. Upstream pull requests and automated contribution
integration are paused during the initial beta; [CONTRIBUTING.md](../CONTRIBUTING.md) owns the current disclosure.
Security disclosures are the exception and follow [SECURITY.md](../SECURITY.md).

## Repository authority

Noodle Seed's private engineering monorepo is the source and release authority. This repository is a deterministic
Apache-2.0 projection designed to be independently buildable, testable, and forkable; it is not a second release
authority or an independently edited implementation.

If contribution intake is activated after its safety verification, Copybara will carry accepted changes in both
directions:

1. a contributor opens a public pull request and public CI validates its exact revision;
2. maintainers review the change in public and approve a specific head;
3. the change is imported as a draft, then executed only after revision-bound internal approval on disposable
   validation infrastructure;
4. normal internal integration preserves the commercial dependency boundary; and
5. the accepted result is exported to public `main`, restoring contributor authorship and linking the result.

Transformation and integration produce a different commit hash. That is expected; authorship, the public review,
and the returned content are the continuity record. A force-pushed or updated public head needs fresh evidence.

## Maintainers and decisions

Maintainers seek technical consensus and may delegate review areas, but Noodle Seed retains final responsibility
for project direction, releases, security response, trademarks, and the public/commercial boundary. There is no
automatic path from contribution count to maintainer or release authority during the beta. A future maintainer
program must define selection, conflicts, removal, and release permissions publicly before granting them.

Substantial public API, compatibility, security-boundary, governance, or licensing changes should begin with an
issue that states the user value, alternatives, risks, and acceptance evidence. The resulting public issue/PR
records the durable rationale; community members do not need access to private design documents to understand the
decision.

## Future contribution terms

Original public code is Apache-2.0 as described in [LICENSE-SCOPE.md](../LICENSE-SCOPE.md). Forks do not need to
wait for upstream intake. Once intake opens, every submitted commit will require a Developer Certificate of Origin
sign-off; contributors will retain copyright and certify they have the right to submit the work. Third-party
dependencies must permit commercial use and preserve required notices. Apache-2.0 permits
forks and competing hosted services, while [TRADEMARKS.md](../TRADEMARKS.md) prevents confusing use of Noodle Seed
branding.

Community support is best-effort. Governance participation does not create an employment, partnership, support,
security-response, or service-level commitment.
