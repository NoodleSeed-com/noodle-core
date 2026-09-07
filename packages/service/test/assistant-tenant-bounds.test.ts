import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryPublicEmbedStore } from '@noodle-borg/assistant-gateway';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServiceHandler, InMemoryAssistantStore, ServerRegistry } from '../src/index.js';

/**
 * Per-tenant agent-loop bounds, which the sponsored-spend ladder degrades a tenant with.
 *
 * The rule they must obey is one-directional: a tenant policy narrows a turn and can never widen
 * one, so the deployment's admission envelope still wins wherever it is lower. Anything else would
 * let a hosted binding raise a structural maximum, which is the thing the envelope exists to prevent.
 */

const ORIGIN = 'https://www.example.com';
const MANIFEST = `
manifestVersion: "2"
server:
  name: tenant_bounds
  version: 1.0.0
  title: Tenant bounds
  instructions: Answer concisely.
  assistant:
    model:
      kind: noodle-managed
    surfaces:
      - mode: public
        origins: [${ORIGIN}]
        capabilities: [{ kind: tool, name: list_cases }]
    allowedOrigins: [${ORIGIN}]
tools:
  - name: list_cases
    title: List cases
    description: Return the current support cases.
    annotations:
      readOnlyHint: true
    inputSchema:
      type: object
      properties: {}
      additionalProperties: false
    fulfilment:
      steps: []
      output: { cases: [] }
`;

/**
 * The same surface, but its one tool is `requiredWhenVisible`. That tool reaches the model on its own
 * path rather than through the ordinary list, so a zero tool bound that silenced only the ordinary
 * list would still advertise this one — and the model would call it into an exhausted budget.
 */
const REQUIRED_TOOL_MANIFEST = MANIFEST.replace(
  '      readOnlyHint: true',
  '      readOnlyHint: true\n      x-noodleseed-model-required-when-visible: true',
);

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((r) => server.close(r))));
  vi.restoreAllMocks();
});

