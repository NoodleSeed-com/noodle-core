# Customer Auth - OIDC identity and customer-routed APIs

For a visitor who starts before signup, use the [Stateful Draft reference](../stateful-draft/README.md)
alongside this authenticated backend integration.

This curated example owns the customer/end-user authentication capability slot. It proves that a SaaS app
can protect an MCP endpoint with direct OIDC, retain role/scope-based tool authorization, and route ordinary
reads and confirmed actions to the API origin selected by the verified customer's identity provider.

It also owns the customer-branded embedded-assistant presentation showcase. Direct MCP calls obtain the
route from the verified OIDC claim; embedded sessions obtain it from the authenticated customer backend's
session exchange. Both paths keep the URL outside tool/model/browser-visible state. The built-in card hides
its optional technical Additional details disclosure while retaining the business review and confirmation
controls; this presentation setting does not weaken the exact runtime confirmation boundary.

The public developer entrypoint is [`src/server.ts`](src/server.ts). It exposes a deliberately small MCP
surface for organization discovery and app lifecycle operations:

- `list_my_organizations` lists the NoodleSeed.com organizations the signed-in customer belongs to (no
  arguments — the org set comes from the verified customer session).
- `list_org_apps` lists apps for one of those organizations through that tenant's API. It is visible and
  callable only when the verified customer has the `org_apps:read` scope and either the `org_admin` or
  `org_member` role.
- `archive_org_app` archives one app only after exact runtime confirmation. It requires the
  `org_apps:write` scope and `org_admin` role.

The tools chain: `list_my_organizations` surfaces the `org_id`s the customer can act on,
`list_org_apps` takes one of those ids, and `archive_org_app` accepts the selected app id. Tool code remains
independent of the selected origin.

