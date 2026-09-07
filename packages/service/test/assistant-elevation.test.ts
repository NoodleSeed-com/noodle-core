import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  InMemoryAssistantElevationStore,
  InMemoryAssistantStore,
  InMemoryPublicEmbedStore,
} from '@noodle-borg/assistant-gateway';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServiceHandler, InMemoryAuditStore, ServerRegistry } from '../src/index.js';
import { interceptForElevation } from '../src/routes/assistant-elevation.js';

/**
 * Mid-conversation sign-in over the wire (ADR 0201, 5.6b).
 *
 * The gateway proves the decision; this proves the route, which is where the two halves of the dual key
 * meet. The sign-in ticket crosses the browser, so every test here is really one question: what does
 * possession of it, alone, get you? The answer has to be nothing.
 */

const MIXED_MANIFEST = `
manifestVersion: "1"
server:
  name: elevation
  version: 1.0.0
  title: Elevation
  assistant:
    model:
      kind: openai-compatible
      baseUrl: \${env.ASSISTANT_MODEL_BASE_URL}
      model: \${env.ASSISTANT_MODEL}
      apiKey: ASSISTANT_MODEL_API_KEY
    surfaces:
      - mode: mixed
        origins: [https://www.acme.test, https://app.acme.test]
        capabilities:
          - { kind: tool, name: talk_to_sales }
          - { kind: tool, name: my_orders }
          - { kind: tool, name: premium_report }
          - { kind: tool, name: update_nickname }
    allowedOrigins: [https://www.acme.test, https://app.acme.test]
tools:
  - name: talk_to_sales
    description: Show the visitor how to contact sales.
    annotations:
      readOnlyHint: true
    inputSchema: { type: object, properties: {} }
    fulfilment:
      steps: []
      output:
        value:
          email: sales@acme.test
  - name: my_orders
    description: Read the signed-in visitor's recent orders.
    annotations:
      readOnlyHint: true
    inputSchema: { type: object, properties: {} }
    fulfilment:
      steps: []
      output:
        value:
          orders: \${user.id}
  - name: update_nickname
    description: Update the signed-in visitor's nickname.
    annotations:
      readOnlyHint: false
      destructiveHint: false
      openWorldHint: false
      confirm: true
    inputSchema: { type: object, properties: {} }
    fulfilment:
      steps: []
      output:
        value:
          nickname: \${user.id}
  - name: premium_report
    description: Read the quarterly report (analysts only).
    authorization:
      allowedRoles: [analyst]
    annotations:
      readOnlyHint: true
    inputSchema: { type: object, properties: {} }
    fulfilment:
      steps: []
      output:
        value:
          report: q3
widgets:
  - name: sales_card
    tool: talk_to_sales
    title: Talk to sales
    html: '<!doctype html><main data-bind="email"></main>'
  - name: orders_card
    tool: my_orders
    title: Recent orders
    html: '<!doctype html><main data-bind="orders"></main>'
`;

// The cross-site landing shape (ADR 0201 amendment 2026-08-26): the mixed marketing surface owns
// www, the authenticated app surface owns app — with its own allowlist and instructions. An
// elevation whose login redirect lands on the app origin must continue under the app surface's
// projection, not the marketing one's.
const TWO_SURFACE_ELEVATION_MANIFEST = MIXED_MANIFEST.replace(
  `    surfaces:
      - mode: mixed
        origins: [https://www.acme.test, https://app.acme.test]
        capabilities:
          - { kind: tool, name: talk_to_sales }
          - { kind: tool, name: my_orders }
          - { kind: tool, name: premium_report }
          - { kind: tool, name: update_nickname }`,
  `    surfaces:
      - mode: mixed
        origins: [https://www.acme.test]
        capabilities:
          - { kind: tool, name: talk_to_sales }
          - { kind: tool, name: my_orders }
          - { kind: tool, name: premium_report }
          - { kind: tool, name: update_nickname }
      - mode: authenticated
        origins: [https://app.acme.test]
        instructions: Help the signed-in visitor with their account.
        capabilities:
          - { kind: tool, name: my_orders }`,
);

// A tool whose ONLY identity dependence is its connector's delegated auth: no ${user} reference,
// no authorization block. This is the classification hole the Tivmark report named in §5.
const DELEGATED_MANIFEST = `
manifestVersion: "1"
server:
  name: elevation
  version: 1.0.0
  title: Elevation
  assistant:
    model:
      kind: openai-compatible
      baseUrl: \${env.ASSISTANT_MODEL_BASE_URL}
      model: \${env.ASSISTANT_MODEL}
      apiKey: ASSISTANT_MODEL_API_KEY
    surfaces:
      - mode: mixed
        origins: [https://www.acme.test]
        capabilities:
          - { kind: tool, name: team_time_off }
    allowedOrigins: [https://www.acme.test]
connectors:
  acmehr:
    id: acmehr_api
    version: 1.0.0
tools:
  - name: team_time_off
    description: Read the team's time-off calendar.
    annotations:
      readOnlyHint: true
    inputSchema: { type: object, properties: {}, additionalProperties: false }
    fulfilment:
      use: acmehr.list_time_off
      args: {}
`;

