import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport, type Transport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';

import { run } from '../src/cli.js';
import { recordManagedInvocation } from '../src/plugin-mode/build-readiness-recorder.js';
import {
  type BuildCommandRequest,
  type BuildCommandResult,
  type BuildReadinessCommandRunner,
  createBuildReadinessMcpServer,
} from '../src/plugin-mode/build-readiness-server.js';
import { BuildReadinessStore } from '../src/plugin-mode/build-readiness-store.js';
import { BUILD_READINESS_WIDGET_URI } from '../src/plugin-mode/build-readiness-widget.js';
import type { PluginMode } from '../src/plugin-mode/profile.js';

const roots: string[] = [];
const clients: Client[] = [];
const servers: Array<{ close(): Promise<void> }> = [];
const NOW = new Date('2026-07-18T04:00:00.000Z');

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakeRunner implements BuildReadinessCommandRunner {
  readonly requests: BuildCommandRequest[] = [];
  readonly cancelled: string[] = [];
  exitCode = 0;
  deployExitCode: number | undefined;
  stdout: string | undefined;
  error: Error | undefined;

  constructor(private readonly mode: PluginMode) {}

  async run(request: BuildCommandRequest): Promise<BuildCommandResult> {
    this.requests.push(request);
    if (this.error !== undefined) throw this.error;
    const commandExitCode =
      request.command === 'deploy' && this.deployExitCode !== undefined
        ? this.deployExitCode
        : this.exitCode;
    const exitCode = await recordManagedInvocation(
      {
        command: request.command,
        argv: request.args,
        cwd: request.cwd,
        pluginMode: this.mode,
        now: () => NOW,
      },
      async () => commandExitCode,
    );
    const stdout =
      request.command === 'deploy' && this.stdout !== undefined
        ? this.stdout
        : request.command === 'orgs'
          ? JSON.stringify({ ok: true, data: { orgs: [{ slug: 'acme' }] } })
          : request.command === 'target'
            ? JSON.stringify({
                ok: true,
                data: {
                  target: {
                    runtime: { value: 'cloud', source: 'config' },
                    service: { value: 'https://cloud.noodleseed.dev', source: 'link' },
                    org: { value: 'acme', source: 'link' },
                    app: { value: 'support', source: 'link' },
                    env: { value: 'staging', source: 'link' },
                  },
                },
              })
            : '';
    return { exitCode, stdout, stderr: '' };
  }

  async cancel(runId: string): Promise<boolean> {
    this.cancelled.push(runId);
    return true;
  }
}

