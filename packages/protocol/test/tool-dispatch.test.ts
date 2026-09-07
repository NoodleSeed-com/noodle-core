import { compileManifest, InMemoryCatalog, type Manifest } from '@noodle-borg/compiler';
import {
  InMemoryConnector,
  InMemoryConnectorRegistry,
  StaticServiceBroker,
} from '@noodle-borg/runtime';
import { describe, expect, it, vi } from 'vitest';
import { buildDeps, connectClientTo, resolvedArtifact } from './harness.js';

const signature = {
  type: 'action' as const,
  input: {
    type: 'object' as const,
    properties: { id: { type: 'string' as const } },
    required: ['id'],
    additionalProperties: false,
  },
  output: {
    type: 'object' as const,
    properties: { id: { type: 'string' as const } },
    required: ['id'],
    additionalProperties: false,
  },
};

function fanoutSetup() {
  let connectorCalls = 0;
  const result = compileManifest(
    {
      manifestVersion: '1',
      server: { name: 'fanout', title: 'Fanout', version: '1.0.0' },
      connectors: { actions: { id: 'actions', version: '1.0.0' } },
      tools: [
        {
          name: 'fanout',
          description: 'Run two operations.',
          inputSchema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
            additionalProperties: false,
          },
          fulfilment: {
            steps: [
              { id: 'first', use: 'actions.run', args: { id: '${input.id}' } },
              { id: 'second', use: 'actions.run', args: { id: '${steps.first.id}' } },
            ],
            output: { id: '${steps.second.id}' },
          },
        },
      ],
      resources: [
        {
          name: 'action',
          uri: 'action://one',
          fulfilment: { use: 'actions.run', args: { id: 'resource' } },
        },
      ],
      prompts: [
        {
          name: 'action_prompt',
          fulfilment: { use: 'actions.run', args: { id: 'prompt' } },
        },
      ],
    } as Manifest,
    {
      catalog: new InMemoryCatalog([
        {
          id: 'actions',
          version: '1.0.0',
          kind: 'catalog',
          operations: { run: signature },
        },
      ]),
    },
  );
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  const connector = new InMemoryConnector('actions', '1.0.0', {
    run: {
      signature,
      handler: (args) => {
        connectorCalls += 1;
        return { id: args.id };
      },
    },
  });
  return {
    artifact: result.artifact,
    deps: {
      connectors: new InMemoryConnectorRegistry([connector]),
      broker: new StaticServiceBroker({ token: 'service-token' }),
    },
    connectorCalls: () => connectorCalls,
  };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('MCP tools/call dispatch hook', () => {
  it('runs once across connector fan-out and is reset for each tools/call request', async () => {
    const setup = fanoutSetup();
    const beforeToolDispatch = vi.fn(async () => ({ allow: true as const }));
    const client = await connectClientTo(setup, { beforeToolDispatch });

    await expect(
      client.callTool({
        name: 'fanout',
        arguments: { id: 'A1' },
        _meta: { 'openai/session': 'conversation-1' },
      }),
    ).resolves.toMatchObject({ structuredContent: { id: 'A1' } });
    expect(beforeToolDispatch).toHaveBeenCalledTimes(1);
    expect(beforeToolDispatch).toHaveBeenLastCalledWith({
      toolName: 'fanout',
      toolArguments: { id: 'A1' },
      requestId: expect.any(Number),
      signal: expect.any(AbortSignal),
      requestMeta: { 'openai/session': 'conversation-1' },
    });
    expect(setup.connectorCalls()).toBe(2);

    await client.callTool({ name: 'fanout', arguments: { id: 'A2' } });
    expect(beforeToolDispatch).toHaveBeenCalledTimes(2);
    expect(setup.connectorCalls()).toBe(4);
  });

  it('does not run for unknown or invalid tools/call requests', async () => {
    const beforeToolDispatch = vi.fn(async () => ({ allow: true as const }));
    const client = await connectClientTo(
      { artifact: resolvedArtifact(), deps: buildDeps() },
      { beforeToolDispatch },
    );

    await expect(client.callTool({ name: 'missing', arguments: {} })).rejects.toBeDefined();
    await expect(client.callTool({ name: 'get_order', arguments: {} })).rejects.toBeDefined();
    expect(beforeToolDispatch).not.toHaveBeenCalled();
  });

  it('does not run for noodle_context, resources, or prompts', async () => {
    const setup = fanoutSetup();
    const beforeToolDispatch = vi.fn(async () => ({ allow: true as const }));
    const artifact = {
      ...setup.artifact,
      server: {
        ...setup.artifact.server,
        context: { defaults: { locale: 'en-US', timeZone: 'UTC' } },
      },
    };
    const context = {
      temporal: {
        instant: '2026-07-15T00:00:00.000Z',
        localDate: '2026-07-15',
        localTime: '00:00:00',
        utcOffset: '+00:00',
        weekday: 'Wednesday',
        timeZone: 'UTC',
        locale: 'en-US',
        source: { locale: 'platform-default' as const, timeZone: 'platform-default' as const },
      },
      ambientStatus: 'not_configured' as const,
    };
    const client = await connectClientTo(
      { artifact, deps: { ...setup.deps, context } },
      { invocationContext: context, beforeToolDispatch },
    );

    await client.callTool({ name: 'noodle_context', arguments: {} });
    await client.readResource({ uri: 'action://one' });
    await client.getPrompt({ name: 'action_prompt' });

    expect(beforeToolDispatch).not.toHaveBeenCalled();
    expect(setup.connectorCalls()).toBe(2);
  });

  it('prevents connector dispatch when request admission is denied or fails', async () => {
    const denied = fanoutSetup();
    const deniedClient = await connectClientTo(denied, {
      beforeToolDispatch: async () => ({ allow: false, reason: 'account limit reached' }),
    });
    await expect(
      deniedClient.callTool({ name: 'fanout', arguments: { id: 'A1' } }),
    ).rejects.toBeDefined();
    expect(denied.connectorCalls()).toBe(0);

    const failed = fanoutSetup();
    const failedClient = await connectClientTo(failed, {
      beforeToolDispatch: async () => {
        throw new Error('counter unavailable');
      },
    });
    await expect(
      failedClient.callTool({ name: 'fanout', arguments: { id: 'A1' } }),
    ).rejects.toBeDefined();
    expect(failed.connectorCalls()).toBe(0);
  });

  it('returns a monthly billing hard cap as an MCP tool error instead of a protocol failure', async () => {
    const setup = fanoutSetup();
    const client = await connectClientTo(setup, {
      beforeToolDispatch: async () => ({
        allow: false,
        reason: 'billing_usage_limit_exceeded',
        kind: 'usage_limit_exceeded',
        resetAt: '2026-08-16T08:00:00.000Z',
      }),
    });

    await expect(
      client.callTool({ name: 'fanout', arguments: { id: 'A1' } }),
    ).resolves.toMatchObject({
      isError: true,
      content: [
        {
          type: 'text',
          text: 'Monthly MCP call limit reached. Usage resets at 2026-08-16T08:00:00.000Z.',
        },
      ],
    });
    expect(setup.connectorCalls()).toBe(0);
  });

  it('treats SDK cancellation after asynchronous admission begins as post-dispatch', async () => {
    const setup = fanoutSetup();
    const controller = new AbortController();
    const entered = deferred();
    const release = deferred();
    let serverSignal: AbortSignal | undefined;
    const client = await connectClientTo(setup, {
      beforeToolDispatch: async (dispatch) => {
        serverSignal = dispatch.signal;
        entered.resolve();
        await release.promise;
        return { allow: true };
      },
    });

    const request = client.callTool({ name: 'fanout', arguments: { id: 'A1' } }, undefined, {
      signal: controller.signal,
    });
    const rejected = expect(request).rejects.toBeDefined();
    await entered.promise;
    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(serverSignal?.aborted).toBe(true);
    release.resolve();

    await rejected;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(setup.connectorCalls()).toBe(2);
  });
});
