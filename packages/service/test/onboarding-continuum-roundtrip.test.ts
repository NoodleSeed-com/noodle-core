import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  InMemoryAssistantElevationStore,
  InMemoryAssistantStore,
  InMemoryPublicEmbedStore,
} from '@noodle-borg/assistant-gateway';
import {
  createJwtVerifier,
  createStaticSigningKeyProvider,
  InMemoryTokenExchangeJtiStore,
} from '@noodle-borg/auth';
import {
  InMemoryControlPlaneStore,
  NoodleOAuthControlPlaneGate,
} from '@noodle-borg/control-plane/portable';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServiceHandler, InMemoryAuditStore, ServerRegistry } from '../src/index.js';
import { createOAuthApp } from '../src/oauth/app.js';
import type { ControlPlaneExchangeDeps } from '../src/oauth/delegated-control-plane-token-handler.js';
import { InMemoryDeveloperGrantStore } from '../src/oauth/developer-grant.js';
import { NoodleOAuthProvider } from '../src/oauth/provider.js';
import { InMemoryOAuthStore } from '../src/oauth/store.js';
import { mintOAuthAccessToken } from '../src/oauth/token-issuer.js';
import { readAssistantEvents } from './assistant-sse-test-helpers.js';

/**
 * The program-acceptance round trip (the C4 dev journey, minus hosted infrastructure): one local
 * service plays every part at once — the assistant runtime, the customer's "downstream API"
 * (its own control plane), and the ADR 0218 exchange target on its own `/token`.
 *
 * The journey under test, entirely over real HTTP with a scripted model:
 * anonymous visitor on the mixed website surface → requires-identity tool intercepted into a
 * sign-in ticket → backend elevation spend on the app origin (session rebinds to the
 * authenticated surface) → bounded visible-transcript replay → one-shot resume actually executes
 * the tool, whose connector performs the delegated token exchange against this same service and
 * reads the control plane with the minted grant-bound token → a confirm-gated create deploys a
 * starter app under the signed-in person's own authority.
 */

const ISSUER = 'https://cloud.acme.test';
const EXCHANGE_CLIENT_ID = 'cpx_first_party';
const EXCHANGE_CLIENT_SECRET = 'cpx-secret-abcdefghijklmnopqrstuvwxyz012345';
const WWW = 'https://www.acme.test';
const APP = 'https://app.acme.test';

const MANIFEST = `
manifestVersion: "1"
server:
  name: continuum
  version: 1.0.0
  title: Continuum
  assistant:
    model:
      kind: openai-compatible
      baseUrl: \${env.ASSISTANT_MODEL_BASE_URL}
      model: \${env.ASSISTANT_MODEL}
      apiKey: ASSISTANT_MODEL_API_KEY
    surfaces:
      - mode: mixed
        origins: [${WWW}]
        capabilities:
          - { kind: tool, name: my_onboarding_status }
      - mode: authenticated
        origins: [${APP}]
        instructions: Help the signed-in person finish onboarding.
        capabilities:
          - { kind: tool, name: my_onboarding_status }
          - { kind: tool, name: create_first_app }
    allowedOrigins: [${WWW}, ${APP}]
connectors:
  cloud:
    id: noodle_cloud
    version: 1.0.0
tools:
  - name: my_onboarding_status
    description: Read the signed-in person's workspace and apps.
    annotations:
      readOnlyHint: true
    inputSchema: { type: object, properties: {}, additionalProperties: false }
    fulfilment:
      steps:
        - id: whoami
          use: cloud.whoami
          args: {}
        - id: apps
          use: cloud.list_apps
          args:
            org: \${steps.whoami.workspace}
      output:
        signedInAs: \${user.email}
        workspace: \${steps.whoami.workspace}
        apps: \${steps.apps.apps}
  - name: create_first_app
    description: Deploy a starter app into the signed-in person's workspace.
    annotations:
      readOnlyHint: false
      destructiveHint: false
      openWorldHint: true
      confirm: true
    inputSchema:
      type: object
      properties:
        org: { type: string, minLength: 1, maxLength: 63 }
        app: { type: string, pattern: "^[a-z][a-z0-9]{2,29}$" }
      required: [org, app]
      additionalProperties: false
    fulfilment:
      steps:
        - id: deploy
          use: cloud.deploy_starter_app
          args:
            org: \${input.org}
            app: \${input.app}
      output:
        ok: \${steps.deploy.ok}
`;