const DELEGATED_CONNECTORS = `
connectors:
  - id: acmehr_api
    version: 1.0.0
    http:
      baseUrl: https://app.acmehr.example/api/v1
      allowedOrigins: [https://app.acmehr.example]
      auth:
        kind: delegatedTokenExchange
        tokenUrl: https://app.acmehr.example/oauth/token
        clientId: deleg-client-id
        clientSecret: ACMEHR_DELEG_CLIENT_SECRET
    operations:
      list_time_off:
        type: read
        method: GET
        path: /time-off
        output: { type: object, properties: { days: { type: number } }, additionalProperties: false }
`;

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function start(
  options: {
    readonly org?: string;
    readonly elevations?: InMemoryAssistantElevationStore | undefined;
    readonly withoutElevations?: true;
    /** The tool the mocked model asks for on its first step. */
    readonly modelCalls?: string;
    /** Deploy the delegated-connector manifest instead of the \${user}/authorization one. */
    readonly delegated?: true;
    /** Deploy the two-surface manifest: mixed on www, authenticated on app. */
    readonly twoSurfaces?: true;
  } = {},
) {
  const modelCalls = options.modelCalls ?? 'my_orders';
  const registry = new ServerRegistry();
  const org = options.org ?? 'acme';
  const tenant = { org, app: 'site', env: 'prod' };
  const scope = { level: 'env' as const, ...tenant };
  for (const [name, value] of [
    ['ASSISTANT_MODEL_BASE_URL', 'https://model.test'],
    ['ASSISTANT_MODEL', 'acme-model'],
  ]) {
    await registry.configStore.setConfigValue({ kind: 'variable', scope, name, value });
  }
  for (const name of ['ASSISTANT_MODEL_API_KEY', 'ACMEHR_DELEG_CLIENT_SECRET']) {
    await registry.configStore.setConfigValue({ kind: 'secret', scope, name, value: 'set' });
  }
  const deployed = await registry.deploy(
    tenant,
    options.delegated
      ? DELEGATED_MANIFEST
      : options.twoSurfaces
        ? TWO_SURFACE_ELEVATION_MANIFEST
        : MIXED_MANIFEST,
    { accessMode: 'public', ...(options.delegated ? { connectors: DELEGATED_CONNECTORS } : {}) },
  );
  expect(deployed.ok, JSON.stringify((deployed as { errors?: unknown }).errors)).toBe(true);

  // The model asks for the tool when spoken to and answers in prose once it has a tool result —
  // otherwise the agent loop would request a new elevation every step, superseding the ticket the
  // test just captured. A fresh Response per call: a Response body is single-use.
  const modelFetch = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const request = JSON.parse(String((init as RequestInit).body)) as {
      readonly messages: ReadonlyArray<{ readonly role: string }>;
    };
    const message =
      request.messages.at(-1)?.role === 'user'
        ? {
            role: 'assistant',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: modelCalls, arguments: '{}' } },
            ],
          }
        : { role: 'assistant', content: 'Done.' };
    return new Response(JSON.stringify({ choices: [{ message }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const assistantStore = new InMemoryAssistantStore();
  const publicEmbeds = new InMemoryPublicEmbedStore();
  // Production runs one store for every tenant, so a cross-tenant test that gives each its own store
  // proves nothing: it would refuse for never having seen the value rather than for the tenant check.
  const elevations = options.withoutElevations
    ? undefined
    : (options.elevations ?? new InMemoryAssistantElevationStore());
  const audit = new InMemoryAuditStore();
  const admissionControl = { refuseTurns: false };
  const counters = {
    durable: true,
    consume: async ({ key, limit }: { readonly key: string; readonly limit: number }) =>
      admissionControl.refuseTurns && key.startsWith('turns:')
        ? { allowed: false, used: limit, limit }
        : { allowed: true, used: 1, limit },
    peek: async () => 0,
  };
  const server = createServer(
    createServiceHandler(registry, {
      assistantStore,
      publicEmbeds,
      ...(elevations ? { elevations } : {}),
      admissionCounters: counters,
      assistantModelFetch: modelFetch,
      audit,
    } as never),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const embed = await publicEmbeds.ensure({
    ...tenant,
    surfaceMode: 'mixed',
    now: new Date(),
  });
  return {
    base: `http://127.0.0.1:${port}`,
    registry,
    assistantStore,
    audit,
    embed,
    tenant,
    org,
    elevations,
    modelFetch,
    admissionControl,
  };
}

async function resumeTurn(base: string, token: string, origin = 'https://www.acme.test') {
  const response = await fetch(`${base}/v1/assistant/turns`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      origin,
    },
    body: JSON.stringify({ resume: true }),
  });
  return { status: response.status, body: await response.text() };
}

async function mintAnonymous(base: string, embedId: string) {
  const response = await fetch(`${base}/v1/assistant/public-sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://www.acme.test' },
    body: JSON.stringify({ embedId }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { readonly token: string };
}

async function askForOrders(base: string, token: string) {
  const response = await fetch(`${base}/v1/assistant/turns`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      origin: 'https://www.acme.test',
    },
    body: JSON.stringify({ message: 'show me my orders' }),
  });
  const body = await response.text();
  const event = /event: auth_requested\ndata: (.+)/.exec(body);
  return {
    body,
    data: event?.[1]
      ? (JSON.parse(event[1]) as { readonly signInTicket: string; readonly continuation: string })
      : undefined,
  };
}

async function createClient(base: string, org = 'acme') {
  const response = await fetch(`${base}/v1/orgs/${org}/apps/site/envs/prod/assistant/clients`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'backend' }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { readonly id: string; readonly clientSecret: string };
}

const basic = (client: { readonly id: string; readonly clientSecret: string }) =>
  `Basic ${Buffer.from(`${client.id}:${client.clientSecret}`).toString('base64')}`;

async function elevate(
  base: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
) {
  return fetch(`${base}/v1/assistant/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ origin: 'https://www.acme.test', ...body }),
  });
}

