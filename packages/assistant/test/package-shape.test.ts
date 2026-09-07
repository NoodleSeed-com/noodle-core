// The published package meets arbitrary customer toolchains (Next.js server webpack, CJS Node,
// classic `moduleResolution: node`, bundlers). This gate exists because 1.0.0 shipped ESM-only with
// `import`-only export conditions and `engines >=24`, which broke real integrations before the
// session contract bug was even reachable. See docs/roadmap/embedded-assistant-hardening.md (S3).
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import attwPackage from '@arethetypeswrong/cli/package.json' with { type: 'json' };
import { publint } from 'publint';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const sourcePackageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = mkdtempSync(join(tmpdir(), 'noodle-assistant-package-shape-'));
const pkg = JSON.parse(readFileSync(join(sourcePackageRoot, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
  engines: { node: string };
  main: string;
  module: string;
  types: string;
  typesVersions: Record<string, Record<string, string[]>>;
  exports: Record<string, Record<string, string | Record<string, string>> | string>;
};

const SUBPATHS = ['.', './app-view', './client', './react', './react/client', './server'] as const;

beforeAll(() => {
  // Rebuild the real package into an isolated consumer tree. Cleaning shared dist during parallel
  // CLI type/browser tests otherwise deletes the declarations those consumers are inspecting.
  for (const name of ['package.json', 'README.md', 'LICENSE']) {
    if (existsSync(join(sourcePackageRoot, name)))
      copyFileSync(join(sourcePackageRoot, name), join(packageRoot, name));
  }
  symlinkSync(join(sourcePackageRoot, 'node_modules'), join(packageRoot, 'node_modules'), 'dir');
  execFileSync('pnpm', ['exec', 'tsup', '--out-dir', join(packageRoot, 'dist')], {
    cwd: sourcePackageRoot,
    stdio: 'pipe',
  });
}, 120_000);
afterAll(() => {
  rmSync(packageRoot, { recursive: true, force: true });
});

describe('@noodleseed/assistant package shape', () => {
  it('supports Node 20 LTS consumers (customer CI commonly runs 20/22)', () => {
    expect(pkg.engines.node).toBe('>=20');
  });

  it('ships the headless AI SDK without a third-party chat adapter', () => {
    expect(pkg.dependencies.ai).toBe('6.0.201');
    expect(pkg.dependencies.zod).toBe('^4.4.3');
    expect(Object.keys(pkg.dependencies).filter((name) => name.startsWith('@ai-sdk/'))).toEqual([]);
  });

  it.each(SUBPATHS)('subpath %s pairs each module system with its own declarations', (subpath) => {
    const entry = pkg.exports[subpath];
    expect(entry, `${subpath} must be an exports object`).toBeTypeOf('object');
    const conditions = entry as Record<string, string | Record<string, string>>;

    // A subpath-level "types" key would match BEFORE import/require and hand ESM-flavored
    // declarations back to CJS consumers — the FalseESM bug this shape exists to prevent.
    expect(
      conditions.types,
      `${subpath} must not hoist "types" above the conditions`,
    ).toBeUndefined();

    const esm = conditions.import as Record<string, string>;
    const cjs = conditions.require as Record<string, string>;
    expect(esm, `${subpath} needs a nested "import" condition`).toBeTypeOf('object');
    expect(cjs, `${subpath} needs a nested "require" condition`).toBeTypeOf('object');
    expect(esm.types).toMatch(/\.d\.ts$/);
    expect(esm.default).toMatch(/\.js$/);
    expect(cjs.types).toMatch(/\.d\.cts$/);
    expect(cjs.default).toMatch(/\.cjs$/);
    expect(conditions.default, `${subpath} needs a fallback "default"`).toMatch(/\.js$/);
  });

  it('exposes ./package.json and typesVersions for classic moduleResolution: node', () => {
    expect(pkg.exports['./package.json']).toBe('./package.json');
    expect(pkg.typesVersions['*']?.['app-view']).toEqual(['./dist/app-view.d.ts']);
    expect(pkg.typesVersions['*']?.client).toEqual(['./dist/client.d.ts']);
    expect(pkg.typesVersions['*']?.react).toEqual(['./dist/react.d.ts']);
    expect(pkg.typesVersions['*']?.['react/client']).toEqual(['./dist/react/client.d.ts']);
    expect(pkg.typesVersions['*']?.server).toEqual(['./dist/server.d.ts']);
  });

  it('keeps main (CJS), module (ESM), and types coherent for tools that ignore exports', () => {
    expect(pkg.main).toBe('./dist/index.cjs');
    expect(pkg.module).toBe('./dist/index.js');
    expect(pkg.types).toBe('./dist/index.d.ts');
  });
});

describe('built package resolves and loads like a real consumer', () => {
  it('publint reports no errors', async () => {
    const { messages } = await publint({ pkgDir: packageRoot });
    expect(messages.filter((message) => message.type === 'error')).toEqual([]);
  });

  it.each(
    SUBPATHS,
  )('subpath %s resolves and imports under the import condition', async (subpath) => {
    const specifier =
      subpath === '.' ? '@noodleseed/assistant' : `@noodleseed/assistant/${subpath.slice(2)}`;
    const consumerRequire = createRequire(join(packageRoot, 'test', 'package-shape.test.ts'));
    const resolved = consumerRequire.resolve(specifier);
    expect(resolved).toMatch(/\.cjs$/); // require condition wins under require.resolve
    const esm = await import(
      pathToFileURL(join(packageRoot, 'dist', `${subpath === '.' ? 'index' : subpath.slice(2)}.js`))
        .href
    );
    expect(Object.keys(esm).length).toBeGreaterThan(0);
  });

  it.each(SUBPATHS)('subpath %s loads under CJS require', (subpath) => {
    const specifier =
      subpath === '.' ? '@noodleseed/assistant' : `@noodleseed/assistant/${subpath.slice(2)}`;
    const consumerRequire = createRequire(join(packageRoot, 'test', 'package-shape.test.ts'));
    const loaded = consumerRequire(specifier) as Record<string, unknown>;
    expect(Object.keys(loaded).length).toBeGreaterThan(0);
  });

  it('declaration files exist for both module systems', () => {
    for (const entry of ['index', 'app-view', 'client', 'react', 'react/client', 'server']) {
      expect(existsSync(join(packageRoot, 'dist', `${entry}.d.ts`))).toBe(true);
      expect(existsSync(join(packageRoot, 'dist', `${entry}.d.cts`))).toBe(true);
    }
  });

  it('exports the managed assistant and supported App host from the React entry', async () => {
    const react = await import(pathToFileURL(join(packageRoot, 'dist', 'react.js')).href);
    expect(Object.keys(react)).toEqual(
      expect.arrayContaining(['NoodleAssistant', 'NoodleAppView']),
    );
  });

  it('exports a framework-neutral App host without React or the managed assistant graph', async () => {
    const appView = await import(pathToFileURL(join(packageRoot, 'dist', 'app-view.js')).href);
    expect(Object.keys(appView)).toEqual(
      expect.arrayContaining([
        'APP_VIEW_TAG_NAME',
        'NoodleAppViewElement',
        'registerNoodleAppView',
      ]),
    );

    const sources = [
      readEsmGraph(join(packageRoot, 'dist', 'app-view.js')),
      readCjsGraph(join(packageRoot, 'dist', 'app-view.cjs')),
    ];
    for (const source of sources) {
      expect(source).not.toMatch(/(?:from|require\()\s*["']react(?:\/|["'])/);
      expect(source).not.toContain('react-dom');
      expect(source).not.toContain('NoodleAssistantElement');
      expect(source).not.toContain('registerNoodleAssistant');
    }
  });

  it('keeps the customer-owned React renderer graph free of the managed element', () => {
    const sources = [
      readEsmGraph(join(packageRoot, 'dist', 'react', 'client.js')),
      readCjsGraph(join(packageRoot, 'dist', 'react', 'client.cjs')),
    ];
    for (const source of sources) {
      expect(source).toContain('"use client"');
      expect(source).toContain('useNoodleAssistant');
      for (const managedMarker of [
        'NoodleAssistantElement',
        'NoodleAppView',
        'registerNoodleAssistant',
        'mountAssistantApp',
        'DOMPurify',
      ]) {
        expect(source).not.toContain(managedMarker);
      }
    }
  });

  it('ships a browser entry whose complete ESM graph needs no import map', () => {
    const pending = [join(packageRoot, 'dist', 'index.js')];
    const visited = new Set<string>();
    const bareSpecifiers = new Set<string>();

    while (pending.length > 0) {
      const file = pending.pop();
      if (!file || visited.has(file)) continue;
      visited.add(file);
      const source = readFileSync(file, 'utf8');
      const specifiers = [
        ...source.matchAll(/\b(?:import|export)\s+[^"']*?\s+from\s+["']([^"']+)["']/g),
        ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
        ...source.matchAll(/\bimport\s+["']([^"']+)["']/g),
      ].map((match) => match[1]);

      for (const specifier of specifiers) {
        if (!specifier) continue;
        if (specifier.startsWith('./') || specifier.startsWith('../')) {
          pending.push(resolve(dirname(file), specifier));
          continue;
        }
        if (
          !specifier.startsWith('/') &&
          !specifier.startsWith('data:') &&
          !specifier.startsWith('http://') &&
          !specifier.startsWith('https://')
        ) {
          bareSpecifiers.add(specifier);
        }
      }
    }

    expect([...bareSpecifiers], 'native browsers cannot resolve bare module specifiers').toEqual(
      [],
    );
    expect(visited.size).toBeGreaterThan(1);
  });
});

function readEsmGraph(entry: string): string {
  return readModuleGraph(
    entry,
    /\b(?:import|export)\s+[^"']*?\s+from\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']/g,
  );
}

function readCjsGraph(entry: string): string {
  return readModuleGraph(entry, /\brequire\(\s*["']([^"']+)["']\s*\)/g);
}

function readModuleGraph(entry: string, imports: RegExp): string {
  const pending = [entry];
  const visited = new Set<string>();
  const sources: string[] = [];
  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, 'utf8');
    sources.push(source);
    for (const match of source.matchAll(imports)) {
      const specifier = match[1] ?? match[2];
      if (specifier?.startsWith('./') || specifier?.startsWith('../')) {
        pending.push(resolve(dirname(file), specifier));
      }
    }
  }
  return sources.join('\n');
}

describe('type-resolution correctness (attw)', () => {
  // publint validates the manifest; attw validates what TypeScript actually RESOLVES per module
  // system — the check that caught this package serving ESM-flavored declarations to CJS consumers.
  // The baseline is empty: every export condition now carries its own matching declaration kind.
  it('reports no type-resolution problems at all', () => {
    const packageRequire = createRequire(import.meta.url);
    const attw = resolve(
      dirname(packageRequire.resolve('@arethetypeswrong/cli/package.json')),
      attwPackage.bin.attw,
    );
    // attw exits non-zero when problems exist AND can exit before its stdout pipe drains under
    // load (observed: reports truncated at exactly 64KiB). A file redirect avoids the pipe.
    const reportPath = join(tmpdir(), `attw-report-${process.pid}.json`);
    const result = spawnSync(process.execPath, [attw, '--pack', packageRoot, '--format', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', openSync(reportPath, 'w'), 'inherit'],
    });
    if (result.error) throw result.error;
    const stdout = readFileSync(reportPath, 'utf8');
    rmSync(reportPath, { force: true });
    const report = JSON.parse(stdout) as { problems?: Record<string, unknown[]> };
    const kinds = Object.keys(report.problems ?? {}).sort();
    expect(kinds).toEqual([]);
  }, 120_000);
});
