import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { defaultKnowledgeStores, wireKnowledge } from '@noodle-borg/knowledge-operations';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createServiceHandler,
  InMemoryAssistantStore,
  InMemoryAuditStore,
  InMemoryConfigStore,
  ServerRegistry,
} from '../src/index.js';

/**
 * The assistant loop half of the generated knowledge tool (ADR 0202): the model sees
 * `search_<name>` with the citation guidance, its call executes read-only through the
 * deployment-bound port, and flipping the gate off unlists the tool on the next turn.
 */

const tenant = { org: 'acme', app: 'support', env: 'prod' } as const;
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const DOC_TEXT = 'Acme pricing starts at ten dollars per seat per month.';

const MANIFEST = JSON.stringify({
  manifestVersion: '2',
  server: {
    name: 'support',
    title: 'Acme Support',
    version: '1.0.0',
    instructions: 'Help visitors with product questions.',
    assistant: {
      model: {
        kind: 'openai-compatible',
        baseUrl: '${env.ASSISTANT_MODEL_BASE_URL}',
        model: '${env.ASSISTANT_MODEL}',
        apiKey: 'ASSISTANT_MODEL_API_KEY',
      },
      allowedOrigins: ['https://app.example.com'],
    },
    knowledge: [
      {
        name: 'product',
        title: 'Product knowledge',
        description: 'Public product information.',
        documents: [
          {
            path: 'docs/pricing.md',
            title: 'Pricing guide',
            sha256: sha(DOC_TEXT),
            bytes: Buffer.byteLength(DOC_TEXT),
          },
        ],
        sites: [],
      },
    ],
  },
  tools: [
    {
      name: 'ping',
      description: 'Ping.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      fulfilment: { steps: [], output: { ok: true } },
    },
  ],
});