describe('assistant elevation over the wire', () => {
  it('renders a public-safe widget for an anonymous mixed-mode visitor', async () => {
    const { base, embed } = await start({ modelCalls: 'talk_to_sales' });
    const { token } = await mintAnonymous(base, embed.embedId);

    const { body } = await askForOrders(base, token);

    expect(body).toContain('event: view_available');
    expect(body).toContain('"resourceUri":"ui://elevation/sales_card"');
    expect(body).toContain('"html":');
    expect(body).not.toContain('auth_requested');
  });

  it('offers sign-in instead of executing an identity tool for an anonymous visitor', async () => {
    const { base, embed } = await start();
    const { token } = await mintAnonymous(base, embed.embedId);

    const { body, data } = await askForOrders(base, token);

    // The offer is made...
    expect(body).toContain('auth_requested');
    expect(data?.signInTicket).toMatch(/^elv_/);
    // Dual-emit: widgets published before the signInTicket rename guard on `data.continuation`.
    // Drop the legacy key at the next coordinated widget major (ADR 0151 / ADR 0201).
    expect(data?.continuation).toBe(data?.signInTicket);
    // ...and the tool that needs an identity never ran. `${user.id}` had nothing to resolve to, and a
    // tool that returns everyone's rows for an absent user is exactly what this must never reach.
    expect(body).not.toContain('tool_completed');
  });

  it('binds the same conversation to the signed-in visitor and kills the anonymous token', async () => {
    const { base, embed, audit, assistantStore } = await start();
    const anonymous = await mintAnonymous(base, embed.embedId);
    const { data } = await askForOrders(base, anonymous.token);
    const client = await createClient(base);

    const response = await elevate(
      base,
      { authorization: basic(client) },
      { signInTicket: data?.signInTicket, user: { id: 'user_42', email: 'v@acme.test' } },
    );

    expect(response.status).toBe(200);
    const elevated = (await response.json()) as { readonly token: string } & Record<
      string,
      unknown
    >;
    expect(elevated.token).not.toBe(anonymous.token);
    // The same wire shape as a fresh mint (ADR 0151): the widget cannot tell the two apart.
    // `configuration` is optional on both paths (absent here because this manifest authors none),
    // and `resume` rides only an elevation that armed the default-on post-sign-in resume.
    expect(
      Object.keys(elevated)
        .filter((key) => key !== 'configuration')
        .sort(),
    ).toEqual(['continuedAfterAuthentication', 'endpoints', 'expiresAt', 'resume', 'token']);

    // Issuer rebind (ADR 0152): the session's clientId becomes the elevating client's id, so a
    // post-elevation delegated exchange asserts the same customer_identity.issuer as a fresh
    // authenticated mint — and the same one `noodle assistant doctor` probes. Before this, it kept
    // the embed id and issuer-pinning customer token endpoints rejected elevated callers.
    const record = await assistantStore.getSession(elevated.token, new Date());
    expect(record?.clientId).toBe(client.id);
    expect(record?.publicEmbedId).toBe(embed.embedId);
    // Same-origin elevation is a no-op re-pin: the conversation stays where it started, on the
    // surface that admitted it.
    expect(record?.origin).toBe('https://www.acme.test');
    expect(record?.boundSurface).toBe('public');

    // The old token is dead the moment the new one exists.
    const stale = await fetch(`${base}/v1/assistant/turns`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${anonymous.token}`,
        origin: 'https://www.acme.test',
      },
      body: JSON.stringify({ message: 'still me?' }),
    });
    expect(stale.status).toBe(401);

    const events = await audit.list({ org: 'acme' });
    expect(events.some((event) => event.eventType === 'assistant.session.elevated')).toBe(true);
  });

  it('continues the conversation on the origin the elevating client designates', async () => {
    const { base, embed } = await start();
    const anonymous = await mintAnonymous(base, embed.embedId);
    const { data } = await askForOrders(base, anonymous.token);
    const client = await createClient(base);

    // The visitor signed in via a full-page redirect to the app origin; the backend designates it.
    const response = await elevate(
      base,
      { authorization: basic(client) },
      {
        origin: 'https://app.acme.test',
        signInTicket: data?.signInTicket,
        user: { id: 'user_42' },
      },
    );
    expect(response.status).toBe(200);
    const elevated = (await response.json()) as { readonly token: string };

    const turnFrom = (origin: string) =>
      fetch(`${base}/v1/assistant/turns`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${elevated.token}`,
          origin,
        },
        body: JSON.stringify({ message: 'and now?' }),
      });

    // The token works where the conversation now lives...
    expect((await turnFrom('https://app.acme.test')).status).toBe(200);
    // ...and nowhere else: the pin moved, it did not widen.
    expect((await turnFrom('https://www.acme.test')).status).toBe(403);
  });

  it('lands the elevated conversation on the surface that owns the login origin', async () => {
    const { base, embed, assistantStore, modelFetch } = await start({ twoSurfaces: true });
    const anonymous = await mintAnonymous(base, embed.embedId);
    const { data } = await askForOrders(base, anonymous.token);
    const client = await createClient(base);

    // The login redirect lands on the app origin, which the authenticated surface owns.
    const response = await elevate(
      base,
      { authorization: basic(client) },
      {
        origin: 'https://app.acme.test',
        signInTicket: data?.signInTicket,
        user: { id: 'user_42' },
      },
    );
    expect(response.status).toBe(200);
    const elevated = (await response.json()) as { readonly token: string };
    const record = await assistantStore.getSession(elevated.token, new Date());
    expect(record?.boundSurface).toBe('authenticated');

    // The auto-resume runs under the landing surface: my_orders is on its allowlist, so the
    // intercepted intent completes, and the turn's model call sees the app surface's projection
    // and instructions — not the marketing surface's.
    const resumed = await resumeTurn(base, elevated.token, 'https://app.acme.test');
    expect(resumed.status, resumed.body).toBe(200);
    expect(resumed.body).toContain('Done.');
    const [, init] = modelFetch.mock.calls.at(-1) ?? [];
    const request = JSON.parse(String((init as RequestInit).body)) as {
      readonly messages: readonly { readonly role: string; readonly content: string }[];
      readonly tools?: readonly { readonly function: { readonly name: string } }[];
    };
    expect(request.tools?.map((tool) => tool.function.name)).toEqual(['my_orders']);
    expect(
      request.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n'),
    ).toContain(
      'Surface instructions (authenticated website surface; same trust level as tenant instructions):\nHelp the signed-in visitor with their account.',
    );
  });

  it('fails the resume closed, honestly, when the landing surface does not offer the tool', async () => {
    const { base, embed, modelFetch } = await start({
      twoSurfaces: true,
      modelCalls: 'update_nickname',
    });
    const anonymous = await mintAnonymous(base, embed.embedId);
    // update_nickname reads ${user}, so the anonymous ask raises the sign-in card...
    const asked = await fetch(`${base}/v1/assistant/turns`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${anonymous.token}`,
        origin: 'https://www.acme.test',
      },
      body: JSON.stringify({ message: 'change my nickname to buddy' }),
    });
    const askedBody = await asked.text();
    const ticket = /"signInTicket":"([^"]+)"/.exec(askedBody)?.[1];
    expect(ticket).toBeTruthy();
    const client = await createClient(base);

    // ...but the login lands on the app surface, whose allowlist does not carry update_nickname.
    const response = await elevate(
      base,
      { authorization: basic(client) },
      { origin: 'https://app.acme.test', signInTicket: ticket, user: { id: 'user_42' } },
    );
    expect(response.status).toBe(200);
    const elevated = (await response.json()) as { readonly token: string };

    const resumed = await resumeTurn(base, elevated.token, 'https://app.acme.test');
    expect(resumed.status, resumed.body).toBe(200);
    // The model is told plainly rather than being asked to call a tool it cannot see. Found by
    // content rather than position: a model that reaches for the absent tool anyway earns one
    // recovery step, so the platform message is not necessarily in the last request.
    const platform = modelFetch.mock.calls
      .flatMap(([, init]) => {
        const request = JSON.parse(String((init as RequestInit).body)) as {
          readonly messages: readonly { readonly role: string; readonly content: string }[];
        };
        return request.messages;
      })
      .find((message) => message.content?.includes('does not offer it'));
    expect(platform?.role).toBe('user');
    expect(platform?.content).not.toContain('Call "update_nickname" now');
  });

  it('refuses an unlisted origin before the ticket is spent', async () => {
    const { base, embed } = await start();
    const anonymous = await mintAnonymous(base, embed.embedId);
    const { data } = await askForOrders(base, anonymous.token);
    const client = await createClient(base);

    const refused = await elevate(
      base,
      { authorization: basic(client) },
      { origin: 'https://evil.test', signInTicket: data?.signInTicket, user: { id: 'user_42' } },
    );
    expect(refused.status).toBe(403);

    // The allowlist check runs before the claim, so the refused exchange must not burn the ticket.
    const retry = await elevate(
      base,
      { authorization: basic(client) },
      { signInTicket: data?.signInTicket, user: { id: 'user_42' } },
    );
    expect(retry.status).toBe(200);
  });

  it('refuses a sign-in ticket presented without client credentials', async () => {
    const { base, embed } = await start();
    const { token } = await mintAnonymous(base, embed.embedId);
    const { data } = await askForOrders(base, token);

    // The whole point of the dual key: the browser holds this value, so holding it must not be enough.
    const response = await elevate(
      base,
      {},
      { signInTicket: data?.signInTicket, user: { id: 'user_42' } },
    );
    expect(response.status).toBe(401);
  });

  it('refuses a client spending a sign-in ticket for a conversation it does not own', async () => {
    const first = await start();
    // Same elevation store, as production has: only the tenant check stands between them.
    const second = await start({ org: 'rival', elevations: first.elevations });
    const { token } = await mintAnonymous(first.base, first.embed.embedId);
    const { data } = await askForOrders(first.base, token);
    // A real client with real credentials, reaching for another tenant's conversation.
    const otherClient = await createClient(second.base, 'rival');

    const response = await elevate(
      second.base,
      { authorization: basic(otherClient) },
      { signInTicket: data?.signInTicket, user: { id: 'attacker' } },
    );

    expect(response.status).toBe(403);
    // `{ error: <human message>, code: <machine code> }` — the published client parses `body.code`
    // (same envelope as public-session refusals); collapsing the two fields broke that contract once.
    const refusal = (await response.json()) as { readonly error: string; readonly code: string };
    expect(refusal.code).toBe('elevation_tenant_mismatch');
    expect(refusal.error).toMatch(/ /);
  });

  it('refuses a replayed sign-in ticket', async () => {
    const { base, embed } = await start();
    const { token } = await mintAnonymous(base, embed.embedId);
    const { data } = await askForOrders(base, token);
    const client = await createClient(base);

    const first = await elevate(
      base,
      { authorization: basic(client) },
      { signInTicket: data?.signInTicket, user: { id: 'user_42' } },
    );
    expect(first.status).toBe(200);

    const replay = await elevate(
      base,
      { authorization: basic(client) },
      { signInTicket: data?.signInTicket, user: { id: 'user_42' } },
    );
    expect(replay.status).toBe(403);
    const refusal = (await replay.json()) as { readonly error: string; readonly code: string };
    expect(refusal.code).toBe('elevation_ticket_invalid');
    expect(refusal.error).toMatch(/ /);
  });

  it('advertises authorization-gated tools to anonymous visitors on a mixed surface', async () => {
    const { base, embed, modelFetch } = await start();
    const { token } = await mintAnonymous(base, embed.embedId);

    await askForOrders(base, token);

    // ADR 0201 decision 4: projecting a gated tool to the mixed surface IS the author's opt-in to
    // advertise it — offering is how the visitor learns signing in is worth doing. Hiding it made
    // the authorization branch of the sign-in classification unreachable.
    const modelRequest = JSON.parse(String(modelFetch.mock.calls[0]?.[1]?.body)) as {
      tools: ReadonlyArray<{ function: { name: string } }>;
    };
    const advertised = modelRequest.tools.map((tool) => tool.function.name);
    expect(advertised).toContain('premium_report');
    expect(advertised).toContain('my_orders');
  });

  it('offers sign-in instead of denying a gated tool for an anonymous visitor', async () => {
    const { base, embed } = await start({ modelCalls: 'premium_report' });
    const { token } = await mintAnonymous(base, embed.embedId);

    const { body, data } = await askForOrders(base, token);

    // The offer replaces the denial only here: before this ordering, the anonymous call hard-denied
    // with invalid_model_tool_call before the elevation intercept ever ran.
    expect(body).toContain('auth_requested');
    expect(data?.signInTicket).toMatch(/^elv_/);
    expect(body).not.toContain('invalid_model_tool_call');
    expect(body).not.toContain('tool_completed');
  });

  it('still denies a signed-in caller who lacks the role, and executes for one who has it', async () => {
    const { base, embed } = await start({ modelCalls: 'premium_report' });

    const run = async (user: Record<string, unknown>) => {
      const anonymous = await mintAnonymous(base, embed.embedId);
      const { data } = await askForOrders(base, anonymous.token);
      const client = await createClient(base);
      const response = await elevate(
        base,
        { authorization: basic(client) },
        { signInTicket: data?.signInTicket, user },
      );
      expect(response.status).toBe(200);
      const { token } = (await response.json()) as { readonly token: string };
      return (await askForOrders(base, token)).body;
    };

    // Signing in does not confer the role: the tool vanishes from the filtered list, so a direct
    // call reaches nothing. The visitor gets an answer in words rather than a broken widget, and
    // the tool is never started — the denial is in what does not happen, not in an error code.
    const novice = await run({ id: 'user_novice' });
    expect(novice).not.toContain('tool_started');
    expect(novice).not.toContain('tool_completed');
    expect(novice).not.toContain('auth_requested');
    // With the role, the same conversation executes it (tool_started; the direct path streams the
    // result back to the model rather than emitting an interaction's tool_completed).
    const analyst = await run({ id: 'user_analyst', roles: ['analyst'] });
    expect(analyst).toContain('tool_started');
    expect(analyst).not.toContain('invalid_model_tool_call');
    expect(analyst).not.toContain('auth_requested');
  });

  it('offers sign-in for a delegated-auth tool with no ${user} reference (the §5 hole)', async () => {
    const { base, embed } = await start({ delegated: true, modelCalls: 'team_time_off' });
    const { token } = await mintAnonymous(base, embed.embedId);

    const { body, data } = await askForOrders(base, token);

    // Before the auth-kind join, this tool classified public-safe, executed anonymously, and died
    // in the credential broker as credential_unavailable — a generic error card on a surface whose
    // whole point is that signing in would have made it work.
    expect(body).toContain('auth_requested');
    expect(data?.signInTicket).toMatch(/^elv_/);
    expect(body).not.toContain('credential_unavailable');
    expect(body).not.toContain('tool_completed');
  });

  it('validates routing on the elevation leg instead of silently dropping it', async () => {
    const { base, embed } = await start();
    const anonymous = await mintAnonymous(base, embed.embedId);
    const { data } = await askForOrders(base, anonymous.token);
    const client = await createClient(base);

    // This deployment declares no customerEndpoints, so any routing key is invalid — the point is
    // that the elevation leg answers 400 rather than accepting and discarding the routes. The
    // persistence half is proven by the store parity suite, where routing ownership lives.
    const response = await elevate(
      base,
      { authorization: basic(client) },
      {
        signInTicket: data?.signInTicket,
        user: { id: 'user_42' },
        routing: { endpoints: { customer_api: 'https://tenant-a.api.acme.test/v1' } },
      },
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('invalid assistant routing');
  });

  it('refuses a malformed sign-in ticket with the invalid code, not a bare message', async () => {
    const { base } = await start();
    const client = await createClient(base);

    const response = await elevate(
      base,
      { authorization: basic(client) },
      { signInTicket: 42, user: { id: 'user_42' } },
    );
    expect(response.status).toBe(400);
    const refusal = (await response.json()) as { readonly error: string; readonly code: string };
    // Same recovery as a spent ticket — obtain a fresh one — so it reuses the same code; the 400
    // status is what preserves malformed-vs-refused for operators.
    expect(refusal.code).toBe('elevation_ticket_invalid');
  });

  it('reports a deployment without an elevation store as a config state, not a refusal', async () => {
    const { base } = await start({ withoutElevations: true });
    const client = await createClient(base);

    const response = await elevate(
      base,
      { authorization: basic(client) },
      { signInTicket: 'elv_never_issued', user: { id: 'user_42' } },
    );
    expect(response.status).toBe(503);
    const refusal = (await response.json()) as { readonly error: string; readonly code: string };
    // Deliberately outside the refusal union: this pages the operator, not the visitor.
    expect(refusal.code).toBe('elevation_unavailable');
  });
});

describe('assistant doctor proves the sign-in leg', () => {
  const doctor = async (
    base: string,
    org: string,
    client: { readonly id: string; readonly clientSecret: string },
  ) => {
    const response = await fetch(`${base}/v1/orgs/${org}/apps/site/envs/prod/assistant/doctor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: client.id,
        clientSecret: client.clientSecret,
        origin: 'https://www.acme.test',
      }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as {
      readonly ok: boolean;
      readonly checks: Readonly<
        Record<string, { readonly ok: boolean; readonly skipped?: boolean }>
      >;
    };
  };

  it('runs a synthetic elevation round trip and proves the issuer rebind', async () => {
    const { base, org } = await start();
    const client = await createClient(base);

    const body = await doctor(base, org, client);

    // Issue -> claim -> elevate against a throwaway anonymous session: the same code path a real
    // sign-in takes, including the clientId and origin rebind the exchange performs.
    expect(body.checks.elevation).toMatchObject({ ok: true, issuerRebound: true });
    expect(body.ok).toBe(true);
    // The synthetic ticket is spent inside the probe and must never appear in the report.
    expect(JSON.stringify(body)).not.toContain('elv_');
  });

  it('fails the elevation check when a mixed surface has no elevation store', async () => {
    const { base, org } = await start({ withoutElevations: true });
    const client = await createClient(base);

    const body = await doctor(base, org, client);

    // A mixed surface promises sign-in; a deployment that cannot complete one is misconfigured,
    // and doctor is exactly where an operator should learn that before a visitor does.
    expect(body.checks.elevation).toMatchObject({ ok: false });
    expect(body.ok).toBe(false);
  });
});

