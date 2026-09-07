# Gmail multi-account automation

**Owns:** The flagship proof that one reusable connector can be bound to multiple independently
authenticated accounts inside one MCP server.

This fictional example binds `gmailConnector()` twice through separate `externalExchange()` logical
connections. Public tools always accept `accounts: [...]`; reads accept either account or the canonical
personal-then-work pair, while mutations accept exactly one account and require runtime confirmation.

Capability slot: **reusable connector + independently authenticated multi-account bindings**. It is distinct
from `customer-auth`, which owns authentication of the MCP caller rather than downstream connector accounts.

The labels `personal@example.com` and `work@example.com` are static display labels, not provider identities.
The deployment-owned credential provider maps each logical connection to its real Google authorization.
No Google client, provider account id, token, or real email address belongs in this project.

## Safety and API boundary

- Search, message/thread reads, draft reads, and vacation-setting reads may target one or both accounts.
- Draft creation/update/send, label changes, archive, raw send, trash, and vacation updates target one account.
- Every mutation is prepared against the exact selected binding and must be confirmed before dispatch.
- `send_message.raw` and draft `raw` are RFC 2822 MIME bytes encoded with base64url. This example does not
  pretend that `to`/`subject`/`body` strings are sufficient to encode Unicode MIME correctly.
- Vacation `startTime`/`endTime` schemas enforce only digit-shaped 1–19 character epoch-millisecond strings.
  When both are supplied, Gmail's backend remains authoritative for the required `startTime < endTime`
  relationship; this example does not claim cross-field JSON Schema validation.
- Trash is reversible. Permanent message/thread/draft deletion, delegation, forwarding/sharing settings,
  and unrestricted raw HTTP requests are intentionally absent.

## Local checks

```sh
noodle validate
noodle test
```

The committed tests compile hermetic fake connector responses. They never contact Gmail or load OAuth
credentials. A real deployment additionally needs an operator-provided external credential exchange
endpoint for each logical connection.

## Personal automation skill

The source skill is [`skills/personal-email-automation/SKILL.md`](skills/personal-email-automation/SKILL.md).
Validate it with the standard skill validator before distribution. The source skill is shipped as part of
this example; canonical export of an app and its skill as an installable Codex plugin remains roadmap work
and is not currently provided by Noodle Seed.
