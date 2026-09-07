/**
 * Authored-entrypoint loading: turn an authored `server.ts` (or compiled `.js`) project file into
 * its manifest string (plus optional connector catalog and distribution metadata) by transpiling to
 * an isolated temp module and importing it against a synthetic SDK shim.
 *
 * Extracted from the CLI (2026-08-15) because this is author-time SDK behavior, not CLI plumbing:
 * any host of `@noodle-borg/authoring` (CLI, devtools, tests) loads authored projects the same way.
 * The transpile is single-file and type-check-free by design — type errors are `tsc`'s job; a file
 * that does not *parse* is rejected here.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import type { DistributionMetadataV1 } from './distribution.js';
import { isServerDefinition } from './server.js';

/**
 * Where the transpiled entry can resolve workspace SDK imports from: the `@noodle-borg/*` scope is
 * symlinked from the host installation, and `@noodleseed/one` is a synthetic shim over it so the
 * import surface the author wrote against exists even where the published package is not installed.
 */
export interface LoadAuthoredOptions {
  readonly sdkModulesDir: string;
}

export interface AuthoredEntrypoint {
  readonly manifest: string;
  readonly connectors?: string;
  readonly distribution?: DistributionMetadataV1;
}

/** Prepare an isolated runtime dir: the `@noodle-borg/*` scope symlink plus the `@noodleseed/one` shim. */
export function prepareAuthoringRuntimeDir(dir: string, options: LoadAuthoredOptions): void {
  const modules = join(dir, 'node_modules');
  mkdirSync(modules, { recursive: true });
  const scoped = join(options.sdkModulesDir, '@noodle-borg');
  const scopedTarget = join(modules, '@noodle-borg');
  if (existsSync(scoped) && !pathExists(scopedTarget)) symlinkSync(scoped, scopedTarget, 'dir');
  const self = join(modules, '@noodleseed', 'one');
  mkdirSync(self, { recursive: true });
  writeFileSync(
    join(self, 'package.json'),
    JSON.stringify({
      name: '@noodleseed/one',
      type: 'module',
      exports: {
        '.': './index.mjs',
        './platform': './platform.mjs',
        './react': './react.mjs',
      },
    }),
  );
  writeFileSync(
    join(self, 'index.mjs'),
    "export { algolia, annotations, asset, authenticatedWebsite, bind, clientCredentials, connector, connection, customerAuth, customerEndpoint, embeddedAssistant, externalExchange, file, firecrawl, gmailConnector, googleWorkloadIdentity, handoffSession, knowledge, managedCollection, managedSecret, meilisearch, noodleManaged, noodlePlatform, openAICompatible, prompt, publicWebsite, resource, secret, server, site, tavily, tool, variable, when, z } from '@noodle-borg/authoring';\n",
  );
  writeFileSync(
    join(self, 'platform.mjs'),
    "export { noodlePlatform, noodlePlatformCatalog } from '@noodle-borg/authoring';\n",
  );
  writeFileSync(join(self, 'react.mjs'), "export * from '@noodle-borg/authoring/react';\n");
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `ts.transpileModule()` is single-file and type-check-free, so its diagnostics are *syntactic* only —
 * but it still emits error-recovered output for input that does not parse. Left unchecked, a
 * `server.ts` with a real syntax error becomes running JavaScript whose semantics are whatever the
 * parser guessed.
 */
function assertParsed(
  path: string,
  source: string,
  diagnostics: readonly ts.Diagnostic[] | undefined,
): void {
  // Only diagnostics *about this file*. `transpileModule` also reports global option diagnostics
  // (e.g. TS5110 for this call's module/moduleResolution pairing, which it ignores anyway because it
  // resolves nothing), and those say nothing about whether the author's source parses.
  const failure = diagnostics?.find(
    (diagnostic) =>
      diagnostic.category === ts.DiagnosticCategory.Error && diagnostic.file !== undefined,
  );
  if (failure === undefined) return;
  const message = ts.flattenDiagnosticMessageText(failure.messageText, ' ');
  const where =
    failure.start === undefined
      ? ''
      : (() => {
          const { line, character } = ts.getLineAndCharacterOfPosition(
            ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true),
            failure.start,
          );
          return `:${line + 1}:${character + 1}`;
        })();
  throw new Error(`${path}${where} does not parse — ${message} (TS${failure.code})`);
}

/** Transpile sibling `.ts`/`.mts` modules (helpers, views) and symlink compiled `.js` siblings. */
function materializeAuthoringSiblingModules(sourceDir: string, targetDir: string): void {
  for (const entry of readdirSync(sourceDir)) {
    const target = join(targetDir, entry);
    if ((entry.endsWith('.js') || entry.endsWith('.mjs')) && !pathExists(target)) {
      symlinkSync(resolve(sourceDir, entry), target);
      continue;
    }
    if (!entry.endsWith('.ts') && !entry.endsWith('.mts')) continue;
    if (entry.endsWith('.d.ts')) continue;
    const compiledTarget = join(
      targetDir,
      `${basename(entry, extname(entry))}${entry.endsWith('.mts') ? '.mjs' : '.js'}`,
    );
    if (pathExists(compiledTarget)) continue;
    const source = readFileSync(resolve(sourceDir, entry), 'utf8');
    const out = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        esModuleInterop: true,
      },
      fileName: resolve(sourceDir, entry),
    });
    writeFileSync(compiledTarget, out.outputText);
  }
}

/**
 * Load a compiled (`.js`/`.mjs`) authored module against a prepared runtime dir and extract the
 * manifest string, connector catalog, and distribution metadata from its server definition.
 */
export async function loadAuthoredModule(path: string): Promise<AuthoredEntrypoint> {
  const mod = (await import(pathToFileURL(path).href)) as { default?: unknown; manifest?: unknown };
  const value = mod.default ?? mod.manifest;
  if (isServerDefinition(value)) {
    const manifest = JSON.stringify(await value.toManifest());
    const catalog = value.toConnectorCatalog?.();
    const distribution = value.toDistributionMetadata?.();
    return {
      manifest,
      ...(catalog ? { connectors: JSON.stringify(catalog) } : {}),
      ...(distribution === undefined ? {} : { distribution }),
    };
  }
  throw new Error('authoring module must export a Noodle server definition');
}

/** Load an authored TypeScript entrypoint: transpile into an isolated dir, then {@link loadAuthoredModule}. */
export async function loadAuthoredTypeScriptEntry(
  path: string,
  options: LoadAuthoredOptions,
): Promise<AuthoredEntrypoint> {
  if (!isAbsolute(path)) throw new Error('authored entrypoint path must be absolute');
  const source = readFileSync(path, 'utf8');
  const out = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      esModuleInterop: true,
    },
    fileName: path,
    reportDiagnostics: true,
  });
  assertParsed(path, source, out.diagnostics);
  const dir = mkdtempSync(join(tmpdir(), `noodle-authoring-${process.pid}-`));
  prepareAuthoringRuntimeDir(dir, options);
  materializeAuthoringSiblingModules(dirname(path), dir);
  const compiled = join(dir, `${basename(path, extname(path))}-${Date.now()}.mjs`);
  writeFileSync(compiled, out.outputText);
  return loadAuthoredModule(compiled);
}
