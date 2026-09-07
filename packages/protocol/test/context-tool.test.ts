import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { RuntimeArtifact } from '@noodle-borg/compiler';
import type { InvocationContext } from '@noodle-borg/runtime';
import { describe, expect, it } from 'vitest';
import { buildMcpServer } from '../src/index.js';
import { buildDeps, connectClientTo, resolvedArtifact } from './harness.js';

const CONTEXT_TOOL_NAME = 'noodle_context';

const snapshot = {
  temporal: {
    instant: '2026-07-14T04:30:00.000Z',
    localDate: '2026-07-14',
    localTime: '09:30:00',
    utcOffset: '+05:00',
    weekday: 'Tuesday',
    timeZone: 'Asia/Karachi',
    locale: 'en-PK',
    source: { locale: 'client-hint', timeZone: 'user-preference' },
  },
  ambientStatus: 'available',
  ambient: {
    workingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
    defaultTeam: 'Noodle',
  },
  location: {
    latitude: 31.5204,
    longitude: 74.3587,
    city: 'Lahore',
    region: 'Punjab',
    country: 'PK',
    timeZone: 'Asia/Karachi',
    source: 'client-hint',
  },
} satisfies InvocationContext;

function withContext(artifact: RuntimeArtifact = resolvedArtifact()): RuntimeArtifact {
  return {
    ...artifact,
    server: {
      ...artifact.server,
      context: { defaults: { locale: 'en-PK', timeZone: 'Asia/Karachi' } },
    },
  };
}

describe('reserved noodle_context tool', () => {
  it('is omitted when the artifact does not declare server context', async () => {
    const client = await connectClientTo({ artifact: resolvedArtifact(), deps: buildDeps() });

    await expect(client.listTools()).resolves.toMatchObject({
      tools: [{ name: 'get_order' }],
    });
  });

  it('preserves an author tool named noodle_context when no adapter is declared', async () => {
    const artifact = resolvedArtifact();
    const first = artifact.tools[0];
    if (!first) throw new Error('fixture must declare a tool');
    const client = await connectClientTo({
      artifact: { ...artifact, tools: [{ ...first, name: CONTEXT_TOOL_NAME }] },
      deps: buildDeps(),
    });

    await expect(client.listTools()).resolves.toMatchObject({
      tools: [{ name: CONTEXT_TOOL_NAME }],
    });
    await expect(
      client.callTool({ name: CONTEXT_TOOL_NAME, arguments: { order_id: 'A1' } }),
    ).resolves.toMatchObject({ structuredContent: { order: { id: 'A1' } } });
  });

  it('is listed as a read-only, model-callable tool with no arguments', async () => {
    const client = await connectClientTo({
      artifact: withContext(),
      deps: { ...buildDeps(), context: snapshot },
    });

    const { tools } = await client.listTools();
    const contextTool = tools.find((tool) => tool.name === CONTEXT_TOOL_NAME);

    expect(contextTool).toMatchObject({
      name: CONTEXT_TOOL_NAME,
      description: expect.any(String),
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        required: ['temporal', 'ambientStatus'],
        properties: {
          location: {
            type: 'object',
            required: ['latitude', 'longitude', 'source'],
          },
        },
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
    expect(contextTool?._meta).toBeUndefined();
  });

  it('returns the already-resolved invocation snapshot as structured content', async () => {
    const client = await connectClientTo({
      artifact: withContext(),
      deps: { ...buildDeps(), context: snapshot },
    });

    const result = await client.callTool({ name: CONTEXT_TOOL_NAME, arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(snapshot);
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(snapshot) }]);
  });

  it('rejects arguments instead of silently accepting surface-specific state', async () => {
    const client = await connectClientTo({
      artifact: withContext(),
      deps: { ...buildDeps(), context: snapshot },
    });

    await expect(
      client.callTool({ name: CONTEXT_TOOL_NAME, arguments: { sessionId: 'embed-session' } }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('fails closed when the request adapter did not resolve invocation context', async () => {
    const client = await connectClientTo({ artifact: withContext(), deps: buildDeps() });

    await expect(client.callTool({ name: CONTEXT_TOOL_NAME, arguments: {} })).rejects.toMatchObject(
      { code: ErrorCode.InternalError },
    );
  });

  it('rejects an author tool that collides with the reserved name', () => {
    const artifact = withContext();
    const firstTool = artifact.tools[0];
    if (firstTool === undefined) throw new Error('fixture must declare a tool');
    const collidingArtifact: RuntimeArtifact = {
      ...artifact,
      tools: [...artifact.tools, { ...firstTool, name: CONTEXT_TOOL_NAME }],
    };

    expect(() =>
      buildMcpServer({ artifact: collidingArtifact, deps: { ...buildDeps(), context: snapshot } }),
    ).toThrow(/reserved.*noodle_context|noodle_context.*reserved/i);
  });
});
