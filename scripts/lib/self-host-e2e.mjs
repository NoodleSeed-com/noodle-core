import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { backupSelfHostState } from './self-host-e2e-backup.mjs';
import {
  assertBootstrapOrganization,
  assertDeploymentPackage,
  assertExactComposeServices,
  assertLiveNonRootUid,
  assertRecoveredDeployment,
  assertSameAsset,
  deploymentResult,
  fetchAsset,
  hostedAssetUrl,
  parseCliJson,
  requireString,
} from './self-host-e2e-contract.mjs';
import { acceptanceRequestSignal, exerciseHello, mcpRpc } from './self-host-e2e-mcp.mjs';
import {
  assertContainerHardening,
  assertSelfHostProjectName,
  assertSelfHostRootAvailable,
  cliArguments,
  composeArguments,
  createExactProjectCleanup,
  createProcessRunner,
  renderSafeCommand,
  runAcceptanceStages,
  SelfHostE2EFailure,
} from './self-host-e2e-process.mjs';

export {
  assertExactComposeServices,
  assertLiveNonRootUid,
  deploymentResult,
  fetchAsset,
  hostedAssetUrl,
  parseCliJson,
} from './self-host-e2e-contract.mjs';
export { mcpRpc, parseMcpResponse } from './self-host-e2e-mcp.mjs';
export {
  assertContainerHardening,
  assertSelfHostProjectName,
  assertSelfHostRootAvailable,
  createExactProjectCleanup,
  createProcessRunner,
  redactSensitiveOutput,
  renderSafeCommand,
  runAcceptanceStages,
  SelfHostE2EFailure,
} from './self-host-e2e-process.mjs';