The server also declares one typed `agentGuide` for those product workflows. The deployed embedded assistant
uses it automatically: each turn keeps only complete workflows supported by the verified session's roles,
scopes, and model-visible tools. An organization member can receive organization/app review guidance, while
only an administrator with `org_apps:write` receives the complete archive workflow and its confirmation
boundary. The guide stays server-side, so the Web Component, React renderer, headless hook, and public client
need no new option and receive no raw skill content. See
[using a product guide at runtime](https://docs.noodleseed.dev/docs/guides/product-agent-guides#use-the-guide-at-runtime)
for the public behavior guide.

A skill-aware external agent connected directly to the same tenant MCP URL receives the same
complete-workflow filtering through the modern draft MCP Skills extension. Members and administrators may
therefore receive different `SKILL.md` and MCP-surface bytes, each with matching caller-specific digests.
This reuses the configured customer OAuth boundary; it does not require a second skill installation or auth
system, and it is not a claim that every external host currently implements the draft extension. The
same [runtime guide](https://docs.noodleseed.dev/docs/guides/product-agent-guides#use-the-guide-at-runtime)
explains this preview boundary.

## Declare the customer endpoint

`customerEndpoint` names one private routing authority and bounds the origins an IdP may select:

```ts
const customerApi = customerEndpoint('customer_api', {
  allowedHttpsHostSuffixes: ['api.noodleseed.dev'],
});
```

Use either non-empty `allowedHttpsHostSuffixes` or non-empty `allowedHttpsOrigins`, never both. Exact-origin
policies may include a non-default port. Suffix policies match only the exact hostname or dot-boundary
subdomains on port 443. A routed connector must not add `allowedOrigins`; its endpoint policy is the egress
allowlist.

The connector uses that declaration as its normal base URL. Its token endpoint remains a fixed, independently
validated HTTPS URL:

```ts
const api = connector('noodleseed_app_api')
  .version('1.0.0')
  .http({
    baseUrl: customerApi,
    auth: {
      kind: 'delegatedTokenExchange',
      tokenUrl: 'https://id.noodleseed.dev/oauth/token',
      clientId: variable('CUSTOMER_API_CLIENT_ID'),
      clientSecret: secret('CUSTOMER_API_CLIENT_SECRET'),
      scopes: ['organizations:read', 'org_apps:read', 'org_apps:write'],
      audience: 'noodleseed-customer-api',
    },
    operations: {
      // read and action operations...
    },
  });
```

`delegatedTokenExchange` consumes a verified customer caller; an MCP access mode does not create one. The
server must declare `customerAuth.*(...)` or `embeddedAssistant(...)` so Noodle Seed can establish the caller
subject, issuer, and audience. Otherwise `noodle validate`, `noodle auth doctor`, and deploy fail early with
`delegated_token_exchange_identity_required`, before secrets are resolved or any connector egress. A
successful local Devtools exchange is not evidence that the hosted server has an identity source. Devtools
supplies a separate, loopback-only local identity context that is never accepted by hosted deployment.

At both connector and operation level, auth must be omitted or use `delegatedTokenExchange`. The compiler
validates the concrete connector definition emitted from TypeScript, including connector defaults and
operation overrides, and reports the exact failing auth path and kind. Do not keep a bearer, API-key,
client-credentials, or managed-provider fallback for local mode; use operation fakes while leaving auth
declarative.

## Map the endpoint from verified OIDC

The IdP claim contains the complete base URL, including an optional base path. Routing is separate from the
public `${user}` expression scope:

```ts
auth: customerAuth.oidc({
  issuer: 'https://id.noodleseed.dev',
  audience: 'noodleseed-customer-auth-prod',
  claims: {
    id: 'sub',
    email: 'email',
    name: 'name',
    orgs: 'permissions.orgs',
    roles: 'permissions.roles',
    scopes: 'permissions.scopes',
  },
  routing: {
    endpoints: {
      customer_api: { claim: 'tenant.api_base_url' },
    },
  },
}),
```

For federated OIDC, put the same endpoint map on every issuer. Claim paths may differ, but each issuer must
map every endpoint the app uses:

```ts
auth: customerAuth.federatedOidc({
  issuers: [
    {
      issuer: 'https://id.customer-a.com',
      audience: 'noodleseed-customer-auth-prod',
      routing: {
        endpoints: {
          customer_api: { claim: 'tenant.api_base_url' },
        },
      },
    },
    {
      issuer: 'https://login.customer-b.com',
      audience: 'noodleseed-customer-auth-prod',
      routing: {
        endpoints: {
          customer_api: { claim: 'organization.routes.customer_api' },
        },
      },
    },
  ],
}),
```

At runtime, Noodle Seed validates the configured stable audience, associates the caller with the exact
transport-derived MCP resource, projects the route into private request state, applies its policy, and
freezes it for the call. Missing, malformed, or
disallowed claims return `connector_route_unavailable` before credential lookup or connector egress.
Resolved URLs never enter artifacts, `${user}`, logs, model output, widgets, public confirmation review,
broker cache keys, or delegated exchange assertions.

Routed reads work in tools, including declared nested calls. Routed actions require exact
`annotations.confirm: true`; otherwise they fail with `customer_endpoint_action_unsupported`. Routed
resources, prompts, and ambient context fail with `customer_endpoint_surface_unsupported`.

The flagship's routed action uses the normal TypeScript action helper:

```ts
tool('archive_org_app', {
  authorization: {
    requiredScopes: ['org_apps:write'],
    allowedRoles: ['org_admin'],
  },
  annotations: annotations.openAction({ destructive: false, confirm: true }),
  // input, output, and the normal connectors.app_api.archiveOrgApp(...) call...
});
```

The flagship also opts into the current stateless hosted MCP path:

```ts
interactions: {
  confirmationFallback: 'host',
},
```

A bidirectional client that negotiated form elicitation can complete the standard confirmation exchange
instead. The explicit host fallback trusts the MCP host to have collected native write approval before the
tool call reaches Noodle Seed; it is never inferred from client identity and does not replace auth, policy,
or accurate action/destructive annotations. Omit the fallback when connected hosts are not trusted to
provide that approval. If neither standard confirmation nor the fallback is available, the action fails
closed with `interaction_unavailable`.

Preparation stores only sorted route `{ key, fingerprint }` bindings in its private server-held
continuation; the public review exposes none of them. Acceptance re-resolves the current request route and
returns `invalid_continuation` if it is missing or changed, before policy, credentials, or egress. A match
reuses the current frozen snapshot for the action and all nested or later reads.

The application developer owns the direct/federated authorization server. It must publish its path-inserted
RFC 8414 document as direct HTTP 200 JSON with exact issuer and HTTPS authorization/token/registration/JWKS
endpoints, authorization-code and refresh grants, PKCE S256, public-client auth method `none`, RFC 8707
resource handling, and public signing keys. It validates each exact MCP resource on authorize, code exchange,
and refresh, then maps approved versions of this app/environment to `noodleseed-customer-auth-prod`. Other
apps and environments use distinct audiences.

Run `noodle auth doctor src/server.ts` before sharing. Its bounded, read-only probes never register a client.
Adding the embedded assistant does not choose or rewrite MCP customer auth. Its authenticated backend may
bind `routing.endpoints.customer_api` during assistant-session exchange from server-owned membership data;
direct MCP requests continue to resolve the same endpoint from the configured verified OIDC claim.

## Per-tool authorization remains independent

The mapped `roles` and `scopes` paths are read only after OIDC verification. The restricted tool declares its
rule beside the rest of its public contract:

```ts
tool('list_org_apps', {
  authorization: {
    requiredScopes: ['org_apps:read'],
    allowedRoles: ['org_admin', 'org_member'],
  },
  // input, output, and fulfilment...
});
```

Every required scope must be present and at least one allowed role must match. When both lists are declared,
both conditions apply. Route availability never changes `tools/list`: discovery remains based only on
roles/scopes. A restricted tool is omitted for an ineligible customer and a guessed direct call still fails
closed.

Tool code calls the connector normally:

```ts
fulfil({ input, connectors }) {
  const apps = connectors.app_api.listOrgApps({
    org_id: input.org_id,
    skip: input.skip,
    limit: input.limit,
  });

  return { result: apps.result };
}
```

The broker exchanges a short-lived, platform-signed assertion at the fixed token endpoint and caches the
result by caller, connector, scopes, and a route fingerprint. The assertion carries only the route key and
fingerprint, never the URL. The MCP access token is never forwarded to the customer API. The exchange wire
contract lives in docs/spec/connectors.md.

Firebase and Microsoft remain supported managed adapters; their provider-specific contracts and tests live
in docs/spec/auth-and-policy.md and the SharePoint flagship.

## Supabase direct-OIDC access-token hook

Dynamic Client Registration lets any OAuth client register, so the presence of `client_id` is not approval.
Keep an operator-controlled client-to-audience map and rewrite `aud` only for an exact mapped client. For a
dynamically registered client, review its generated client ID, name, and exact redirect URIs in the consent
flow before adding the mapping. Each new registration needs its own row; never approve by name or prefix.

Replace `<approved-oauth-client-id>` with the reviewed client ID and `<stable-mcp-audience>` with the exact
value configured in `customerAuth.oidc`:

```sql
create table if not exists public.mcp_oauth_client_audiences (
  client_id text primary key check (btrim(client_id) <> ''),
  audience text not null check (btrim(audience) <> '')
);

revoke all on table public.mcp_oauth_client_audiences from authenticated, anon, public;
grant usage on schema public to supabase_auth_admin;
grant select on table public.mcp_oauth_client_audiences to supabase_auth_admin;

insert into public.mcp_oauth_client_audiences (client_id, audience)
values ('<approved-oauth-client-id>', '<stable-mcp-audience>')
on conflict (client_id) do update set audience = excluded.audience;

create or replace function public.mcp_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims jsonb := coalesce(event->'claims', '{}'::jsonb);
  oauth_client_id text := nullif(btrim(claims->>'client_id'), '');
  mapped_audience text;
begin
  if oauth_client_id is not null then
    select mapping.audience
      into mapped_audience
      from public.mcp_oauth_client_audiences as mapping
      where mapping.client_id = oauth_client_id;
  end if;

  if mapped_audience is not null then
    claims := jsonb_set(
      claims,
      '{aud}',
      to_jsonb(mapped_audience),
      true
    );
  end if;

  return jsonb_build_object('claims', claims);
end;
$$;

grant execute on function public.mcp_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.mcp_access_token_hook(jsonb) from authenticated, anon, public;
```

| Token source | Mapping | Resulting `aud` |
| --- | --- | --- |
| Approved OAuth client | Exact client row | Mapped stable MCP audience |
| Unrelated or unknown OAuth client | No row | Original Supabase audience |
| Browser session | No `client_id` | Original Supabase audience |

Select this function under Supabase Auth Hooks before completing the interactive verification below.

## Validate

```bash
noodle validate examples/customer-auth/src/server.ts --json
noodle auth doctor examples/customer-auth/src/server.ts --json
noodle test examples/customer-auth/src/server.ts --json
```

The doctor proves metadata and JWKS readiness without registering a client. For this protected app,
`noodle test` proves the anonymous 401 plus exact protected-resource metadata boundary and reports
`interactiveRequired: true`; neither command proves token issuance or audience verification.

Against a deployed customer-protected environment, set a short-lived real customer token only in
`NOODLE_CUSTOMER_TOKEN` and add `--live --org <org> --app <app> --env <env>`. The live doctor performs
credential exchanges without invoking any business tool. Add `--version 1` when testing a pinned version;
the reported customer resource must match that versioned MCP endpoint.

## Run locally

```bash
noodle devtools examples/customer-auth/src/server.ts
```

Complete sign-in in Devtools and load the tool list. That authenticated request is the local proof that DCR,
PKCE, token issuance, issuer/signature verification, the stable audience, and exact-resource binding work
together. Invoke a representative safe read when the configured customer API is available.

### Test delegated exchange locally

Local customer OIDC sign-in and delegated-exchange assertion trust are two distinct boundaries. OIDC proves
the caller to the local MCP server; Devtools uses a separate local issuer only for the RFC 8693 assertion
sent to the downstream token endpoint. This is the canonical local path and requires no `server.ts` change,
flag, environment variable, or config surface.

1. Configure the OIDC authorization server for the exact loopback callback and RFC 8707 resource. Do not add
   the Devtools assertion key to OIDC issuer metadata or change its signing keys.
2. Start Devtools, complete customer sign-in, and copy the displayed `{ issuer, jwks }` from **Local delegated exchange**.
3. Pin both values only in the customer-owned development RFC 8693 token endpoint.
4. Restrict that trust to development client credentials, audience, API, and data.
5. Invoke the delegated `list_org_apps` tool until its binding reads **Exchange verified**.
6. Use hosted preview or `noodle auth doctor --live` to prove the production platform issuer.

**Never trust the Devtools issuer in production: anyone holding the local private key could impersonate a customer.**

## Configuration

The embedded assistant uses a customer-supplied Responses-compatible endpoint, selected explicitly with
`transport: 'responses'` in `src/server.ts`. Use `transport: 'chat-completions'` or omit the field for a
Chat Completions endpoint. Noodle never falls back between them. Configure its managed values at the Noodle
deployment environment; none of these values belongs in the customer web application environment, and the
API key never reaches the browser:

The assistant session carries a verified user, tenant, deployment, roles, and scopes. For this flagship's
routed tools, the embedding backend resolves the signed-in user's cluster from server-owned membership data
and passes `routing: { endpoints: { customer_api: cluster.apiBaseUrl } }` to
`createAssistantSession`. Noodle validates and privately stores that route; it is not returned to the
browser. Do not copy the route into page context, session claims, tool input, or model instructions.

The authenticated assistant surface also declares `accountTier` as a model-visible session claim. Pass it
from the same backend-owned account record as `claims: { accountTier: account.tier }`; undeclared claims are
dropped. This is personalization context, not authorization: the verified roles/scopes beside each tool and
the server-owned customer route remain the enforcement boundaries. The public
[runtime guide](https://docs.noodleseed.dev/docs/guides/product-agent-guides#use-the-guide-at-runtime)
explains how verified session claims constrain the guide content available to the model.

```bash
noodle variables set ASSISTANT_ORIGIN https://app.example.com --scope env
noodle variables set ASSISTANT_MODEL_BASE_URL https://model.example.com/v1 --scope env
noodle variables set ASSISTANT_MODEL your-model --scope env
noodle secrets set ASSISTANT_MODEL_API_KEY --scope env
noodle variables set CUSTOMER_API_CLIENT_ID your-broker-client-id --scope env
noodle secrets set CUSTOMER_API_CLIENT_SECRET --scope env
noodle check --target embedded-assistant src/server.ts
```

`ASSISTANT_ORIGIN` is the operator-owned production embedding origin, so one source can serve every customer
without an application fork. Assistant origins are exact. Production embedding origins must use HTTPS; plain HTTP is accepted only for
loopback development origins such as `http://localhost:3000`, `http://127.0.0.1:3000`, or
`http://[::1]:3000`. `noodle dev` serves the MCP project, not that separate embedding application.

The bounded `presentation` object configures the panel, launcher, header, composer, and messages. Its
primitives derive colors from shared server `branding`; raw HTML, CSS, inline SVG, renderer classes, and
callbacks are not accepted. This example omits `presentation.panel.surface`, so the renderer keeps the
opaque default panel treatment while the example's light/dark `branding` surfaces provide its customer colors;
set the bounded surface to `glass` only when translucency is intentional.

These TypeScript values remain the reusable developer defaults. After deployment, an environment operator
can adjust theme, logo, launcher style, position, and the bounded color palette from the Console's
**Assistant** tab or `noodle assistant appearance` without changing the customer's embed code. See the
[embedded assistant guide](https://docs.noodleseed.dev/docs/guides/embedded-assistant) for precedence and reset
behavior.

Create the backend credential after deployment. The CLI writes it to a mode-0600 file and never prints the
secret:

```bash
noodle assistant clients create --name web --org noodleseed --app customer-auth --env prod
```

Only the Noodle service URL, assistant client ID, and assistant client secret belong in the authenticated
customer backend. The model URL, model name, and model API key remain managed by the Noodle deployment.

The customer's authenticated backend calls `createAssistantSession(...)` from
`@noodleseed/assistant/server`, passing the already-verified user and browser origin. The browser then uses
the returned short-lived session through the managed Web Component/React renderer or a customer-owned UI:

```bash
pnpm add @noodleseed/assistant
```

```tsx
import { NoodleAssistant } from '@noodleseed/assistant/react';

<NoodleAssistant
  sessionEndpoint="/api/noodle-assistant/session"
  theme={resolvedTheme}
  onSessionExpired={() => console.info('Assistant session renewed')}
/>;
```

`resolvedTheme` is the application's current `'light' | 'dark'` value. Use `theme="auto"` only when the
browser operating-system preference is intentionally authoritative.

### Minimal fail-closed custom renderer skeleton

Use the renderer-free hook only when the product has a concrete reason to own the conversation UI. This
minimal skeleton keeps the canonical client and App host, but intentionally refuses confirmation and input
acceptance until the application implements their complete schema-aware presentation. Start with the managed
renderer unless the application accepts every obligation below.

```tsx
'use client';

import { useEffect, useState } from 'react';
import { NoodleAppView } from '@noodleseed/assistant/react';
import { useNoodleAssistant } from '@noodleseed/assistant/react/client';

export function CustomerAssistant({
  principalKey,
  resolvedTheme,
  onSignInRequested,
}: {
  principalKey: string;
  resolvedTheme: 'light' | 'dark';
  onSignInRequested: (request: {
    signInTicket: string;
    expiresAt: string;
  }) => Promise<'started' | 'cancelled'>;
}) {
  const [draft, setDraft] = useState('');
  const [sessionNotice, setSessionNotice] = useState('');
  const [turnNotice, setTurnNotice] = useState('');
  const [pendingSignInTicket, setPendingSignInTicket] = useState<string>();
  const { client, messages, suggestions, status, error } = useNoodleAssistant({
    sessionEndpoint: '/api/noodle-assistant/session',
    principalKey,
  });
  const busy = status === 'submitted' || status === 'streaming';
  const settle = (operation: Promise<void>) => {
    void operation.catch(() => {
      // The hook exposes this same structured failure through `error`.
    });
  };
  useEffect(
    () =>
      client.subscribe((event) => {
        if (event.event === 'session_expired') setSessionNotice('Session expired.');
        if (event.event === 'session_started' || event.event === 'session_reset') {
          setSessionNotice('');
        }
      }),
    [client],
  );

  return (
    <section aria-label="Assistant" aria-busy={busy}>
      {messages.map((message) => (
        <article key={message.id} data-role={message.role}>
          {message.parts.map((part, index) => {
            if (part.type === 'text') return <p key={index}>{part.text}</p>;
            if (part.type === 'data-confirmation') {
              const review = part.data;
              return (
                <section key={review.id} aria-label="Review proposed action">
                  <h3>{review.title ?? 'Review proposed action'}</h3>
                  {review.description ? <p>{review.description}</p> : null}
                  <p>This custom renderer has not implemented a complete schema-aware review.</p>
                  <button
                    disabled={busy || review.status !== 'pending'}
                    onClick={() => settle(client.respond(review.id, { action: 'decline' }))}
                  >
                    Don't proceed
                  </button>
                  <button
                    disabled={busy || review.status !== 'pending'}
                    onClick={() => settle(client.respond(review.id, { action: 'cancel' }))}
                  >
                    Cancel
                  </button>
                </section>
              );
            }
            if (part.type === 'data-input-request') {
              const request = part.data;
              return (
                <section key={request.id} aria-label="Assistant needs input">
                  <p>{request.message}</p>
                  {/* request.requestedSchema is the sole input-form contract. */}
                  <p>This custom renderer has not implemented the requested schema form.</p>
                  <button
                    disabled={busy || request.status !== 'pending'}
                    onClick={() => settle(client.respond(request.id, { action: 'decline' }))}
                  >
                    Don't proceed
                  </button>
                  <button
                    disabled={busy || request.status !== 'pending'}
                    onClick={() => settle(client.respond(request.id, { action: 'cancel' }))}
                  >
                    Cancel
                  </button>
                </section>
              );
            }
            if (part.type === 'data-tool-result') {
              return (
                <p key={part.data.id} role="status">
                  A result is available, but this renderer has no trusted presentation for it.
                </p>
              );
            }
            if (part.type === 'data-view') {
              return (
                <NoodleAppView
                  key={`${part.data.id}:${part.data.resourceUri}`}
                  client={client}
                  view={part.data}
                  theme={resolvedTheme}
                />
              );
            }
            if (part.type === 'data-sign-in') {
              const request = part.data;
              return (
                <section key={request.id} aria-label="Sign in required">
                  <p>Continue with your account to use this capability.</p>
                  <button
                    disabled={busy || pendingSignInTicket !== undefined}
                    onClick={() => {
                      setPendingSignInTicket(request.signInTicket);
                      void Promise.resolve()
                        .then(() =>
                          onSignInRequested({
                            signInTicket: request.signInTicket,
                            expiresAt: request.expiresAt,
                          }),
                        )
                        .then(
                          (result) => {
                            if (result === 'cancelled') setPendingSignInTicket(undefined);
                          },
                          () => setPendingSignInTicket(undefined),
                        );
                    }}
                  >
                    Sign in
                  </button>
                </section>
              );
            }
            return <p key={index}>Unsupported assistant content.</p>;
          })}
        </article>
      ))}
      <p role="status" aria-live="polite">
        {sessionNotice || turnNotice || (busy ? 'Assistant is working' : '')}
      </p>
      {suggestions?.prompts.length ? (
        <nav aria-label="Suggested messages">
          {suggestions.prompts.map((prompt) => (
            <button
              key={prompt}
              type="button"
              disabled={busy}
              onClick={() => {
                setTurnNotice('');
                settle(client.sendMessage(prompt));
              }}
            >
              {prompt}
            </button>
          ))}
        </nav>
      ) : null}
      {error ? <p role="alert">The assistant could not complete that request.</p> : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const message = draft.trim();
          if (!message) return;
          setDraft('');
          setTurnNotice('');
          settle(client.sendMessage(message));
        }}
      >
        <input
          aria-label="Message"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
        {busy ? (
          <button
            type="button"
            onClick={() => {
              client.abort();
              setTurnNotice('Response stopped. This does not undo a started action.');
            }}
          >
            Stop
          </button>
        ) : (
          <button type="submit">Send</button>
        )}
      </form>
    </section>
  );
}
```

`principalKey` stays in the browser. Change it whenever the authenticated user or tenant changes; the hook
then aborts and clears the prior session and transcript. The sample does not render Confirm until the host
implements a complete schema-aware review, and it does not accept elicitation until a portable form covers
`requestedSchema`; use the managed renderer instead of shipping either unsupported branch. Suggestions are
hook-owned and submit ordinary messages through `client.sendMessage`.

`data-sign-in` has no status and is never passed to `client.respond`. Bind `signInTicket` to the host's
short-lived login transaction without putting it in URLs, logs, analytics, or durable browser storage. Resolve
the callback as `started` only after the host owns one active transaction; return `cancelled` or reject when no
transaction started so the renderer restores the sign-in affordance. A
mixed renderer uses separate public and authenticated clients: the public shell uses `embedId`, `serviceUrl`,
and a visitor principal key; after login, the destination mounts a new client against the same-origin session
endpoint under the user/tenant principal key. Never pass both source options or mutate the public client's
source in place. `session_expired` is observational: the client owns its single safe pre-execution re-exchange.
Never add a generic Retry button or replay an interaction decision automatically.

For `data-tool-result`, do not expose technical tool names or raw JSON. Prefer the linked `data-view`;
otherwise map a known bounded result to application-trusted UI or keep the explicit unsupported state. For
`data-view`, use `<noodle-app-view>` or its React `NoodleAppView` adapter. The element's semantic lifecycle
identity is the client plus `view.id` plus `view.resourceUri`, so payload/callback rerenders keep the iframe
and only a different view, disconnect, or App teardown request retires the bridge.
App views remain inline by default: the host advertises only inline presentation and rejects a widget's
fullscreen request. A customer-owned renderer may opt in explicitly with `allowFullscreen` on
`NoodleAppView` or `allow-fullscreen` on `<noodle-app-view>` only when fullscreen is part of its intended
experience. When fullscreen is accepted, the shared host adds a top-right exit control that returns the same
mounted App to inline mode without discarding its state.
Never inject `part.data.html`, assign it to `srcdoc`, fetch a `ui://` URI, or reproduce the bridge directly. Pages with a
Content-Security-Policy must include the Noodle service origin in both `connect-src` and `frame-src`.

Before the production-equivalent host build, run the presence-only handoff check:

```sh
noodle assistant embed --check --json
```

Add application-owned delegated-exchange requirements with repeatable `--require-env NAME` flags. The JSON
reports required and missing names, CSP status, and post-deploy probes without returning environment values
or writing scaffold files. Map the names through the production secret manager, CI environment, and any
secret allowlist; regenerate existing framework-owned environment binding types before the build. Default
Devtools/model exercises to synthetic data, and obtain approval before sending real connector data to an
external model.

Read `evidence.levels` in order: static host, local contract, hosted session, production browser, then
operations. Stop at `evidence.firstUnproven`. A static result may be `passed`, `partial`, or `failed`; even
top-level `ready: true` means only that no static blocker was detected. It never proves the local session
contract or a production-browser flow. Value-free diagnostics call out an MCP endpoint used as the service
URL, an HTML redirect risk, an SSR mount risk, and a cross-origin session endpoint. The command has no live
or browser flag; its `postDeployProbes` are next actions, not executed evidence.

After deployment, use the assistant doctor to verify the embed client, exact model transport, and static
session boundary:

```sh
noodle assistant doctor --user-id <real-test-user> --origin "$PUBLIC_APP_ORIGIN" --org <org> --app <app> --env <env>
```

The doctor makes one bounded synthetic model request without business tools or customer conversation data;
failures show only a redacted category, status, and retryability. It does not invent or test an
application-specific customer route. Prove routed assistant tools by
having the authenticated embedding backend pass the user's server-verified endpoint during session
exchange, then invoke one representative safe read.

Do not send a first turn on mount by default. React effect cleanup can suppress one provisional Strict Mode
effect, but it cannot make a remount, dependency change, or client replacement idempotent. Require an
explicit user action unless the host owns durable one-shot state and an application idempotency key that
makes repeated sends safe.

For a chat-first custom host, raw `tool_started` supplies the direct call `id` and technical tool name. Map
known tools to concise application copy and use a neutral fallback. Reserve a stable `role="status"` region
for thinking, tool activity, and the view skeleton; switch to the ready `<noodle-app-view>` (or React
`NoodleAppView`) on `view_available` or to `role="alert"` on error. Decorative skeleton shapes stay hidden from assistive technology, and shimmer
or transition motion is disabled under `prefers-reduced-motion`.

Use `${view.id}:${view.resourceUri}` as transport identity. Different call IDs are distinct invocations and
must not be deduplicated generically. If this application intentionally owns one current panel for a known
resource, declare an application-owned slot for that resource and replace only that slot.

### Framework-neutral DOM client

Subscribe to the DOM-free client directly without a component wrapper and use the isolated App host.
It exposes the same conversation as headless AI SDK `UIMessage` state, including typed confirmation, input,
tool-result, and linked-view parts:

```html
<div id="assistant-app-views"></div>
```

```ts
import '@noodleseed/assistant/app-view';
import {
  type AssistantViewAvailableDetail,
  type NoodleAppViewElement,
} from '@noodleseed/assistant/app-view';
import { createAssistantClient } from '@noodleseed/assistant/client';

const assistant = createAssistantClient({
  sessionEndpoint: '/api/noodle-assistant/session',
});
const appViews = document.querySelector('#assistant-app-views');
if (!appViews) throw new Error('Missing App views host');
const mountedViews = new Map<string, NoodleAppViewElement>();
const readResolvedTheme = (): 'light' | 'dark' =>
  document.documentElement.classList.contains('dark') ? 'dark' : 'light';
let resolvedTheme: 'light' | 'dark' = readResolvedTheme();
const syncResolvedTheme = () => {
  resolvedTheme = readResolvedTheme();
  for (const mountedView of mountedViews.values()) mountedView.theme = resolvedTheme;
};
new MutationObserver(syncResolvedTheme).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['class'],
});
const appViewFor = (view: AssistantViewAvailableDetail) => {
  const key = `${view.id}:${view.resourceUri}`;
  let appView = mountedViews.get(key);
  if (!appView) {
    appView = document.createElement('noodle-app-view') as NoodleAppViewElement;
    appView.client = assistant;
    mountedViews.set(key, appView);
    appViews.append(appView);
  }
  appView.theme = resolvedTheme;
  return appView;
};

assistant.subscribeChat((state) => {
  renderUIMessageState(state, {
    respond: (id, response) => assistant.respond(id, response),
  });
  const activeViewKeys = new Set<string>();
  for (const message of state.messages) {
    for (const part of message.parts) {
      if (part.type === 'data-view') {
        const key = `${part.data.id}:${part.data.resourceUri}`;
        activeViewKeys.add(key);
        appViewFor(part.data).view = part.data;
      }
    }
  }
  for (const [key, mountedView] of mountedViews) {
    if (!activeViewKeys.has(key)) {
      mountedView.remove();
      mountedViews.delete(key);
    }
  }
});
```

`renderUIMessageState` is application code. It must present a complete schema-aware confirmation or input
form and require an explicit user gesture before using `respond`; never call `respond` while scanning a
transcript snapshot.

`theme="auto"` follows the operating-system preference, not a SaaS-owned toggle. Pass the resolved
`light`/`dark` theme to `NoodleAssistant` and `<noodle-app-view>`/`NoodleAppView`; updates reach mounted MCP Apps without a
remount. CSS custom properties inherit through the host, and documented `--ns-assistant-*` variables remain
the final integration escape hatch. Server `branding` is shared by widgets and the assistant; there is no
second branding declaration. Text streams progressively. Expired turns re-exchange and retry once;
confirmations never replay automatically.

The customer IdP must place the full tenant API base URL in `tenant.api_base_url`. For example, one verified
customer may receive `https://customer-a.api.noodleseed.dev/v1` and another
`https://customer-b.api.noodleseed.dev/v1`; both satisfy the declared suffix policy. Application code,
deployment variables, and connector arguments do not select the tenant route.

`CUSTOMER_API_CLIENT_ID` and `CUSTOMER_API_CLIENT_SECRET` authenticate only the broker to the fixed exchange
endpoint. They are not customer API bearer tokens. The exchange endpoint verifies the platform-signed
subject assertion and mints a short-lived token scoped to the signed-in user and route binding.

## Launch and qualified-usage proof

Use the [embedded assistant guide](https://docs.noodleseed.dev/docs/guides/embedded-assistant) for the complete
pre-launch, browser-proof, qualified-usage, recovery, measurement, and operator procedure; do not copy those
commands into this example. Keep deployed capability, production-browser proof, qualified usage, and measured
outcome separate; raw turn volume is utilization rather than outcome. Platform-owned completion events still
require a separate human-approved analytics and customer-data contract.

## Deploy customer-protected to Noodle Seed Cloud

```bash
noodle deploy examples/customer-auth/src/server.ts \
  --org noodleseed \
  --app customer-auth \
  --env prod \
  --access customers
```

Endpoint:

```text
https://cloud.noodleseed.dev/o/noodleseed/customer-auth/mcp
```

## MCP Primitives

- Tool `list_my_organizations`: calls `GET /api/organizations` and returns the organizations the signed-in
  customer is a member of. Takes no arguments; the org set is scoped by the verified customer session.
- Tool `list_org_apps`: calls `GET /api/organizations/{org_id}/apps` for one organization `org_id`.
- Tool `archive_org_app`: after confirmation, calls
  `POST /api/organizations/{org_id}/apps/{app_id}/archive`.

## Auth boundary

Noodle Seed verifies the configured OIDC issuer and stable audience, then binds the exact transport-derived
MCP resource before reading identity or routing claims. Public caller identity contains the user/role/scope
projection; the customer route remains private request state.

Connector-backed tools ask the broker for a route-bound delegated credential; only the endpoint key and
fingerprint enter broker cache/single-flight state or the assertion. The route claim and inbound MCP bearer
token never reach tools, connectors, widgets, model output, or downstream systems. Confirmed actions keep
the same URL-blind binding only in private continuation state and reject acceptance-time drift.
