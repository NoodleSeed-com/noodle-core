import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  calculateFindingId,
  canonicalJson,
  findingInventoryDigest,
} from '../../../scripts/lib/npm-artifact-policy.mjs';
import { createNpmArtifactReport } from '../../../scripts/npm-artifact-containment.mjs';
import {
  installAndValidatePackedArtifacts,
  releaseArtifactInstallCommands,
  validateInstalledReleaseArtifacts,
} from '../../../scripts/system-release-artifacts.mjs';
import { canonicalTarballHash } from '../../../scripts/system-release-planner.mjs';

type TarEntry = { path: string; content: string; mode?: number };

function tarHeader(entry: TarEntry): Buffer {
  const content = Buffer.from(entry.content);
  const header = Buffer.alloc(512);
  const write = (offset: number, length: number, value: string) =>
    header.write(value, offset, Math.min(length, Buffer.byteLength(value)), 'utf8');
  write(0, 100, entry.path);
  write(100, 8, `${(entry.mode ?? 0o644).toString(8).padStart(7, '0')}\0`);
  write(108, 8, '0000000\0');
  write(116, 8, '0000000\0');
  write(124, 12, `${content.length.toString(8).padStart(11, '0')}\0`);
  write(136, 12, '00000000000\0');
  header.fill(0x20, 148, 156);
  write(156, 1, '0');
  write(257, 6, 'ustar\0');
  write(263, 2, '00');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  write(148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return Buffer.concat([header, content, Buffer.alloc((512 - (content.length % 512)) % 512)]);
}

function writeTarball(
  path: string,
  options: {
    name?: string;
    version?: string;
    files?: TarEntry[];
  } = {},
): void {
  const name = options.name ?? '@noodleseed/one';
  const version = options.version ?? '1.2.3';
  const entries: TarEntry[] = [
    {
      path: 'package/package.json',
      content: JSON.stringify({
        name,
        version,
        license: 'Apache-2.0',
        bundleDependencies: [],
      }),
    },
    ...(name === '@noodleseed/one'
      ? [
          { path: 'package/LICENSE', content: 'Apache license' },
          { path: 'package/NOTICE', content: 'notice' },
          { path: 'package/README.md', content: 'readme' },
          { path: 'package/dist/bin.js', content: '#!/usr/bin/env node\n', mode: 0o755 },
        ]
      : []),
    ...(options.files ?? []),
  ];
  writeFileSync(path, gzipSync(Buffer.concat([...entries.map(tarHeader), Buffer.alloc(1024)])));
}

function sha512(value: string | Buffer) {
  return `sha512-${createHash('sha512').update(value).digest('base64')}`;
}

function artifactPolicy(tarballPath?: string, dirty = false) {
  const finding = {
    class: 'commercial-service-path',
    path: 'dist/private.js',
    package: '@noodleseed/one',
  };
  const findingIds = dirty ? [calculateFindingId(finding)] : [];
  return {
    schemaVersion: 1,
    package: '@noodleseed/one',
    mode: dirty ? 'freeze' : 'enforce',
    moduleSyntax: { parser: 'typescript', parserVersion: '6.0.3', rulesVersion: 1 },
    requiredRootFiles: ['LICENSE', 'NOTICE', 'README.md', 'dist/bin.js', 'package.json'],
    allowedRootPathClasses: [
      'LICENSE',
      'NOTICE',
      'README.md',
      'dist/**',
      'node_modules/**',
      'package.json',
      'react/**',
    ],
    firstPartyAllowedPathClasses: ['LICENSE*', 'NOTICE*', 'README*', 'dist/**', 'package.json'],
    bundleDependencies: [],
    nestedPhysicalPackages: [],
    firstPartyPackages: [],
    deniedPackages: ['stripe'],
    deniedPackagePatterns: ['@workos-inc/*'],
    deniedPathClasses: dirty
      ? [{ findingClass: finding.class, patterns: ['dist/private.js'] }]
      : [],
    limits: { maxArchiveBytes: 1_000_000, maxEntries: 100, maxUnpackedBytes: 1_000_000 },
    baseline: {
      npmVersion: dirty ? '1.2.3' : null,
      npmIntegrity: dirty && tarballPath ? sha512(readFileSync(tarballPath)) : null,
      initialFindingIds: findingIds,
      initialInventoryDigest: findingInventoryDigest(findingIds),
      remainingFindingIds: findingIds,
    },
  };
}

function releaseEvidenceFixture(options: { dirtyCli?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'release-artifact-evidence-test-'));
  const releasePackages = join(root, 'release-packages');
  mkdirSync(releasePackages);
  const tarballs = {
    cli: 'release-packages/noodleseed-one-1.2.3.tgz',
    'agent-kit': 'release-packages/noodleseed-agent-kit-0.21.0.tgz',
    assistant: 'release-packages/noodleseed-assistant-1.0.1.tgz',
  };
  const cliPath = join(root, tarballs.cli);
  writeTarball(cliPath, {
    files: options.dirtyCli
      ? [{ path: 'package/dist/private.js', content: 'export const commercial = true;' }]
      : [],
  });
  const agentKitPath = join(root, tarballs['agent-kit']);
  writeTarball(agentKitPath, {
    name: '@noodleseed/agent-kit',
    version: '0.21.0',
    files: [
      { path: 'package/manifest.json', content: '{"packageVersion":"0.21.0"}' },
      { path: 'package/skills/example/SKILL.md', content: '# Example' },
    ],
  });
  const assistantPath = join(root, tarballs.assistant);
  writeTarball(assistantPath, {
    name: '@noodleseed/assistant',
    version: '1.0.1',
    files: [{ path: 'package/dist/index.js', content: 'export {};' }],
  });
  const planningRoot = join(root, 'planning-packages');
  mkdirSync(planningRoot);
  const planningPaths = {
    cli: join(planningRoot, 'noodleseed-one-1.2.2.tgz'),
    'agent-kit': join(planningRoot, 'noodleseed-agent-kit-0.20.0.tgz'),
    assistant: join(planningRoot, 'noodleseed-assistant-1.0.0.tgz'),
  };
  writeTarball(planningPaths.cli, {
    version: '1.2.2',
    files: options.dirtyCli
      ? [{ path: 'package/dist/private.js', content: 'export const commercial = true;' }]
      : [],
  });
  writeTarball(planningPaths['agent-kit'], {
    name: '@noodleseed/agent-kit',
    version: '0.20.0',
    files: [
      { path: 'package/manifest.json', content: '{"packageVersion":"0.20.0"}' },
      { path: 'package/skills/example/SKILL.md', content: '# Example' },
    ],
  });
  writeTarball(planningPaths.assistant, {
    name: '@noodleseed/assistant',
    version: '1.0.0',
    files: [{ path: 'package/dist/index.js', content: 'export {};' }],
  });
  const policy = artifactPolicy(cliPath, options.dirtyCli ?? false);
  const descriptor = { component: 'cli', source: 'candidate', tarball: tarballs.cli };
  const report = createNpmArtifactReport({ policy, artifacts: [descriptor], artifactRoot: root });
  const cli = report.artifacts[0];
  const packages = {
    '@noodleseed/one': {
      version: cli.version,
      tag: 'v1.2.3',
      sourceSha: 'a'.repeat(40),
      integrity: cli.tarballIntegrity,
      treeHash: cli.treeHash,
    },
    '@noodleseed/agent-kit': {
      version: '0.21.0',
      tag: 'agent-kit-v0.21.0',
      sourceSha: 'a'.repeat(40),
      integrity: sha512(readFileSync(agentKitPath)),
      treeHash: canonicalTarballHash(agentKitPath),
    },
    '@noodleseed/assistant': {
      version: '1.0.1',
      tag: 'assistant-v1.0.1',
      sourceSha: 'a'.repeat(40),
      integrity: sha512(readFileSync(assistantPath)),
      treeHash: canonicalTarballHash(assistantPath),
    },
  };
  const paths = {
    tarballs: join(root, 'tarballs.json'),
    plan: join(root, 'package-plan.json'),
    packages: join(root, 'packages.json'),
    report: join(root, 'npm-artifact-report.json'),
  };
  const planned = {
    cli: {
      version: '1.2.3',
      tag: 'v1.2.3',
      sourceSha: 'a'.repeat(40),
      integrity: null,
      treeHash: canonicalTarballHash(planningPaths.cli),
    },
    'agent-kit': {
      version: '0.21.0',
      tag: 'agent-kit-v0.21.0',
      sourceSha: 'a'.repeat(40),
      integrity: null,
      treeHash: canonicalTarballHash(planningPaths['agent-kit']),
    },
    assistant: {
      version: '1.0.1',
      tag: 'assistant-v1.0.1',
      sourceSha: 'a'.repeat(40),
      integrity: null,
      treeHash: canonicalTarballHash(planningPaths.assistant),
    },
  };
  writeFileSync(paths.tarballs, `${JSON.stringify(tarballs)}\n`);
  const planPackages = Object.fromEntries(
    [
      ['cli', '@noodleseed/one'],
      ['agent-kit', '@noodleseed/agent-kit'],
      ['assistant', '@noodleseed/assistant'],
    ].map(([component, npmPackage]) => {
      return [
        component,
        {
          component,
          npmPackage,
          changed: true,
          planned: planned[component as keyof typeof planned],
        },
      ];
    }),
  );
  writeFileSync(paths.plan, `${JSON.stringify({ packages: planPackages })}\n`);
  writeFileSync(paths.packages, `${JSON.stringify(packages)}\n`);
  writeFileSync(paths.report, `${canonicalJson(report)}\n`);
  return { root, paths, policy, report, tarballs, packages, planned };
}

