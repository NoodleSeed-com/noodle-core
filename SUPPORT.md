# Support

**Owns:** Public help routes and the support boundary for the self-hosted Noodle Core beta.
**Read when:** Seeking help, reporting a reproducible defect, or evaluating support expectations.
**Do not put here:** Vulnerability details, managed-service commitments, or private customer procedures.
**Update when:** Community channels, supported versions, or support commitments change.

- Read the [documentation index](docs/README.md) and search existing issues first.
- Use the repository issue templates for reproducible bugs, focused feature proposals, and connector requests.
- Include the Noodle Core revision, operating system, Node/Docker versions, exact command, and redacted output.
- Follow [SECURITY.md](SECURITY.md) for vulnerabilities; never disclose them in a public issue.

Community support is best-effort and has no response-time, remediation, compatibility, or uptime guarantee.
Maintainers may close requests that cannot be reproduced, target an unsupported version, require production
hosting design, or concern Noodle Seed Cloud rather than the Apache core.

The local beta does not include production deployment review, TLS/ingress design, automated backup validation,
high availability, monitoring, incident response, data recovery, or an SLA. You own those operations and should
test the [backup and restore procedure](docs/backup-and-restore.md) in your environment. Managed-cloud and
commercial support commitments exist only under their applicable agreement.
