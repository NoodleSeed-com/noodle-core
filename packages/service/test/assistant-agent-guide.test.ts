import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryPublicEmbedStore } from '@noodle-borg/assistant-gateway';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServiceHandler, InMemoryAssistantStore, ServerRegistry } from '../src/index.js';

const ORIGIN = 'https://www.example.com';
const APP_ORIGIN = 'https://app.example.com';
const MANIFEST = `
manifestVersion: "2"
server:
  name: guided_assistant
  version: 1.0.0
  title: Guided assistant
  instructions: Keep every answer concise and grounded.
  agentGuide:
    description: Use Acme Support to investigate and resolve customer cases.
    useWhen: [A signed-in customer asks about a support case.]
    workflows:
      - id: review_cases
        title: Review cases
        intent: Ground the answer in current case records.
        steps:
          - capability: { kind: tool, name: list_cases }
            guidance: Read the current cases before answering.
      - id: close_case
        title: Close a case
        steps:
          - capability: { kind: tool, name: list_cases }
          - capability: { kind: tool, name: close_case }
            guidance: Close only the case selected by the user.
      - id: widget_settings
        title: Change widget settings
        steps:
          - capability: { kind: tool, name: widget_only_settings }
    boundaries: [Never claim a case changed until the write succeeds.]
    examples:
      - { prompt: Which cases are open?, workflow: review_cases }
      - { prompt: Close case 42., workflow: close_case }
  assistant:
    model:
      kind: openai-compatible
      baseUrl: \${env.ASSISTANT_MODEL_BASE_URL}
      model: \${env.ASSISTANT_MODEL}
      apiKey: ASSISTANT_MODEL_API_KEY
    surfaces:
      - mode: mixed
        origins: [${ORIGIN}]
        instructions: Guide anonymous visitors consultatively and never push them.
        capabilities:
          - { kind: tool, name: list_cases }
      - mode: authenticated
        origins: [${APP_ORIGIN}]
    allowedOrigins: [${ORIGIN}, ${APP_ORIGIN}]
tools:
  - name: list_cases
    description: Return the current support cases and their status.
    authorization:
      allowedRoles: [support_agent, support_admin]
      requiredScopes: [cases:read]
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    inputSchema: { type: object, properties: {}, additionalProperties: false }
    fulfilment: { steps: [], output: { cases: [] } }
  - name: close_case
    description: Close one selected support case.
    authorization:
      allowedRoles: [support_admin]
      requiredScopes: [cases:write]
    annotations:
      readOnlyHint: false
      destructiveHint: false
      openWorldHint: false
      confirm: true
    inputSchema:
      type: object
      properties: { caseId: { type: string } }
      required: [caseId]
      additionalProperties: false
    fulfilment:
      steps: []
      output:
        closed: "\${input.caseId}"
  - name: widget_only_settings
    description: Change settings from the trusted widget.
    visibility: [app]
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
    inputSchema: { type: object, properties: {}, additionalProperties: false }
    fulfilment: { steps: [], output: { updated: true } }
`;

