# Security Policy

**Owns:** Vulnerability reporting and supported-version policy for the public Noodle Core project.
**Read when:** Reporting or triaging a possible security vulnerability.
**Do not put here:** Public bug reports, deployment hardening instructions, or commercial incident procedures.
**Update when:** The disclosure channel or public support window changes.

## Supported versions

Security fixes target the latest released `0.x` version. Older releases receive fixes only when maintainers
explicitly announce an extended support window. Self-host operators remain responsible for their operating
system, Docker host, reverse proxy, identity provider, PostgreSQL, backups, and dependency updates.

## Report a vulnerability privately

Do not open a public issue, discussion, or pull request for a suspected vulnerability. Use GitHub's private
vulnerability reporting for this repository: open **Security**, choose **Advisories**, then **Report a
vulnerability**. Include affected versions, impact, reproduction steps or a proof of concept, and any known
mitigation.

If private vulnerability reporting is unavailable, contact the repository owner privately through their GitHub
profile and ask for a secure channel without including exploit details in the first message.

Maintainers will acknowledge a report as soon as practical, validate it, coordinate a fix and disclosure, and
credit the reporter if requested. Community security response is best-effort and carries no response-time or
remediation SLA. Please allow a reasonable remediation period before public disclosure.

For deployment hardening and the local reference boundary, read [docs/security.md](docs/security.md).