function fixture(
  root = mkdtempSync(join(tmpdir(), 'release-artifacts-test-')),
  cliVersion = '0.34.0',
) {
  const packageRoot = join(root, 'node_modules/@noodleseed');
  for (const name of ['one', 'agent-kit', 'assistant'])
    mkdirSync(join(packageRoot, name), { recursive: true });
  writeFileSync(
    join(packageRoot, 'one/package.json'),
    JSON.stringify({
      version: cliVersion,
      repository: {
        type: 'git',
        url: 'https://github.com/NoodleSeed-com/noodle-core',
        directory: 'packages/cli',
      },
      homepage: 'https://docs.noodleseed.dev/docs/quickstart',
      bugs: { url: 'https://github.com/NoodleSeed-com/noodle-core/issues' },
      author: 'Noodle Seed',
      keywords: ['mcp', 'agent-connectivity', 'headless-software', 'typescript'],
    }),
  );
  writeFileSync(
    join(packageRoot, 'one/README.md'),
    readFileSync(new URL('../README.md', import.meta.url), 'utf8'),
  );
  mkdirSync(join(packageRoot, 'one/dist'));
  writeFileSync(join(packageRoot, 'one/dist/bin.js'), `console.log(${JSON.stringify(cliVersion)})`);
  writeFileSync(join(packageRoot, 'agent-kit/package.json'), JSON.stringify({ version: '0.21.0' }));
  writeFileSync(
    join(packageRoot, 'agent-kit/manifest.json'),
    JSON.stringify({ packageVersion: '0.21.0' }),
  );
  mkdirSync(join(packageRoot, 'agent-kit/skills/example'), { recursive: true });
  writeFileSync(join(packageRoot, 'agent-kit/skills/example/SKILL.md'), '# Example');
  writeFileSync(
    join(packageRoot, 'assistant/package.json'),
    JSON.stringify({
      version: '1.0.1',
      type: 'module',
      exports: {
        '.': { import: './dist/index.js', require: './dist/index.cjs' },
        './client': { import: './dist/client.js', require: './dist/client.cjs' },
        './react': { import: './dist/react.js', require: './dist/react.cjs' },
        './react/client': {
          import: './dist/react/client.js',
          require: './dist/react/client.cjs',
        },
        './server': { import: './dist/server.js', require: './dist/server.cjs' },
        './package.json': './package.json',
      },
    }),
  );
  mkdirSync(join(packageRoot, 'assistant/dist'));
  mkdirSync(join(packageRoot, 'assistant/dist/react'));
  for (const entry of ['index', 'client', 'react', 'react/client', 'server']) {
    writeFileSync(join(packageRoot, 'assistant/dist', `${entry}.js`), 'export {};');
    writeFileSync(join(packageRoot, 'assistant/dist', `${entry}.cjs`), 'module.exports = {};');
  }
  return root;
}

