import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport, type Transport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';

import {
  type BuildCommandRequest,
  type BuildCommandResult,
  type BuildReadinessCommandRunner,
  createBuildReadinessMcpServer,
} from '../src/plugin-mode/build-readiness-server.js';
import {
  LocalCliBuildRunner,
  pluginChildEnvironment,
} from '../src/plugin-mode/plugin-command-runner.js';
import type { PluginMode } from '../src/plugin-mode/profile.js';

const roots: string[] = [];
const clients: Client[] = [];
const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const ok = (data: unknown = {}): BuildCommandResult => ({
  exitCode: 0,
  stdout: JSON.stringify({ ok: true, data }),
  stderr: '',
});

class FakeRunner implements BuildReadinessCommandRunner {
  readonly requests: BuildCommandRequest[] = [];
  readonly responses: BuildCommandResult[] = [];

  async run(request: BuildCommandRequest): Promise<BuildCommandResult> {
    this.requests.push(request);
    return this.responses.shift() ?? ok();
  }

  async cancel(): Promise<boolean> {
    return true;
  }

  cloudPreflight(target = { org: 'acme', app: 'support', environment: 'staging' }): void {
    this.responses.push(
      ok({ orgs: [{ slug: target.org }] }),
      ok({
        target: {
          runtime: { value: 'cloud', source: 'config' },
          service: { value: 'https://cloud.noodleseed.dev', source: 'link' },
          org: { value: target.org, source: 'link' },
          app: { value: target.app, source: 'link' },
          env: { value: target.environment, source: 'link' },
        },
      }),
    );
  }
}

async function setup(environment: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), 'noodle-plugin-operations-'));
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'noodle.json'), '{"entry":"src/server.ts"}\n');
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  await writeFile(join(root, 'src/server.ts'), 'export const value = 1;\n');
  const pluginMode: PluginMode = {
    host: 'codex',
    configHome: join(root, '.profile'),
    compatibilityFile: join(root, 'noodle-plugin-compatibility.json'),
  };
  const runner = new FakeRunner();
  const client = new Client(
    { name: 'plugin-operations-test', version: '1.0.0' },
    { capabilities: {}, versionNegotiation: { mode: 'legacy' } },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = serveStdio(
    () =>
      createBuildReadinessMcpServer({
        workspaceRoot: root,
        pluginMode,
        runner,
        environment,
      }),
    { legacy: 'serve', transport: serverTransport as Transport },
  );
  await client.connect(clientTransport as Transport);
  clients.push(client);
  servers.push(server);
  const context = await client.callTool({ name: 'get_local_context', arguments: {} });
  const workspaceHandle = (context.structuredContent as { data: { workspaceHandle: string } }).data
    .workspaceHandle;
  return { root, runner, client, workspaceHandle };
}

const target = {
  org: 'acme',
  app: 'support',
  environment: 'staging',
} as const;

