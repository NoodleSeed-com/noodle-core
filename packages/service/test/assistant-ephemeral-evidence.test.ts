import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { createServiceHandler, InMemoryAssistantStore, ServerRegistry } from '../src/index.js';

const origin = 'https://example.com';
const rawEvidence = 'FULL_TEMPORARY_WEBSITE_TEXT';
const now = new Date('2030-01-01T00:00:00Z');
function modelResponse(message: Record<string, unknown>) {
  return new Response(JSON.stringify({ choices: [{ message }] }), {
    headers: { 'content-type': 'application/json' },
  });
}

describe('assistant extraction evidence custody', () => {
  it.each([
    false,
    true,
  ])('does not persist source content in history, replay or widgets (confirmed: %s)', async (confirm) => {
    const registry = new ServerRegistry();
    const tenant = { org: 'acme', app: 'web', env: 'staging' };
    for (const [kind, name, value] of [
      ['variable', 'MODEL_ORIGIN', 'https://model.example/v1'],
      ['variable', 'MODEL', 'fixture-model'],
      ['secret', 'KEY', 'fixture-key'],
    ] as const)
      await registry.configStore.setConfigValue({
        kind,
        scope: { level: 'env', ...tenant },
        name,
        value,
      });
    const deployed = await registry.deploy(
      tenant,
      JSON.stringify({
        manifestVersion: '1',
        server: {
          name: 'ephemeral',
          title: 'Ephemeral',
          version: '1.0.0',
          assistant: {
            model: {
              kind: 'openai-compatible',
              baseUrl: '${env.MODEL_ORIGIN}',
              model: '${env.MODEL}',
              apiKey: 'KEY',
            },
            allowedOrigins: [origin],
          },
        },
        tools: [
          {
            name: 'read_pages',
            description: 'Return temporary evidence.',
            inputSchema: { type: 'object' },
            annotations: { confirm, readOnlyHint: false, destructiveHint: false },
            fulfilment: {
              steps: [],
              output: {
                text: rawEvidence,
                __noodleResultMeta: { 'noodle/ephemeralEvidence': true },
              },
            },
          },
        ],
        widgets: [
          {
            name: 'evidence',
            tool: 'read_pages',
            title: 'Evidence',
            html: '<!doctype html><main>Evidence</main>',
          },
        ],
      }),
      { accessMode: 'public' },
    );
    if (!deployed.ok) throw new Error(JSON.stringify(deployed.errors));
    const store = new InMemoryAssistantStore();
    const persistView = vi.spyOn(store, 'replaceLatestView');
    const modelFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        modelResponse({
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'read', type: 'function', function: { name: 'read_pages', arguments: '{}' } },
          ],
        }),
      )
      .mockImplementation(async () =>
        modelResponse({ role: 'assistant', content: 'I found the page.' }),
      );
    const server = createServer(
      createServiceHandler(registry, {
        assistantStore: store,
        assistantModelFetch: modelFetch,
        clock: () => now,
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const clientResponse = await fetch(
        `${base}/v1/orgs/acme/apps/web/envs/staging/assistant/clients`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'web' }),
        },
      );
      expect(clientResponse.status).toBe(201);
      const client = await clientResponse.json();
      const sessionResponse = await fetch(`${base}/v1/assistant/sessions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Basic ${Buffer.from(`${client.id}:${client.clientSecret}`).toString('base64')}`,
        },
        body: JSON.stringify({ origin, user: { id: 'customer' } }),
      });
      expect(sessionResponse.status).toBe(201);
      const session = await sessionResponse.json();
      const headers = {
        'content-type': 'application/json',
        authorization: `Bearer ${session.token}`,
        origin,
      };
      const turn = await fetch(`${base}/v1/assistant/turns`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ message: 'Read the page' }),
      });
      expect(turn.status).toBe(200);
      let text = await turn.text();
      if (confirm) {
        const proposal = JSON.parse(/event: tool_proposed\ndata: ([^\n]+)/.exec(text)?.[1] ?? '{}');
        expect(proposal.id).toBeTruthy();
        const interaction = await fetch(session.endpoints.interactions, {
          method: 'POST',
          headers,
          body: JSON.stringify({ id: proposal.id, action: 'accept' }),
        });
        expect(interaction.status).toBe(200);
        text = await interaction.text();
        const replay = await fetch(session.endpoints.interactions, {
          method: 'POST',
          headers,
          body: JSON.stringify({ id: proposal.id, action: 'accept' }),
        });
        expect(await replay.text()).not.toContain(rawEvidence);
      }
      expect(text).toContain(rawEvidence);
      expect(text).toContain('event: view_available');
      expect(JSON.stringify(persistView.mock.calls)).not.toContain(rawEvidence);
      expect(JSON.stringify(await store.getSession(session.token, now))).not.toContain(rawEvidence);
      expect(JSON.stringify(modelFetch.mock.calls)).toContain(rawEvidence);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
