# Secure self-hosted Noodle Core

**Owns:** The local reference trust boundaries, hardening defaults, internet-exposure requirements, and operator duties.
**Read when:** Evaluating risk, changing exposure, configuring identity, or deploying beyond a local machine.
**Do not put here:** Vulnerability disclosures, managed incident response, or provider-specific infrastructure recipes.
**Update when:** The Compose hardening, authentication boundary, secret flow, or supported exposure model changes.

The reference stack is a local evaluation and single-node operation profile. It publishes Noodle only at
`127.0.0.1:8787`; PostgreSQL has no host port. That loopback boundary is part of the certified default, not an
accidental convenience.

## Control plane and data plane

Initialization creates a high-entropy administrator token. Compose maps it to the fixed `self-host-admin`
control-plane actor only inside the service and one-shot CLI containers. The token authorizes deploy and operator
operations; it is rejected as an MCP data-plane bearer token and must never be pasted into shell history, logs,
application code, or a browser.

Public MCP deployments require no caller identity. Owner/member/authenticated modes are not silently enabled:
configure and test one complete OAuth group from [configuration](configuration.md), then bind the intended owner
subject separately from the deploy actor. Losing identity-provider access is an operator recovery problem; this
beta does not include Noodle Seed managed identity recovery.

## Container and storage boundary

The generated Compose services run as non-root with read-only root filesystems, all Linux capabilities dropped,
`no-new-privileges`, bounded temporary filesystems, and explicit writable volumes. PostgreSQL owns control-plane
and application state. The asset volume owns packaged widget bytes and is a data boundary, not trusted executable
code. The same-origin asset handler validates paths and content metadata, but host access to either Docker volume
is equivalent to access to service data.

Generated secrets use `0600`; their directory uses `0700`. Service-specific env files receive only the values
their container needs. Ambient Compose/shell variables do not replace the generated credentials. Protect the
Docker socket and host account: anyone who controls either can inspect containers, volumes, or one-shot CLI runs.

## Before exposing it outside loopback

The repository does not provide a production internet-hosting recipe. At minimum, an operator must:

1. keep the Noodle and PostgreSQL containers on a private network;
2. place a maintained TLS-terminating reverse proxy in front of Noodle and publish only the proxy;
3. set and verify the real `PUBLIC_BASE_URL` origin;
4. select an end-user access mode and test issuer, audience, key rotation, revocation, and recovery;
5. restrict administrative network access and keep the administrator token out of the data plane;
6. test backup and restore, key custody, host patching, dependency updates, log retention, monitoring, and alerts;
7. define rate limits, capacity bounds, incident response, and availability expectations for your users; and
8. revalidate the container hardening and exposed ports after every local Compose customization.

Noodle Seed does not certify a public deployment merely because the local Compose profile starts. Multi-node
operation also requires a shared durable asset adapter and a tested database/coordination design beyond this beta.

Report product vulnerabilities privately through [SECURITY.md](../SECURITY.md). Use public issues only for
non-sensitive hardening proposals.