function evidenceExecutor(events: string[]) {
  return (command: string, args: readonly string[]) => {
    events.push(`${command} ${args[0] ?? ''}`);
    if (command === 'npm' && args[0] === 'install') {
      const prefix = args[args.indexOf('--prefix') + 1];
      if (!prefix) throw new Error('missing install prefix');
      fixture(prefix, '1.2.3');
    }
    if (command === process.execPath && args.at(-1) === '--version') return '1.2.3\n';
    return '';
  };
}

describe('packed System Release artifacts', () => {
  it.each([
    '--tarballs',
    '--package-plan',
    '--packages',
    '--npm-artifact-report',
  ])('requires the complete four-path CLI contract when %s is omitted', (omitted) => {
    const input = releaseEvidenceFixture();
    const flags = [
      ['--tarballs', input.paths.tarballs],
      ['--package-plan', input.paths.plan],
      ['--packages', input.paths.packages],
      ['--npm-artifact-report', input.paths.report],
    ].filter(([flag]) => flag !== omitted);
    const result = spawnSync(
      process.execPath,
      [join(import.meta.dirname, '../../../scripts/system-release-artifacts.mjs'), ...flags.flat()],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('usage: system-release-artifacts.mjs');
  });

  it('accepts final changed packs whose version materialization changed every planning tree', async () => {
    const input = releaseEvidenceFixture();
    const events: string[] = [];
    expect(input.planned.cli.treeHash).not.toBe(input.packages['@noodleseed/one'].treeHash);
    expect(input.planned['agent-kit'].treeHash).not.toBe(
      input.packages['@noodleseed/agent-kit'].treeHash,
    );
    expect(input.planned.assistant.treeHash).not.toBe(
      input.packages['@noodleseed/assistant'].treeHash,
    );

    await expect(
      installAndValidatePackedArtifacts(
        {
          tarballsPath: input.paths.tarballs,
          packagePlanPath: input.paths.plan,
          packagesPath: input.paths.packages,
          npmArtifactReportPath: input.paths.report,
        },
        {
          policy: input.policy,
          execute: evidenceExecutor(events),
          validateCli: async () => ({ version: '1.2.3' }),
        },
      ),
    ).resolves.toEqual({ cli: '1.2.3', agentKit: '0.21.0', assistant: '1.0.1' });
    expect(events[0]).toBe('npm install');
    expect(events).toContain('npm ci');
  });

  it('installs only descriptor-staged bytes when selected source paths change after validation', async () => {
    const input = releaseEvidenceFixture();
    const sourcePaths = Object.values(input.tarballs).map((path) => join(input.root, path));
    const expectedBytes = sourcePaths.map((path) => readFileSync(path));
    const events: string[] = [];
    const baseExecutor = evidenceExecutor(events);
    let stagedPaths: string[] = [];
    let consumerRoot = '';
    const execute = (command: string, args: readonly string[]) => {
      if (command === 'npm' && args[0] === 'install') {
        consumerRoot = args[args.indexOf('--prefix') + 1] ?? '';
        stagedPaths = args.slice(-3);
        for (const source of sourcePaths) writeFileSync(source, 'unvalidated replacement');
        for (const [index, staged] of stagedPaths.entries()) {
          expect(sourcePaths).not.toContain(staged);
          expect(readFileSync(staged)).toEqual(expectedBytes[index]);
        }
      }
      return baseExecutor(command, args);
    };

    await expect(
      installAndValidatePackedArtifacts(
        {
          tarballsPath: input.paths.tarballs,
          packagePlanPath: input.paths.plan,
          packagesPath: input.paths.packages,
          npmArtifactReportPath: input.paths.report,
        },
        { policy: input.policy, execute, validateCli: async () => ({ version: '1.2.3' }) },
      ),
    ).resolves.toEqual({ cli: '1.2.3', agentKit: '0.21.0', assistant: '1.0.1' });
    expect(stagedPaths).toHaveLength(3);
    expect(stagedPaths.every((path) => !existsSync(path))).toBe(true);
    expect(consumerRoot).not.toBe('');
    expect(existsSync(consumerRoot)).toBe(false);
  });

  it('rejects dirty candidate evidence before the first executor event', async () => {
    const input = releaseEvidenceFixture({ dirtyCli: true });
    const events: string[] = [];
    await expect(
      installAndValidatePackedArtifacts(
        {
          tarballsPath: input.paths.tarballs,
          packagePlanPath: input.paths.plan,
          packagesPath: input.paths.packages,
          npmArtifactReportPath: input.paths.report,
        },
        { policy: input.policy, execute: evidenceExecutor(events) },
      ),
    ).rejects.toThrow(/dirty candidate/i);
    expect(events).toEqual([]);
  });

  it.each([
    'agent-kit',
    'assistant',
  ] as const)('rejects a changed %s semantic tree before the first executor event', async (component) => {
    const input = releaseEvidenceFixture();
    const logical = input.tarballs[component];
    const packageName =
      component === 'agent-kit' ? '@noodleseed/agent-kit' : '@noodleseed/assistant';
    const version = component === 'agent-kit' ? '0.21.0' : '1.0.1';
    writeTarball(join(input.root, logical), {
      name: packageName,
      version,
      files: [{ path: 'package/dist/unvalidated.js', content: 'export const changed = true;' }],
    });
    const events: string[] = [];
    await expect(
      installAndValidatePackedArtifacts(
        {
          tarballsPath: input.paths.tarballs,
          packagePlanPath: input.paths.plan,
          packagesPath: input.paths.packages,
          npmArtifactReportPath: input.paths.report,
        },
        { policy: input.policy, execute: evidenceExecutor(events) },
      ),
    ).rejects.toThrow(/tree/i);
    expect(events).toEqual([]);
  });

  it('rejects changed Agent Kit bytes whose exact integrity differs from package authorization', async () => {
    const input = releaseEvidenceFixture();
    const packages = structuredClone(input.packages);
    packages['@noodleseed/agent-kit'].integrity = sha512('not the selected tarball');
    writeFileSync(input.paths.packages, `${JSON.stringify(packages)}\n`);
    const events: string[] = [];
    await expect(
      installAndValidatePackedArtifacts(
        {
          tarballsPath: input.paths.tarballs,
          packagePlanPath: input.paths.plan,
          packagesPath: input.paths.packages,
          npmArtifactReportPath: input.paths.report,
        },
        { policy: input.policy, execute: evidenceExecutor(events) },
      ),
    ).rejects.toThrow(/integrity/i);
    expect(events).toEqual([]);
  });

  it.each([
    ['missing', (input: ReturnType<typeof releaseEvidenceFixture>) => rmSync(input.paths.report)],
    [
      'noncanonical',
      (input: ReturnType<typeof releaseEvidenceFixture>) =>
        writeFileSync(input.paths.report, `${JSON.stringify(input.report, null, 2)}\n`),
    ],
    [
      'tampered',
      (input: ReturnType<typeof releaseEvidenceFixture>) => {
        const copy = structuredClone(input.report);
        copy.artifacts[0].fileCount += 1;
        writeFileSync(input.paths.report, `${canonicalJson(copy)}\n`);
      },
    ],
    [
      'wrong-source',
      (input: ReturnType<typeof releaseEvidenceFixture>) => {
        const copy = structuredClone(input.report);
        copy.artifacts[0].source = 'inherited-npm';
        writeFileSync(input.paths.report, `${canonicalJson(copy)}\n`);
      },
    ],
    [
      'wrong-tarball',
      (input: ReturnType<typeof releaseEvidenceFixture>) =>
        writeFileSync(join(input.root, 'release-packages/noodleseed-one-1.2.3.tgz'), 'changed'),
    ],
  ])('rejects %s evidence without executing npm or importing package code', async (_name, tamper) => {
    const input = releaseEvidenceFixture();
    tamper(input);
    const events: string[] = [];

    await expect(
      installAndValidatePackedArtifacts(
        {
          tarballsPath: input.paths.tarballs,
          packagePlanPath: input.paths.plan,
          packagesPath: input.paths.packages,
          npmArtifactReportPath: input.paths.report,
        },
        { policy: input.policy, execute: evidenceExecutor(events) },
      ),
    ).rejects.toThrow();
    expect(events).toEqual([]);
  });

  it('replays the generated consumer lockfile with npm ci after the first install', () => {
    const commands = releaseArtifactInstallCommands('/tmp/release-smoke', [
      '/tmp/one.tgz',
      '/tmp/agent-kit.tgz',
      '/tmp/assistant.tgz',
    ]);

    expect(commands.map((command) => command.args[0])).toEqual(['install', 'ci']);
    expect(commands[0]?.args).toEqual([
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefix',
      '/tmp/release-smoke',
      'react@19',
      '/tmp/one.tgz',
      '/tmp/agent-kit.tgz',
      '/tmp/assistant.tgz',
    ]);
    expect(commands[1]?.args).toEqual([
      'ci',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefix',
      '/tmp/release-smoke',
    ]);
  });

  it('smokes the CLI, Agent Kit manifest/skills, and every Assistant export', async () => {
    await expect(
      validateInstalledReleaseArtifacts(fixture(), undefined, async () => ({ version: '0.34.0' })),
    ).resolves.toEqual({
      cli: '0.34.0',
      agentKit: '0.21.0',
      assistant: '1.0.1',
    });
  });

  it('runs the shared installed-CLI consumer compatibility contract', async () => {
    const root = fixture();
    const calls: string[] = [];
    const execute = (_command: string, args: readonly string[]) =>
      args.at(-1) === '--version' ? '0.34.0\n' : '';
    await validateInstalledReleaseArtifacts(root, execute, async (receivedRoot) => {
      calls.push(receivedRoot);
      return { version: '0.34.0' };
    });
    expect(calls).toEqual([root]);
  });

  it('fails when the customer-owned React renderer export cannot load', async () => {
    const root = fixture();
    writeFileSync(
      join(root, 'node_modules/@noodleseed/assistant/dist/react/client.cjs'),
      'throw new Error("broken React client export");',
    );

    await expect(validateInstalledReleaseArtifacts(root)).rejects.toThrow();
  });

  it('fails when the assistant exports map omits the require condition (1.0.0-era shape)', async () => {
    const root = fixture();
    writeFileSync(
      join(root, 'node_modules/@noodleseed/assistant/package.json'),
      JSON.stringify({
        version: '1.0.1',
        type: 'module',
        exports: {
          '.': { import: './dist/index.js' },
          './react': { import: './dist/react.js' },
          './server': { import: './dist/server.js' },
        },
      }),
    );
    await expect(validateInstalledReleaseArtifacts(root)).rejects.toThrow();
  });

  it('fails when the Agent Kit manifest and package versions drift', async () => {
    const root = fixture();
    writeFileSync(
      join(root, 'node_modules/@noodleseed/agent-kit/manifest.json'),
      JSON.stringify({ packageVersion: '0.20.0' }),
    );
    await expect(validateInstalledReleaseArtifacts(root)).rejects.toThrow(/manifest version/i);
  });

  it('fails when the installed CLI artifact has no npm README', async () => {
    const root = fixture();
    rmSync(join(root, 'node_modules/@noodleseed/one/README.md'));

    await expect(validateInstalledReleaseArtifacts(root)).rejects.toThrow(/README/i);
  });

  it.each([
    'npx --yes @noodleseed/one@latest init my-noodle-app',
    'https://docs.noodleseed.dev/docs/quickstart',
  ])('rejects a README missing the customer landing contract: %s', async (marker) => {
    const root = fixture();
    const path = join(root, 'node_modules/@noodleseed/one/README.md');
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll(marker, 'removed'));
    await expect(validateInstalledReleaseArtifacts(root)).rejects.toThrow(/README/i);
  });

  it('fails when the installed CLI artifact loses its public repository metadata', async () => {
    const root = fixture();
    const packagePath = join(root, 'node_modules/@noodleseed/one/package.json');
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>;
    delete pkg.repository;
    writeFileSync(packagePath, JSON.stringify(pkg));

    await expect(validateInstalledReleaseArtifacts(root)).rejects.toThrow(/repository/i);
  });
});