describe('plugin public-operation tools', () => {
  it('builds a minimal child environment and forwards only an explicitly named value source', () => {
    const environment = pluginChildEnvironment(
      {
        host: 'codex',
        configHome: '/tmp/noodle-profile',
        compatibilityFile: '/tmp/noodle-compatibility.json',
      },
      {
        PATH: '/usr/bin',
        MODEL_API_KEY: 'requested-secret',
        GITHUB_TOKEN: 'ambient-github-secret',
        AWS_SECRET_ACCESS_KEY: 'ambient-aws-secret',
      },
      [{ sourceName: 'MODEL_API_KEY', targetName: 'NOODLE_PLUGIN_SECRET_INPUT' }],
    );
    expect(environment).toMatchObject({
      PATH: '/usr/bin',
      NOODLE_PLUGIN_SECRET_INPUT: 'requested-secret',
      NOODLE_PLUGIN_HOST: 'codex',
      NOODLE_CONFIG_HOME: '/tmp/noodle-profile',
      NOODLE_PLUGIN_COMPATIBILITY_FILE: '/tmp/noodle-compatibility.json',
      NOODLE_UPDATE_MODE: 'off',
    });
    expect(environment).not.toHaveProperty('GITHUB_TOKEN');
    expect(environment).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
  });

  it('does not preserve execution-sensitive names when forwarding a secret source', () => {
    const environment = pluginChildEnvironment(
      {
        host: 'codex',
        configHome: '/tmp/noodle-profile',
        compatibilityFile: '/tmp/noodle-compatibility.json',
      },
      { NODE_OPTIONS: '--require ./untrusted-hook.cjs' },
      [{ sourceName: 'NODE_OPTIONS', targetName: 'NOODLE_PLUGIN_SECRET_INPUT' }],
    );
    expect(environment).not.toHaveProperty('NODE_OPTIONS');
    expect(environment.NOODLE_PLUGIN_SECRET_INPUT).toBe('--require ./untrusted-hook.cjs');
  });

  it('redacts an explicitly forwarded value from captured child output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'noodle-plugin-runner-redaction-'));
    roots.push(root);
    const entrypoint = join(root, 'echo-forwarded-secret.mjs');
    await writeFile(
      entrypoint,
      "process.stdout.write(process.env.NOODLE_PLUGIN_SECRET_INPUT ?? 'missing');\n",
    );
    const secret = 'sentinel-forwarded-secret';
    const runner = new LocalCliBuildRunner({
      cliEntrypoint: entrypoint,
      pluginMode: {
        host: 'codex',
        configHome: join(root, '.profile'),
        compatibilityFile: join(root, 'noodle-plugin-compatibility.json'),
      },
      sourceEnvironment: { MODEL_API_KEY: secret },
    });
    const result = await runner.run({
      command: 'secrets',
      args: [],
      cwd: root,
      workspaceHandle: 'abcdefghijklmnopqrstuv',
      forwardEnvironment: [
        {
          sourceName: 'MODEL_API_KEY',
          targetName: 'NOODLE_PLUGIN_SECRET_INPUT',
        },
      ],
    });
    expect(result.stdout).toBe('[redacted]');
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('maps bootstrap choices to fixed public CLI capabilities', async () => {
    const { client, runner, workspaceHandle } = await setup();
    runner.responses.push(
      ok({
        setup: {
          ready: true,
          packageManager: 'npm',
          completed: ['scaffold', 'install', 'validate', 'behavior', 'types'],
          restartRequired: true,
          proof: 'local-synthetic',
        },
      }),
    );
    await client.callTool({
      name: 'setup_project',
      arguments: { workspaceHandle, mode: 'initialize', template: 'hello' },
    });
    await client.callTool({
      name: 'setup_project',
      arguments: { workspaceHandle, mode: 'reconcile' },
    });
    expect(runner.requests).toEqual([
      {
        command: 'init',
        args: ['.', '--template', 'hello', '--json'],
        cwd: expect.any(String),
        workspaceHandle,
      },
      {
        command: 'setup',
        args: ['--write', '--json'],
        cwd: expect.any(String),
        workspaceHandle,
      },
    ]);
  });

  it('defaults plugin initialization to the SaaS bootstrap and returns bounded progress', async () => {
    const { client, runner, workspaceHandle } = await setup();
    runner.responses.push(
      ok({
        setup: {
          ready: true,
          packageManager: 'pnpm',
          completed: ['scaffold', 'install', 'context', 'validate', 'behavior', 'types'],
          restartRequired: true,
          proof: 'local-synthetic',
          resumeCommand: 'private-plugin-cache',
          unknown: 'private-sentinel',
        },
      }),
    );
    const result = await client.callTool({
      name: 'setup_project',
      arguments: { workspaceHandle, mode: 'initialize', packageManager: 'pnpm' },
    });
    expect(runner.requests[0]?.args).toEqual(['.', '--package-manager', 'pnpm', '--json']);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: { setup: { ready: true, proof: 'local-synthetic', restartRequired: true } },
    });
    expect(JSON.stringify(result)).not.toContain('private-');
    const listed = await client.listTools();
    expect(
      listed.tools.find((tool) => tool.name === 'setup_project')?.annotations?.openWorldHint,
    ).toBe(true);
  });

  it('projects files-only setup and safe stage recovery without child logs or arbitrary commands', async () => {
    const { client, runner, workspaceHandle } = await setup();
    const progress = {
      ready: false,
      packageManager: 'npm',
      completed: ['scaffold'],
      restartRequired: true,
      proof: 'unverified',
    };
    runner.responses.push(ok({ setup: progress }), {
      exitCode: 1,
      stdout: JSON.stringify({
        ok: false,
        error: {
          code: 'bootstrap_failed',
          message: 'private-error-sentinel',
          next: 'npx private-plugin-cache',
          detail: { setup: { ...progress, failed: { stage: 'install', code: 'command_timeout' } } },
        },
      }),
      stderr: 'private-error-log',
    });
    const prepared = await client.callTool({
      name: 'setup_project',
      arguments: { workspaceHandle, mode: 'initialize', install: false },
    });
    expect(runner.requests[0]?.args).toContain('--no-install');
    expect(prepared.structuredContent).toMatchObject({
      ok: true,
      data: { setup: { ready: false } },
    });
    const failed = await client.callTool({
      name: 'setup_project',
      arguments: { workspaceHandle, mode: 'initialize' },
    });
    expect(failed.structuredContent).toMatchObject({
      ok: false,
      error: {
        next: 'noodle init . --json',
        setup: { failed: { stage: 'install', code: 'command_timeout' } },
      },
    });
    expect(JSON.stringify(failed)).not.toContain('private-');
  });

  it.each([
    'not JSON',
    '{"ok":false,"error":{"code":"failed"}}',
  ])('rejects a zero-exit invalid success envelope: %s', async (stdout) => {
    const { client, runner, workspaceHandle } = await setup();
    runner.responses.push({ exitCode: 0, stdout, stderr: '' });
    const result = await client.callTool({
      name: 'setup_project',
      arguments: { workspaceHandle, mode: 'reconcile' },
    });
    expect(result.isError).toBe(true);
  });

  it('validates live organization access before linking and confirms the exact saved target', async () => {
    const { client, runner, workspaceHandle } = await setup();
    runner.cloudPreflight();
    runner.responses.splice(1, 0, ok());
    const result = await client.callTool({
      name: 'link_cloud_project',
      arguments: { workspaceHandle, ...target, access: 'owner-only' },
    });
    expect(runner.requests).toEqual([
      {
        command: 'orgs',
        args: ['list', '--json'],
        cwd: expect.any(String),
        workspaceHandle,
      },
      {
        command: 'link',
        args: ['--org', 'acme', '--app', 'support', '--env', 'staging', '--access', 'owner-only'],
        cwd: expect.any(String),
        workspaceHandle,
      },
      {
        command: 'target',
        args: ['show', '--json'],
        cwd: expect.any(String),
        workspaceHandle,
      },
    ]);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: {
        operation: 'link',
        command: 'noodle link --org acme --app support --env staging --access owner-only',
        target,
      },
    });
  });

  it('stops before link when login is expired or the organization is unavailable', async () => {
    const expired = await setup();
    expired.runner.responses.push({
      exitCode: 3,
      stdout: JSON.stringify({
        ok: false,
        error: { code: 'auth_required', message: 'Sign in again.', next: 'noodle login' },
      }),
      stderr: 'internal entrypoint must stay hidden',
    });
    const expiredResult = await expired.client.callTool({
      name: 'link_cloud_project',
      arguments: { workspaceHandle: expired.workspaceHandle, ...target },
    });
    expect(expiredResult).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'auth_required',
          command: 'noodle orgs list --json',
          next: 'noodle login',
        },
      },
    });
    expect(JSON.stringify(expiredResult)).not.toContain('internal entrypoint');
    expect(expired.runner.requests).toHaveLength(1);

    const unavailable = await setup();
    unavailable.runner.responses.push(ok({ orgs: [{ slug: 'other' }] }));
    const unavailableResult = await unavailable.client.callTool({
      name: 'link_cloud_project',
      arguments: { workspaceHandle: unavailable.workspaceHandle, ...target },
    });
    expect(unavailableResult).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'organization_not_available',
          command: 'noodle orgs list --json',
        },
      },
    });
    expect(unavailable.runner.requests).toHaveLength(1);
  });

  it('sets a normal variable through stdin only after exact linked-target validation', async () => {
    const { client, runner, workspaceHandle } = await setup();
    runner.cloudPreflight();
    const result = await client.callTool({
      name: 'set_cloud_variable',
      arguments: {
        workspaceHandle,
        ...target,
        name: 'ASSISTANT_MODEL',
        value: 'gpt-5',
      },
    });
    expect(runner.requests.at(-1)).toEqual({
      command: 'variables',
      args: [
        'set',
        'ASSISTANT_MODEL',
        '--runtime',
        'cloud',
        '--scope',
        'env',
        '--org',
        'acme',
        '--app',
        'support',
        '--env',
        'staging',
        '--from-stdin',
        '--json',
      ],
      cwd: expect.any(String),
      workspaceHandle,
      stdin: 'gpt-5',
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: { operation: 'set-variable', target, name: 'ASSISTANT_MODEL' },
    });
  });

  it('does not mutate configuration when the linked app or environment differs', async () => {
    const { client, runner, workspaceHandle } = await setup();
    runner.cloudPreflight({ org: 'acme', app: 'other', environment: 'prod' });
    const result = await client.callTool({
      name: 'set_cloud_variable',
      arguments: {
        workspaceHandle,
        ...target,
        name: 'ASSISTANT_MODEL',
        value: 'gpt-5',
      },
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'target_mismatch',
          command: 'noodle target show --json',
        },
      },
    });
    expect(runner.requests.map((request) => request.command)).toEqual(['orgs', 'target']);
  });

  it('sets a secret only from one named environment variable and never returns its value', async () => {
    const secret = 'sentinel-secret-that-must-not-escape';
    const { client, runner, workspaceHandle } = await setup({
      MODEL_API_KEY: secret,
      AWS_SECRET_ACCESS_KEY: 'ambient-secret-that-must-not-be-forwarded',
    });
    runner.cloudPreflight();
    const result = await client.callTool({
      name: 'set_cloud_secret_from_env',
      arguments: {
        workspaceHandle,
        ...target,
        name: 'MODEL_API_KEY',
        sourceEnvironmentVariable: 'MODEL_API_KEY',
      },
    });
    expect(runner.requests.at(-1)).toEqual({
      command: 'secrets',
      args: [
        'set',
        'MODEL_API_KEY',
        '--runtime',
        'cloud',
        '--scope',
        'env',
        '--org',
        'acme',
        '--app',
        'support',
        '--env',
        'staging',
        '--from-env',
        'NOODLE_PLUGIN_SECRET_INPUT',
        '--json',
      ],
      cwd: expect.any(String),
      workspaceHandle,
      forwardEnvironment: [
        {
          sourceName: 'MODEL_API_KEY',
          targetName: 'NOODLE_PLUGIN_SECRET_INPUT',
        },
      ],
    });
    const serialized = JSON.stringify({ result, requests: runner.requests });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('ambient-secret-that-must-not-be-forwarded');
  });

  it('fails before any command when the named secret source is absent', async () => {
    const { client, runner, workspaceHandle } = await setup({});
    const result = await client.callTool({
      name: 'set_cloud_secret_from_env',
      arguments: {
        workspaceHandle,
        ...target,
        name: 'MODEL_API_KEY',
        sourceEnvironmentVariable: 'MODEL_API_KEY',
      },
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'secret_source_missing',
          command:
            'noodle secrets set MODEL_API_KEY --runtime cloud --scope env --org acme --app support --env staging --from-env MODEL_API_KEY --json',
        },
      },
    });
    expect(runner.requests).toEqual([]);
  });

  it('previews feedback and requires an explicit approval literal before submission', async () => {
    const { client, runner, workspaceHandle } = await setup();
    await client.callTool({
      name: 'preview_product_feedback',
      arguments: {
        workspaceHandle,
        message: 'The target recovery was confusing.',
        type: 'fix',
        severity: 'P2',
        area: 'plugins',
      },
    });
    expect(runner.requests.at(-1)).toMatchObject({
      command: 'feedback',
      args: expect.arrayContaining(['--dry-run', '--json']),
    });
    const denied = await client.callTool({
      name: 'submit_product_feedback',
      arguments: {
        workspaceHandle,
        message: 'The target recovery was confusing.',
        type: 'fix',
        severity: 'P2',
        area: 'plugins',
      },
    });
    expect(denied).toMatchObject({ isError: true });
    expect(runner.requests).toHaveLength(1);

    await client.callTool({
      name: 'submit_product_feedback',
      arguments: {
        workspaceHandle,
        message: 'The target recovery was confusing.',
        type: 'fix',
        severity: 'P2',
        area: 'plugins',
        approved: true,
      },
    });
    expect(runner.requests.at(-1)).toMatchObject({
      command: 'feedback',
      args: expect.not.arrayContaining(['--dry-run']),
    });
  });
});