/** The starter manifest the deploy op sends; `\${args.app}` is the one deliberate interpolation. */
const STARTER =
  '{"manifestVersion":"1","server":{"name":"${args.app}","version":"1.0.0","title":"${args.app}"},"tools":[{"name":"hello","description":"Say hello from your first app.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"outputSchema":{"type":"object","properties":{"message":{"type":"string"}},"required":["message"],"additionalProperties":false},"fulfilment":{"steps":[],"output":{"message":"Hello from your first app!"}}}]}';

function connectors(base: string): string {
  return `
connectors:
  - id: noodle_cloud
    version: 1.0.0
    http:
      baseUrl: ${base}
      allowedOrigins: [${base}]
      auth:
        kind: delegatedTokenExchange
        tokenUrl: ${base}/token
        clientId: ${EXCHANGE_CLIENT_ID}
        clientSecret: CLOUD_EXCHANGE_SECRET
        scopes: [cloud:read, deployments:write]
        audience: urn:noodleseed:control-plane:delegated-exchange
    operations:
      whoami:
        type: read
        method: GET
        path: /v1/whoami
        output:
          type: object
          properties:
            email: { type: string }
            workspace: { type: string }
          required: [email, workspace]
          additionalProperties: false
        response:
          email: \${response.identity.email}
          workspace: \${response.orgs[0].slug}
      list_apps:
        type: read
        method: GET
        path: /v1/orgs/{org}/apps
        input:
          type: object
          properties:
            org: { type: string, minLength: 1, maxLength: 63 }
          required: [org]
          additionalProperties: false
        output:
          type: object
          properties:
            apps: { type: array, items: { type: object, additionalProperties: true } }
          required: [apps]
          additionalProperties: false
        response:
          apps: \${response.data.apps}
      deploy_starter_app:
        type: action
        method: POST
        path: /v1/orgs/{org}/apps/{app}/envs/prod/deploy
        input:
          type: object
          properties:
            org: { type: string, minLength: 1, maxLength: 63 }
            app: { type: string, pattern: "^[a-z][a-z0-9]{2,29}$" }
          required: [org, app]
          additionalProperties: false
        output:
          type: object
          properties:
            ok: { type: boolean }
          required: [ok]
          additionalProperties: false
        request:
          manifest: '${STARTER}'
          accessMode: owner-only
          deploymentSource: console-example
        response:
          ok: \${response.ok}
`;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function start() {
  const signer = await createStaticSigningKeyProvider();
  const registry = new ServerRegistry(undefined, undefined, undefined, {
    delegatedExchange: { issuer: ISSUER, signer },
  });
  const tenant = { org: 'acme', app: 'site', env: 'prod' };
  const scope = { level: 'env' as const, ...tenant };
  for (const [name, value] of [
    ['ASSISTANT_MODEL_BASE_URL', 'https://model.test'],
    ['ASSISTANT_MODEL', 'acme-model'],
  ]) {
    await registry.configStore.setConfigValue({ kind: 'variable', scope, name, value });
  }
  await registry.configStore.setConfigValue({
    kind: 'secret',
    scope,
    name: 'ASSISTANT_MODEL_API_KEY',
    value: 'set',
  });
  await registry.configStore.setConfigValue({
    kind: 'secret',
    scope,
    name: 'CLOUD_EXCHANGE_SECRET',
    value: EXCHANGE_CLIENT_SECRET,
  });

  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: 'user-1',
    email: 'fahd@acme.test',
    role: 'developer',
  });

  const grants = new InMemoryDeveloperGrantStore();
  const jti = new InMemoryTokenExchangeJtiStore();
  const assistantStore = new InMemoryAssistantStore();
  const publicEmbeds = new InMemoryPublicEmbedStore();
  const elevations = new InMemoryAssistantElevationStore();
  const audit = new InMemoryAuditStore();

  const provider = new NoodleOAuthProvider({
    issuer: ISSUER,
    store: new InMemoryOAuthStore(),
    signer,
    tokenExchangeReady: true,
  });
  const exchangeDeps: ControlPlaneExchangeDeps = {
    issuer: ISSUER,
    config: {
      clientId: EXCHANGE_CLIENT_ID,
      clientSecret: EXCHANGE_CLIENT_SECRET,
      allowedTenants: ['acme/site/prod'],
    },
    verifierKey: () => signer.verifierKey(),
    grants,
    consumeJti: (value, expiresAtMs) => jti.consume(value, expiresAtMs, Date.now()),
    resolveSubject: async () => ({ ok: true }),
    listAssistantClientIds: async (ref) => {
      const clients = await assistantStore.listClients(ref);
      return clients.filter((client) => client.revokedAt === undefined).map((client) => client.id);
    },
    resourcePath: '/developer/assistant',
    capabilityCeiling: ['cloud:read', 'deployments:write'],
    issueAccessToken: (input) =>
      mintOAuthAccessToken({
        signer,
        issuer: ISSUER,
        ttlSeconds: input.ttlSeconds,
        identity: {
          ownerSubject: input.subject,
          ownerEmail: input.email,
          resource: input.resource,
          scope: input.scope,
          identityKind: 'platform',
          developerGrantId: input.developerGrantId,
          oauthClientId: input.oauthClientId,
        },
      }),
    audit,
  };
  const authServerApp = createOAuthApp(provider, { controlPlaneExchange: exchangeDeps });

  const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: await signer.verifierKey() });
  const gate = new NoodleOAuthControlPlaneGate({
    verifier: async (token, audience) => {
      const verified = await verify(token, audience);
      if (!verified) return null;
      const caller = verified.caller;
      return {
        subject: caller.subject,
        ...(caller.email !== undefined ? { email: caller.email } : {}),
        ...(caller.developerGrantId !== undefined
          ? { developerGrantId: caller.developerGrantId }
          : {}),
        ...(caller.oauthClientId !== undefined ? { oauthClientId: caller.oauthClientId } : {}),
      };
    },
    audience: [ISSUER, `${ISSUER}/developer/assistant`],
    admins: [],
    allowedEmailDomain: '@acme.test',
  });

  // The scripted model: on a fresh user turn it reaches for whatever the test armed next; once a
  // tool result is in context it answers in prose so the loop terminates.
  const arm = { tool: 'my_onboarding_status', args: '{}' };
  const modelFetch = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const request = JSON.parse(String((init as RequestInit).body)) as {
      readonly messages: ReadonlyArray<{ readonly role: string }>;
    };
    const message =
      request.messages.at(-1)?.role === 'user'
        ? {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: arm.tool, arguments: arm.args },
              },
            ],
          }
        : { role: 'assistant', content: 'Done.' };
    return new Response(JSON.stringify({ choices: [{ message }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  const server = createServer(
    createServiceHandler(registry, {
      assistantStore,
      publicEmbeds,
      elevations,
      admissionCounters: {
        durable: true,
        consume: async ({ limit }: { readonly limit: number }) => ({
          allowed: true,
          used: 1,
          limit,
        }),
        peek: async () => 0,
      },
      assistantModelFetch: modelFetch,
      audit,
      deployGate: gate,
      controlPlaneStore: controlPlane,
      developerGrantStore: grants,
      authServerApp,
      authServerIssuer: ISSUER,
    } as never),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const deployed = await registry.deploy(tenant, MANIFEST, {
    accessMode: 'public',
    connectors: connectors(base),
  });
  expect(deployed.ok, JSON.stringify((deployed as { errors?: unknown }).errors)).toBe(true);

  const embed = await publicEmbeds.ensure({ ...tenant, surfaceMode: 'mixed', now: new Date() });
  const client = await assistantStore.createClient({
    name: 'console',
    tenant,
    deploymentId: deployed.ok ? deployed.deploymentId : '',
    allowedOrigins: [WWW, APP],
    now: new Date(),
  });
  return { base, registry, assistantStore, audit, embed, client, arm, modelFetch };
}

async function turn(base: string, token: string, origin: string, body: Record<string, unknown>) {
  const response = await fetch(`${base}/v1/assistant/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, origin },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.text() };
}

describe('the onboarding continuum, end to end on one local service', () => {
  it('carries one conversation from anonymous website visitor to a deployed first app', async () => {
    const { base, registry, audit, embed, client, arm, modelFetch } = await start();

    // 1. Anonymous mint on the mixed website surface.
    const mint = await fetch(`${base}/v1/assistant/public-sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: WWW },
      body: JSON.stringify({ embedId: embed.embedId }),
    });
    expect(mint.status).toBe(201);
    const anonymous = (await mint.json()) as { readonly token: string };

    // 2. Reaching the requires-identity tool raises the sign-in ticket instead of executing.
    const intercepted = await turn(base, anonymous.token, WWW, {
      message: 'what is my onboarding status?',
    });
    expect(intercepted.body).toContain('event: auth_requested');
    expect(intercepted.body).not.toContain('tool_completed');
    const ticket = /"signInTicket":"([^"]+)"/.exec(intercepted.body)?.[1];
    expect(ticket).toBeTruthy();

    // 3. The backend spends the ticket on the app origin: the same conversation, rebound to the
    //    authenticated surface (ADR 0201 amendment 2026-08-26).
    const elevated = await fetch(`${base}/v1/assistant/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(`${client.client.id}:${client.secret}`).toString('base64')}`,
      },
      body: JSON.stringify({
        origin: APP,
        user: { id: 'user-1', email: 'fahd@acme.test' },
        signInTicket: ticket,
      }),
    });
    expect(elevated.status, await elevated.clone().text()).toBe(200);
    const session = (await elevated.json()) as {
      readonly token: string;
      readonly endpoints: { readonly transcript: string };
      readonly resume?: { readonly tool: string };
    };
    // The pending intent survived the identity change and is armed for the one-shot resume.
    expect(session.resume?.tool).toBe('my_onboarding_status');

    // 4. The visible transcript replays across the redirect; scaffolding rows stay out.
    const transcript = await fetch(session.endpoints.transcript, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${session.token}`,
        origin: APP,
      },
      body: '{}',
    });
    expect(transcript.status).toBe(200);
    const replayed = await readAssistantEvents(transcript);
    expect(replayed).toContainEqual({
      event: 'message_started',
      data: { message: 'what is my onboarding status?' },
    });

    // 5. The one-shot resume executes the intercepted tool for real: the connector performs the
    //    delegated exchange against this same service's /token and reads the control plane with
    //    the minted grant-bound credential.
    const resumed = await turn(base, session.token, APP, { resume: true });
    expect(resumed.status).toBe(200);
    expect(resumed.body).toContain('event: tool_started');
    expect(resumed.body).not.toContain('event: error');
    expect(resumed.body).toContain('event: done');
    // A direct read's result reaches the model, not the SSE stream: the second model call carries
    // the tool message with the composed status — proof the connector exchanged and read for real.
    const toolMessages = modelFetch.mock.calls
      .map(
        (call) =>
          JSON.parse(String((call[1] as RequestInit).body)) as {
            readonly messages: ReadonlyArray<{ readonly role: string; readonly content?: string }>;
          },
      )
      .flatMap((request) => request.messages)
      .filter((message) => message.role === 'tool')
      .map((message) => String(message.content));
    expect(toolMessages.some((content) => content.includes('"workspace":"acme"'))).toBe(true);
    expect(toolMessages.some((content) => content.includes('"signedInAs":"fahd@acme.test"'))).toBe(
      true,
    );
    const issued = await audit.list({ org: 'acme' });
    expect(issued.map((event) => event.eventType)).toContain('control_plane.token_exchange.issued');

    // 6. The confirm-gated create: proposal, explicit confirmation, and a real deploy under the
    //    signed-in person's own capability-ceilinged authority.
    arm.tool = 'create_first_app';
    arm.args = JSON.stringify({ org: 'acme', app: 'starterone' });
    const proposal = await turn(base, session.token, APP, { message: 'create my first app' });
    expect(proposal.body).toContain('tool_proposed');
    const pendingId = /"id":"([^"]+)"/.exec(proposal.body)?.[1];
    expect(pendingId).toBeTruthy();

    const confirmed = await fetch(`${base}/v1/assistant/tool-confirmations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${session.token}`,
        origin: APP,
      },
      body: JSON.stringify({ id: pendingId }),
    });
    expect(confirmed.status).toBe(200);
    const outcome = await confirmed.text();
    expect(outcome).toContain('tool_completed');
    expect(outcome).toContain('"ok":true');

    const apps = await registry.listApps('acme');
    expect(apps.apps.map((app) => app.appSlug)).toContain('starterone');
  });

  it('never lets the anonymous session execute the identity tool or read the app-origin transcript', async () => {
    const { base, embed } = await start();
    const mint = await fetch(`${base}/v1/assistant/public-sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: WWW },
      body: JSON.stringify({ embedId: embed.embedId }),
    });
    const anonymous = (await mint.json()) as {
      readonly token: string;
      readonly endpoints: { readonly transcript: string };
    };

    // The interception is not an execution: nothing ran, and repeating the ask just re-offers.
    const first = await turn(base, anonymous.token, WWW, { message: 'my status?' });
    expect(first.body).toContain('auth_requested');
    expect(first.body).not.toContain('"workspace"');

    // The anonymous token cannot present itself on the authenticated app origin.
    const crossOrigin = await turn(base, anonymous.token, APP, { message: 'my status?' });
    expect(crossOrigin.status).toBeGreaterThanOrEqual(400);
  });
});