describe('interceptForElevation only diverts the one case it exists for', () => {
  const elevations = () => new InMemoryAssistantElevationStore();
  const identityTool = {
    name: 'my_orders',
    description: 'Read orders.',
    inputSchema: { type: 'object' },
    fulfilment: {
      kind: 'operation',
      connector: 'c',
      operation: 'o',
      args: { id: { kind: 'path', root: 'user', segments: [{ kind: 'name', name: 'id' }] } },
    },
  } as never;
  const safeTool = {
    ...(identityTool as unknown as Record<string, unknown>),
    fulfilment: {
      kind: 'operation',
      connector: 'c',
      operation: 'o',
      args: { id: { kind: 'path', root: 'input', segments: [{ kind: 'name', name: 'id' }] } },
    },
  } as never;
  const anonymous = {
    id: 'sess_1',
    tenant: { org: 'acme', app: 'site', env: 'prod' },
    caller: { subject: 'anon_1', identityKind: 'anonymous' },
  } as never;
  const mixed = { surfaces: [{ mode: 'mixed', origins: [], capabilities: [] }] };
  const now = new Date('2030-01-01T00:00:00Z');

  it('offers elevation for an anonymous visitor, an identity tool, and a mixed surface', async () => {
    const result = await interceptForElevation({
      tool: identityTool,
      session: anonymous,
      assistant: mixed,
      elevations: elevations(),
      now,
    });
    expect(result?.event.event).toBe('auth_requested');
  });

  it('does not offer elevation on a surface that is not mixed', async () => {
    // A `public` surface rejects an identity capability at compile time, so reaching here at all would
    // mean that guard failed. Offering sign-in on a surface the author never opted into would be the
    // wrong recovery: it advertises a door the deployment did not agree to have.
    for (const assistant of [
      { surfaces: [{ mode: 'public', origins: [], capabilities: [] }] },
      { surfaces: [{ mode: 'authenticated', origins: [] }] },
      {},
      undefined,
    ]) {
      expect(
        await interceptForElevation({
          tool: identityTool,
          session: anonymous,
          assistant,
          elevations: elevations(),
          now,
        }),
      ).toBeUndefined();
    }
  });

  it('does not offer elevation for a public-safe tool or a signed-in caller', async () => {
    expect(
      await interceptForElevation({
        tool: safeTool,
        session: anonymous,
        assistant: mixed,
        elevations: elevations(),
        now,
      }),
    ).toBeUndefined();

    expect(
      await interceptForElevation({
        tool: identityTool,
        session: {
          ...(anonymous as object),
          caller: { subject: 'u', identityKind: 'customer' },
        } as never,
        assistant: mixed,
        elevations: elevations(),
        now,
      }),
    ).toBeUndefined();
  });

  it('offers elevation for a delegated-auth tool the resolver flags, and stays put without one', async () => {
    // The auth-kind half of the classification joins at runtime: anonymousBehavior cannot see
    // connector bindings, so the caller supplies the join. Absent resolver = current behavior
    // (fail closed to the ordinary refusal — no offer that cannot be completed).
    const offered = await interceptForElevation({
      tool: safeTool,
      session: anonymous,
      assistant: mixed,
      elevations: elevations(),
      requiresDelegatedIdentity: () => true,
      now,
    });
    expect(offered?.event.event).toBe('auth_requested');

    expect(
      await interceptForElevation({
        tool: safeTool,
        session: anonymous,
        assistant: mixed,
        elevations: elevations(),
        requiresDelegatedIdentity: () => false,
        now,
      }),
    ).toBeUndefined();
  });

  it('does not offer elevation when the deployment has no elevation store', async () => {
    // No store means no way to complete what the card would promise, so the existing refusal stands.
    expect(
      await interceptForElevation({
        tool: identityTool,
        session: anonymous,
        assistant: mixed,
        elevations: undefined,
        now,
      }),
    ).toBeUndefined();
  });
});

