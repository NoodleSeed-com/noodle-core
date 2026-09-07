---
name: personal-email-automation
description: Safely search, read, draft, label, archive, send, trash, and update vacation settings across explicitly selected connected Gmail accounts. Use for personal email automation requests that name one account or the canonical personal-and-work pair.
---

# Personal Email Automation

Use the Gmail multi-account tools with an explicit `accounts` array on every call.

## Select accounts

- Use `accounts: ["personal@example.com"]` or `accounts: ["work@example.com"]` for one mailbox.
- Use `accounts: ["personal@example.com", "work@example.com"]` only for reads.
- Preserve that canonical pair order. Never guess, reorder, duplicate, or accept another label.
- Treat labels as selectors only. Never infer the authenticated Google identity from a label.

## Read safely

Search or read both accounts when comparison is useful. Keep returned items labeled by account and do not
merge identities, message ids, draft ids, or continuation tokens across accounts.

## Mutate safely

Target exactly one account for every mutation. State the selected account and intended change, then use the
tool's enforced confirmation. Never try to reuse a continuation for another account.

Prefer draft-first behavior:

1. Create or update a draft.
2. Show the account, recipients/subject derived from the MIME content, and draft id for review.
3. Send the confirmed draft only when the user asks.

Raw message and draft inputs are base64url-encoded RFC 2822 MIME. Do not improvise Unicode/MIME encoding
with string concatenation; obtain a correctly encoded `raw` value from a trusted composer.

For deletion requests, use reversible trash only after confirmation. Permanent delete is unavailable and
must remain unavailable. Do not use delegation, forwarding/sharing settings, or generic HTTP escape hatches.

Never expose credentials, provider connection ids, access tokens, or account-enrollment internals.