async function start(
  requestPolicy: Record<string, unknown>,
  manifest = MANIFEST,
  completions?: readonly Record<string, unknown>[],
) {
  const tenant = { org: 'acme', app: 'bounds', env: 'prod' } as const;
  const registry = new ServerRegistry();
  const deployed = await registry.deploy(tenant, manifest, { accessMode: 'public' });
  if (!deployed.ok) throw new Error(JSON.stringify(deployed.errors));

  const requests: { tools: string[]; toolChoice?: unknown }[] = [];
  const modelFetch = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      readonly tools?: readonly { readonly function: { readonly name: string } }[];
      readonly tool_choice?: unknown;
    };
    requests.push({
      tools: (body.tools ?? []).map((tool) => tool.function.name),
      toolChoice: body.tool_choice,
    });
    return Response.json(
      completions?.[Math.min(requests.length - 1, completions.length - 1)] ?? {
        choices: [{ message: { role: 'assistant', content: 'Here is what I know.' } }],
      },
    );
  });
  const publicEmbeds = new InMemoryPublicEmbedStore();
  const embed = await publicEmbeds.ensure({ ...tenant, surfaceMode: 'public', now: new Date() });
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
      managedAssistantModelResolver: {
        resolve: async () => ({
          source: 'noodle-managed' as const,
          baseUrl: 'https://models.example/v1',
          model: 'managed',
          apiKey: 'sponsor-secret',
          requestPolicy,
        }),
      },
    }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const mint = await fetch(`${base}/v1/assistant/public-sessions`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ embedId: embed.embedId }),
  });
  const session = await mint.json();
  const turn = await fetch(session.endpoints.turns, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.token}`,
      origin: ORIGIN,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ message: 'What is open?' }),
  });
  return { body: await turn.text(), status: turn.status, requests };
}

describe('per-tenant agent-loop bounds', () => {
  it('offers the surface tools when the tenant policy sets none', async () => {
    const { status, body, requests } = await start({});
    expect(status, body).toBe(200);
    expect(requests[0]?.tools).toContain('list_cases');
  });

  /**
   * A zero tool bound must remove the tools, not let the model call one and meet
   * `tool_call_budget_exhausted` — that emits an error event, which the widget renders as
   * "temporarily unavailable". The degraded rung has to stay a shorter answer, not a broken one.
   */
  it('offers no tools at all when the tenant policy allows none', async () => {
    const { status, body, requests } = await start({ maxToolCallsPerTurn: 0 });
    expect(status, body).toBe(200);
    expect(requests[0]?.tools ?? []).toEqual([]);
    expect(body).not.toContain('event: error');
    expect(body).toContain('Here is what I know.');
  });

  it('offers no required tool either when the tenant policy allows none', async () => {
    // The ordinary list and the required tool are separate paths into the request. Clearing one and
    // not the other is how a "no tools" rung still spends a model request and ends in an error.
    const visible = await start({}, REQUIRED_TOOL_MANIFEST);
    expect(visible.requests[0]?.tools).toContain('list_cases');
    // `tool_choice: required` is the tell that this really is the required path and not the ordinary
    // list wearing its name — without it the case below would pass for the wrong reason.
    expect(visible.requests[0]?.toolChoice).toBe('required');

    const { status, body, requests } = await start(
      { maxToolCallsPerTurn: 0 },
      REQUIRED_TOOL_MANIFEST,
    );
    expect(status, body).toBe(200);
    expect(requests[0]?.tools ?? []).toEqual([]);
    expect(body).not.toContain('event: error');
  });

  it('caps model steps for this tenant without touching anyone else', async () => {
    const { status, requests } = await start({ maxModelStepsPerTurn: 1 });
    expect(status).toBe(200);
    // One step ran and answered; the bound is a ceiling on the loop, not a refusal.
    expect(requests).toHaveLength(1);
  });

  /**
   * `maxTokensPerTurn` reaches the provider as an output cap that reasoning tokens are billed under
   * but never counted against. A turn that spends its whole budget thinking therefore used to look
   * free: the production surface measured reasoning at 5.4x visible completion, so the cap was
   * bounding roughly a sixth of what the sponsor pays for. The budget has to spend on billed output,
   * whichever half of the split it arrives in.
   */
  it('spends the turn budget on reasoning tokens, not just visible output', async () => {
    const thinkingToolCall = {
      choices: [
        {
          message: {
            role: 'assistant',
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'list_cases', arguments: '{}' } },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 50,
        total_tokens: 2_060,
        completion_tokens_details: { reasoning_tokens: 2_000 },
      },
    };
    const answer = {
      choices: [{ message: { role: 'assistant', content: 'Here is what I know.' } }],
    };

    const { requests, body } = await start(
      { maxTokensPerTurn: 1_000, maxCompletionTokens: 500 },
      MANIFEST,
      [thinkingToolCall, answer],
    );
    // Fifty visible tokens against a thousand-token budget looks like nothing; two thousand thinking
    // tokens exhausted it. A second model request here means the budget never saw them.
    expect(requests).toHaveLength(1);
    expect(body).toContain('model_token_budget_exhausted');
  });

  it('still charges the request limit when a provider reports no usage at all', async () => {
    // The conservative fallback predates this and must survive it: no usage block means assume the
    // step spent everything it was allowed, never that it spent nothing.
    const silentToolCall = {
      choices: [
        {
          message: {
            role: 'assistant',
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'list_cases', arguments: '{}' } },
            ],
          },
        },
      ],
    };
    const { requests } = await start(
      { maxTokensPerTurn: 400, maxCompletionTokens: 400 },
      MANIFEST,
      [
        silentToolCall,
        { choices: [{ message: { role: 'assistant', content: 'Here is what I know.' } }] },
      ],
    );
    expect(requests).toHaveLength(1);
  });
});
