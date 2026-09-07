import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compileManifest,
  InMemoryCatalog,
  type OperationSignature,
  type RuntimeArtifact,
} from '@noodle-borg/compiler';
import {
  type ConfirmationNonceLedger,
  RequestStateManager,
  requestStateSecretBox,
  type ServedArtifact,
} from '@noodle-borg/protocol';
import {
  InMemoryConnector,
  InMemoryConnectorRegistry,
  StaticServiceBroker,
} from '@noodle-borg/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpRouter } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const artifactPath = join(
  here,
  '..',
  '..',
  'compiler',
  'fixtures',
  'valid',
  'minimal.resolved.artifact.json',
);
const SERVICE_CALLER = {
  subject: 'spn_00000000-0000-4000-8000-000000000001',
  scopes: ['todos.read'],
  roles: [],
  identityKind: 'service' as const,
};
const signature: OperationSignature = {
  type: 'read',
  input: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: { order: { type: 'object' } },
    additionalProperties: false,
  },
};
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error === undefined ? resolve() : reject(error))),
          ),
      ),
  );
});

describe('service-principal confirmation boundary', () => {
  it.each([
    'legacy',
    'modern',
  ] as const)('denies a confirmed %s tools/call before every execution-side effect', async (era) => {
    const invoke = vi.fn(() => ({ ok: true }));
    const resolveInvocationContext = vi.fn(async () => ({ env: {} }));
    const beforeToolDispatch = vi.fn(() => ({ allow: true }) as const);
    const seal = vi.fn(async () => 'sealed-state');
    const consume = vi.fn(async () => true);
    const url = await startConfirmedToolServer({
      invoke,
      resolveInvocationContext,
      beforeToolDispatch,
      requestState: { seal } as unknown as RequestStateManager,
      confirmationNonceLedger: { consume } satisfies ConfirmationNonceLedger,
    });

    const response = await callTool(url, era);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: -32001,
        data: { reason: 'human_confirmation_required' },
      },
    });
    expect(resolveInvocationContext).not.toHaveBeenCalled();
    expect(beforeToolDispatch).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(seal).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });

  it('allows ordinary modern missing-input MRTR for a service principal', async () => {
    const url = await startToolServer({
      artifact: elicitingArtifact(),
      caller: SERVICE_CALLER,
      invoke: vi.fn(),
      resolveInvocationContext: vi.fn(async () => ({ env: {} })),
      beforeToolDispatch: vi.fn(() => ({ allow: true }) as const),
      requestState: new RequestStateManager(requestStateSecretBox(Buffer.alloc(32, 7))),
      confirmationNonceLedger: { consume: vi.fn(async () => true) },
    });

    const response = await callTool(url, 'modern', 'choose_team');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        resultType: 'input_required',
        requestState: expect.any(String),
        inputRequests: { team: { method: 'elicitation/create' } },
      },
    });
  });

  it.each([
    'legacy',
    'modern',
  ] as const)('preserves the existing %s confirmation flow for human callers', async (era) => {
    const resolveInvocationContext = vi.fn(async () => ({ env: {} }));
    const url = await startConfirmedToolServer({
      caller: {
        subject: 'human-1',
        scopes: ['todos.read'],
        roles: [],
        identityKind: 'platform',
      },
      invoke: vi.fn(() => ({ ok: true })),
      resolveInvocationContext,
      beforeToolDispatch: vi.fn(() => ({ allow: true }) as const),
      requestState: new RequestStateManager(requestStateSecretBox(Buffer.alloc(32, 8))),
      confirmationNonceLedger: { consume: vi.fn(async () => true) },
    });

    const response = await callTool(url, era);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty('error');
    expect(resolveInvocationContext).toHaveBeenCalledTimes(1);
  });
});

async function startConfirmedToolServer(input: {
  readonly caller?: Caller;
  readonly invoke: (args: Record<string, unknown>) => unknown;
  readonly resolveInvocationContext: () => Promise<{ env: Record<string, string> }>;
  readonly beforeToolDispatch: () => { readonly allow: true };
  readonly requestState: RequestStateManager;
  readonly confirmationNonceLedger: ConfirmationNonceLedger;
}): Promise<string> {
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as RuntimeArtifact;
  const tool = artifact.tools[0];
  if (tool === undefined) throw new Error('missing fixture tool');
  (tool.annotations as Record<string, unknown>).confirm = true;
  return startToolServer({ ...input, artifact, caller: input.caller ?? SERVICE_CALLER });
}

type Caller =
  | typeof SERVICE_CALLER
  | {
      readonly subject: string;
      readonly scopes: readonly string[];
      readonly roles: readonly string[];
      readonly identityKind: 'platform';
    };

async function startToolServer(input: {
  readonly artifact: RuntimeArtifact;
  readonly caller: Caller;
  readonly invoke: (args: Record<string, unknown>) => unknown;
  readonly resolveInvocationContext: () => Promise<{ env: Record<string, string> }>;
  readonly beforeToolDispatch: () => { readonly allow: true };
  readonly requestState: RequestStateManager;
  readonly confirmationNonceLedger: ConfirmationNonceLedger;
}): Promise<string> {
  const connector = new InMemoryConnector('acme_orders', '1.2.0', {
    get_order: { signature, handler: input.invoke },
  });
  const served: ServedArtifact = {
    artifact: input.artifact,
    deps: {
      connectors: new InMemoryConnectorRegistry([connector]),
      broker: new StaticServiceBroker({ token: 'svc' }),
    },
  };
  const server = createServer(
    createMcpRouter(() => Promise.resolve(undefined), {
      tenantLookup: async () => ({
        served,
        deploymentId: 'dep_service_confirmation',
        accessMode: 'authenticated',
        org: 'acme',
        app: 'todoist',
        environment: 'prod',
        verifyToken: async () => ({ caller: input.caller }),
      }),
      resolveInvocationContext: input.resolveInvocationContext,
      beforeToolDispatch: input.beforeToolDispatch,
      requestState: input.requestState,
      confirmationNonceLedger: input.confirmationNonceLedger,
    }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/o/acme/todoist/mcp`;
}

function callTool(url: string, era: 'legacy' | 'modern', name = 'get_order'): Promise<Response> {
  const modern = era === 'modern';
  const params = {
    name,
    arguments: name === 'get_order' ? { order_id: 'A-1' } : {},
    ...(modern
      ? {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
            'io.modelcontextprotocol/clientInfo': { name: 'service-test', version: '1' },
          },
        }
      : {}),
  };
  return fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer service-token',
      'content-type': 'application/json',
      'mcp-protocol-version': modern ? '2026-07-28' : '2025-11-25',
      ...(modern ? { 'mcp-method': 'tools/call', 'mcp-name': name } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params }),
  });
}

function elicitingArtifact(): RuntimeArtifact {
  const compiled = compileManifest(
    {
      manifestVersion: '1',
      server: { name: 'service_input', version: '1.0.0', title: 'Service input' },
      tools: [
        {
          name: 'choose_team',
          description: 'Choose a team.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          fulfilment: {
            steps: [
              {
                id: 'team',
                elicit: {
                  message: 'Which team?',
                  requestedSchema: {
                    type: 'object',
                    properties: { team: { type: 'string' } },
                    required: ['team'],
                  },
                },
              },
            ],
            output: { team: '${steps.team.team}' },
          },
        },
      ],
    },
    { catalog: new InMemoryCatalog([]) },
  );
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
  return compiled.artifact;
}
