import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  assertContainerHardening,
  assertExactComposeServices,
  assertLiveNonRootUid,
  assertSelfHostProjectName,
  createExactProjectCleanup,
  createProcessRunner,
  deploymentResult,
  fetchAsset,
  hostedAssetUrl,
  mcpRpc,
  parseCliJson,
  parseMcpResponse,
  redactSensitiveOutput,
  runAcceptanceStages,
  runSelfHostE2E,
  SELF_HOST_E2E_STAGE_NAMES,
  SelfHostE2EFailure,
} from '../../../scripts/lib/self-host-e2e.mjs';

describe('projected self-host acceptance harness', () => {
  const org = '{"slug":"noodle-local","displayName":"Noodle Local","createdAt":"fixed"}';
  const changedOrg = '{"slug":"noodle-local","displayName":"Noodle Local","createdAt":"changed"}';
  const bootstrapResponses = [
    `{"ok":true,"data":{"service":"http://noodle:8787","org":${org}}}`,
    `{"ok":true,"data":{"service":"http://noodle:8787","orgs":[${org}]}}`,
    `{"ok":true,"data":${org}}`,
  ];
  const missingIdentityOrg = '{"slug":"noodle-local","displayName":"Noodle Local"}';
  const wrongSlugOrg = '{"slug":"other","displayName":"Noodle Local","createdAt":"fixed"}';
  const changedResponses = bootstrapResponses.map((value) => value.replaceAll(org, changedOrg));
  it('accepts only one bounded lowercase Compose project name', () => {
    expect(assertSelfHostProjectName('noodle-e2e-a1b2c3d4')).toBe('noodle-e2e-a1b2c3d4');

    for (const candidate of [
      '',
      'noodle-core',
      'Noodle-e2e-a1b2c3d4',
      'noodle-e2e-a1b2c3d4/other',
      `noodle-e2e-${'a'.repeat(48)}`,
    ]) {
      expect(() => assertSelfHostProjectName(candidate)).toThrow(
        'invalid self-host E2E Compose project name',
      );
    }
  });

  it('keeps the user-visible journey in dependency order', () => {
    expect(SELF_HOST_E2E_STAGE_NAMES).toEqual([
      'prerequisites',
      'init',
      'rendered-config-audit',
      'image-build-start',
      'health',
      'bootstrap',
      'hello-v1-deploy',
      'legacy-call',
      'modern-call',
      'hello-v2-deploy',
      'hello-v2-redeploy',
      'rollback-v2',
      'widget-deploy',
      'asset-fetch',
      'retained-volume-restart',
      'recovered-calls-assets',
      'backup',
      'log-scan',
      'cleanup',
    ]);
  });

  it('accepts one successful CLI JSON envelope and rejects noise or failure envelopes', () => {
    expect(parseCliJson('{"ok":true,"data":{"deploymentId":"dep-1"}}')).toEqual({
      deploymentId: 'dep-1',
    });
    expect(() => parseCliJson('progress\n{"ok":true,"data":{}}')).toThrow(
      'CLI output was not one JSON envelope',
    );
    expect(() => parseCliJson('{"ok":false,"error":{"code":"denied","message":"no"}}')).toThrow(
      'CLI command failed: denied',
    );
  });

  it('requires exact deployment endpoint shapes and distinct persisted identities', () => {
    const seen = new Set<string>();
    const result = deploymentResult(
      JSON.stringify({
        ok: true,
        data: {
          deploymentId: 'hello-v1',
          serverVersion: '1',
          url: 'http://127.0.0.1:8787/o/noodle-local/hello/v1/mcp',
          defaultUrl: 'http://127.0.0.1:8787/o/noodle-local/hello/mcp',
        },
      }),
      'hello v1 deploy',
      { app: 'hello', version: '1' },
      seen,
    );

    expect(result.deploymentId).toBe('hello-v1');
    expect(() =>
      deploymentResult(
        JSON.stringify({
          ok: true,
          data: {
            deploymentId: 'hello-v1',
            serverVersion: '2',
            url: 'http://127.0.0.1:8787/o/noodle-local/hello/v2/mcp',
            defaultUrl: 'http://127.0.0.1:8787/o/noodle-local/hello/mcp',
          },
        }),
        'hello v2 deploy',
        { app: 'hello', version: '2' },
        seen,
      ),
    ).toThrow('reused deploymentId');
    expect(() =>
      deploymentResult(
        JSON.stringify({
          ok: true,
          data: {
            deploymentId: 'hello-v2',
            serverVersion: '2',
            url: 'http://127.0.0.1:8787/o/noodle-local/other/v2/mcp',
            defaultUrl: 'http://127.0.0.1:8787/o/noodle-local/hello/mcp',
          },
        }),
        'hello v2 deploy',
        { app: 'hello', version: '2' },
        seen,
      ),
    ).toThrow('exact public endpoint');
  });

  it('requires the bounded non-empty Food Ordering image with matching GET and HEAD metadata', async () => {
    const assetFetch =
      (bytes: Buffer, contentType: string): typeof fetch =>
      async (_input, init) =>
        new Response(init?.method === 'HEAD' ? null : bytes, {
          headers: {
            etag: '"asset"',
            'content-length': String(bytes.byteLength),
            'content-type': contentType,
            'x-content-type-options': 'nosniff',
          },
        });

    await expect(
      fetchAsset(assetFetch(Buffer.from('widget-branding'), 'image/jpeg'), 'x'),
    ).resolves.toMatchObject({ contentType: 'image/jpeg' });
    await expect(fetchAsset(assetFetch(Buffer.alloc(0), 'image/jpeg'), 'x')).rejects.toThrow(
      'empty',
    );
    await expect(fetchAsset(assetFetch(Buffer.from('widget'), 'text/html'), 'x')).rejects.toThrow(
      'Food Ordering image',
    );
    await expect(
      fetchAsset(assetFetch(Buffer.alloc(10 * 1024 * 1024 + 1), 'image/jpeg'), 'x'),
    ).rejects.toThrow('10 MiB');
  });

  it('accepts hosted widget assets only from the exact local filesystem-backed origin', () => {
    expect(
      hostedAssetUrl({
        contents: [
          {
            text: '<img src="http://127.0.0.1:8787/__noodle/hosted-assets/0123456789abcdef/1111111111111111/2222222222222222/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/branding_logo">',
          },
        ],
      }),
    ).toBe(
      'http://127.0.0.1:8787/__noodle/hosted-assets/0123456789abcdef/1111111111111111/2222222222222222/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/branding_logo',
    );
    expect(() =>
      hostedAssetUrl({
        contents: [
          {
            text: '<img src="https://assets.example/__noodle/hosted-assets/0123456789abcdef/1111111111111111/2222222222222222/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/branding_logo">',
          },
        ],
      }),
    ).toThrow('exact local hosted-asset origin');
  });

  it('requires the exact projected Compose service set and live numeric non-root UIDs', () => {
    expect(assertExactComposeServices('postgres\nnoodle\nbootstrap\ncli\n')).toEqual([
      'bootstrap',
      'cli',
      'noodle',
      'postgres',
    ]);
    expect(() =>
      assertExactComposeServices('postgres\nnoodle\nbootstrap\ncli\nunexpected\n'),
    ).toThrow('exact public service set');
    expect(assertLiveNonRootUid('1000\n', 'noodle')).toBe(1000);
    for (const output of ['0\n', 'root\n', '-1\n', '1000\nnoise\n']) {
      expect(() => assertLiveNonRootUid(output, 'noodle')).toThrow('numeric non-root UID');
    }
  });

  it('redacts generated values and structural secret forms without changing safe diagnostics', () => {
    const safe = redactSensitiveOutput(
      [
        'stage=bootstrap status=failed',
        'Authorization: Bearer bearer-value',
        'DATABASE_URL=postgresql://noodle:database-password@postgres:5432/noodle',
        'NOODLE_SECRET_MASTER_KEY=master-value',
        'free text admin-token-value asset-salt-value',
      ].join('\n'),
      ['admin-token-value', 'asset-salt-value', 'database-password', 'master-value'],
    );

    expect(safe).toContain('stage=bootstrap status=failed');
    expect(safe).not.toContain('bearer-value');
    expect(safe).not.toContain('database-password');
    expect(safe).not.toContain('master-value');
    expect(safe).not.toContain('admin-token-value');
    expect(safe).not.toContain('asset-salt-value');
    expect(safe).toContain('[REDACTED]');
  });

  it.each(
    SELF_HOST_E2E_STAGE_NAMES.filter((stage) => stage !== 'cleanup'),
  )('runs cleanup exactly once when %s fails', async (failedStage) => {
    const cleanup = vi.fn(async () => undefined);
    const seen: string[] = [];
    const stages = SELF_HOST_E2E_STAGE_NAMES.filter((stage) => stage !== 'cleanup').map((name) => ({
      name,
      run: async () => {
        seen.push(name);
        if (name === failedStage) throw new Error('boom');
      },
    }));

    await expect(runAcceptanceStages(stages, cleanup)).rejects.toMatchObject({
      name: 'SelfHostE2EFailure',
      stage: failedStage,
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toBe(failedStage);
  });

  it('runs cleanup once after success and reports every completed stage', async () => {
    const cleanup = vi.fn(async () => undefined);
    const results = await runAcceptanceStages(
      [
        { name: 'prerequisites', run: async () => ({ detail: 'docker ready' }) },
        { name: 'health', run: async () => ({ detail: 'service ready' }) },
      ],
      cleanup,
    );

    expect(results).toEqual([
      { name: 'prerequisites', detail: 'docker ready' },
      { name: 'health', detail: 'service ready' },
      { name: 'cleanup' },
    ]);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('preserves a stage failure while surfacing a simultaneous cleanup failure', async () => {
    const cleanup = vi.fn(async () => {
      throw new Error('cleanup resources remained');
    });

    await expect(
      runAcceptanceStages(
        [{ name: 'health', run: async () => Promise.reject(new Error('service unavailable')) }],
        cleanup,
      ),
    ).rejects.toMatchObject({
      stage: 'health',
      message: expect.stringContaining('cleanup also failed'),
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('removes generated state even when exact-project Docker cleanup fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noodle-self-host-e2e-cleanup-'));
    mkdirSync(join(root, '.self-host'));
    writeFileSync(join(root, 'noodle.service.yaml'), 'profile: open-core\n');
    const run = vi.fn(async () => Promise.reject(new Error('docker unavailable')));
    const cleanup = createExactProjectCleanup({
      root,
      projectName: 'noodle-e2e-a1b2c3d4',
      dockerPath: '/opt/noodle-oss-verify/bin/docker',
      runner: { run },
      removeGeneratedState: true,
    });

    try {
      await expect(cleanup()).rejects.toThrow('docker unavailable');
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ command: '/opt/noodle-oss-verify/bin/docker' }),
      );
      expect(existsSync(join(root, '.self-host'))).toBe(false);
      expect(existsSync(join(root, 'noodle.service.yaml'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps bounded safe failure evidence without exposing the raw cause', () => {
    const failure = new SelfHostE2EFailure(
      'image-build-start',
      'command failed',
      'Authorization: Bearer hidden-token',
      ['hidden-token'],
    );

    expect(failure.message).toContain('image-build-start');
    expect(failure.message).not.toContain('hidden-token');
    expect(failure.safeTail).toContain('[REDACTED]');
  });

  it('parses bounded JSON and SSE JSON-RPC success responses', async () => {
    expect(
      await parseMcpResponse(
        new Response('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}', {
          headers: { 'content-type': 'application/json' },
        }),
        1,
      ),
    ).toEqual({ ok: true });
    expect(
      await parseMcpResponse(
        new Response('event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
        2,
      ),
    ).toEqual({ ok: true });

    await expect(
      parseMcpResponse(
        new Response('{"jsonrpc":"2.0","id":3,"error":{"code":-32602,"message":"bad"}}', {
          headers: { 'content-type': 'application/json' },
        }),
        3,
      ),
    ).rejects.toThrow('MCP JSON-RPC error -32602');
    await expect(
      parseMcpResponse(
        new Response('{"jsonrpc":"2.0","id":4,"result":{}}', {
          headers: { 'content-type': 'application/json' },
        }),
        5,
      ),
    ).rejects.toThrow('MCP response id did not match request');
    for (const headers of [undefined, { 'content-type': 'text/plain' }]) {
      await expect(
        parseMcpResponse(new Response('{"jsonrpc":"2.0","id":6,"result":{}}', { headers }), 6),
      ).rejects.toThrow('unsupported content type');
    }
    await expect(
      parseMcpResponse(
        new Response('x'.repeat(1024 * 1024 + 1), {
          headers: { 'content-type': 'application/json' },
        }),
        6,
      ),
    ).rejects.toThrow('MCP response exceeded the 1 MiB acceptance bound');
  });

  it('sends era-correct legacy and modern MCP requests', async () => {
    const requests: Request[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request =
        input instanceof Request && init === undefined ? input : new Request(input, init);
      requests.push(request);
      const body = (await request.clone().json()) as { readonly id: number };
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { accepted: true } }),
        { headers: { 'content-type': 'application/json' } },
      );
    };

    await mcpRpc({
      fetch: fetchImpl,
      url: 'http://127.0.0.1:8787/o/noodle-local/hello/mcp',
      era: '2025-11-25',
      id: 1,
      method: 'tools/call',
      params: { name: 'greet', arguments: { name: 'Core' } },
    });
    await mcpRpc({
      fetch: fetchImpl,
      url: 'http://127.0.0.1:8787/o/noodle-local/hello/mcp',
      era: '2026-07-28',
      id: 2,
      method: 'tools/call',
      params: { name: 'greet', arguments: { name: 'Core' } },
    });

    const legacy = requests[0];
    const modern = requests[1];
    expect(legacy?.headers.get('mcp-protocol-version')).toBe('2025-11-25');
    expect(legacy?.headers.get('mcp-method')).toBeNull();
    expect(await legacy?.json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'greet', arguments: { name: 'Core' } },
    });
    expect(modern?.headers.get('mcp-protocol-version')).toBe('2026-07-28');
    expect(modern?.headers.get('mcp-method')).toBe('tools/call');
    expect(modern?.headers.get('mcp-name')).toBe('greet');
    expect(await modern?.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'greet',
        arguments: { name: 'Core' },
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': {
            name: 'noodle-self-host-e2e',
            version: '1.0.0',
          },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    });
  });

  it('cancels an in-flight MCP request with the acceptance signal', async () => {
    const abort = new AbortController();
    const interrupted = new Error('acceptance interrupted');
    const fetchImpl: typeof fetch = async (_input, init) =>
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    const pending = mcpRpc({
      fetch: fetchImpl,
      url: 'http://127.0.0.1:8787/o/noodle-local/hello/mcp',
      era: '2026-07-28',
      id: 3,
      method: 'tools/list',
      params: {},
      signal: abort.signal,
      timeoutMs: 200,
    });

    abort.abort(interrupted);

    await expect(pending).rejects.toBe(interrupted);
  });

  it('interrupts an active subprocess when the acceptance run is cancelled', async () => {
    const runner = createProcessRunner();
    const abort = new AbortController();
    const running = runner.run({
      stage: 'image-build-start',
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(0), 100)'],
      cwd: process.cwd(),
      timeoutMs: 2_000,
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 10);

    await expect(running).rejects.toThrow('command was interrupted');
  });

  it.skipIf(process.platform === 'win32')(
    'kills subprocess descendants before timeout cleanup can race them',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'noodle-self-host-e2e-process-group-'));
      const marker = join(root, 'descendant-survived');
      const childScript = `process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 500)`;
      const parentScript = `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: ['ignore', 'pipe', 'ignore'] }); child.stdout.once('data', (chunk) => process.stdout.write(chunk)); setInterval(() => {}, 1000)`;
      const runner = createProcessRunner({ forceKillAfterMs: 25 });

      try {
        await expect(
          runner.run({
            stage: 'image-build-start',
            command: process.execPath,
            args: ['-e', parentScript],
            cwd: root,
            timeoutMs: 200,
          }),
        ).rejects.toThrow('command timed out after 200ms');
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('stops an interrupted stage graph before new work and cleans its project once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noodle-self-host-e2e-interrupt-'));
    writeFileSync(join(root, 'package.json'), '{"name":"noodle-core"}\n');
    const abort = new AbortController();
    abort.abort();
    const run = vi.fn();
    const cleanup = vi.fn(async () => undefined);

    try {
      await expect(
        runSelfHostE2E({
          root,
          projectName: 'noodle-e2e-a1b2c3d4',
          runner: { run },
          fetch,
          signal: abort.signal,
          cleanup,
        }),
      ).rejects.toThrow('acceptance run was interrupted');
      expect(run).not.toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('force-kills a command that ignores the bounded graceful timeout', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: (signal: NodeJS.Signals) => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const kills: NodeJS.Signals[] = [];
    child.kill = (signal) => {
      kills.push(signal);
      if (signal === 'SIGTERM') setTimeout(() => child.emit('close', null, 'SIGTERM'), 80);
      if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
      return true;
    };
    const runner = createProcessRunner({ spawn: () => child, forceKillAfterMs: 10 });

    await expect(
      runner.run({
        stage: 'image-build-start',
        command: 'docker',
        args: ['build'],
        cwd: process.cwd(),
        timeoutMs: 10,
      }),
    ).rejects.toThrow('command timed out after 10ms');
    expect(kills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('removes ambient Compose control variables from every subprocess', async () => {
    let spawnedEnvironment: NodeJS.ProcessEnv | undefined;
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: (signal: NodeJS.Signals) => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    const runner = createProcessRunner({
      environment: {
        PATH: process.env.PATH,
        COMPOSE_FILE: '/tmp/attacker-compose.yaml',
        COMPOSE_PROJECT_NAME: 'attacker-project',
        COMPOSE_PROFILES: 'attacker-profile',
      },
      spawn: (_command: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
        spawnedEnvironment = options.env;
        queueMicrotask(() => child.emit('close', 0, null));
        return child;
      },
    });

    await runner.run({
      stage: 'rendered-config-audit',
      command: 'docker',
      args: ['compose', 'config'],
      cwd: process.cwd(),
      timeoutMs: 2_000,
    });

    expect(spawnedEnvironment).toMatchObject({ PATH: process.env.PATH });
    expect(
      Object.keys(spawnedEnvironment ?? {}).filter((key) => key.startsWith('COMPOSE_')),
    ).toEqual([]);
  });

  it.each([
    ['privileged mode', { privileged: 'true' }],
    ['added capabilities', { capAdd: '["SYS_ADMIN"]' }],
    [
      'unconfined security options',
      { security: '["no-new-privileges:true","seccomp=unconfined"]' },
    ],
    ['host networking', { networkMode: 'host' }],
    ['missing bounded temporary filesystems', { tmpfs: '{}' }],
    [
      'contradictory temporary-filesystem options',
      { tmpfs: '{"/tmp":"rw,noexec,nosuid,size=64m,exec,size=1g"}' },
    ],
    [
      'an extra published port',
      {
        noodlePorts:
          '{"8787/tcp":[{"HostIp":"127.0.0.1","HostPort":"8787"}],"9000/tcp":[{"HostIp":"0.0.0.0","HostPort":"9000"}]}',
      },
    ],
    [
      'unexpected mounts',
      {
        noodleMounts:
          '[{"Type":"volume","Name":"noodle-e2e-a1b2c3d4_asset-data","Destination":"/var/lib/noodle/assets"},{"Type":"bind","Source":"/","Destination":"/host"}]',
      },
    ],
  ])('rejects %s in the runtime container audit', (_label, override) => {
    const line = (service: 'postgres' | 'noodle') =>
      [
        service === 'postgres' ? 'postgres' : 'node',
        'true',
        override.privileged ?? 'false',
        override.capAdd ?? 'null',
        '["ALL"]',
        override.security ?? '["no-new-privileges:true"]',
        override.networkMode ?? 'noodle-e2e-a1b2c3d4_default',
        override.tmpfs ??
          (service === 'postgres'
            ? '{"/tmp":"rw,noexec,nosuid,size=64m","/var/run/postgresql":"rw,noexec,nosuid,size=16m,uid=999,gid=999,mode=0775"}'
            : '{"/tmp":"rw,noexec,nosuid,size=64m"}'),
        service === 'postgres'
          ? '{}'
          : (override.noodlePorts ?? '{"8787/tcp":[{"HostIp":"127.0.0.1","HostPort":"8787"}]}'),
        service === 'postgres'
          ? '[{"Type":"volume","Name":"noodle-e2e-a1b2c3d4_postgres-data","Destination":"/var/lib/postgresql/data"}]'
          : (override.noodleMounts ??
            '[{"Type":"volume","Name":"noodle-e2e-a1b2c3d4_asset-data","Destination":"/var/lib/noodle/assets"}]'),
      ].join('\t');

    expect(() =>
      assertContainerHardening(`${line('postgres')}\n${line('noodle')}\n`, 'noodle-e2e-a1b2c3d4'),
    ).toThrow();
  });

  it.each([
    ['malformed response', ['not-json']],
    ['missing stable identity', [`{"ok":true,"data":{"org":${missingIdentityOrg}}}`]],
    ['wrong slug', [`{"ok":true,"data":{"org":${wrongSlugOrg}}}`]],
    ['changed stable identity', [...bootstrapResponses, ...changedResponses]],
    [
      'duplicated organization',
      [...bootstrapResponses, bootstrapResponses[0], `{"ok":true,"data":{"orgs":[${org},${org}]}}`],
    ],
  ])('stops at bootstrap for a %s', async (_case, responses) => {
    const root = mkdtempSync(join(tmpdir(), 'noodle-self-host-bootstrap-failure-'));
    writeFileSync(join(root, 'package.json'), '{"name":"noodle-core"}\n');
    mkdirSync(join(root, 'examples', 'hello', 'src'), { recursive: true });
    writeFileSync(join(root, 'examples', 'hello', 'src', 'server.ts'), '`Hello, ${input.name}!`');
    let response = 0;
    const runner = {
      run: vi.fn(async (input: { readonly stage: string; readonly args: readonly string[] }) => {
        if (input.stage === 'init') {
          mkdirSync(join(root, '.self-host'), { recursive: true });
          writeFileSync(
            join(root, '.self-host', '.env'),
            'POSTGRES_PASSWORD=postgres-secret\nDATABASE_URL=database-url\nNOODLE_SECRET_MASTER_KEY=master-secret\nNOODLE_SELF_HOST_ADMIN_TOKEN=admin-secret\nNOODLE_ASSET_IDENTITY_SALT=asset-secret\n',
          );
          writeFileSync(join(root, 'noodle.service.yaml'), 'profile: open-core\n');
        }
        const stdout =
          input.stage === 'rendered-config-audit' && input.args.at(-1) === '--services'
            ? 'postgres\nnoodle\nbootstrap\ncli\n'
            : input.stage === 'bootstrap'
              ? (responses[response++] ?? '')
              : '';
        return { stdout, stderr: '' };
      }),
    };
    try {
      await expect(
        runSelfHostE2E({
          root,
          projectName: 'noodle-e2e-a1b2c3d4',
          runner,
          fetch: async (url) =>
            new Response('', { status: String(url).endsWith('/readyz') ? 200 : 401 }),
        }),
      ).rejects.toMatchObject({ stage: 'bootstrap' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('drives the complete public journey with two bootstraps and exact cleanup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noodle-self-host-e2e-unit-'));
    const trustedNode = '/opt/noodle-oss-verify/node/bin/node';
    const trustedDocker = '/opt/noodle-oss-verify/bin/docker';
    writeFileSync(join(root, 'package.json'), '{"name":"noodle-core"}\n');
    mkdirSync(join(root, 'examples', 'hello', 'src'), { recursive: true });
    writeFileSync(
      join(root, 'examples', 'hello', 'src', 'server.ts'),
      'const greet = ({ input }) => ({ message: `Hello, ${input.name}!` });\n',
    );
    const calls: Array<{
      readonly stage: string;
      readonly command: string;
      readonly args: readonly string[];
      readonly stdinFile?: string;
      readonly stdoutFile?: string;
    }> = [];
    let activeGreeting = 'Hello, Core!';
    let v2Greeting = 'Hello again, Core!';
    const runner = {
      run: vi.fn(
        async (input: {
          stage: string;
          command: string;
          args: readonly string[];
          stdinFile?: string;
          stdoutFile?: string;
        }) => {
          calls.push(input);
          if (input.stage === 'init') {
            mkdirSync(join(root, '.self-host'), { recursive: true });
            writeFileSync(
              join(root, '.self-host', '.env'),
              [
                'POSTGRES_PASSWORD=postgres-secret',
                'DATABASE_URL=postgresql://noodle:postgres-secret@postgres:5432/noodle',
                'NOODLE_SECRET_MASTER_KEY=master-secret',
                'NOODLE_SELF_HOST_ADMIN_TOKEN=admin-secret',
                'NOODLE_ASSET_IDENTITY_SALT=asset-secret',
                '',
              ].join('\n'),
            );
            writeFileSync(join(root, 'noodle.service.yaml'), 'profile: open-core\n');
          }
          if (input.stage === 'hello-v2-deploy') activeGreeting = 'Hello again, Core!';
          if (input.stage === 'hello-v2-redeploy') {
            activeGreeting = 'Hello, Core!';
            v2Greeting = 'Hello, Core!';
          }
          if (input.stage === 'rollback-v2') {
            activeGreeting = 'Hello again, Core!';
            v2Greeting = 'Hello again, Core!';
          }
          if (input.stage === 'backup') {
            const backupRoot = join(root, '.self-host', 'e2e', 'backup');
            if (input.stdoutFile !== undefined) {
              mkdirSync(backupRoot, { recursive: true });
              writeFileSync(
                join(root, input.stdoutFile),
                input.stdoutFile.endsWith('database.dump') ? 'database backup' : 'asset backup',
              );
            }
            if (input.command === 'tar' && input.args.includes('-czf')) {
              writeFileSync(join(root, '.self-host', 'e2e', 'noodle-backup.tar.gz'), 'archive');
            }
          }
          if (
            input.stage === 'log-scan' &&
            input.command === trustedDocker &&
            input.args.some((argument) => argument.includes('writeFileSync'))
          ) {
            throw new SelfHostE2EFailure(
              'log-scan',
              'command exited with code 1',
              'EROFS: read-only file system',
            );
          }
          const stdout =
            input.stage === 'rendered-config-audit' && input.args.at(-1) === '--services'
              ? 'postgres\nnoodle\nbootstrap\ncli\n'
              : input.stage === 'bootstrap'
                ? `${bootstrapResponses[(calls.filter((call) => call.stage === 'bootstrap').length - 1) % 3]}\n`
                : input.stage === 'hello-v1-deploy'
                  ? `${JSON.stringify({
                      ok: true,
                      data: {
                        deploymentId: 'hello-v1',
                        serverVersion: '1',
                        url: 'http://127.0.0.1:8787/o/noodle-local/hello/v1/mcp',
                        defaultUrl: 'http://127.0.0.1:8787/o/noodle-local/hello/mcp',
                      },
                    })}\n`
                  : input.stage === 'hello-v2-deploy'
                    ? `${JSON.stringify({
                        ok: true,
                        data: {
                          deploymentId: 'hello-v2',
                          serverVersion: '2',
                          url: 'http://127.0.0.1:8787/o/noodle-local/hello/v2/mcp',
                          defaultUrl: 'http://127.0.0.1:8787/o/noodle-local/hello/mcp',
                        },
                      })}\n`
                    : input.stage === 'hello-v2-redeploy'
                      ? `${JSON.stringify({
                          ok: true,
                          data: {
                            deploymentId: 'hello-v2-replacement',
                            serverVersion: '2',
                            url: 'http://127.0.0.1:8787/o/noodle-local/hello/v2/mcp',
                            defaultUrl: 'http://127.0.0.1:8787/o/noodle-local/hello/mcp',
                          },
                        })}\n`
                      : input.stage === 'rollback-v2'
                        ? `${JSON.stringify({
                            ok: true,
                            data: {
                              ok: true,
                              target: { org: 'noodle-local', app: 'hello', env: 'prod' },
                              rollback: {
                                deploymentId: 'hello-v2',
                                previousDeploymentId: 'hello-v2-replacement',
                                endpointUrl: 'http://127.0.0.1:8787/o/noodle-local/hello/v2/mcp',
                              },
                            },
                          })}\n`
                        : input.stage === 'widget-deploy' && input.args.includes('package')
                          ? `${JSON.stringify({
                              ok: true,
                              data: {
                                deploymentId: 'food-ordering-v1',
                                appSlug: 'food-ordering',
                                environment: 'prod',
                                serverVersion: '1',
                                active: true,
                                snapshot: {
                                  files: [{ target: 'codex', path: 'AGENTS.md' }],
                                },
                              },
                            })}\n`
                          : input.stage === 'widget-deploy'
                            ? `${JSON.stringify({
                                ok: true,
                                data: {
                                  deploymentId: 'food-ordering-v1',
                                  serverVersion: '1',
                                  url: 'http://127.0.0.1:8787/o/noodle-local/food-ordering/v1/mcp',
                                  defaultUrl:
                                    'http://127.0.0.1:8787/o/noodle-local/food-ordering/mcp',
                                },
                              })}\n`
                            : input.stage === 'recovered-calls-assets' &&
                                input.args.includes('status')
                              ? `${JSON.stringify({
                                  ok: true,
                                  data: {
                                    target: { org: 'noodle-local', app: 'hello', env: 'prod' },
                                    deployment: {
                                      deploymentId: 'hello-v2',
                                      endpointUrl:
                                        'http://127.0.0.1:8787/o/noodle-local/hello/v2/mcp',
                                    },
                                  },
                                })}\n`
                              : input.stage === 'recovered-calls-assets' &&
                                  input.args.includes('inspect')
                                ? (() => {
                                    const deploymentId =
                                      input.args[input.args.indexOf('inspect') + 1];
                                    const summary =
                                      deploymentId === 'hello-v1'
                                        ? {
                                            deploymentId,
                                            appSlug: 'hello',
                                            environment: 'prod',
                                            serverVersion: '1',
                                            endpointUrl:
                                              'http://127.0.0.1:8787/o/noodle-local/hello/v1/mcp',
                                            active: true,
                                          }
                                        : deploymentId === 'hello-v2'
                                          ? {
                                              deploymentId,
                                              appSlug: 'hello',
                                              environment: 'prod',
                                              serverVersion: '2',
                                              endpointUrl:
                                                'http://127.0.0.1:8787/o/noodle-local/hello/v2/mcp',
                                              active: true,
                                            }
                                          : deploymentId === 'hello-v2-replacement'
                                            ? {
                                                deploymentId,
                                                appSlug: 'hello',
                                                environment: 'prod',
                                                serverVersion: '2',
                                                endpointUrl:
                                                  'http://127.0.0.1:8787/o/noodle-local/hello/v2/mcp',
                                                active: false,
                                              }
                                            : {
                                                deploymentId,
                                                appSlug: 'food-ordering',
                                                environment: 'prod',
                                                serverVersion: '1',
                                                endpointUrl:
                                                  'http://127.0.0.1:8787/o/noodle-local/food-ordering/v1/mcp',
                                                active: true,
                                              };
                                    return `${JSON.stringify({ ok: true, data: summary })}\n`;
                                  })()
                                : input.stage === 'log-scan' && input.args.includes('id')
                                  ? input.args.includes('postgres')
                                    ? '999\n'
                                    : '1000\n'
                                  : input.stage === 'log-scan' && input.args.includes('logs')
                                    ? 'level=info event=service.ready\n'
                                    : input.stage === 'backup' &&
                                        input.command === 'tar' &&
                                        input.args[0] === '-tzf' &&
                                        input.args.at(-1)?.endsWith('assets.tar.gz')
                                      ? './opaque-asset\n'
                                      : input.stage === 'backup' && input.command === 'tar'
                                        ? 'database.dump\nassets.tar.gz\n'
                                        : input.stage === 'log-scan' &&
                                            input.command === trustedDocker
                                          ? [
                                              [
                                                'postgres',
                                                'true',
                                                'false',
                                                'null',
                                                '["ALL"]',
                                                '["no-new-privileges:true"]',
                                                'noodle-e2e-a1b2c3d4_default',
                                                '{"/tmp":"rw,noexec,nosuid,size=64m","/var/run/postgresql":"rw,noexec,nosuid,size=16m,uid=999,gid=999,mode=0775"}',
                                                '{}',
                                                '[{"Type":"volume","Name":"noodle-e2e-a1b2c3d4_postgres-data","Destination":"/var/lib/postgresql/data"}]',
                                              ].join('\t'),
                                              [
                                                'node',
                                                'true',
                                                'false',
                                                'null',
                                                '["ALL"]',
                                                '["no-new-privileges:true"]',
                                                'noodle-e2e-a1b2c3d4_default',
                                                '{"/tmp":"rw,noexec,nosuid,size=64m"}',
                                                '{"8787/tcp":[{"HostIp":"127.0.0.1","HostPort":"8787"}]}',
                                                '[{"Type":"volume","Name":"noodle-e2e-a1b2c3d4_asset-data","Destination":"/var/lib/noodle/assets"}]',
                                              ].join('\t'),
                                              '',
                                            ].join('\n')
                                          : '';
          return { code: 0, stdout, stderr: '', display: 'safe command' };
        },
      ),
    };
    const requests: Request[] = [];
    const reports: string[] = [];
    const assetBytes = Buffer.from('durable-widget-branding-image');
    const fetchImpl: typeof fetch = async (input, init) => {
      const request =
        input instanceof Request && init === undefined ? input : new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname === '/readyz') return new Response('ready');
      if (url.pathname === '/v1/orgs/noodle-local') return new Response(null, { status: 401 });
      if (url.pathname.startsWith('/__noodle/hosted-assets/')) {
        return new Response(request.method === 'HEAD' ? null : assetBytes, {
          headers: {
            etag: '"asset-etag"',
            'content-type': 'image/jpeg',
            'content-length': String(assetBytes.byteLength),
            'x-content-type-options': 'nosniff',
          },
        });
      }
      const body = (await request.clone().json()) as {
        readonly id?: number;
        readonly method: string;
        readonly params?: {
          readonly name?: string;
          readonly uri?: string;
          readonly arguments?: unknown;
        };
      };
      if (body.id === undefined) return new Response(null, { status: 202 });
      let result: unknown;
      if (body.method === 'initialize') {
        result = { protocolVersion: '2025-11-25', capabilities: { tools: {} } };
      } else if (body.method === 'server/discover') {
        result = { protocolVersion: '2026-07-28', capabilities: { tools: {} } };
      } else if (body.method === 'tools/list') {
        result = { tools: [{ name: 'greet' }, { name: 'list_today' }] };
      } else if (body.method === 'tools/call' && body.params?.name === 'greet') {
        const greeting = url.pathname.includes('/hello/v2/')
          ? v2Greeting
          : url.pathname.includes('/hello/v1/')
            ? 'Hello, Core!'
            : activeGreeting;
        result = { structuredContent: { message: greeting } };
      } else if (body.method === 'resources/list') {
        result = {
          resources: [
            { uri: 'noodle://food_ordering/guide' },
            { uri: 'ui://food_ordering/open_ordering_widget' },
          ],
        };
      } else if (body.method === 'resources/read') {
        result = {
          contents: [
            {
              uri: body.params?.uri,
              text: '<img src="http://127.0.0.1:8787/__noodle/hosted-assets/0123456789abcdef/1111111111111111/2222222222222222/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/branding_logo">',
            },
          ],
        };
      } else {
        result = {};
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const results = await runSelfHostE2E({
        root,
        projectName: 'noodle-e2e-a1b2c3d4',
        dockerPath: trustedDocker,
        nodePath: trustedNode,
        runner,
        fetch: fetchImpl,
        report: (message: string) => reports.push(message),
      });

      expect(results.map((result: { readonly name: string }) => result.name)).toEqual(
        SELF_HOST_E2E_STAGE_NAMES,
      );
      expect(calls.find((call) => call.stage === 'init')).toMatchObject({
        command: trustedNode,
        args: [
          'packages/cli/dist/bin.js',
          'service',
          'init',
          '--profile',
          'open-core',
          '--compose',
        ],
      });
      expect(calls.some((call) => call.stage === 'hello-v1-deploy')).toBe(true);
      const organizationArgs = calls.flatMap((call) =>
        call.args.flatMap((argument, index) =>
          argument === '--org' ? [call.args[index + 1]] : [],
        ),
      );
      expect(organizationArgs).not.toHaveLength(0);
      expect(new Set(organizationArgs)).toEqual(new Set(['noodle-local']));
      expect(
        calls.some(
          (call) =>
            call.stage === 'image-build-start' &&
            call.args.includes('build') &&
            ['noodle', 'bootstrap', 'cli'].every((service) => call.args.includes(service)),
        ),
      ).toBe(true);
      expect(
        calls.some(
          (call) =>
            call.stage === 'image-build-start' &&
            call.args.includes('up') &&
            !call.args.includes('--build'),
        ),
      ).toBe(true);
      expect(
        calls.filter(
          (call) =>
            call.stage === 'bootstrap' &&
            call.args.includes('run') &&
            call.args.includes('--no-deps') &&
            call.args.includes('bootstrap'),
        ),
      ).toHaveLength(2);
      expect(
        calls.filter((call) => call.stage === 'bootstrap' && call.args.includes('list')),
      ).toHaveLength(2);
      expect(
        calls.filter((call) => call.stage === 'bootstrap' && call.args.includes('inspect')),
      ).toHaveLength(2);
      expect(calls.some((call) => call.stage === 'hello-v2-redeploy')).toBe(true);
      expect(calls.some((call) => call.stage === 'rollback-v2')).toBe(true);
      expect(
        calls.some(
          (call) =>
            call.stage === 'widget-deploy' &&
            call.args.includes('/app/examples/food-ordering/src/server.ts'),
        ),
      ).toBe(true);
      expect(
        calls.some((call) => call.stage === 'widget-deploy' && call.args.includes('package')),
      ).toBe(true);
      expect(calls.some((call) => call.stage === 'retained-volume-restart')).toBe(true);
      const firstRestartRemoval = calls.findIndex(
        (call) => call.stage === 'retained-volume-restart' && call.args.includes('rm'),
      );
      const logSnapshots = calls
        .map((call, index) => ({ call, index }))
        .filter(({ call }) => call.args.includes('logs') && call.args.includes('--no-color'));
      expect(logSnapshots).toHaveLength(2);
      expect(logSnapshots[0]?.index).toBeLessThan(firstRestartRemoval);
      expect(logSnapshots[1]?.index).toBeGreaterThan(firstRestartRemoval);
      expect(
        calls.some(
          (call) => call.stage === 'recovered-calls-assets' && call.args.includes('status'),
        ),
      ).toBe(true);
      expect(
        calls.filter(
          (call) => call.stage === 'recovered-calls-assets' && call.args.includes('inspect'),
        ),
      ).toHaveLength(4);
      const databaseBackup = calls.find(
        (call) => call.stage === 'backup' && call.args.includes('pg_dump'),
      );
      expect(databaseBackup?.stdoutFile).toBe('.self-host/e2e/backup/database.dump');
      const databaseValidation = calls.find(
        (call) => call.stage === 'backup' && call.args.includes('pg_restore'),
      );
      expect(databaseValidation?.stdinFile).toBe('.self-host/e2e/backup/database.dump');
      const assetBackupRun = calls.find(
        (call) =>
          call.stage === 'backup' &&
          call.args.includes('/var/lib/noodle/assets') &&
          call.args.includes('-czf'),
      );
      expect(assetBackupRun?.stdoutFile).toBe('.self-host/e2e/backup/assets.tar.gz');
      expect(assetBackupRun?.args).toContain('--rm');
      expect(assetBackupRun?.args).not.toContain('--user');
      expect(calls.some((call) => call.stage === 'backup' && call.args.includes('cp'))).toBe(false);
      expect(
        calls.some(
          (call) =>
            call.stage === 'log-scan' &&
            call.args.some((argument) => argument.includes('writeFileSync')),
        ),
      ).toBe(true);
      expect(calls.at(-1)).toMatchObject({
        stage: 'cleanup',
        command: trustedDocker,
        args: expect.arrayContaining([
          'compose',
          '--file',
          'compose.yaml',
          '--project-name',
          'noodle-e2e-a1b2c3d4',
          'down',
          '--volumes',
          '--remove-orphans',
        ]),
      });
      for (const call of calls.filter(
        (candidate) =>
          candidate.command === trustedDocker && candidate.args.includes('--project-name'),
      )) {
        expect(call.args.slice(0, 3)).toEqual(['compose', '--file', 'compose.yaml']);
      }
      expect(calls.some((call) => call.command === 'docker')).toBe(false);
      expect(
        requests.some((request) => request.headers.get('mcp-protocol-version') === '2025-11-25'),
      ).toBe(true);
      expect(
        requests.some((request) => request.headers.get('mcp-protocol-version') === '2026-07-28'),
      ).toBe(true);
      expect(calls.flatMap((call) => call.args).join('\n')).not.toMatch(
        /admin-secret|postgres-secret|master-secret|asset-secret/,
      );
      const inspect = calls.find(
        (call) => call.stage === 'log-scan' && call.args.includes('inspect'),
      );
      expect(inspect?.args).toContain('--format');
      const inspectFormat = inspect?.args[inspect.args.indexOf('--format') + 1];
      expect(inspectFormat).toContain('.HostConfig.Privileged');
      expect(inspectFormat).toContain('.HostConfig.CapAdd');
      expect(inspectFormat).toContain('.HostConfig.NetworkMode');
      expect(inspectFormat).toContain('.HostConfig.Tmpfs');
      expect(inspect?.args.join(' ')).not.toContain('.Config.Env');
      expect(
        calls.filter((call) => call.stage === 'log-scan' && call.args.includes('id')),
      ).toHaveLength(2);
      expect(reports).toContain('stage: prerequisites');
      expect(reports).toContain('stage: cleanup');
      expect(
        reports.some((message) => message.startsWith(`command: ${trustedDocker} compose`)),
      ).toBe(true);
      expect(reports.join('\n')).not.toMatch(
        /admin-secret|postgres-secret|master-secret|asset-secret/,
      );
      expect(existsSync(join(root, '.self-host'))).toBe(false);
      expect(existsSync(join(root, 'noodle.service.yaml'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