describe('post-sign-in resume (issue #1177)', () => {
  const APP_ORIGIN = 'https://www.acme.test';

  async function armedElevation(overrides: Record<string, unknown> = {}) {
    const started = await start();
    const client = await createClient(started.base);
    const anonymous = await mintAnonymous(started.base, started.embed.embedId);
    const asked = await askForOrders(started.base, anonymous.token);
    expect(asked.data?.signInTicket).toBeTruthy();
    const exchanged = await elevate(
      started.base,
      { authorization: basic(client) },
      {
        signInTicket: asked.data?.signInTicket,
        user: { id: 'user_42', email: 'v@acme.test' },
        ...overrides,
      },
    );
    expect(exchanged.status).toBe(200);
    const session = (await exchanged.json()) as {
      readonly token: string;
      readonly resume?: { readonly tool: string };
    };
    return { ...started, client, session };
  }

  it('is on by default: the exchange advertises the hint and one resume turn answers', async () => {
    const { base, session, modelFetch, audit } = await armedElevation();
    expect(session.resume).toEqual({ tool: 'my_orders' });

    const resumed = await resumeTurn(base, session.token);
    expect(resumed.status).toBe(200);
    // The model re-attempted the intercepted tool under the new principal and narrated the result.
    expect(resumed.body).toContain('event: tool_started');
    expect(resumed.body).toContain('my_orders');
    expect(resumed.body).toContain('event: view_available');
    expect(resumed.body).toContain('"resourceUri":"ui://elevation/orders_card"');
    expect(resumed.body).toContain('Done.');
    expect(resumed.body).not.toContain('auth_requested');

    const later = await askForOrders(base, session.token);
    expect(later.body).toContain('event: view_available');
    expect(later.body).toContain('"resourceUri":"ui://elevation/orders_card"');
    expect(later.body).not.toContain('auth_requested');
    const lastModelRequest = JSON.parse(
      String((modelFetch.mock.calls.at(-1)?.[1] as RequestInit).body),
    ) as { readonly messages: ReadonlyArray<{ readonly role: string; readonly content?: string }> };
    const platform = lastModelRequest.messages.find((entry) =>
      String(entry.content ?? '').startsWith('[platform] The visitor has just signed in'),
    );
    expect(platform?.content).toContain('"my_orders"');
    const audited = await audit.list({ org: 'acme' });
    expect(
      audited.some(
        (event) =>
          event.eventType === 'assistant.session.resumed' &&
          (event.details as { tool?: string } | undefined)?.tool === 'my_orders',
      ),
    ).toBe(true);
  });

  it('is one-shot: a second resume turn answers 409 nothing_to_resume', async () => {
    const { base, session } = await armedElevation();
    expect((await resumeTurn(base, session.token)).status).toBe(200);
    const second = await resumeTurn(base, session.token);
    expect(second.status).toBe(409);
    expect(JSON.parse(second.body)).toMatchObject({ code: 'nothing_to_resume' });
  });

  it('resume: false suppresses the hint and leaves nothing to resume', async () => {
    const { base, session } = await armedElevation({ resume: false });
    expect(session.resume).toBeUndefined();
    const attempted = await resumeTurn(base, session.token);
    expect(attempted.status).toBe(409);
    expect(JSON.parse(attempted.body)).toMatchObject({ code: 'nothing_to_resume' });
  });

  it('a typed turn moots the pending resume', async () => {
    const { base, session } = await armedElevation();
    const typed = await fetch(`${base}/v1/assistant/turns`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${session.token}`,
        origin: APP_ORIGIN,
      },
      body: JSON.stringify({ message: 'never mind, tell me about pricing' }),
    });
    expect(typed.status).toBe(200);
    await typed.text();
    const late = await resumeTurn(base, session.token);
    expect(late.status).toBe(409);
  });

  it('admission runs first and a refused resume stays armed', async () => {
    const { base, session, admissionControl } = await armedElevation();
    admissionControl.refuseTurns = true;
    const refused = await resumeTurn(base, session.token);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).not.toBe(409);
    admissionControl.refuseTurns = false;
    // The arm survived the refusal: the retry still resumes.
    expect((await resumeTurn(base, session.token)).status).toBe(200);
  });

  it('a confirm-gated intercepted tool resumes to its proposal card, never execution', async () => {
    const started = await start({ modelCalls: 'update_nickname' });
    const client = await createClient(started.base);
    const anonymous = await mintAnonymous(started.base, started.embed.embedId);
    const asked = await askForOrders(started.base, anonymous.token);
    expect(asked.data?.signInTicket).toBeTruthy();
    const exchanged = await elevate(
      started.base,
      { authorization: basic(client) },
      { signInTicket: asked.data?.signInTicket, user: { id: 'user_42', email: 'v@acme.test' } },
    );
    const session = (await exchanged.json()) as { readonly token: string };
    const resumed = await resumeTurn(started.base, session.token);
    expect(resumed.status).toBe(200);
    // Sign-in never converts into implicit consent for a write: the turn ends at the card.
    expect(resumed.body).toContain('event: tool_proposed');
    expect(resumed.body).not.toContain('event: tool_completed');
  });

  it('a fresh authenticated mint never carries the hint and has nothing to resume', async () => {
    const { base } = await start();
    const client = await createClient(base);
    const minted = await elevate(
      base,
      { authorization: basic(client) },
      { user: { id: 'user_42', email: 'v@acme.test' } },
    );
    expect(minted.status).toBe(201);
    const session = (await minted.json()) as {
      readonly token: string;
      readonly resume?: unknown;
    };
    expect(session.resume).toBeUndefined();
    expect((await resumeTurn(base, session.token)).status).toBe(409);
  });

  it('rejects a malformed resume body before any work', async () => {
    const { base, session } = await armedElevation();
    const malformed = await fetch(`${base}/v1/assistant/turns`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${session.token}`,
        origin: APP_ORIGIN,
      },
      body: JSON.stringify({ resume: true, extra: 1 }),
    });
    expect(malformed.status).toBe(400);
    // Still armed afterwards.
    expect((await resumeTurn(base, session.token)).status).toBe(200);
  });
});
