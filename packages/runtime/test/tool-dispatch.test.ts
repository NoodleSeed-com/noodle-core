import {
  compileManifest,
  InMemoryCatalog,
  type Manifest,
  type OperationSignature,
  type RuntimeArtifact,
} from '@noodle-borg/compiler';
import { describe, expect, it, vi } from 'vitest';
import type { CredentialBroker } from '../src/broker/types.js';
import { InMemoryConnector, InMemoryConnectorRegistry } from '../src/connector/in-memory.js';
import type { Connector, ConnectorCall } from '../src/connector/types.js';
import {
  type ExecuteToolDeps,
  executePrompt,
  executeResource,
  executeTool,
} from '../src/execute.js';
import type { PolicyGate } from '../src/policy/types.js';

const signature: OperationSignature = {
  type: 'action',
  input: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
};

const catalog = new InMemoryCatalog([
  {
    id: 'actions',
    version: '1.0.0',
    kind: 'catalog',
    operations: { run: signature },
  },
]);

function compile(extra: Partial<Manifest> = {}): RuntimeArtifact {
  const result = compileManifest(
    {
      manifestVersion: '1',
      server: { name: 'dispatch', title: 'Dispatch', version: '1.0.0' },
      connectors: { actions: { id: 'actions', version: '1.0.0' } },
      tools: [
        {
          name: 'run',
          description: 'Run an action.',
          inputSchema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
            additionalProperties: false,
          },
          fulfilment: { use: 'actions.run', args: { id: '${input.id}' } },
        },
      ],
      ...extra,
    } as Manifest,
    { catalog },
  );
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.artifact;
}

function connector(handler: (call: ConnectorCall) => unknown = (call) => ({ id: call.args.id })) {
  return new InMemoryConnector('actions', '1.0.0', {
    run: {
      signature,
      handler: (args, credential) => handler({ operation: 'run', args, credential }),
    },
  });
}

