import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ProductSkillPackageInput,
  ProductSkillRenderError,
  renderProductSkillBundle,
} from '@noodle-borg/agent-kit';
import { compileManifest, sha256Canonical } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  type AppPackageRenderer,
  AppPackageSnapshotError,
  createAppPackageSnapshot,
} from '../src/app-package-snapshot.js';
import { InMemoryArtifactStore, ServerRegistry } from '../src/index.js';

const GUIDED = readFileSync(
  join(import.meta.dirname, 'fixtures/app-package-guided-v2.yaml'),
  'utf8',
);

const UNGUIDED = GUIDED.replace(/\n {2}agentGuide:[\s\S]*?\ntools:/, '\ntools:');
const TENANT = { org: 'acme', app: 'tasks', env: 'prod' } as const;
const DEPLOY_OPTIONS = {
  accessMode: 'owner-only' as const,
  actor: { subject: 'owner-subject', email: 'owner@acme.test', superAdmin: false },
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function rendererWith(
  mutate: (
    bundle: ReturnType<typeof renderProductSkillBundle>,
    input: ProductSkillPackageInput,
  ) => ReturnType<typeof renderProductSkillBundle>,
): AppPackageRenderer {
  return (input) => mutate(renderProductSkillBundle(input), input);
}

function bundleSha256(
  input: ProductSkillPackageInput,
  files: ReturnType<typeof renderProductSkillBundle>['files'],
): string {
  return sha256Canonical({
    sourceManifestSha256: input.provenance.sourceManifestSha256,
    mcpSurfaceSha256: input.provenance.mcpSurfaceSha256,
    files: files.map(({ target, path, sha256: fileSha256 }) => ({
      target,
      path,
      sha256: fileSha256,
    })),
  });
}

function rendererForSnapshotBytes(
  artifact: ProductSkillPackageInput,
  targetBytes: number,
): AppPackageRenderer {
  const rendered = renderProductSkillBundle(artifact);
  const snapshotShape = (files: typeof rendered.files) => ({
    schemaVersion: 1,
    artifact,
    rendererVersion: rendered.rendererVersion,
    files,
    snapshotSha256: 'a'.repeat(64),
  });
  const baselineBytes = Buffer.byteLength(JSON.stringify(snapshotShape(rendered.files)), 'utf8');
  const extra = targetBytes - baselineBytes;
  if (extra < 0) throw new Error('target snapshot size is too small for the fixture');
  const files = rendered.files.map((file, index) =>
    index === 0 ? { ...file, path: `${file.path}${'p'.repeat(extra)}` } : file,
  );
  expect(Buffer.byteLength(JSON.stringify(snapshotShape(files)), 'utf8')).toBe(targetBytes);
  return () => ({ ...rendered, files, bundleSha256: bundleSha256(artifact, files) });
}

describe('deployment-bound App Package snapshots', () => {
  it('compiles every valid Core name into a bounded, distinct host path', () => {
    const source = parse(GUIDED) as Record<string, unknown>;
    const names = [
      '_a',
      'a_',
      'a__b',
      '___',
      `n_h${'a'.repeat(64)}_n`,
      'a'.repeat(101),
      'acme_tasks',
    ];
    const roots = names.map((name) => {
      const compiled = compileManifest({
        ...source,
        server: { ...(source.server as Record<string, unknown>), name },
      });
      expect(compiled.ok, name).toBe(true);
      if (!compiled.ok || compiled.appPackage === undefined) return undefined;
      expect(
        () => renderProductSkillBundle(compiled.appPackage as ProductSkillPackageInput),
        name,
      ).not.toThrow();
      const path = renderProductSkillBundle(compiled.appPackage).files[0]?.path;
      expect(path).toMatch(/^\.agents\/skills\/[a-z0-9]+(?:-[a-z0-9]+)*\/SKILL\.md$/);
      expect(path?.length).toBeLessThan(140);
      return path;
    });
    expect(roots.at(-1)).toBe('.agents/skills/acme-tasks/SKILL.md');
    expect(new Set(roots).size).toBe(names.length);
  });

  it('stores one authoritative rendered snapshot only for a guided deployment', async () => {
    const compiled = compileManifest(parse(GUIDED));
    expect(compiled.ok).toBe(true);
    if (!compiled.ok || compiled.appPackage === undefined) return;
    const rendererInput: ProductSkillPackageInput = compiled.appPackage;
    const expected = renderProductSkillBundle(rendererInput);

    const store = new InMemoryArtifactStore();
    const registry = new ServerRegistry(store);
    const guided = await registry.deploy(TENANT, GUIDED, DEPLOY_OPTIONS);
    const unguided = await registry.deploy(TENANT, UNGUIDED, DEPLOY_OPTIONS);

    expect(guided.ok).toBe(true);
    expect(unguided.ok).toBe(true);
    if (!guided.ok || !unguided.ok) return;
    const guidedRecord = await store.get(guided.deploymentId);
    const unguidedRecord = await store.get(unguided.deploymentId);
    expect(guidedRecord?.appPackageSnapshot).toMatchObject({
      schemaVersion: 1,
      artifact: compiled.appPackage,
      rendererVersion: expected.rendererVersion,
      files: expected.files,
      snapshotSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(guidedRecord?.appPackageSnapshot?.files).toHaveLength(4);
    for (const file of guidedRecord?.appPackageSnapshot?.files ?? []) {
      expect(file.sha256).toBe(sha256(file.content));
      expect(file.byteLength).toBe(Buffer.byteLength(file.content, 'utf8'));
    }
    expect(unguidedRecord?.appPackageSnapshot).toBeUndefined();

    expect((await registry.get(guided.deploymentId))?.served.appPackageSnapshot).toEqual(
      guidedRecord?.appPackageSnapshot,
    );
    expect((await registry.get(unguided.deploymentId))?.served.appPackageSnapshot).toBeUndefined();

    const rollback = await registry.rollback(TENANT, guided.deploymentId);
    expect(rollback.ok).toBe(true);
    expect((await registry.getActiveByTenant(TENANT))?.served.appPackageSnapshot).toEqual(
      guidedRecord?.appPackageSnapshot,
    );

    const restarted = new ServerRegistry(store);
    expect((await restarted.getActiveByTenant(TENANT))?.served.appPackageSnapshot).toEqual(
      guidedRecord?.appPackageSnapshot,
    );
  });

  it('rejects a serialized snapshot above the 1 MiB ceiling during construction', () => {
    const compiled = compileManifest(parse(GUIDED));
    expect(compiled.ok).toBe(true);
    if (!compiled.ok || compiled.appPackage === undefined) return;

    expect(() =>
      createAppPackageSnapshot(
        compiled.appPackage,
        rendererForSnapshotBytes(compiled.appPackage, 1024 * 1024 + 1),
      ),
    ).toThrow(AppPackageSnapshotError);
    try {
      createAppPackageSnapshot(
        compiled.appPackage,
        rendererForSnapshotBytes(compiled.appPackage, 1024 * 1024 + 1),
      );
    } catch (error) {
      expect((error as AppPackageSnapshotError).deployError.code).toBe('app_package_invalid');
    }
  });

  it('returns a safe structured renderer error without persisting or exposing a deployment', async () => {
    const store = new InMemoryArtifactStore();
    const registry = new ServerRegistry(store, undefined, undefined, {
      renderAppPackage: () => {
        throw new ProductSkillRenderError('app_package_file_too_large');
      },
    });

    const result = await registry.deploy(TENANT, GUIDED, DEPLOY_OPTIONS);

    expect(result).toEqual({
      ok: false,
      errors: [
        {
          code: 'app_package_file_too_large',
          path: 'server.agentGuide',
          message: 'app package rendering failed: app_package_file_too_large',
        },
      ],
    });
    expect(await store.loadAll()).toEqual([]);
    expect(await registry.listDeployments({ org: TENANT.org, includeArchived: true })).toEqual([]);
    expect(registry.size).toBe(0);
  });

  it('reports rendering and independent config/auth blockers together during preflight', async () => {
    const store = new InMemoryArtifactStore();
    const registry = new ServerRegistry(store, undefined, undefined, {
      renderAppPackage: () => {
        throw new ProductSkillRenderError('app_package_file_too_large');
      },
    });
    const result = await registry.preflightDeploy(
      TENANT,
      `${GUIDED}\nhandoff:\n  allowedDomains: ["\${env.STORE_ORIGIN}"]\n`,
      { ...DEPLOY_OPTIONS, accessMode: 'customers' },
    );
    expect(result).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ code: 'missing_variable', path: 'variables.STORE_ORIGIN' }),
        expect.objectContaining({ code: 'server_auth_required', path: 'server.auth' }),
        expect.objectContaining({ code: 'app_package_file_too_large', path: 'server.agentGuide' }),
      ]),
    });
    expect(result).not.toHaveProperty('compiledArtifact');
    expect(await store.loadAll()).toEqual([]);
    expect(registry.size).toBe(0);
  });

  it('replays an exact idempotent deploy from stored bytes without invoking a changed renderer', async () => {
    const store = new InMemoryArtifactStore();
    const options = { ...DEPLOY_OPTIONS, idempotencyKey: 'stable-package-retry' };
    const firstRegistry = new ServerRegistry(store);
    const first = await firstRegistry.deploy(TENANT, GUIDED, options);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const original = await store.get(first.deploymentId);
    expect(original?.appPackageSnapshot).toBeDefined();

    const changedRegistry = new ServerRegistry(store, undefined, undefined, {
      renderAppPackage: () => {
        throw new Error('changed renderer must not run for an exact replay');
      },
    });
    const replay = await changedRegistry.deploy(TENANT, GUIDED, options);

    expect(replay).toEqual({
      ok: true,
      deploymentId: first.deploymentId,
      deploymentVersion: first.deploymentVersion,
      accessMode: DEPLOY_OPTIONS.accessMode,
      ownerSubject: DEPLOY_OPTIONS.actor.subject,
      replayed: true,
    });
    expect(await store.get(first.deploymentId)).toEqual(original);
  });

  it.each([
    {
      name: 'empty file content',
      renderer: rendererWith((bundle, input) => {
        const files = bundle.files.map((file, index) =>
          index === 0 ? { ...file, content: '', sha256: sha256(''), byteLength: 0 } : file,
        );
        return { ...bundle, files, bundleSha256: bundleSha256(input, files) };
      }),
    },
    {
      name: 'blank file content',
      renderer: rendererWith((bundle, input) => {
        const content = '   ';
        const files = bundle.files.map((file, index) =>
          index === 0
            ? {
                ...file,
                content,
                sha256: sha256(content),
                byteLength: Buffer.byteLength(content),
              }
            : file,
        );
        return { ...bundle, files, bundleSha256: bundleSha256(input, files) };
      }),
    },
    {
      name: 'blank renderer version',
      renderer: rendererWith((bundle) => ({ ...bundle, rendererVersion: '   ' })),
    },
    {
      name: 'padded renderer version',
      renderer: rendererWith((bundle) => ({
        ...bundle,
        rendererVersion: ` ${bundle.rendererVersion} `,
      })),
    },
    {
      name: 'overlong renderer version',
      renderer: rendererWith((bundle) => ({ ...bundle, rendererVersion: 'v'.repeat(201) })),
    },
    {
      name: 'incorrect bundle hash',
      renderer: rendererWith((bundle) => ({ ...bundle, bundleSha256: 'f'.repeat(64) })),
    },
  ])('rejects $name before persistence', async ({ renderer }) => {
    const store = new InMemoryArtifactStore();
    const registry = new ServerRegistry(store, undefined, undefined, {
      renderAppPackage: renderer,
    });

    const result = await registry.deploy(TENANT, GUIDED, DEPLOY_OPTIONS);

    expect(result).toEqual({
      ok: false,
      errors: [
        {
          code: 'app_package_invalid',
          path: 'server.agentGuide',
          message: 'app package rendering failed: app_package_invalid',
        },
      ],
    });
    expect(await store.loadAll()).toEqual([]);
    expect(registry.size).toBe(0);
  });

  it.each([
    {
      name: 'an empty file path',
      code: 'app_package_unsafe_path' as const,
      renderer: rendererWith((bundle, input) => {
        const files = bundle.files.map((file, index) =>
          index === 0 ? { ...file, path: '' } : file,
        );
        return { ...bundle, files, bundleSha256: bundleSha256(input, files) };
      }),
    },
    {
      name: 'a non-canonical file path',
      code: 'app_package_unsafe_path' as const,
      renderer: rendererWith((bundle, input) => {
        const files = bundle.files.map((file, index) =>
          index === 0 ? { ...file, path: 'SKILL.md' } : file,
        );
        return { ...bundle, files, bundleSha256: bundleSha256(input, files) };
      }),
    },
    {
      name: 'all files targeting Codex',
      code: 'app_package_unsafe_path' as const,
      renderer: rendererWith((bundle, input) => {
        const files = bundle.files.map((file) => ({ ...file, target: 'codex' as const }));
        return { ...bundle, files, bundleSha256: bundleSha256(input, files) };
      }),
    },
    {
      name: 'a SKILL.md above 500 lines',
      code: 'app_package_file_too_large' as const,
      renderer: rendererWith((bundle, input) => {
        const content = 'line\n'.repeat(501);
        const files = bundle.files.map((file, index) =>
          index === 0
            ? {
                ...file,
                content,
                sha256: sha256(content),
                byteLength: Buffer.byteLength(content),
              }
            : file,
        );
        return { ...bundle, files, bundleSha256: bundleSha256(input, files) };
      }),
    },
  ])('rejects $name from an injected renderer', async ({ code, renderer }) => {
    const store = new InMemoryArtifactStore();
    const registry = new ServerRegistry(store, undefined, undefined, {
      renderAppPackage: renderer,
    });

    const result = await registry.deploy(TENANT, GUIDED, DEPLOY_OPTIONS);

    expect(result).toEqual({
      ok: false,
      errors: [
        {
          code,
          path: 'server.agentGuide',
          message: `app package rendering failed: ${code}`,
        },
      ],
    });
    expect(await store.loadAll()).toEqual([]);
  });
});
