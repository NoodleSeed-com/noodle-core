/**
 * The public entrypoint is loaded by every consumer of this package — including the
 * published `@noodleseed/one` CLI, which reaches it through `@noodle-borg/compiler`.
 * A published tarball installs `dependencies` only, so any module reachable from
 * `src/index.ts` may import nothing but this package's declared runtime dependencies
 * and Node builtins. The shared conformance suites import `vitest` and therefore live
 * behind the `@noodle-borg/knowledge/conformance` subpath, never on the entrypoint.
 */
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
};

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

const IMPORT_RE = /^\s*(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm;

/** Every module reachable from `entry` by following relative imports/re-exports. */
function reachableExternalImports(entry: string): Map<string, string> {
  const external = new Map<string, string>();
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);

    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(IMPORT_RE)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      if (specifier.startsWith('.')) {
        // Source is TypeScript; emitted specifiers end in .js.
        queue.push(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
        continue;
      }
      if (BUILTINS.has(specifier)) continue;
      const name = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : (specifier.split('/')[0] as string);
      if (!external.has(name)) external.set(name, file.slice(packageRoot.length + 1));
    }
  }
  return external;
}

describe('public entrypoint purity', () => {
  it('imports nothing beyond the declared runtime dependencies', () => {
    const declared = new Set(Object.keys(pkg.dependencies ?? {}));
    const external = reachableExternalImports(join(packageRoot, 'src', 'index.ts'));

    const undeclared = [...external].filter(([name]) => !declared.has(name));

    expect(
      undeclared,
      `these modules are reachable from src/index.ts but are not runtime dependencies, so they ` +
        `would fail to resolve in a published tarball: ` +
        undeclared.map(([name, file]) => `${name} (via ${file})`).join(', '),
    ).toEqual([]);
  });

  it('does not reach the conformance suites from the entrypoint', () => {
    const external = reachableExternalImports(join(packageRoot, 'src', 'index.ts'));
    expect(external.has('vitest')).toBe(false);
  });
});