async function setup(versionNegotiation: 'legacy' | 'pinned-modern' = 'legacy') {
  const root = await mkdtemp(join(tmpdir(), 'noodle-readiness-mcp-'));
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'noodle.json'), '{"entry":"src/server.ts"}\n');
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  await writeFile(join(root, 'src/server.ts'), 'export const value = 1;\n');
  const mode: PluginMode = {
    host: 'codex',
    configHome: join(root, '.profile'),
    compatibilityFile: join(root, 'noodle-plugin-compatibility.json'),
  };
  const runner = new FakeRunner(mode);
  const client = new Client(
    { name: 'build-readiness-test', version: '1.0.0' },
    {
      capabilities: {},
      versionNegotiation:
        versionNegotiation === 'legacy' ? { mode: 'legacy' } : { mode: { pin: '2026-07-28' } },
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = serveStdio(
    () =>
      createBuildReadinessMcpServer({
        workspaceRoot: root,
        pluginMode: mode,
        runner,
        now: () => NOW,
      }),
    { legacy: 'serve', transport: serverTransport as Transport },
  );
  await client.connect(clientTransport as Transport);
  clients.push(client);
  servers.push(server);
  const context = await client.callTool({ name: 'get_local_context', arguments: {} });
  const data = (context.structuredContent as { data: { workspaceHandle: string } }).data;
  return { root, mode, runner, client, workspaceHandle: data.workspaceHandle };
}

describe('local Build Readiness MCP', () => {
  it.each([
    'legacy',
    'pinned-modern',
  ] as const)('preflights without requiring a link or recording publication (%s)', async (era) => {
    const { client, runner, workspaceHandle, root, mode } = await setup(era);
    runner.stdout = JSON.stringify({
      ok: true,
      data: {
        ok: true,
        ready: true,
        published: false,
        serverVersion: '2',
        target: {
          org: 'acme',
          app: 'support',
          env: 'staging',
          appState: 'will-create',
          environmentState: 'will-create',
        },
        config: { ready: true, missingSecrets: [], missingVariables: [] },
        errors: [],
      },
    });
    const result = await client.callTool({
      name: 'preflight_build',
      arguments: {
        workspaceHandle,
        org: 'acme',
        app: 'support',
        environment: 'staging',
        version: '2',
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: {
        operation: 'preflight',
        preflight: { ready: true, published: false, serverVersion: '2' },
      },
    });
    expect(runner.requests).toEqual([
      expect.objectContaining({
        command: 'deploy',
        args: [
          'preflight',
          '--org',
          'acme',
          '--app',
          'support',
          '--env',
          'staging',
          '--json',
          '--no-prompt',
          '--version',
          '2',
        ],
      }),
    ]);
    const { resolveWorkspaceIdentity } = await import(
      '../src/plugin-mode/build-readiness-fingerprint.js'
    );
    const store = new BuildReadinessStore(join(mode.configHome, 'build-readiness'));
    expect(await store.read(resolveWorkspaceIdentity(root).workspaceHandle)).toBeUndefined();
    expect(
      (await client.listTools()).tools.find((tool) => tool.name === 'preflight_build')?.annotations,
    ).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
  });

  it('retains the complete configuration and validation checklist for plugin agents', async () => {
    const { client, runner, workspaceHandle } = await setup();
    runner.deployExitCode = 1;
    runner.stdout = JSON.stringify({
      ok: false,
      error: {
        code: 'deploy_preflight_failed',
        message: 'Missing configuration and auth',
        errors: [
          { code: 'server_auth_required', path: 'server.auth', message: 'Add customer auth' },
        ],
        detail: {
          missingSecrets: ['API_TOKEN'],
          missingVariables: ['ORIGIN'],
          actions: [
            'noodle secrets set API_TOKEN --from-env API_TOKEN',
            'noodle variables set ORIGIN --from-env ORIGIN',
          ],
        },
      },
    });
    const result = await client.callTool({
      name: 'preflight_build',
      arguments: { workspaceHandle, org: 'acme', app: 'support', environment: 'staging' },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: {
        preflight: {
          missingSecrets: ['API_TOKEN'],
          missingVariables: ['ORIGIN'],
          actions: expect.any(Array),
          errors: [
            { code: 'server_auth_required', path: 'server.auth', message: 'Add customer auth' },
          ],
        },
      },
    });
    expect(runner.requests).toHaveLength(1);
  });

  it.each([
    'wrong-target',
    'wrong-version',
    'inconsistent',
    'malformed',
  ])('rejects %s plugin preflight evidence', async (kind) => {
    const { client, runner, workspaceHandle } = await setup();
    runner.stdout =
      kind === 'malformed'
        ? '{'
        : JSON.stringify({
            ok: true,
            data: {
              ok: true,
              ready: true,
              published: false,
              serverVersion: kind === 'wrong-version' ? '9' : '2',
              target: {
                org: kind === 'wrong-target' ? 'other' : 'acme',
                app: 'support',
                env: 'staging',
                appState: 'existing',
                environmentState: 'existing',
              },
              config: { ready: kind !== 'inconsistent', missingSecrets: [], missingVariables: [] },
              errors: [],
            },
          });
    const result = await client.callTool({
      name: 'preflight_build',
      arguments: {
        workspaceHandle,
        org: 'acme',
        app: 'support',
        environment: 'staging',
        version: '2',
      },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false });
    expect(runner.requests).toHaveLength(1);
  });

  it('rejects an out-of-scope workspace before invoking the preflight command', async () => {
    const { client, runner } = await setup();
    const result = await client.callTool({
      name: 'preflight_build',
      arguments: {
        workspaceHandle: 'abcdefghijklmnopqrstuv',
        org: 'acme',
        app: 'support',
        environment: 'staging',
      },
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: 'workspace_out_of_scope' } },
    });
    expect(runner.requests).toEqual([]);
  });

  it('compares the normalized numeric version returned by the public CLI', async () => {
    const { client, runner, workspaceHandle } = await setup();
    runner.stdout = JSON.stringify({
      ok: true,
      data: {
        ok: true,
        ready: true,
        published: false,
        serverVersion: '2',
        target: {
          org: 'acme',
          app: 'support',
          env: 'staging',
          appState: 'existing',
          environmentState: 'existing',
        },
        config: { ready: true, missingSecrets: [], missingVariables: [] },
        errors: [],
      },
    });
    const result = await client.callTool({
      name: 'preflight_build',
      arguments: {
        workspaceHandle,
        org: 'acme',
        app: 'support',
        environment: 'staging',
        version: '02',
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: { preflight: { serverVersion: '2' } },
    });
  });

  it('serves modern stdio requests while retaining explicit legacy mode', async () => {
    const modern = await setup('pinned-modern');
    expect(modern.client.getProtocolEra()).toBe('modern');
    expect(modern.client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    await expect(modern.client.listTools()).resolves.toMatchObject({
      tools: expect.arrayContaining([expect.objectContaining({ name: 'get_local_context' })]),
    });
  });

  it('keeps the stdio entrypoint unavailable outside signed plugin mode', async () => {
    await expect(run(['plugin-mcp'], {}, '/tmp/noodle-public-home')).resolves.toBe(2);
  });

  it('publishes only bounded plugin functions with strict schemas and impact annotations', async () => {
    const { client } = await setup();
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      'get_local_context',
      'setup_project',
      'get_build_readiness',
      'run_build_gate',
      'preflight_build',
      'link_cloud_project',
      'set_cloud_variable',
      'set_cloud_secret_from_env',
      'deploy_build',
      'preview_product_feedback',
      'submit_product_feedback',
      'cancel_build_run',
    ]);
    expect(tools.find((tool) => tool.name === 'run_build_gate')?.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['workspaceHandle', 'operation'],
      properties: {
        operation: { enum: ['validate', 'test', 'target-check', 'preview'] },
      },
    });
    expect(tools.find((tool) => tool.name === 'get_build_readiness')?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(tools.find((tool) => tool.name === 'get_build_readiness')?._meta).toEqual({
      ui: { resourceUri: BUILD_READINESS_WIDGET_URI },
      'openai/outputTemplate': BUILD_READINESS_WIDGET_URI,
    });
    expect(tools.find((tool) => tool.name === 'deploy_build')?.annotations).toMatchObject({
      readOnlyHint: false,
      openWorldHint: true,
    });
    for (const tool of tools) {
      const schema = JSON.stringify(tool.inputSchema);
      expect(schema, tool.name).not.toMatch(/"command"|"argv"|"path"|"secretValue"/);
    }
  });

  it('returns an opaque local context and rejects a workspace outside its scope', async () => {
    const { root, client, workspaceHandle } = await setup();
    const context = await client.callTool({ name: 'get_local_context', arguments: {} });
    expect(context.structuredContent).toMatchObject({
      ok: true,
      data: {
        workspaceHandle,
        capabilities: { widgets: true, tasks: false, subscriptions: false },
      },
    });
    expect(JSON.stringify(context.structuredContent)).not.toContain(root);
    const denied = await client.callTool({
      name: 'get_build_readiness',
      arguments: { workspaceHandle: 'abcdefghijklmnopqrstuv' },
    });
    expect(denied).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: 'workspace_out_of_scope' } },
    });
  });

  it('serves the Build Readiness MCP App as a closed local resource', async () => {
    const { client } = await setup();
    const resources = await client.listResources();
    expect(resources.resources).toEqual([
      expect.objectContaining({
        uri: BUILD_READINESS_WIDGET_URI,
        mimeType: 'text/html;profile=mcp-app',
        _meta: {
          ui: {
            csp: { connectDomains: [], resourceDomains: [] },
            prefersBorder: true,
          },
          'openai/widgetDescription': expect.any(String),
        },
      }),
    ]);
    const resource = await client.readResource({ uri: BUILD_READINESS_WIDGET_URI });
    expect(resource.contents[0]).toMatchObject({
      uri: BUILD_READINESS_WIDGET_URI,
      mimeType: 'text/html;profile=mcp-app',
      text: expect.stringContaining('globalThis.ExtApps'),
    });
  });

  it('runs only fixed gate argv and returns a complete headless decision', async () => {
    const { client, runner, workspaceHandle } = await setup();
    const result = await client.callTool({
      name: 'run_build_gate',
      arguments: { workspaceHandle, operation: 'validate' },
    });
    expect(runner.requests).toEqual([
      { command: 'validate', args: ['--json'], cwd: expect.any(String), workspaceHandle },
    ]);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: {
        decision: 'action-required',
        nextActions: [{ id: 'run-test', label: 'Run tests' }],
      },
    });
    expect((result.structuredContent as { data: { stages: unknown[] } }).data.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'validate', status: 'passed', runId: expect.any(String) }),
      ]),
    );
    await expect(
      client.callTool({
        name: 'run_build_gate',
        arguments: { workspaceHandle, operation: 'rm -rf /' },
      }),
    ).resolves.toMatchObject({ isError: true });
  });

  it('maps a private child-start failure to a stable public recovery command', async () => {
    const { client, runner, workspaceHandle } = await setup();
    runner.error = new Error('/private/plugin-cache/noodle-plugin.mjs could not start');
    const result = await client.callTool({
      name: 'run_build_gate',
      arguments: { workspaceHandle, operation: 'validate' },
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'public_command_unavailable',
          command: 'noodle validate --json',
          next: 'noodle validate --json',
        },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/plugin-cache|noodle-plugin\.mjs/);
  });

  it('requires fresh gates before deploy and marks changed source evidence stale', async () => {
    const { root, client, runner, workspaceHandle } = await setup();
    const premature = await client.callTool({
      name: 'deploy_build',
      arguments: {
        workspaceHandle,
        org: 'acme',
        app: 'support',
        environment: 'staging',
      },
    });
    expect(premature).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: 'build_not_ready' } },
    });
    for (const operation of ['validate', 'test', 'target-check'] as const) {
      await client.callTool({
        name: 'run_build_gate',
        arguments: { workspaceHandle, operation },
      });
    }
    const ready = await client.callTool({
      name: 'get_build_readiness',
      arguments: { workspaceHandle },
    });
    expect(ready.structuredContent).toMatchObject({
      ok: true,
      data: { decision: 'ready-to-deploy' },
    });
    runner.requests.length = 0;
    await client.callTool({
      name: 'deploy_build',
      arguments: {
        workspaceHandle,
        org: 'acme',
        app: 'support',
        environment: 'staging',
      },
    });
    expect(runner.requests.at(-1)).toMatchObject({
      command: 'deploy',
      args: ['--org', 'acme', '--app', 'support', '--env', 'staging', '--json', '--no-prompt'],
    });
    await writeFile(join(root, 'src/server.ts'), 'export const value = 2;\n');
    const stale = await client.callTool({
      name: 'get_build_readiness',
      arguments: { workspaceHandle },
    });
    expect(stale.structuredContent).toMatchObject({
      ok: true,
      data: {
        decision: 'action-required',
      },
    });
    expect((stale.structuredContent as { data: { stages: unknown[] } }).data.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'validate', status: 'stale', runId: expect.any(String) }),
      ]),
    );
  });

  it('preserves the deploy checklist and resume command for a missing-config response', async () => {
    const { client, runner, workspaceHandle } = await setup();
    for (const operation of ['validate', 'test', 'target-check'] as const) {
      await client.callTool({
        name: 'run_build_gate',
        arguments: { workspaceHandle, operation },
      });
    }
    runner.deployExitCode = 1;
    runner.stdout = JSON.stringify({
      ok: false,
      error: {
        code: 'missing_config',
        message: 'Required hosted configuration is missing.',
        next: 'noodle variables set REGION --from-env REGION',
        detail: {
          actions: [
            'noodle variables set REGION --from-env REGION',
            'noodle secrets set API_TOKEN --from-env API_TOKEN',
          ],
          resume: 'noodle deploy --org acme --app support --env staging --version 1',
        },
      },
    });

    const result = await client.callTool({
      name: 'deploy_build',
      arguments: {
        workspaceHandle,
        org: 'acme',
        app: 'support',
        environment: 'staging',
      },
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'missing_config',
          recoveryCommands: [
            'noodle variables set REGION --from-env REGION',
            'noodle secrets set API_TOKEN --from-env API_TOKEN',
          ],
          resume: 'noodle deploy --org acme --app support --env staging --version 1',
        },
      },
    });
  });

  it('cancels only the named active run and persists the terminal state', async () => {
    const { mode, client, runner, workspaceHandle } = await setup();
    const store = new BuildReadinessStore(join(mode.configHome, 'build-readiness'));
    const current = await store.read(workspaceHandle);
    const runId = 'run_abcdefghijklmnopqrstuv';
    await store.write({
      ...(current ?? {
        schemaVersion: 1,
        workspaceHandle,
        workspaceDigest: `sha256:${'a'.repeat(64)}`,
        updatedAt: NOW.toISOString(),
        runs: [],
      }),
      updatedAt: NOW.toISOString(),
      runs: [
        {
          runId,
          stage: 'preview',
          status: 'running',
          startedAt: NOW.toISOString(),
          heartbeatAt: NOW.toISOString(),
        },
      ],
    });
    const result = await client.callTool({
      name: 'cancel_build_run',
      arguments: { workspaceHandle, runId },
    });
    expect(result.structuredContent).toMatchObject({ ok: true, data: { cancelled: true } });
    expect(runner.cancelled).toEqual([runId]);
    expect((await store.read(workspaceHandle))?.runs[0]).toMatchObject({ status: 'cancelled' });
  });
});
