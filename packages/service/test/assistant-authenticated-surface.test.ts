import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServiceHandler, InMemoryAssistantStore, ServerRegistry } from '../src/index.js';
import { EMBEDDED_ASSISTANT_MANIFEST } from './embedded-assistant-fixtures.js';

/**
 * Exact authenticated-surface binding (ADR 0201 / console-operator slice 0): a backend-exchanged
 * session binds the one authored surface that owns its origin — its capability projection and its
 * instructions — never the deployment-wide origin union or the unprojected server.
 */

const PUBLIC_ORIGIN = 'https://www.example.com';
const APP_ORIGIN = 'https://app.example.com';
const UNOWNED_ORIGIN = 'https://legacy.example.com';
const PUBLIC_INSTRUCTIONS = 'Guide anonymous visitors consultatively.';
const APP_INSTRUCTIONS = 'Help the signed-in operator finish onboarding.';

const TWO_SURFACE_MANIFEST = `
manifestVersion: "2"
server:
  name: two_surfaces
  version: 1.0.0
  title: Two surfaces
  instructions: Keep shared product claims accurate.
  assistant:
    model:
      kind: openai-compatible
      baseUrl: \${env.ASSISTANT_MODEL_BASE_URL}
      model: \${env.ASSISTANT_MODEL}
      apiKey: ASSISTANT_MODEL_API_KEY
    surfaces:
      - mode: public
        origins: [${PUBLIC_ORIGIN}]
        instructions: ${PUBLIC_INSTRUCTIONS}
        capabilities: [{ kind: tool, name: public_tool }]
      - mode: authenticated
        origins: [${APP_ORIGIN}]
        instructions: ${APP_INSTRUCTIONS}
        capabilities: [{ kind: tool, name: auth_tool }]
    allowedOrigins: [${PUBLIC_ORIGIN}, ${APP_ORIGIN}, ${UNOWNED_ORIGIN}]
tools:
  - name: public_tool
    description: Answer a public product question.
    annotations: { readOnlyHint: true }
    inputSchema: { type: object, properties: {}, additionalProperties: false }
    fulfilment: { steps: [], output: { ok: true } }
  - name: auth_tool
    description: Read the signed-in operator's onboarding state.
    annotations: { readOnlyHint: true }
    inputSchema: { type: object, properties: {}, additionalProperties: false }
    fulfilment: { steps: [], output: { ok: true } }
  - name: hidden_tool
    description: Listed on no surface; unreachable from both.
    annotations: { readOnlyHint: true }
    inputSchema: { type: object, properties: {}, additionalProperties: false }
    fulfilment: { steps: [], output: { ok: true } }
`;

describe('authenticated-surface binding', () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  async function start(manifest = TWO_SURFACE_MANIFEST) {
    const registry = new ServerRegistry();
    const scope = { level: 'env' as const, org: 'acme', app: 'support', env: 'prod' };
    for (const [kind, name, value] of [
      ['variable', 'ASSISTANT_MODEL_BASE_URL', 'https://models.example/v1'],
      ['variable', 'ASSISTANT_MODEL', 'acme-model'],
      ['secret', 'ASSISTANT_MODEL_API_KEY', 'provider-key'],
    ] as const) {
      await registry.configStore.setConfigValue({ kind, scope, name, value });
    }
    const deployed = await registry.deploy({ org: 'acme', app: 'support', env: 'prod' }, manifest, {
      accessMode: 'public',
    });
    if (!deployed.ok) throw new Error(JSON.stringify(deployed.errors));
    const modelFetch = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        choices: [{ message: { role: 'assistant', content: 'Done.' } }],
      }),
    );
    const server = createServer(
      createServiceHandler(registry, {
        assistantStore: new InMemoryAssistantStore(),
        assistantModelFetch: modelFetch,
      }),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}`, modelFetch };
  }

  async function exchange(base: string, origin: string) {
    const created = await fetch(`${base}/v1/orgs/acme/apps/support/envs/prod/assistant/clients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'web' }),
    });
    const client = await created.json();
    const basic = Buffer.from(`${client.id}:${client.clientSecret}`).toString('base64');
    return fetch(`${base}/v1/assistant/sessions`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' },
      body: JSON.stringify({ origin, user: { id: 'user-1', email: 'user@example.com' } }),
    });
  }

  async function turn(base: string, session: { token: string }, origin: string) {
    const response = await fetch(`${base}/v1/assistant/turns`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.token}`,
        origin,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message: 'Hello there' }),
    });
    return { status: response.status, body: await response.text() };
  }

  function modelRequest(modelFetch: ReturnType<typeof vi.fn<typeof fetch>>) {
    const [, init] = modelFetch.mock.calls.at(-1) ?? [];
    return JSON.parse(String(init?.body)) as {
      readonly messages: readonly { readonly role: string; readonly content: string }[];
      readonly tools?: readonly { readonly function: { readonly name: string } }[];
    };
  }

  it('binds a backend session on the app origin to the authenticated surface projection', async () => {
    const { base, modelFetch } = await start();
    const minted = await exchange(base, APP_ORIGIN);
    expect(minted.status).toBe(201);
    const session = await minted.json();

    const result = await turn(base, session, APP_ORIGIN);
    expect(result.status, result.body).toBe(200);

    const request = modelRequest(modelFetch);
    expect(request.tools?.map((tool) => tool.function.name)).toEqual(['auth_tool']);
    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    expect(system).toContain(
      `Surface instructions (authenticated website surface; same trust level as tenant instructions):\n${APP_INSTRUCTIONS}`,
    );
    expect(system).not.toContain(PUBLIC_INSTRUCTIONS);
  });

  it('binds a backend session on the public origin to the public surface projection', async () => {
    const { base, modelFetch } = await start();
    const minted = await exchange(base, PUBLIC_ORIGIN);
    expect(minted.status).toBe(201);
    const session = await minted.json();

    const result = await turn(base, session, PUBLIC_ORIGIN);
    expect(result.status, result.body).toBe(200);

    const request = modelRequest(modelFetch);
    expect(request.tools?.map((tool) => tool.function.name)).toEqual(['public_tool']);
    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    expect(system).toContain(
      `Surface instructions (public website surface; same trust level as tenant instructions):\n${PUBLIC_INSTRUCTIONS}`,
    );
    expect(system).not.toContain(APP_INSTRUCTIONS);
  });

  it('refuses an origin no authored surface owns, even when the union lists it', async () => {
    const { base } = await start();
    const minted = await exchange(base, UNOWNED_ORIGIN);
    expect(minted.status).toBe(403);
  });

  it('keeps the pre-surfaces artifact shape unprojected: the union is its whole contract', async () => {
    const { base, modelFetch } = await start(EMBEDDED_ASSISTANT_MANIFEST);
    const minted = await exchange(base, APP_ORIGIN);
    expect(minted.status).toBe(201);
    const session = await minted.json();

    const result = await turn(base, session, APP_ORIGIN);
    expect(result.status, result.body).toBe(200);
    const request = modelRequest(modelFetch);
    expect(request.tools?.map((tool) => tool.function.name)).toContain('lookup');
  });
});
