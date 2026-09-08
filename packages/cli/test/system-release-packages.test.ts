import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPublishableSkills } from '@noodle-borg/agent-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginMarketplaceArchive } from '../../../scripts/lib/plugin-marketplace-artifact.mjs';
import {
  createPluginReleasePlan,
  PLUGIN_CONTENT_HASH_PLACEHOLDER,
  PLUGIN_SOURCE_SHA_PLACEHOLDER,
  PLUGIN_VERSION_PLACEHOLDER,
} from '../../../scripts/lib/plugin-release-plan.mjs';
import {
  renderCopilotReleaseProjection,
  renderReleaseCopilotPlugin,
} from '../../../scripts/render-copilot-plugin.mjs';
import {
  renderMarketplaceReleaseProjection,
  renderReleaseMarketplace,
} from '../../../scripts/render-plugin-marketplace.mjs';
import {
  assertNpmPackagePreflight,
  assessBaselineConvergence,
  classifyPlannedPackage,
  preflightReleaseBundlePackages,
  preflightReleaseTags,
  readNpmState,
  resolveRemoteTagSha,
  validateReleaseBundle,
} from '../../../scripts/system-release-packages.mjs';

const base = {
  packageName: '@noodleseed/one',
  changed: true,
  planned: {
    version: '0.34.0',
    tag: 'v0.34.0',
    sourceSha: 'a'.repeat(40),
    treeHash: `sha256:${'a'.repeat(64)}`,
  },
  npm: {
    versions: [] as string[],
    latest: '0.33.0',
    integrity: null as string | null,
  },
  tarballIntegrity: `sha512-${'A'.repeat(86)}==`,
  tarballPath: 'release-packages/noodleseed-one-0.34.0.tgz',
};