export const SELF_HOST_E2E_STAGE_NAMES = Object.freeze([
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

const REQUIRED_SECRET_NAMES = Object.freeze([
  'POSTGRES_PASSWORD',
  'DATABASE_URL',
  'NOODLE_SECRET_MASTER_KEY',
  'NOODLE_SELF_HOST_ADMIN_TOKEN',
  'NOODLE_ASSET_IDENTITY_SALT',
]);
const SELF_HOST_ORG_SLUG = 'noodle-local';

function parseGeneratedSecrets(contents) {
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error('generated .env contained an invalid line');
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  for (const name of REQUIRED_SECRET_NAMES) {
    if (typeof values[name] !== 'string' || values[name].length === 0) {
      throw new Error(`generated .env did not contain ${name}`);
    }
  }
  return values;
}

/**
 * Drive the documented public self-host journey through injected process and HTTP ports.
 * The caller owns the temporary root; this boundary owns only its exact Compose project.
 */
export async function runSelfHostE2E(input) {
  if (input.dockerPath !== undefined && !isAbsolute(input.dockerPath)) {
    throw new Error('self-host E2E requires an absolute Docker path when one is provided');
  }
  if (input.nodePath !== undefined && !isAbsolute(input.nodePath)) {
    throw new Error('self-host E2E requires an absolute Node path when one is provided');
  }
  const projectName = assertSelfHostProjectName(input.projectName);
  const runner = input.runner ?? createProcessRunner();
  const fetchImpl = input.fetch ?? fetch;
  const root = input.root;
  const dockerCommand = input.dockerPath ?? 'docker';
  const nodeCommand = input.nodePath ?? 'node';
  await assertSelfHostRootAvailable(root);
  const report = input.report ?? (() => undefined);
  const captured = [];
  let generatedSecrets = [];
  let helloV1;
  let helloV2;
  let helloV2Replacement;
  let widget;
  const seenDeploymentIds = new Set();
  let assetUrl;
  let assetBefore;

  const run = async (stage, command, args, timeoutMs = 120_000, io = {}) => {
    report(`command: ${renderSafeCommand(command, args)}`);
    const result = await runner.run({
      stage,
      command,
      args,
      cwd: root,
      timeoutMs,
      generatedSecrets,
      signal: input.signal,
      ...io,
    });
    captured.push(result.stdout, result.stderr);
    return result;
  };
  const expectReadOnlyFailure = async (stage, command, args, timeoutMs = 30_000) => {
    report(`command: ${renderSafeCommand(command, args)}`);
    try {
      await runner.run({
        stage,
        command,
        args,
        cwd: root,
        timeoutMs,
        generatedSecrets,
        signal: input.signal,
      });
    } catch (error) {
      if (
        error instanceof SelfHostE2EFailure &&
        /command exited with code [1-9]/.test(error.message) &&
        /EROFS|read-only file system/i.test(error.safeTail)
      ) {
        captured.push(error.safeTail);
        return;
      }
      throw error;
    }
    throw new Error('write outside declared writable paths unexpectedly succeeded');
  };
  const compose = (stage, args, timeoutMs, io) =>
    run(stage, dockerCommand, composeArguments(projectName, ...args), timeoutMs, io);
  const cli = (stage, args, timeoutMs) =>
    run(stage, dockerCommand, cliArguments(projectName, ...args), timeoutMs);

  const stages = [
    {
      name: 'prerequisites',
      run: async () => {
        await run('prerequisites', dockerCommand, ['version'], 30_000);
        await run('prerequisites', dockerCommand, ['compose', 'version'], 30_000);
        await run('prerequisites', 'tar', ['--version'], 30_000);
        return { detail: 'Docker Engine, Compose, and tar are available' };
      },
    },
    {
      name: 'init',
      run: async () => {
        await run(
          'init',
          nodeCommand,
          ['packages/cli/dist/bin.js', 'service', 'init', '--profile', 'open-core', '--compose'],
          60_000,
        );
        const env = parseGeneratedSecrets(await readFile(join(root, '.self-host', '.env'), 'utf8'));
        generatedSecrets = REQUIRED_SECRET_NAMES.map((name) => env[name]);
        const helloSource = await readFile(
          join(root, 'examples', 'hello', 'src', 'server.ts'),
          'utf8',
        );
        const changed = helloSource.replace(
          '`Hello, ${input.name}!`',
          '`Hello again, ${input.name}!`',
        );
        if (changed === helloSource)
          throw new Error('hello v2 greeting fixture was not found exactly once');
        const e2eRoot = join(root, '.self-host', 'e2e', 'hello-v2');
        await mkdir(e2eRoot, { recursive: true });
        await writeFile(join(e2eRoot, 'server.ts'), changed, 'utf8');
        return { detail: 'generated local self-host configuration and isolated v2 source' };
      },
    },
    {
      name: 'rendered-config-audit',
      run: async () => {
        await compose('rendered-config-audit', ['config', '--quiet'], 30_000);
        const services = await compose('rendered-config-audit', ['config', '--services'], 30_000);
        assertExactComposeServices(services.stdout);
        return { detail: 'Compose config renders the exact public service set' };
      },
    },
    {
      name: 'image-build-start',
      run: async () => {
        await compose('image-build-start', ['build', 'noodle', 'bootstrap', 'cli'], 15 * 60_000);
        await compose('image-build-start', ['up', '--wait', 'postgres', 'noodle'], 15 * 60_000);
        return {
          detail: 'source-built service and CLI images are ready and the service is healthy',
        };
      },
    },
    {
      name: 'health',
      run: async () => {
        const response = await fetchImpl('http://127.0.0.1:8787/readyz', {
          signal: acceptanceRequestSignal(input.signal),
        });
        if (!response.ok) throw new Error(`readiness failed with HTTP ${response.status}`);
        for (const authorization of [undefined, 'Bearer deliberately-wrong']) {
          const denied = await fetchImpl(`http://127.0.0.1:8787/v1/orgs/${SELF_HOST_ORG_SLUG}`, {
            headers: authorization === undefined ? undefined : { authorization },
            signal: acceptanceRequestSignal(input.signal),
          });
          if (denied.status !== 401)
            throw new Error('control plane accepted a missing or wrong token');
        }
        return { detail: 'loopback health succeeds and control plane rejects invalid auth' };
      },
    },
    {
      name: 'bootstrap',
      run: async () => {
        let createdAt;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const created = await compose(
            'bootstrap',
            ['run', '--rm', '--no-deps', 'bootstrap'],
            120_000,
          );
          const listed = await cli('bootstrap', ['orgs', 'list', '--json'], 120_000);
          const inspected = await cli(
            'bootstrap',
            ['orgs', 'inspect', SELF_HOST_ORG_SLUG, '--json'],
            120_000,
          );
          createdAt = assertBootstrapOrganization(
            created.stdout,
            listed.stdout,
            inspected.stdout,
            createdAt,
          );
        }
        return { detail: 'two bootstraps preserved one local organization' };
      },
    },
    {
      name: 'hello-v1-deploy',
      run: async () => {
        const result = await cli(
          'hello-v1-deploy',
          [
            'deploy',
            '/app/examples/hello/src/server.ts',
            '--org',
            SELF_HOST_ORG_SLUG,
            '--app',
            'hello',
            '--env',
            'prod',
            '--access',
            'public',
            '--version',
            '1',
            '--no-save',
            '--no-prompt',
            '--json',
          ],
          120_000,
        );
        helloV1 = deploymentResult(
          result.stdout,
          'hello v1 deploy',
          { app: 'hello', version: '1' },
          seenDeploymentIds,
        );
        return { detail: `deployed hello v1 as ${helloV1.deploymentId}` };
      },
    },
    {
      name: 'legacy-call',
      run: async () => {
        await exerciseHello(
          fetchImpl,
          helloV1.defaultUrl,
          '2025-11-25',
          'Hello, Core!',
          10,
          input.signal,
        );
        return { detail: 'legacy initialize, discovery, and greet succeeded' };
      },
    },
    {
      name: 'modern-call',
      run: async () => {
        await exerciseHello(
          fetchImpl,
          helloV1.defaultUrl,
          '2026-07-28',
          'Hello, Core!',
          20,
          input.signal,
        );
        return { detail: 'modern discovery and greet succeeded' };
      },
    },
    {
      name: 'hello-v2-deploy',
      run: async () => {
        const result = await cli(
          'hello-v2-deploy',
          [
            'deploy',
            '/app/e2e/hello-v2/server.ts',
            '--org',
            SELF_HOST_ORG_SLUG,
            '--app',
            'hello',
            '--env',
            'prod',
            '--access',
            'public',
            '--version',
            '2',
            '--no-save',
            '--no-prompt',
            '--json',
          ],
          120_000,
        );
        helloV2 = deploymentResult(
          result.stdout,
          'hello v2 deploy',
          { app: 'hello', version: '2' },
          seenDeploymentIds,
        );
        await exerciseHello(
          fetchImpl,
          helloV2.defaultUrl,
          '2026-07-28',
          'Hello again, Core!',
          30,
          input.signal,
        );
        return { detail: `deployed and called hello v2 as ${helloV2.deploymentId}` };
      },
    },
    {
      name: 'hello-v2-redeploy',
      run: async () => {
        const result = await cli(
          'hello-v2-redeploy',
          [
            'deploy',
            '/app/examples/hello/src/server.ts',
            '--org',
            SELF_HOST_ORG_SLUG,
            '--app',
            'hello',
            '--env',
            'prod',
            '--access',
            'public',
            '--version',
            '2',
            '--no-save',
            '--no-prompt',
            '--json',
          ],
          120_000,
        );
        helloV2Replacement = deploymentResult(
          result.stdout,
          'hello v2 redeploy',
          { app: 'hello', version: '2' },
          seenDeploymentIds,
        );
        await exerciseHello(
          fetchImpl,
          helloV2Replacement.defaultUrl,
          '2026-07-28',
          'Hello, Core!',
          35,
          input.signal,
        );
        return { detail: `replaced hello v2 with ${helloV2Replacement.deploymentId}` };
      },
    },
    {
      name: 'rollback-v2',
      run: async () => {
        const result = await cli('rollback-v2', [
          'rollback',
          helloV2.deploymentId,
          '--org',
          SELF_HOST_ORG_SLUG,
          '--app',
          'hello',
          '--env',
          'prod',
          '--json',
        ]);
        const rollback = parseCliJson(result.stdout);
        if (
          requireString(rollback?.rollback, 'deploymentId', 'rollback response') !==
            helloV2.deploymentId ||
          requireString(rollback?.rollback, 'previousDeploymentId', 'rollback response') !==
            helloV2Replacement.deploymentId ||
          requireString(rollback?.rollback, 'endpointUrl', 'rollback response') !== helloV2.url
        ) {
          throw new Error(
            'rollback response did not preserve the exact version-two pointer change',
          );
        }
        await exerciseHello(
          fetchImpl,
          helloV2.defaultUrl,
          '2026-07-28',
          'Hello again, Core!',
          40,
          input.signal,
        );
        await exerciseHello(fetchImpl, helloV1.url, '2026-07-28', 'Hello, Core!', 41, input.signal);
        return { detail: `rolled hello v2 back to ${helloV2.deploymentId}` };
      },
    },
    {
      name: 'widget-deploy',
      run: async () => {
        const result = await cli(
          'widget-deploy',
          [
            'deploy',
            '/app/examples/food-ordering/src/server.ts',
            '--org',
            SELF_HOST_ORG_SLUG,
            '--app',
            'food-ordering',
            '--env',
            'prod',
            '--access',
            'public',
            '--version',
            '1',
            '--no-save',
            '--no-prompt',
            '--json',
          ],
          120_000,
        );
        widget = deploymentResult(
          result.stdout,
          'widget deploy',
          { app: 'food-ordering', version: '1' },
          seenDeploymentIds,
        );
        const packaged = await cli('widget-deploy', [
          'deployments',
          'package',
          widget.deploymentId,
          '--org',
          SELF_HOST_ORG_SLUG,
          '--json',
        ]);
        assertDeploymentPackage(packaged.stdout, widget, 'food-ordering');
        const resources = await mcpRpc({
          fetch: fetchImpl,
          url: widget.defaultUrl,
          era: '2026-07-28',
          id: 50,
          method: 'resources/list',
          signal: input.signal,
          params: {},
        });
        const resourceUri = 'ui://food_ordering/open_ordering_widget';
        if (
          !Array.isArray(resources?.resources) ||
          !resources.resources.some(
            (resource) =>
              resource !== null && typeof resource === 'object' && resource.uri === resourceUri,
          )
        ) {
          throw new Error('Food Ordering did not expose the exact widget resource URI');
        }
        const resource = await mcpRpc({
          fetch: fetchImpl,
          url: widget.defaultUrl,
          era: '2026-07-28',
          id: 51,
          method: 'resources/read',
          signal: input.signal,
          params: { uri: resourceUri },
        });
        assetUrl = hostedAssetUrl(resource);
        return { detail: `deployed widget as ${widget.deploymentId}` };
      },
    },
    {
      name: 'asset-fetch',
      run: async () => {
        assetBefore = await fetchAsset(fetchImpl, assetUrl, input.signal);
        return { detail: `fetched widget asset ${assetBefore.sha256}` };
      },
    },
    {
      name: 'retained-volume-restart',
      run: async () => {
        await compose('retained-volume-restart', ['logs', '--no-color'], 60_000);
        await compose('retained-volume-restart', ['stop', 'noodle'], 60_000);
        await compose('retained-volume-restart', ['rm', '--force', 'noodle'], 60_000);
        await compose(
          'retained-volume-restart',
          ['up', '--build', '--wait', 'postgres', 'noodle'],
          15 * 60_000,
        );
        return { detail: 'restarted service while retaining PostgreSQL and asset volumes' };
      },
    },
    {
      name: 'recovered-calls-assets',
      run: async () => {
        const statusResult = await cli('recovered-calls-assets', [
          'status',
          '--org',
          SELF_HOST_ORG_SLUG,
          '--app',
          'hello',
          '--env',
          'prod',
          '--json',
        ]);
        const status = parseCliJson(statusResult.stdout);
        const activeDeploymentId = requireString(
          status?.deployment,
          'deploymentId',
          'recovered hello status',
        );
        const activeEndpoint = requireString(
          status?.deployment,
          'endpointUrl',
          'recovered hello status',
        );
        if (activeDeploymentId !== helloV2.deploymentId || activeEndpoint !== helloV2.url) {
          throw new Error('recovered hello status did not preserve the rolled-back deployment');
        }
        for (const expected of [
          {
            ...helloV1,
            app: 'hello',
            version: '1',
            active: true,
            context: 'recovered hello v1 deployment',
          },
          {
            ...helloV2,
            app: 'hello',
            version: '2',
            active: true,
            context: 'recovered hello v2 deployment',
          },
          {
            ...helloV2Replacement,
            app: 'hello',
            version: '2',
            active: false,
            context: 'recovered replaced hello v2 deployment',
          },
          {
            ...widget,
            app: 'food-ordering',
            version: '1',
            active: true,
            context: 'recovered widget deployment',
          },
        ]) {
          const inspected = await cli('recovered-calls-assets', [
            'deployments',
            'inspect',
            expected.deploymentId,
            '--org',
            SELF_HOST_ORG_SLUG,
            '--json',
          ]);
          assertRecoveredDeployment(inspected.stdout, expected);
        }
        await exerciseHello(fetchImpl, helloV1.url, '2025-11-25', 'Hello, Core!', 60, input.signal);
        await exerciseHello(
          fetchImpl,
          helloV2.url,
          '2026-07-28',
          'Hello again, Core!',
          70,
          input.signal,
        );
        await exerciseHello(
          fetchImpl,
          helloV1.defaultUrl,
          '2026-07-28',
          'Hello again, Core!',
          80,
          input.signal,
        );
        const after = await fetchAsset(fetchImpl, assetUrl, input.signal);
        assertSameAsset(assetBefore, after);
        return {
          detail: 'both deployment versions and the exact widget asset recovered after restart',
        };
      },
    },
    {
      name: 'backup',
      run: () =>
        backupSelfHostState({
          root,
          projectName,
          run,
          compose,
          fetch: fetchImpl,
          helloDefaultUrl: helloV1.defaultUrl,
          assetBefore,
          assetUrl,
          signal: input.signal,
        }),
    },
    {
      name: 'log-scan',
      run: async () => {
        await expectReadOnlyFailure(
          'log-scan',
          dockerCommand,
          composeArguments(
            projectName,
            'exec',
            '-T',
            'noodle',
            'node',
            '-e',
            "require('node:fs').writeFileSync('/app/.noodle-e2e-write-probe', 'blocked')",
          ),
        );
        await compose('log-scan', ['logs', '--no-color'], 60_000);
        for (const service of ['postgres', 'noodle']) {
          const liveUid = await compose('log-scan', ['exec', '-T', service, 'id', '-u'], 30_000);
          assertLiveNonRootUid(liveUid.stdout, service);
        }
        const inspection = await run(
          'log-scan',
          dockerCommand,
          [
            'inspect',
            '--format',
            '{{.Config.User}}\t{{json .HostConfig.ReadonlyRootfs}}\t{{json .HostConfig.Privileged}}\t{{json .HostConfig.CapAdd}}\t{{json .HostConfig.CapDrop}}\t{{json .HostConfig.SecurityOpt}}\t{{.HostConfig.NetworkMode}}\t{{json .HostConfig.Tmpfs}}\t{{json .HostConfig.PortBindings}}\t{{json .Mounts}}',
            `${projectName}-postgres-1`,
            `${projectName}-noodle-1`,
          ],
          30_000,
        );
        assertContainerHardening(inspection.stdout, projectName);
        const allOutput = captured.join('\n');
        for (const secret of generatedSecrets) {
          if (allOutput.includes(secret))
            throw new Error('generated secret appeared in captured output');
        }
        if (/authorization\s*:|\bbearer\s+|postgres(?:ql)?:\/\//i.test(allOutput)) {
          throw new Error('secret-shaped value appeared in captured output');
        }
        return { detail: 'logs are secret-free and containers retain required hardening' };
      },
    },
  ];

  const cleanup =
    input.cleanup ??
    createExactProjectCleanup({
      root,
      projectName,
      dockerPath: input.dockerPath,
      runner,
      removeGeneratedState: true,
    });
  return runAcceptanceStages(
    stages.map((stage) => ({
      ...stage,
      run: async () => {
        if (input.signal?.aborted) {
          throw new SelfHostE2EFailure(stage.name, 'acceptance run was interrupted');
        }
        report(`stage: ${stage.name}`);
        return stage.run();
      },
    })),
    async () => {
      report('stage: cleanup');
      await cleanup();
    },
  );
}
