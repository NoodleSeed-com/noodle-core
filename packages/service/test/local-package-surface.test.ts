import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');
const serviceSourceRoot = join(repoRoot, 'packages/service/src');
const controlPlaneSourceRoot = join(repoRoot, 'packages/control-plane/src');

interface StaticSourceClosure {
  files: ReadonlySet<string>;
  specifiers: ReadonlySet<string>;
}

function scanModuleSpecifiers(source: string): readonly string[] {
  const specifiers = [...source.matchAll(/\bimport\s+["']([^"']+)["']/gu)].map(
    (match) => match[1] as string,
  );
  for (const match of source.matchAll(
    /\b(?:import|export)\s+([^;]*?)\s+from\s+["']([^"']+)["']/gu,
  )) {
    if (!(match[1] as string).trimStart().startsWith('type ')) {
      specifiers.push(match[2] as string);
    }
  }
  return specifiers;
}

function resolveRelativeSource(importer: string, specifier: string): string | undefined {
  const rawPath = resolve(dirname(importer), specifier);
  const candidates = [
    rawPath,
    rawPath.replace(/\.js$/u, '.ts'),
    rawPath.replace(/\.js$/u, '.tsx'),
    join(rawPath, 'index.ts'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function staticSourceDependencyClosure(entrypoint: string): StaticSourceClosure {
  const files = new Set<string>();
  const specifiers = new Set<string>();
  const pending = [entrypoint];

  while (pending.length > 0) {
    const sourcePath = pending.pop();
    if (sourcePath === undefined || files.has(sourcePath)) {
      continue;
    }

    files.add(sourcePath);
    for (const specifier of scanModuleSpecifiers(readFileSync(sourcePath, 'utf8'))) {
      specifiers.add(specifier);
      let dependency: string | undefined;
      if (specifier.startsWith('.')) {
        dependency = resolveRelativeSource(sourcePath, specifier);
      } else if (specifier === '@noodle-borg/control-plane') {
        dependency = join(controlPlaneSourceRoot, 'index.ts');
      } else if (specifier === '@noodle-borg/control-plane/portable') {
        dependency = join(controlPlaneSourceRoot, 'portable.ts');
      }

      if (
        dependency !== undefined &&
        (dependency.startsWith(serviceSourceRoot) || dependency.startsWith(controlPlaneSourceRoot))
      ) {
        pending.push(dependency);
      }
    }
  }

  return { files, specifiers };
}

function repoRelativeFiles(files: ReadonlySet<string>): readonly string[] {
  return [...files].map((file) => relative(repoRoot, file).replaceAll('\\', '/'));
}

describe('local service package projection', () => {
  it('exports only the CLI local-runtime contract', async () => {
    const localModule = (await import(new URL('../src/local.ts', import.meta.url).href)) as Record<
      string,
      unknown
    >;

    expect(Object.keys(localModule).sort()).toEqual([
      'CONFIG_NAME_PATTERN',
      'SLUG_PATTERN',
      'parseNoodleServiceYaml',
      'projectLocalDevtoolsDelegatedExchangeBindings',
      'resolveConfigScope',
      'resolveServiceConfigSource',
      'resolveTenantBridgeAuthVariables',
      'serveService',
    ]);
    expect(localModule.serveService).toBeTypeOf('function');
  });

  it('boots and closes the loopback-only in-memory composition', async () => {
    const local = await import('../src/local.js');
    const running = await local.serveService({ port: 0 });
    try {
      expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(running.registry).toBeDefined();
    } finally {
      await running.close();
    }
    await expect(local.serveService({ host: '0.0.0.0', port: 0 })).rejects.toThrow(/loopback/i);
  });

  it('exports the host-neutral purge conflict boundary from control-plane portable', async () => {
    const portable = await import('@noodle-borg/control-plane/portable');

    expect(portable.AppPurgeReconciliationError).toBeTypeOf('function');
    expect(
      new portable.AppPurgeReconciliationError('blocked', 'blocked by a conflict'),
    ).toMatchObject({
      code: 'blocked',
      message: 'blocked by a conflict',
    });
  });

  it('keeps root-only purge reconciliation exports off control-plane portable', async () => {
    const portableExports = Object.keys(await import('@noodle-borg/control-plane/portable'));

    expect(portableExports).not.toEqual(
      expect.arrayContaining([
        'computeAppPurgeReconciliationChecksum',
        'ensureAppPurgeReconciliationSchema',
        'PostgresAppPurgeReconciliationOperator',
      ]),
    );
  });

  it('keeps the control-plane portable static closure away from purge Postgres and audit code', () => {
    const closure = staticSourceDependencyClosure(join(controlPlaneSourceRoot, 'portable.ts'));
    const files = repoRelativeFiles(closure.files);

    expect(files).not.toContain('packages/control-plane/src/postgres-app-purge-reconciliation.ts');
    expect(files).not.toContain(
      'packages/control-plane/src/postgres-app-purge-reconciliation-schema.ts',
    );
    expect(closure.specifiers).not.toContain('@noodle-borg/module-audit');
    expect(closure.specifiers).not.toContain('pg');
  });

  it('keeps the service local static closure on the portable purge port', () => {
    const closure = staticSourceDependencyClosure(join(serviceSourceRoot, 'local.ts'));
    const files = repoRelativeFiles(closure.files);

    expect(closure.specifiers).toContain('@noodle-borg/control-plane/portable');
    expect(closure.specifiers).not.toContain('@noodle-borg/control-plane');
    expect(files).not.toContain('packages/control-plane/src/postgres-app-purge-reconciliation.ts');
    expect(files).not.toContain(
      'packages/control-plane/src/postgres-app-purge-reconciliation-schema.ts',
    );
    expect(closure.specifiers).not.toContain('@noodle-borg/module-audit');
    expect(closure.specifiers).not.toContain('pg');
  });
});