describe('assistant loop knowledge tools', () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  async function start() {
    const configStore = new InMemoryConfigStore();
    const registry = new ServerRegistry(undefined, undefined, configStore);
    const stores = defaultKnowledgeStores();
    wireKnowledge(
      registry,
      stores,
      (ref) =>
        configStore.resolveConfigValues('variable', {
          level: 'env',
          org: ref.org,
          app: ref.app,
          env: ref.env,
        }),
      1024 * 1024,
    );
    const scope = { level: 'env' as const, ...tenant };
    for (const [name, value] of [
      ['ASSISTANT_MODEL_BASE_URL', 'https://models.example/v1'],
      ['ASSISTANT_MODEL', 'acme-model'],
      ['NOODLE_KNOWLEDGE_ENABLED', 'true'],
    ] as const) {
      await configStore.setConfigValue({ kind: 'variable', scope, name, value });
    }
    await configStore.setConfigValue({
      kind: 'secret',
      scope,
      name: 'ASSISTANT_MODEL_API_KEY',
      value: 'provider-key',
    });
    await stores.staging.put(
      'acme/support/prod',
      sha(DOC_TEXT),
      Buffer.from(DOC_TEXT),
      Buffer.byteLength(DOC_TEXT),
    );
    const deployed = await registry.deploy(tenant, MANIFEST, {
      accessMode: 'public',
    });
    expect(deployed.ok).toBe(true);

    const modelFetch = vi.fn<typeof fetch>();
    const server = createServer(
      createServiceHandler(registry, {
        assistantStore: new InMemoryAssistantStore(),
        assistantModelFetch: modelFetch,
        audit: new InMemoryAuditStore(),
        configStore,
      }),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const created = await fetch(`${base}/v1/orgs/acme/apps/support/envs/prod/assistant/clients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'web' }),
    });
    const client = await created.json();
    const basic = Buffer.from(`${client.id}:${client.clientSecret}`).toString('base64');
    const sessionResponse = await fetch(`${base}/v1/assistant/sessions`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        origin: 'https://app.example.com',
        user: { id: 'customer-1', email: 'person@example.com' },
      }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = await sessionResponse.json();
    return { base, modelFetch, session, configStore, scope };
  }

  function turn(base: string, token: string, message: string): Promise<Response> {
    return fetch(`${base}/v1/assistant/turns`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        origin: 'https://app.example.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message }),
    });
  }

  const modelReply = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('lists the generated tool with citation guidance, executes it, and answers from hits', async () => {
    const { base, modelFetch, session } = await start();
    modelFetch
      .mockResolvedValueOnce(
        modelReply({
          choices: [
            {
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'call-1',
                    type: 'function',
                    function: {
                      name: 'search_product',
                      arguments: JSON.stringify({ query: 'pricing' }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        }),
      )
      .mockResolvedValueOnce(
        modelReply({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Pricing starts at $10/seat (see Pricing guide).',
              },
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 8 },
        }),
      );

    const response = await turn(base, session.token, 'What does Acme cost?');
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain('Pricing starts at $10/seat');

    const firstBody = String(modelFetch.mock.calls[0]?.[1]?.body);
    expect(firstBody).toContain('search_product');
    expect(firstBody).toContain('cite only the returned hits');

    const secondBody = String(modelFetch.mock.calls[1]?.[1]?.body);
    expect(secondBody).toContain('Pricing guide');
    expect(secondBody).toContain('pricing starts at ten dollars');
  });

  it('unlists the tool when the gate is flipped off after deploy (kill switch)', async () => {
    const { base, modelFetch, session, configStore, scope } = await start();
    await configStore.setConfigValue({
      kind: 'variable',
      scope,
      name: 'NOODLE_KNOWLEDGE_ENABLED',
      value: 'false',
    });
    modelFetch.mockResolvedValueOnce(
      modelReply({
        choices: [{ message: { role: 'assistant', content: 'Hello.' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
    );
    const response = await turn(base, session.token, 'Hello');
    expect(response.status).toBe(200);
    await response.text();
    const body = String(modelFetch.mock.calls[0]?.[1]?.body);
    expect(body).not.toContain('search_product');
  });
});

describe('assistant/MCP argument-validation parity', () => {
  /**
   * The same arguments must get the same verdict on both surfaces. The MCP intercept coerces
   * against the component's generated tool schema; the assistant path once accepted anything
   * with a string `query` and silently ignored a malformed `limit`, so identical calls behaved
   * differently by transport. The oracle here IS the MCP validator — divergence is
   * unrepresentable, not merely untested.
   */
  it('agrees with the MCP validator on every payload, valid and invalid', async () => {
    const { compileKnowledgeComponents } = await import('@noodle-borg/knowledge');
    const { coerceToolArguments } = await import('@noodle-borg/protocol');
    const { executeAssistantKnowledgeSearch } = await import(
      '../src/routes/assistant-knowledge.js'
    );
    const issues: unknown[] = [];
    const [component] = compileKnowledgeComponents(
      [
        {
          name: 'product',
          title: 'Product',
          description: 'Docs.',
          documents: [{ path: 'a.md', title: 'A', sha256: sha('doc'), bytes: 3 }],
          sites: [],
        },
      ],
      undefined,
      issues as never,
    );
    expect(issues).toEqual([]);
    if (component === undefined) throw new Error('compile produced no component');

    const searches: unknown[] = [];
    const knowledge = {
      components: [component] as never,
      port: {
        enabled: async () => true,
        search: async (name: string, request: unknown) => {
          searches.push({ name, request });
          return { ok: true as const, hits: [] };
        },
      } as never,
    };
    const payloads: unknown[] = [
      { query: 'pricing' },
      { query: 'pricing', limit: 3 },
      {},
      { query: 42 },
      { query: 'pricing', limit: 'three' },
      { query: '' },
    ];
    let valid = 0;
    for (const payload of payloads) {
      const oracle = coerceToolArguments(component.generatedTool.inputSchema, payload);
      if (oracle.issues.length === 0) valid += 1;
      const outcome = JSON.parse(
        await executeAssistantKnowledgeSearch(knowledge as never, component as never, payload),
      ) as { error?: string };
      expect(outcome.error === 'invalid_arguments', JSON.stringify({ payload, outcome })).toBe(
        oracle.issues.length > 0,
      );
    }
    // Every oracle-valid payload reached the port; no oracle-invalid one did.
    expect(searches).toHaveLength(valid);
    expect(valid).toBeGreaterThan(0);
  });
});