describe('system release npm candidates', () => {
  it('distinguishes an unpublished version from a registry transport failure', () => {
    const absent = readNpmState('@noodleseed/one', '0.34.0', (_command, args) => {
      if (args[2] === 'versions') return '["0.33.0"]';
      if (args[2] === 'dist-tags.latest') return '"0.33.0"';
      throw new Error(`unexpected ${args.join(' ')}`);
    });
    expect(absent).toEqual({
      versions: ['0.33.0'],
      version: null,
      latest: '0.33.0',
      integrity: null,
    });
    expect(() =>
      readNpmState('@noodleseed/one', '0.34.0', () => {
        throw new Error('network down');
      }),
    ).toThrow(/network down/);
  });
  it('marks a changed, unclaimed version for publication', () => {
    expect(classifyPlannedPackage(base)).toMatchObject({
      publish: true,
      manifest: {
        version: '0.34.0',
        tag: 'v0.34.0',
        sourceSha: 'a'.repeat(40),
        integrity: base.tarballIntegrity,
      },
    });
  });

  it('rejects identical already-published bytes for a changed package as a stale baseline', () => {
    // The r610/r611 race (issue #1189): a docs-only successor planned from the same baseline
    // computes the same version with its own cut SHA as sourceSha. Identical bytes on npm mean a
    // concurrent release already published them — accepting would carry a falsified sourceSha all
    // the way to the finalize tag guard, after approval and promotion.
    const integrity = `sha512-${'B'.repeat(86)}==`;
    let thrown: unknown;
    try {
      classifyPlannedPackage({
        ...base,
        npm: { versions: ['0.34.0'], latest: '0.34.0', integrity },
        tarballIntegrity: integrity,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      message: expect.stringMatching(/already published by a concurrent release.*stale baseline/i),
      exitCode: 4,
    });
  });

  it('inherits the previous record verbatim for an unchanged already-published package', () => {
    // The convergence contract the stale-baseline retry depends on: after re-planning from the
    // fresh baseline, the unchanged package keeps the finalized sourceSha and tag.
    const previous = {
      version: '0.34.0',
      tag: 'v0.34.0',
      sourceSha: 'c'.repeat(40),
      treeHash: `sha256:${'a'.repeat(64)}`,
      integrity: `sha512-${'B'.repeat(86)}==`,
    };
    expect(
      classifyPlannedPackage({
        packageName: '@noodleseed/one',
        changed: false,
        previous,
        planned: previous,
        npm: { versions: ['0.34.0'], latest: '0.34.0', integrity: previous.integrity },
        tarballPath: null,
        tarballIntegrity: null,
      }),
    ).toEqual({
      publish: false,
      manifest: { ...previous, sourceSha: 'c'.repeat(40), tag: 'v0.34.0' },
    });
  });

  it('marks a candidate behind npm latest with exit code 4 for the same fresh-baseline retry', () => {
    let thrown: unknown;
    try {
      classifyPlannedPackage({
        ...base,
        npm: { versions: ['0.35.0'], latest: '0.35.0', integrity: null },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      message: expect.stringMatching(/npm latest 0\.35\.0 is ahead of candidate 0\.34\.0/i),
      exitCode: 4,
    });
  });

  it('rejects a version claimed by different bytes before any production mutation', () => {
    expect(() =>
      classifyPlannedPackage({
        ...base,
        npm: {
          versions: ['0.34.0'],
          latest: '0.34.0',
          integrity: `sha512-${'B'.repeat(86)}==`,
        },
      }),
    ).toThrow(/conflicting integrity/i);
  });

  it('marks the integrity conflict with exit code 4 so the pipeline retries with a fresh baseline', () => {
    // A concurrently-approved System Release can publish this version between the baseline
    // resolution and this check (the run-29324869447 race); exit 4 tells the prepare job to
    // re-resolve the baseline (adopting the just-published draft) and re-plan exactly once.
    let thrown: unknown;
    try {
      classifyPlannedPackage({
        ...base,
        npm: {
          versions: ['0.34.0'],
          latest: '0.34.0',
          integrity: `sha512-${'B'.repeat(86)}==`,
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { exitCode?: number })?.exitCode).toBe(4);
  });

  it('requires changed package tarballs and complete unchanged registry state', () => {
    expect(() => classifyPlannedPackage({ ...base, tarballIntegrity: '' })).toThrow(
      /tarball.*integrity/i,
    );
    expect(() =>
      classifyPlannedPackage({
        ...base,
        changed: false,
        previous: {
          ...base.planned,
          integrity: base.tarballIntegrity,
        },
        npm: { versions: [], latest: null, integrity: null },
        tarballPath: null,
        tarballIntegrity: null,
      }),
    ).toThrow(/missing from npm/i);
  });
});

describe('component tag preflight', () => {
  it('resolves annotated, lightweight, and absent remote tags', () => {
    const tagObject = 'd'.repeat(40);
    const commit = 'c'.repeat(40);
    expect(
      resolveRemoteTagSha('v0.34.0', (command: string, args: string[]) => {
        expect(command).toBe('git');
        expect(args).toEqual(['ls-remote', 'origin', 'refs/tags/v0.34.0', 'refs/tags/v0.34.0^{}']);
        return `${tagObject}\trefs/tags/v0.34.0\n${commit}\trefs/tags/v0.34.0^{}\n`;
      }),
    ).toBe(commit);
    expect(resolveRemoteTagSha('v0.34.0', () => `${commit}\trefs/tags/v0.34.0\n`)).toBe(commit);
    expect(resolveRemoteTagSha('v0.34.0', () => '\n')).toBeNull();
  });

  it('accepts missing tags and tags that already point at each package sourceSha', () => {
    const manifest = {
      packages: {
        '@noodleseed/one': { version: '0.34.0', tag: 'v0.34.0', sourceSha: 'a'.repeat(40) },
        '@noodleseed/agent-kit': {
          version: '0.21.0',
          tag: 'agent-kit-v0.21.0',
          sourceSha: 'a'.repeat(40),
        },
      },
    };
    expect(() => preflightReleaseTags(manifest, () => null)).not.toThrow();
    expect(() => preflightReleaseTags(manifest, () => 'a'.repeat(40))).not.toThrow();
  });

  it('rejects a manifest whose tag claim contradicts the live component tag before the gate', () => {
    // The exact r611 wedge, moved to the cheapest point it is checkable: the finalize guard's
    // predicate must hold before the draft, the human approval, and any production mutation.
    const manifest = {
      packages: {
        '@noodleseed/one': { version: '0.130.0', tag: 'v0.130.0', sourceSha: '6'.repeat(40) },
      },
    };
    expect(() => preflightReleaseTags(manifest, () => 'c'.repeat(40))).toThrow(
      new RegExp(
        `@noodleseed/one: v0\\.130\\.0 points to ${'c'.repeat(40)}, expected sourceSha ${'6'.repeat(40)}`,
      ),
    );
  });

  it('classifies a contradictory live tag as retryable stale state', () => {
    const sourceSha = '6'.repeat(40);
    let failure: unknown;
    try {
      preflightReleaseTags(
        {
          packages: {
            '@noodleseed/one': { version: '0.146.0', tag: 'v0.146.0', sourceSha },
          },
        },
        () => '5'.repeat(40),
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      message: expect.stringMatching(/stale release candidate.*v0\.146\.0/i),
      exitCode: 4,
    });
  });

  it('skips legacy string records that carry no immutable provenance', () => {
    expect(() =>
      preflightReleaseTags({ packages: { '@noodleseed/one': '0.34.0' } }, () => {
        throw new Error('resolver must not run for legacy records');
      }),
    ).not.toThrow();
  });
});

const temporaryDirectories: string[] = [];

function sha512(value: string | Buffer) {
  return `sha512-${createHash('sha512').update(value).digest('base64')}`;
}

function finalizeLegacyV5Manifest(input: {
  packages: Record<string, Record<string, string>>;
  pluginMarketplace: Record<string, string>;
  copilotPlugin: Record<string, string>;
}) {
  const base = {
    schemaVersion: 5,
    releaseId: 'r20',
    gitSha: 'a'.repeat(40),
    createdAt: '2026-07-13T00:00:00.000Z',
    images: Object.fromEntries(
      ['service', 'githubBuilder', 'website', 'docs', 'console'].map((name, index) => [
        name,
        `sha256:${String(index + 1).repeat(64)}`,
      ]),
    ),
    packages: input.packages,
    pluginMarketplace: input.pluginMarketplace,
    copilotPlugin: input.copilotPlugin,
    compatibility: Object.fromEntries(
      Object.entries(input.packages).map(([name, record]) => [name, [record.version]]),
    ),
    previousReleaseId: null,
  };
  return {
    ...base,
    manifestChecksum: `sha256:${createHash('sha256')
      .update(`${JSON.stringify(base)}\n`)
      .digest('hex')}`,
  };
}

function createBundle(options: { empty?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'noodle-system-release-'));
  temporaryDirectories.push(root);
  const tarball = 'release-packages/noodleseed-one-0.34.0.tgz';
  const tarballBytes = Buffer.from('immutable package bytes');
  const tarballIntegrity = sha512(tarballBytes);
  const packageEntries = {
    '@noodleseed/one': {
      version: '0.34.0',
      tag: 'v0.34.0',
      sourceSha: 'a'.repeat(40),
      integrity: tarballIntegrity,
      treeHash: `sha256:${'a'.repeat(64)}`,
    },
    '@noodleseed/agent-kit': {
      version: '0.21.0',
      tag: 'agent-kit-v0.21.0',
      sourceSha: 'a'.repeat(40),
      integrity: sha512('agent kit'),
      treeHash: `sha256:${'b'.repeat(64)}`,
    },
    '@noodleseed/assistant': {
      version: '1.0.1',
      tag: 'assistant-v1.0.1',
      sourceSha: 'a'.repeat(40),
      integrity: sha512('assistant'),
      treeHash: `sha256:${'c'.repeat(64)}`,
    },
  };
  const agentKitTree = join(root, 'agent-kit');
  mkdirSync(agentKitTree, { recursive: true });
  writeFileSync(join(agentKitTree, 'package.json'), '{"version":"0.0.0"}\n');
  for (const file of renderPublishableSkills().filter(
    (candidate) =>
      candidate.agentTarget === 'claude-code' && candidate.path.includes('/references/'),
  )) {
    const destination = join(agentKitTree, file.path);
    mkdirSync(join(destination, '..'), { recursive: true });
    writeFileSync(destination, file.content);
  }
  const pluginTree = join(root, 'plugin-marketplace-tree');
  const pluginArchive = join(root, 'plugin-marketplace.tgz');
  const shared = {
    mode: 'release' as const,
    agentKitVersion: '0.0.0',
    cliVersion: '0.0.0',
    developerMcpUrl: 'https://cloud.noodleseed.dev/developer/mcp',
    developerMcpCapabilityVersion: '0.0.0',
  };
  const releasePlan = createPluginReleasePlan({
    ...shared,
    projections: {
      pluginMarketplace: renderMarketplaceReleaseProjection({
        ...shared,
        version: PLUGIN_VERSION_PLACEHOLDER,
        pluginContentHash: PLUGIN_CONTENT_HASH_PLACEHOLDER,
      }),
      copilotPlugin: renderCopilotReleaseProjection({
        ...shared,
        version: PLUGIN_VERSION_PLACEHOLDER,
        pluginContentHash: PLUGIN_CONTENT_HASH_PLACEHOLDER,
        sourceSha: PLUGIN_SOURCE_SHA_PLACEHOLDER,
      }),
    },
  });
  const pluginMarketplace = renderReleaseMarketplace({
    agentKitTree,
    ...shared,
    sourceSha: 'a'.repeat(40),
    releasePlan,
    stagingDirectory: pluginTree,
    archivePath: pluginArchive,
  });
  const copilotTree = join(root, 'copilot-plugin-tree');
  const copilotArchive = join(root, 'copilot-plugin.tgz');
  const copilotPlugin = renderReleaseCopilotPlugin({
    agentKitTree,
    ...shared,
    sourceSha: 'a'.repeat(40),
    releasePlan,
    stagingDirectory: copilotTree,
    archivePath: copilotArchive,
  });
  const manifest = finalizeLegacyV5Manifest({
    packages: packageEntries,
    pluginMarketplace,
    copilotPlugin,
  });
  const plan = options.empty
    ? []
    : [
        {
          component: 'cli',
          package: '@noodleseed/one',
          version: '0.34.0',
          tarball,
          integrity: tarballIntegrity,
        },
      ];
  writeFileSync(join(root, 'system-release.json'), `${JSON.stringify(manifest)}\n`);
  writeFileSync(join(root, 'packages-to-publish.json'), `${JSON.stringify(plan)}\n`);
  if (!options.empty) {
    mkdirSync(join(root, 'release-packages'));
    writeFileSync(join(root, tarball), tarballBytes);
  }
  return {
    root,
    manifest,
    plan,
    tarball,
    tarballIntegrity,
    pluginArchive,
    pluginTree,
    pluginMarketplace,
    copilotArchive,
    copilotTree,
    copilotPlugin,
  };
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('system release bundle validation', () => {
  it.each([
    ['malformed', '{', 'Invalid agreement catalog JSON'],
    ['absent', undefined, 'NOODLE_GOOGLE_CLIENT_ID is required'],
    [
      'configured',
      JSON.stringify({
        version: 'v1',
        ...Object.fromEntries(
          ['terms', 'privacy', 'processing'].map((name) => [
            name,
            { url: `https://example.com/legal/v1/${name}.txt`, sha256: 'a'.repeat(64) },
          ]),
        ),
      }),
      'NOODLE_GOOGLE_CLIENT_ID is required',
    ],
  ])('validates %s agreement configuration through the promotion command', (_name, catalog, error) => {
    const bundle = createBundle({ empty: true });
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../../../scripts/system-release-promote.mjs', import.meta.url)),
        '--bundle',
        bundle.root,
      ],
      {
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 64 * 1024,
        env: {
          PATH: process.env.PATH,
          NOODLE_BILLING_ENFORCEMENT_MODE: 'free_v1',
          NOODLE_CONTROL_PLANE_SIGNUP_MODE: 'public',
          CONSOLE_SIGNUP_MODE: 'public',
          PUBLIC_BASE_URL: 'https://service.example.com',
          PORTAL_SERVICE_ACCOUNT: 'portal-run@example.iam.gserviceaccount.com',
          NOODLE_PORTAL_URL: 'https://portal.example.com',
          NOODLE_OAUTH_PORTAL_CLIENT_ID: 'portal-client',
          PORTAL_AUTH_SECRET_SECRET: 'portal-auth',
          PORTAL_AUTH_SECRET_VERSION: '1',
          CALENDAR_ADAPTER_INSTANCE_CONNECTION_NAME: 'example-project:us-central1:example-instance',
          CALENDAR_ADAPTER_SERVICE_ACCOUNT: 'calendar-adapter@example.iam.gserviceaccount.com',
          CALENDAR_ADAPTER_KEY_SECRET: 'calendar-adapter-key',
          CALENDAR_ADAPTER_KEY_VERSION: '1',
          CALENDAR_ADAPTER_DATABASE_URL_SECRET: 'calendar-adapter-database-url',
          CALENDAR_ADAPTER_DATABASE_URL_VERSION: '1',
          GCP_PROJECT: 'project-prod',
          GCP_REGION: 'us-central1',
          GCP_ARTIFACTS_PROJECT: 'project-ci',
          AR_REPO: 'borg',
          CLOUD_RUN_SERVICE: 'service',
          CLOUD_RUN_BUILDER_JOB: 'builder',
          CLOUD_RUN_WEBSITE: 'website',
          CLOUD_RUN_DOCS: 'docs',
          CLOUD_RUN_CONSOLE: 'console',
          CLOUD_RUN_PORTAL: 'portal',
          CLOUD_RUN_CALENDAR_ADAPTER: 'calendar-adapter',
          NOODLE_BUSINESS_SOURCE_IDENTITY_KEY_SECRET: 'source-identity',
          NOODLE_BUSINESS_SOURCE_IDENTITY_KEY_VERSION: '1',
          NOODLE_ORGANIZATION_AGREEMENT: catalog,
          // No ambient credentials; the next required variable stops execution before cloud access.
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe(error);
  });

  it('accepts a complete immutable bundle and an empty publication plan', () => {
    const complete = createBundle();
    expect(validateReleaseBundle(complete.root)).toMatchObject({
      manifest: { releaseId: 'r20' },
      publish: complete.plan,
      pluginMarketplace: {
        treeHash: complete.pluginMarketplace.treeHash,
        archiveIntegrity: complete.pluginMarketplace.archiveIntegrity,
      },
      copilotPlugin: {
        treeHash: complete.copilotPlugin.treeHash,
        archiveIntegrity: complete.copilotPlugin.archiveIntegrity,
      },
    });

    const empty = createBundle({ empty: true });
    expect(validateReleaseBundle(empty.root)).toMatchObject({ publish: [] });
  });

  it('rejects missing, malformed, and checksum-invalid bundle metadata', () => {
    const missing = createBundle();
    rmSync(join(missing.root, 'system-release.json'));
    expect(() => validateReleaseBundle(missing.root)).toThrow(/system-release\.json.*missing/i);

    const malformed = createBundle();
    writeFileSync(join(malformed.root, 'packages-to-publish.json'), '{');
    expect(() => validateReleaseBundle(malformed.root)).toThrow(/packages-to-publish\.json.*JSON/i);

    const invalid = createBundle();
    writeFileSync(
      join(invalid.root, 'system-release.json'),
      JSON.stringify({ ...invalid.manifest, gitSha: 'b'.repeat(40) }),
    );
    expect(() => validateReleaseBundle(invalid.root)).toThrow(/checksum mismatch/i);
  });

  it('rejects missing or corrupted tarballs and manifest-plan disagreement', () => {
    const missing = createBundle();
    rmSync(join(missing.root, missing.tarball));
    expect(() => validateReleaseBundle(missing.root)).toThrow(/tarball.*missing/i);

    const corrupted = createBundle();
    writeFileSync(join(corrupted.root, corrupted.tarball), 'different bytes');
    expect(() => validateReleaseBundle(corrupted.root)).toThrow(/integrity mismatch/i);

    const disagreement = createBundle();
    writeFileSync(
      join(disagreement.root, 'packages-to-publish.json'),
      JSON.stringify([{ ...disagreement.plan[0], version: '0.35.0' }]),
    );
    expect(() => validateReleaseBundle(disagreement.root)).toThrow(/version.*manifest/i);
  });

  it('rejects a missing, corrupted, or tree-mismatched plugin marketplace archive', () => {
    const missing = createBundle();
    rmSync(missing.pluginArchive);
    expect(() => validateReleaseBundle(missing.root)).toThrow(/plugin.*missing|tarball.*missing/i);

    const corrupted = createBundle();
    writeFileSync(corrupted.pluginArchive, 'different bytes');
    expect(() => validateReleaseBundle(corrupted.root)).toThrow(/plugin.*integrity mismatch/i);

    const mismatched = createBundle();
    const submissionReadme = join(mismatched.pluginTree, 'submission', 'README.md');
    writeFileSync(
      submissionReadme,
      `${readFileSync(submissionReadme, 'utf8')}\n<!-- different tree -->\n`,
    );
    const archiveIntegrity = createPluginMarketplaceArchive(
      mismatched.pluginTree,
      mismatched.pluginArchive,
    );
    const manifest = finalizeLegacyV5Manifest({
      packages: mismatched.manifest.packages,
      pluginMarketplace: { ...mismatched.pluginMarketplace, archiveIntegrity },
      copilotPlugin: mismatched.copilotPlugin,
    });
    writeFileSync(join(mismatched.root, 'system-release.json'), `${JSON.stringify(manifest)}\n`);
    expect(() => validateReleaseBundle(mismatched.root)).toThrow(/plugin.*tree hash mismatch/i);
  });

  it('rejects a missing or corrupted Copilot plugin archive before production', () => {
    const missing = createBundle();
    rmSync(missing.copilotArchive);
    expect(() => validateReleaseBundle(missing.root)).toThrow(/Copilot.*missing|tarball.*missing/i);

    const corrupted = createBundle();
    writeFileSync(corrupted.copilotArchive, 'different bytes');
    expect(() => validateReleaseBundle(corrupted.root)).toThrow(/Copilot.*integrity mismatch/i);
  });

  it('rejects duplicate, absolute, traversal, and symlink tarball entries', () => {
    const duplicate = createBundle();
    writeFileSync(
      join(duplicate.root, 'packages-to-publish.json'),
      JSON.stringify([duplicate.plan[0], duplicate.plan[0]]),
    );
    expect(() => validateReleaseBundle(duplicate.root)).toThrow(/duplicate/i);

    const absolute = createBundle();
    writeFileSync(
      join(absolute.root, 'packages-to-publish.json'),
      JSON.stringify([{ ...absolute.plan[0], tarball: join(absolute.root, absolute.tarball) }]),
    );
    expect(() => validateReleaseBundle(absolute.root)).toThrow(/relative/i);

    const traversal = createBundle();
    writeFileSync(
      join(traversal.root, 'packages-to-publish.json'),
      JSON.stringify([{ ...traversal.plan[0], tarball: '../outside.tgz' }]),
    );
    expect(() => validateReleaseBundle(traversal.root)).toThrow(/traversal|outside/i);

    const linked = createBundle();
    rmSync(join(linked.root, linked.tarball));
    const outside = join(tmpdir(), `noodle-outside-${Date.now()}.tgz`);
    writeFileSync(outside, 'immutable package bytes');
    temporaryDirectories.push(outside);
    symlinkSync(outside, join(linked.root, linked.tarball));
    expect(() => validateReleaseBundle(linked.root)).toThrow(/symlink/i);
  });
});

describe('system release bundle npm preflight', () => {
  const npmStateFor = (
    bundle: ReturnType<typeof createBundle>,
    overrides: Record<
      string,
      { published?: boolean; latest?: string | null; integrity?: string | null }
    > = {},
  ) => {
    return (packageName: string, version: string) => {
      const entry = bundle.manifest.packages[packageName];
      const override = overrides[packageName] ?? {};
      const latest = override.latest === undefined ? entry.version : override.latest;
      const integrity = override.integrity === undefined ? entry.integrity : override.integrity;
      const published = override.published ?? latest === version;
      return {
        versions: published ? [version] : latest ? [latest] : [],
        version: published ? version : null,
        latest,
        integrity: published ? integrity : null,
      };
    };
  };

  it('rejects a stale candidate version claimed by different npm bytes before approval', () => {
    const bundle = createBundle();
    const readState = npmStateFor(bundle, {
      '@noodleseed/one': {
        integrity: `sha512-${'Z'.repeat(86)}==`,
      },
    });

    let failure: unknown;
    try {
      preflightReleaseBundlePackages(bundle.root, readState);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      message: expect.stringMatching(/@noodleseed\/one@0\.34\.0 has conflicting npm integrity/i),
      exitCode: 4,
    });
  });

  it('accepts unpublished planned bytes and already-published identical bytes', () => {
    const bundle = createBundle();
    const readState = npmStateFor(bundle, {
      '@noodleseed/one': {
        latest: '0.33.0',
      },
    });

    expect(preflightReleaseBundlePackages(bundle.root, readState)).toMatchObject({
      publish: bundle.plan,
    });

    expect(preflightReleaseBundlePackages(bundle.root, npmStateFor(bundle))).toMatchObject({
      publish: bundle.plan,
    });
  });

  it('rejects a candidate behind npm or a missing unplanned package', () => {
    const bundle = createBundle();
    let staleFailure: unknown;
    try {
      preflightReleaseBundlePackages(
        bundle.root,
        npmStateFor(bundle, {
          '@noodleseed/one': {
            latest: '0.35.0',
          },
        }),
      );
    } catch (error) {
      staleFailure = error;
    }
    expect(staleFailure).toMatchObject({
      message: expect.stringMatching(/npm latest 0\.35\.0 is ahead/i),
      exitCode: 4,
    });

    const empty = createBundle({ empty: true });
    expect(() =>
      preflightReleaseBundlePackages(
        empty.root,
        npmStateFor(empty, {
          '@noodleseed/one': {
            latest: null,
          },
        }),
      ),
    ).toThrow(/missing from npm.*publication plan/i);
  });

  it.each(['0.33.0', null])('allows an exact planned retry while latest is %s', (latest) => {
    const bundle = createBundle();
    expect(() =>
      preflightReleaseBundlePackages(
        bundle.root,
        npmStateFor(bundle, {
          '@noodleseed/one': {
            published: true,
            latest,
          },
        }),
      ),
    ).not.toThrow();
  });

  it.each(['0.33.0', null, 'invalid'])('rejects unplanned package latest drift %s', (latest) => {
    const expected = { version: '0.34.0', integrity: 'sha512-expected' };
    expect(() =>
      assertNpmPackagePreflight('@noodleseed/one', expected, undefined, {
        ...expected,
        latest,
      }),
    ).toThrow();
  });

  it('rejects invalid latest values even for an exact planned retry', () => {
    const expected = { version: '0.34.0', integrity: 'sha512-expected' };
    expect(() =>
      assertNpmPackagePreflight('@noodleseed/one', expected, expected, {
        ...expected,
        latest: 'invalid',
      }),
    ).toThrow();
  });
});

describe('baseline convergence assessment', () => {
  const record = (version: string, integrity: string) => ({
    version,
    tag: `v${version}`,
    sourceSha: 'a'.repeat(40),
    integrity,
    treeHash: `sha256:${'b'.repeat(64)}`,
  });
  const manifest = {
    packages: {
      '@noodleseed/one': record('0.34.1', `sha512-${'A'.repeat(86)}==`),
      '@noodleseed/agent-kit': {
        ...record('0.21.1', `sha512-${'B'.repeat(86)}==`),
        tag: 'agent-kit-v0.21.1',
      },
      '@noodleseed/assistant': {
        ...record('1.1.1', `sha512-${'C'.repeat(86)}==`),
        tag: 'assistant-v1.1.1',
      },
    },
  };
  const npmState = (overrides: Record<string, { latest?: string; integrity?: string }> = {}) => {
    return (packageName: string, version: string) => {
      const entry = (manifest.packages as Record<string, { version: string; integrity: string }>)[
        packageName
      ];
      const override = overrides[packageName] ?? {};
      const latest = override.latest ?? entry.version;
      return {
        versions: [latest, entry.version],
        version: latest === version || entry.version === version ? version : null,
        latest,
        integrity: override.integrity ?? entry.integrity,
      };
    };
  };

  it('reports convergence when every package matches npm latest and integrity', () => {
    expect(assessBaselineConvergence(manifest, npmState())).toEqual([]);
  });

  it('reports drift when npm latest moved past the recorded version', () => {
    const drift = assessBaselineConvergence(
      manifest,
      npmState({ '@noodleseed/one': { latest: '0.35.0' } }),
    );
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatch(/@noodleseed\/one/);
    expect(drift[0]).toMatch(/0\.35\.0/);
  });

  it('reports drift when the published bytes differ from the recorded integrity', () => {
    const drift = assessBaselineConvergence(
      manifest,
      npmState({ '@noodleseed/assistant': { integrity: `sha512-${'D'.repeat(86)}==` } }),
    );
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatch(/@noodleseed\/assistant/);
    expect(drift[0]).toMatch(/integrity/i);
  });

  it('reports every package lacking immutable data instead of throwing', () => {
    const drift = assessBaselineConvergence(
      { packages: { '@noodleseed/one': '0.34.1' } },
      npmState(),
    );
    expect(drift.length).toBeGreaterThanOrEqual(3);
  });
});