function deps(target: Connector, overrides: Partial<ExecuteToolDeps> = {}): ExecuteToolDeps {
  return {
    connectors: new InMemoryConnectorRegistry([target]),
    broker: { getCredential: async () => ({ token: 'service-token' }) },
    ...overrides,
  };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('tool execution dispatch hook', () => {
  it('runs after policy, credentials, and argument isolation, immediately before connector dispatch', async () => {
    const events: string[] = [];
    const policy: PolicyGate = {
      before: async () => {
        events.push('policy-before');
        return { allow: true };
      },
      after: async (_context, output) => {
        events.push('policy-after');
        return output;
      },
    };
    const broker: CredentialBroker = {
      getCredential: async () => {
        events.push('credential');
        return { token: 'service-token' };
      },
    };
    const target = connector(() => {
      events.push('connector');
      return { id: 'A1' };
    });

    const result = await executeTool(
      compile(),
      'run',
      { id: 'A1' },
      deps(target, {
        policy,
        broker,
        beforeDispatch: async ({ toolName }) => {
          events.push(`dispatch:${toolName}`);
          return { allow: true };
        },
      }),
    );

    expect(result).toEqual({ ok: true, output: { id: 'A1' } });
    expect(events).toEqual([
      'policy-before',
      'credential',
      'dispatch:run',
      'connector',
      'policy-after',
    ]);
  });

  it('records dispatch before a connector failure and before a post-dispatch policy failure', async () => {
    const connectorDispatch = vi.fn(async () => ({ allow: true as const }));
    const failingConnector = connector(() => {
      throw new Error('downstream failed');
    });

    await expect(
      executeTool(
        compile(),
        'run',
        { id: 'A1' },
        deps(failingConnector, { beforeDispatch: connectorDispatch }),
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'connector_error' } });
    expect(connectorDispatch).toHaveBeenCalledOnce();

    const postPolicyDispatch = vi.fn(async () => ({ allow: true as const }));
    const policy: PolicyGate = {
      before: async () => ({ allow: true }),
      after: async () => {
        throw new Error('post policy failed');
      },
    };
    await expect(
      executeTool(
        compile(),
        'run',
        { id: 'A1' },
        deps(connector(), { policy, beforeDispatch: postPolicyDispatch }),
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'policy_error' } });
    expect(postPolicyDispatch).toHaveBeenCalledOnce();

    const invalidOutputDispatch = vi.fn(async () => ({ allow: true as const }));
    await expect(
      executeTool(
        compile(),
        'run',
        { id: 'A1' },
        deps(
          connector(() => ({ id: 42 })),
          { beforeDispatch: invalidOutputDispatch },
        ),
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'output_invalid' } });
    expect(invalidOutputDispatch).toHaveBeenCalledOnce();
  });

  it('does not run for unknown tools, invalid arguments, policy denial, or credential failure', async () => {
    const beforeDispatch = vi.fn(async () => ({ allow: true as const }));
    const target = connector();
    const artifact = compile();

    await expect(
      executeTool(artifact, 'missing', {}, deps(target, { beforeDispatch })),
    ).resolves.toMatchObject({ ok: false, error: { code: 'unknown_tool' } });
    await expect(
      executeTool(artifact, 'run', {}, deps(target, { beforeDispatch })),
    ).resolves.toMatchObject({ ok: false, error: { code: 'arg_invalid' } });

    const policy: PolicyGate = {
      before: async () => ({ allow: false, reason: 'blocked' }),
      after: async (_context, output) => output,
    };
    await expect(
      executeTool(artifact, 'run', { id: 'A1' }, deps(target, { policy, beforeDispatch })),
    ).resolves.toMatchObject({ ok: false, error: { code: 'policy_denied' } });

    const broker: CredentialBroker = {
      getCredential: async () => {
        throw new Error('unavailable');
      },
    };
    await expect(
      executeTool(artifact, 'run', { id: 'A1' }, deps(target, { broker, beforeDispatch })),
    ).resolves.toMatchObject({ ok: false, error: { code: 'credential_unavailable' } });

    expect(beforeDispatch).not.toHaveBeenCalled();
  });

  it.each([
    'policy',
    'credential',
  ] as const)('does not meter or invoke when cancellation occurs during %s resolution', async (stage) => {
    const controller = new AbortController();
    const entered = deferred();
    const release = deferred();
    const beforeDispatch = vi.fn(async () => ({ allow: true as const }));
    const connectorCalls = vi.fn();
    const target = connector((call) => {
      connectorCalls(call);
      return { id: 'A1' };
    });
    const policy: PolicyGate = {
      before: async () => {
        if (stage === 'policy') {
          entered.resolve();
          await release.promise;
        }
        return { allow: true };
      },
      after: async (_context, output) => output,
    };
    const broker: CredentialBroker = {
      getCredential: async () => {
        if (stage === 'credential') {
          entered.resolve();
          await release.promise;
        }
        return { token: 'service-token' };
      },
    };

    const execution = executeTool(
      compile(),
      'run',
      { id: 'A1' },
      deps(target, {
        policy,
        broker,
        beforeDispatch,
        signal: controller.signal,
      }),
    );
    await entered.promise;
    controller.abort();
    release.resolve();

    await expect(execution).resolves.toMatchObject({
      ok: false,
      error: { code: 'execution_cancelled' },
    });
    expect(beforeDispatch).not.toHaveBeenCalled();
    expect(connectorCalls).not.toHaveBeenCalled();
  });

  it('treats cancellation after asynchronous admission begins as post-dispatch', async () => {
    const controller = new AbortController();
    const entered = deferred();
    const release = deferred();
    const connectorCalls = vi.fn();
    const beforeDispatch = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return { allow: true as const };
    });
    const target = connector((call) => {
      connectorCalls(call);
      return { id: 'A1' };
    });

    const execution = executeTool(
      compile(),
      'run',
      { id: 'A1' },
      deps(target, { beforeDispatch, signal: controller.signal }),
    );
    await entered.promise;
    controller.abort();
    release.resolve();

    await expect(execution).resolves.toEqual({ ok: true, output: { id: 'A1' } });
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(connectorCalls).toHaveBeenCalledOnce();
  });

  it('prevents connector invocation when dispatch is denied or the hook rejects', async () => {
    const connectorCalls = vi.fn();
    const target = connector((call) => {
      connectorCalls(call);
      return { id: 'A1' };
    });

    await expect(
      executeTool(
        compile(),
        'run',
        { id: 'A1' },
        deps(target, {
          beforeDispatch: async () => ({ allow: false, reason: 'account limit reached' }),
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: 'dispatch_denied', message: 'account limit reached' },
    });

    await expect(
      executeTool(
        compile(),
        'run',
        { id: 'A1' },
        deps(target, {
          beforeDispatch: async () => {
            throw new Error('counter unavailable');
          },
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'execution_admission_error' },
    });
    expect(connectorCalls).not.toHaveBeenCalled();
  });

  it('preserves a typed monthly-usage denial for the MCP adapter', async () => {
    const connectorCalls = vi.fn();
    const target = connector((call) => {
      connectorCalls(call);
      return { id: 'A1' };
    });

    await expect(
      executeTool(
        compile(),
        'run',
        { id: 'A1' },
        deps(target, {
          beforeDispatch: async () => ({
            allow: false,
            reason: 'billing_usage_limit_exceeded',
            kind: 'usage_limit_exceeded',
            resetAt: '2026-08-16T08:00:00.000Z',
          }),
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'usage_limit_exceeded',
        message: 'Monthly MCP call limit reached. Usage resets at 2026-08-16T08:00:00.000Z.',
        reason: 'billing_usage_limit_exceeded',
        resetAt: '2026-08-16T08:00:00.000Z',
      },
    });
    expect(connectorCalls).not.toHaveBeenCalled();
  });

  it('suppresses connector execution for an already-admitted retry', async () => {
    const connectorCalls = vi.fn();
    const target = connector((call) => {
      connectorCalls(call);
      return { id: 'A1' };
    });

    await expect(
      executeTool(
        compile(),
        'run',
        { id: 'A1' },
        deps(target, {
          beforeDispatch: async () => ({
            allow: false,
            reason: 'billing_usage_duplicate_suppressed',
            kind: 'duplicate_execution_suppressed',
          }),
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'duplicate_execution_suppressed',
        message:
          'This retry was already admitted. Its result was not replayed and any connector effect was suppressed; verify the original outcome before issuing a new request.',
        reason: 'billing_usage_duplicate_suppressed',
      },
    });
    expect(connectorCalls).not.toHaveBeenCalled();
  });

  it('meters connector-free tools once without metering connector-backed resources or prompts', async () => {
    const beforeDispatch = vi.fn(async () => ({ allow: true as const }));
    const executionDeps = deps(connector(), { beforeDispatch });
    const artifact = compile({
      tools: [
        {
          name: 'pure',
          description: 'Return a constant.',
          inputSchema: { type: 'object', additionalProperties: false },
          fulfilment: { steps: [], output: { ok: true } },
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
    });

    await expect(executeTool(artifact, 'pure', {}, executionDeps)).resolves.toMatchObject({
      ok: true,
    });
    await expect(executeResource(artifact, 'action', {}, executionDeps)).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      executePrompt(artifact, 'action_prompt', {}, executionDeps),
    ).resolves.toMatchObject({ ok: true });

    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(beforeDispatch).toHaveBeenCalledWith({ toolName: 'pure' });
  });

  it('fails closed when connector-free tool admission is denied or unavailable', async () => {
    const artifact = compile({
      connectors: {},
      tools: [
        {
          name: 'pure',
          description: 'Return a constant.',
          inputSchema: { type: 'object', additionalProperties: false },
          fulfilment: { steps: [], output: { ok: true } },
        },
      ],
    });

    await expect(
      executeTool(
        artifact,
        'pure',
        {},
        deps(connector(), {
          beforeDispatch: async () => ({
            allow: false,
            reason: 'billing_usage_limit_exceeded',
            kind: 'usage_limit_exceeded',
            resetAt: '2026-08-16T08:00:00.000Z',
          }),
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'usage_limit_exceeded' },
    });

    await expect(
      executeTool(
        artifact,
        'pure',
        {},
        deps(connector(), {
          beforeDispatch: async () => {
            throw new Error('counter unavailable');
          },
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'execution_admission_error' },
    });

    await expect(
      executeTool(
        artifact,
        'pure',
        {},
        deps(connector(), {
          beforeDispatch: async () => ({
            allow: false,
            reason: 'billing_usage_duplicate_suppressed',
            kind: 'duplicate_execution_suppressed',
          }),
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'duplicate_execution_suppressed' },
    });
  });
});
