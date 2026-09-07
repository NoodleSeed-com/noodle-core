# Contribute a connector

**Owns:** The public path for proposing, authoring, testing, and reviewing HTTP or compute connector capability.
**Read when:** Adding an upstream API, connector operation, credential profile, or connector-focused example.
**Do not put here:** Provider credentials, private catalog operations, or a second authoring format.
**Update when:** The TypeScript connector surface, security boundary, examples, or contribution checks change.

Most integrations do not need a new runtime package. Start in normal TypeScript with `connector(id)` inside a
`server.ts`; Noodle compiles the declaration into system-owned runtime data. Do not ask app authors to edit a
manifest, connector YAML, or generated artifact.

Upstream pull requests are paused during the initial beta. You can develop and test a connector in your fork;
[CONTRIBUTING.md](../CONTRIBUTING.md) owns the current intake disclosure and future submission process.

The public `examples/weather/src/server.ts` is the clearest HTTP connector reference. It demonstrates an exact
base origin, `allowedOrigins`, typed Zod input/output, bounded response size, response projection, and sandboxed
compute. Extend an existing flagship example when it already owns the capability; a new example must justify a
distinct end-to-end behavior rather than duplicating one.

## Before coding

Open a public issue describing:

- the user job and upstream provider;
- the smallest useful read or mutation operation;
- authentication type and who owns the credential;
- exact allowed origins, redirect behavior, pagination, retry, and response-size expectations; and
- how a maintainer can test it without receiving your real secret.

Never commit a working API key, token, client secret, credential file, captured customer payload, or copied
provider response containing personal data.

## Authoring rules

- Give the connector and version stable, descriptive identifiers.
- Declare one exact `baseUrl` and the minimum `allowedOrigins`; do not accept arbitrary user-supplied URLs.
- Use explicit methods, paths, query/body fields, timeouts, response byte limits, and pagination bounds.
- Define operation input and output as Zod object schemas (or closed JSON Schema objects where required).
- Use `secret("NAME")` for credentials and `variable("NAME")` for non-secret operator bindings. Do not read
  `process.env` from app authoring code or embed credentials in source.
- Keep bearer/API-key/client-credential material out of errors, logs, manifests, and tool results.
- Use sandboxed compute only for bounded deterministic reshaping. It has no ambient network or process access;
  network calls belong in declared connector operations.
- Mark mutations accurately and make retry/idempotency behavior explicit.

If the change truly requires a shared runtime adapter, keep its dependency graph Apache-2.0-only and preserve the
generic service boundary. Noodle Seed Cloud-specific provider lifecycle, hosted credential enrollment, billing,
or fleet operations do not belong in the public adapter.

## Test changes in your fork

Add the smallest owning-layer tests first: schema/authoring tests for the compiled declaration, runtime tests for
request encoding and egress policy, and one curated example path when behavior is user-visible. Use fake upstreams
and obviously synthetic credentials. Cover error status, timeout, redirect, size, malformed response, and secret
non-disclosure cases relevant to the operation.

Run focused package tests while editing, then run `pnpm verify`. Once contribution intake opens, sign every
submitted commit and follow [CONTRIBUTING.md](../CONTRIBUTING.md). Future public review should be able to understand
why the connector is useful, how it is bounded, and which behavior the tests prove.
