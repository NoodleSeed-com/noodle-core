# Stateful Draft

**Owns:** The flagship for a useful brief before signup, authoritative caller state, and account continuation.
**Read when:** You want to compose a small conversational onboarding flow from existing platform capabilities.
**Do not put here:** Customer credentials, a new identity provider, or business-system records.
**Update when:** The reference tools, state schema, or runnable journey changes.

Start with the visitor's goal. Help them produce something useful before asking for an account. This
synthetic example collects a project title, audience, and desired outcome; those fields are illustrative,
not requirements for any particular SaaS product.

## The journey

1. The visitor describes a goal. The assistant asks only for missing information and proposes a brief.
2. `open_draft` opens an editable review and reads authoritative state, including its current revision.
3. `save_draft` saves the reviewed brief after confirmation. It sends the current revision and the complete
   value to the state API. Failed or missing responses do not appear as successful saves.
4. The visitor may choose `continue_draft`. This read requires identity, so an anonymous visitor sees the
   sign-in/signup card. Your host application completes its existing login and spends the bound ticket.
5. The authenticated assistant reads the same adopted draft. No project, subscription, or business record
   is created by signing in.

The widget's Continue button requests the identity-dependent tool through the conversation. The ordinary
signup route should remain available on the embedding page.

## Run the reference

From this repository:

```sh
pnpm install
pnpm build
noodle validate examples/stateful-draft/src/server.ts
noodle test examples/stateful-draft/src/server.ts
noodle dev examples/stateful-draft/src/server.ts --org demo --app stateful-draft
```

The local runtime and widget preview exercise the typed tools. A complete mixed-assistant journey also
requires two host pages and a backend that verifies the user. The declared development origins are
`http://localhost:3001` for the public page and `http://localhost:3002` for the authenticated page; replace
these with your exact deployment origins. The assistant uses `noodleManaged()`, whose hosted availability
and budget belong to the operator. Local tool tests do not require a model key.

Use the SDK version declared in this example's package file. Older published SDKs may omit the state
adoption flag when compiling; the example's tests check that the flag reaches the compiled declaration.

Use [signup continuity](https://docs.noodleseed.dev/docs/guides/signup-continuity) for the complete host
integration and [customer-auth](../customer-auth/README.md) for customer-owned API authentication.

### Loopback demonstration with a hosted assistant

The included host serves the public page on port 3001 and a **simulated** account page on port 3002.
It binds to loopback and must not be published as a production authentication implementation.
After deploying this app, copy this directory outside the monorepo and run the commands below from that
copy. This keeps published dependencies from shadowing the monorepo's workspace SDK.

```sh
pnpm install --ignore-workspace --lockfile=false
export NOODLE_EMBED_ID=<embed-id-printed-by-deploy>
pnpm site
```

This is enough to test the anonymous conversation and saved brief. To exercise the synthetic account
handoff, create an assistant backend client for the same org/app/env with
`noodle assistant clients create --name first-brief-demo --org <org> --app <app> --env <env> --json`.
Set `NOODLE_ASSISTANT_CREDENTIALS_FILE` to the returned `secretFile` path and restart `pnpm site`.
The host consumes that private file without printing it or sending its contents to the browser.
Override `NOODLE_SERVICE_URL` only when deploying to a different hosted service.

The simulated signup chooses a random temporary demo identity and spends the ticket through the real
backend session helper. The host's login transaction lasts ten minutes; it is local process memory and
is lost on restart. A production integration replaces it with the customer's existing verified login and
login transaction. Do not copy the synthetic identity branch into a real application.

## Customer integration map

| Reference | Adaptation in the customer's application |
| :--- | :--- |
| Three-field brief | Select the smallest useful outcome and collect only its missing inputs |
| Public mixed surface | Mount the public embed on the unauthenticated website with an exact allowlist |
| Expiring `draft` handle | Keep only temporary, bounded coordination state; omit persistence if unnecessary |
| `continue_draft` | Trigger the existing signup/login at the point the visitor chooses an account |
| Host session endpoint | Verify the logged-in user, spend the bound ticket, return the SDK session response |
| Final business action | Add a typed connector to the existing authorized, idempotent create/update API |

The final business action belongs in the customer backend. Show the resulting record or its identifier
only after that API confirms success. Signup and state adoption alone are not completed onboarding.
Research or document parsing can be added later when they remove a demonstrated user burden; they are not
prerequisites for this reference.

## State and failure behavior

The draft uses caller scope, a finite 24-hour TTL, and `claimOnAuthentication: true`. Its `v2` schema
replaces the earlier title/stage illustration. Widget state is only a display cache. Reads, validation,
revision checks, expiry, and persistence belong to the runtime.

A stale edit requires an explicit reload and review before another save. Spending the single-use sign-in
ticket moves only opted-in state to the backend-verified account, preserving its revision and expiry.
Destination conflicts fail rather than merging two drafts. Abandoned or expired signup leaves the
anonymous state under its original limits. A 24-hour state TTL does not promise cross-device recovery or
that an arbitrary new anonymous visit can recover the conversation.

The save is a connector-backed side effect on a public/mixed surface, so it has `confirm: true`. Previewing
the brief has no side effect and needs neither signup nor confirmation. Do not add a confirmation to each
conversational answer or treat confirmation as proof of identity.
The example relies on the managed confirmation default: reviewers see the complete business brief and
decision controls without connector mechanics. Enable `showConfirmationDetails` only for an audience that
needs those technical details.

## Validate before a customer pilot

- Show useful value with no account and without repeating already supplied information.
- Save, reopen, and edit the actual record; test a stale revision and an unconfirmed save.
- Verify the same draft after the customer's real signup and login, including cancellation and expiry.
- Test an existing-account draft conflict and ensure it is not silently overwritten.
- Ensure signup triggers no unintended business write and account A cannot read account B's draft.
- Compare onboarding completion and first useful product outcome with the existing flow; count signups
  separately. A demo is not evidence of improved conversion.
