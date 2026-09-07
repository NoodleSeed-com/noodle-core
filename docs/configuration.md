# Configure self-hosted Noodle Core

**Owns:** Accepted self-host environment values, secret classification, OAuth groups, and reconciliation rules.
**Read when:** Reviewing or changing `.self-host/.env` for the local Compose profile.
**Do not put here:** Deployment procedures, app variables/secrets, or Noodle Seed Cloud configuration.
**Update when:** The initializer or `apps/self-host` accepts, derives, or rejects an environment value.

Run `noodle service init --profile open-core --compose` from the repository root. It creates canonical operator
state in `.self-host/.env`, then derives three service-specific `0600` files. Edit only the canonical file and
rerun the same initializer; do not edit `.env.postgres`, `.env.noodle`, or `.env.operator` directly.

## Generated core values

| Value | Secret | Consumer | Contract |
| :--- | :---: | :--- | :--- |
| `POSTGRES_DB` | No | PostgreSQL | Generated as `noodle`. |
| `POSTGRES_USER` | No | PostgreSQL | Generated as `noodle`. |
| `POSTGRES_PASSWORD` | Yes | PostgreSQL | URI-safe generated password; also embedded in `DATABASE_URL`. |
| `DATABASE_URL` | Yes | Noodle | A `postgres:` or `postgresql:` URL; the reference targets the private `postgres` service. |
| `NOODLE_SECRET_MASTER_KEY` | Yes | Noodle | Canonical base64 that decodes to exactly 32 bytes; protects persisted managed secrets. |
| `NOODLE_SELF_HOST_ADMIN_TOKEN` | Yes | Noodle and operator CLI | Strong generated value of at least 32 bytes; control-plane only. |
| `NOODLE_ASSET_ROOT` | No | Noodle | Non-root absolute path; generated as `/var/lib/noodle/assets`. |
| `NOODLE_ASSET_IDENTITY_SALT` | Yes | Noodle | Canonical base64url encoding of exactly 32 bytes; stable asset identity input. |
| `HOST` | No | Noodle | Container bind host; generated as `0.0.0.0`. Host exposure is separately pinned to loopback by Compose. |
| `PORT` | No | Noodle | Integer `1`–`65535`; generated as `8787`. |
| `PUBLIC_BASE_URL` | No | Noodle | HTTP(S) origin with no path, query, credentials, or fragment; generated as `http://127.0.0.1:8787`. |

The initializer preserves an existing valid canonical file. `--force` reconciles changed non-secret templates;
it does not rotate secrets. `--replace-secrets` rotates every generated secret and can make existing encrypted
configuration and asset identities unusable. Use it only for an intentionally disposable reset.

## Optional owner authentication

The default first deployment uses `--access public` and requires no end-user identity provider. Choose exactly
one complete group before using owner/authenticated access.

External issuer:

| Value | Secret | Purpose |
| :--- | :---: | :--- |
| `NOODLE_OAUTH_ISSUER` | No | Exact token issuer origin. |
| `NOODLE_OAUTH_JWKS_URI` | No | HTTPS (or explicit loopback HTTP) JWKS endpoint. |

Portable Google federation:

| Value | Secret | Purpose |
| :--- | :---: | :--- |
| `NOODLE_OAUTH_ISSUER` | No | Origin of the local authorization server. |
| `NOODLE_OAUTH_SIGNING_KEY_BASE64` | Yes | Canonical base64 containing a valid PKCS#8 private key. |
| `NOODLE_OAUTH_GOOGLE_CLIENT_ID` | No | Google OAuth client identifier. |
| `NOODLE_OAUTH_GOOGLE_CLIENT_SECRET` | Yes | Google OAuth client secret. |
| `NOODLE_OAUTH_GOOGLE_REDIRECT_URI` | No | HTTPS or explicit-loopback HTTP redirect URI. |
| `NOODLE_OAUTH_ALLOWED_EMAIL_DOMAIN` | No | Optional email-domain restriction. |

Partial groups fail closed, and external JWKS mode cannot be combined with Google-federation settings. Non-loopback
issuer, JWKS, and redirect URLs must use HTTPS. Private Noodle Seed platform-auth variables and unknown
`NOODLE_*` values are rejected by the self-host composition instead of being silently ignored.

Build metadata values `NOODLE_BUILD_VERSION`, `NOODLE_BUILD_SHA`, and `NOODLE_BUILD_TIME` are optional,
non-secret image metadata accepted by the service; they are not generated operator settings. App-specific values
and credentials are managed through typed `noodle variables` and `noodle secrets` operations, not added to this
service environment.

## Apply and verify a change

```sh
npx @noodleseed/one@latest service init --profile open-core --compose
docker compose up --build --wait postgres noodle
docker compose ps --all
```

Configuration validation happens before the HTTP server starts. Keep `.self-host/.env` out of source control,
logs, screenshots, tickets, and the combined data archive. Back it up separately as described in
[backup and restore](backup-and-restore.md).