describe('embedded assistant product guide', () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  async function start() {
    const tenant = { org: 'acme', app: 'support', env: 'prod' } as const;
    const scope = { level: 'env' as const, ...tenant };
    const registry = new ServerRegistry();
    await registry.configStore.setConfigValue({
      kind: 'variable',
      scope,
      name: 'ASSISTANT_MODEL_BASE_URL',
      value: 'https://models.example/v1',
    });
    await registry.configStore.setConfigValue({
      kind: 'variable',
      scope,
      name: 'ASSISTANT_MODEL',
      value: 'assistant-model',
    });
    await registry.configStore.setConfigValue({
      kind: 'secret',
      scope,
      name: 'ASSISTANT_MODEL_API_KEY',
      value: 'provider-key',
    });
    const deployed = await registry.deploy(tenant, MANIFEST, { accessMode: 'public' });
    if (!deployed.ok) throw new Error(JSON.stringify(deployed.errors));
    const modelFetch = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ choices: [{ message: { role: 'assistant', content: 'Grounded.' } }] }),
      );
    const publicEmbeds = new InMemoryPublicEmbedStore();
    const server = createServer(
      createServiceHandler(registry, {
        assistantStore: new InMemoryAssistantStore(),
        publicEmbeds,
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
      }),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const created = await fetch(`${base}/v1/orgs/acme/apps/support/envs/prod/assistant/clients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"web"}',
    });
    const client = await created.json();
    const basic = Buffer.from(`${client.id}:${client.clientSecret}`).toString('base64');
    const embed = await publicEmbeds.ensure({ ...tenant, surfaceMode: 'mixed', now: new Date() });
    return { base, basic, embed, modelFetch };
  }

  async function runTurn(
    base: string,
    basic: string,
    identity: { readonly roles: readonly string[]; readonly scopes: readonly string[] },
  ) {
    // A signed-in operator lives on the authenticated surface's own origin; the mixed surface's
    // allowlist and instructions belong to the marketing front door (exact binding, ADR 0201).
    const sessionResponse = await fetch(`${base}/v1/assistant/sessions`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        origin: APP_ORIGIN,
        user: { id: identity.roles.join('-'), roles: identity.roles, scopes: identity.scopes },
      }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = await sessionResponse.json();
    expect(session).not.toHaveProperty('guide');
    expect(session).not.toHaveProperty('skill');
    const turn = await fetch(session.endpoints.turns, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.token}`,
        origin: APP_ORIGIN,
        'content-type': 'application/json',
      },
      body: '{"message":"Help me with a case."}',
    });
    expect(turn.status).toBe(200);
    expect(await turn.text()).toContain('Grounded.');
  }

  async function runAnonymousTurn(base: string, embedId: string) {
    const sessionResponse = await fetch(`${base}/v1/assistant/public-sessions`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ embedId }),
    });
    const sessionBody = await sessionResponse.text();
    expect(sessionResponse.status, sessionBody).toBe(201);
    const session = JSON.parse(sessionBody);
    const turn = await fetch(`${base}/v1/assistant/turns`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.token}`,
        origin: ORIGIN,
        'content-type': 'application/json',
      },
      body: '{"message":"Help me with a case."}',
    });
    const turnBody = await turn.text();
    expect(turn.status, turnBody).toBe(200);
    expect(turnBody).toContain('Grounded.');
  }

  it('adds only complete, surface- and authorization-filtered workflows for each caller', async () => {
    const { base, basic, embed, modelFetch } = await start();
    await runAnonymousTurn(base, embed.embedId);
    await runTurn(base, basic, {
      roles: ['support_agent'],
      scopes: ['cases:read'],
    });
    await runTurn(base, basic, {
      roles: ['support_admin'],
      scopes: ['cases:read', 'cases:write'],
    });

    const requests = modelFetch.mock.calls.map(
      ([, init]) =>
        JSON.parse(String(init?.body)) as {
          readonly messages: readonly { readonly role: string; readonly content: string }[];
          readonly tools: readonly { readonly function: { readonly name: string } }[];
        },
    );
    expect(requests).toHaveLength(3);
    const [anonymousRequest, memberRequest, adminRequest] = requests;
    if (
      anonymousRequest === undefined ||
      memberRequest === undefined ||
      adminRequest === undefined
    ) {
      throw new Error('expected anonymous, member, and administrator model requests');
    }
    const anonymousSystem = anonymousRequest.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    const memberSystem = memberRequest.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    const adminSystem = adminRequest.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');

    expect(anonymousRequest.tools.map((tool) => tool.function.name)).toEqual(['list_cases']);
    expect(anonymousSystem).toContain('Review cases');
    expect(anonymousSystem).toContain(
      'Surface instructions (mixed website surface; same trust level as tenant instructions):\nGuide anonymous visitors consultatively and never push them.',
    );
    expect(anonymousSystem.indexOf('Authorization-filtered product workflows')).toBeLessThan(
      anonymousSystem.indexOf('Surface instructions (mixed website surface'),
    );
    expect(anonymousSystem).not.toContain('Close a case');
    expect(anonymousSystem).not.toContain('Change widget settings');

    expect(memberSystem).toContain('Tenant instructions:\nKeep every answer concise and grounded.');
    expect(memberSystem).not.toContain('Guide anonymous visitors consultatively');
    expect(memberSystem).toContain('Authorization-filtered product workflows');
    expect(memberSystem).toContain('Review cases');
    expect(memberSystem).not.toContain('Close a case');
    expect(memberSystem).not.toContain('Change widget settings');
    expect(memberSystem).not.toContain('| Tool |');
    expect(memberSystem).not.toContain('Return the current support cases and their status.');
    expect(memberRequest.tools.map((tool) => tool.function.name)).toEqual(['list_cases']);

    expect(adminSystem).toContain('Review cases');
    expect(adminSystem).not.toContain('Guide anonymous visitors consultatively');
    expect(adminSystem).toContain('Close a case');
    expect(adminSystem).toContain('confirmation required');
    expect(adminSystem).not.toContain('Change widget settings');
    expect(adminRequest.tools.map((tool) => tool.function.name)).toEqual([
      'list_cases',
      'close_case',
    ]);
  });
});
