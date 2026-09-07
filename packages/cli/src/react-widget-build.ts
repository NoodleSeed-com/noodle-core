import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Manifest } from '@noodle-borg/compiler';
import ts from 'typescript';

type ManifestWidget = NonNullable<Manifest['widgets']>[number];
type BuiltWidget = Omit<ManifestWidget, 'view'> & {
  readonly view?: NonNullable<ManifestWidget['view']> & {
    readonly compiledHtml?: string;
  };
};
type BuiltManifest = Omit<Manifest, 'widgets'> & {
  widgets?: BuiltWidget[];
};

type ViteOutputItem =
  | { readonly type: 'chunk'; readonly code: string }
  | { readonly type: 'asset'; readonly fileName: string; readonly source: string | Uint8Array };
type ViteChunk = Extract<ViteOutputItem, { readonly type: 'chunk' }>;
type ViteAsset = Extract<ViteOutputItem, { readonly type: 'asset' }>;

type ViteOutput = { readonly output: readonly ViteOutputItem[] };
type ViteBuild = typeof import('vite')['build'];

export async function buildReactWidgetViews(
  manifestJson: string,
  options: { readonly rootDir: string },
): Promise<string> {
  const manifest = JSON.parse(manifestJson) as BuiltManifest;
  const widgets = manifest.widgets ?? [];
  if (widgets.every((widget) => widget.view === undefined)) return manifestJson;
  manifest.widgets = await Promise.all(
    widgets.map(async (widget) => {
      if (widget.view === undefined) return widget;
      return {
        ...widget,
        view: {
          ...widget.view,
          compiledHtml: await buildReactWidgetHtml({
            rootDir: options.rootDir,
            title: widget.title ?? widget.view.component,
            component: widget.view.component,
            entry: widget.view.entry,
          }),
        },
      };
    }),
  );
  return JSON.stringify(manifest);
}

/** Directories whose local widget source changes must rebuild an authored manifest in `noodle dev`. */
export function reactWidgetWatchDirectories(
  manifestJson: string,
  options: { readonly rootDir: string },
): readonly string[] {
  const manifest = JSON.parse(manifestJson) as BuiltManifest;
  return [
    ...new Set(
      (manifest.widgets ?? [])
        .flatMap((widget) => (widget.view === undefined ? [] : [widget.view.entry]))
        .map((entry) => dirname(resolveWidgetEntry(options.rootDir, entry))),
    ),
  ].sort();
}

async function buildReactWidgetHtml(input: {
  readonly rootDir: string;
  readonly title: string;
  readonly component: string;
  readonly entry: string;
}): Promise<string> {
  const entry = resolveWidgetEntry(input.rootDir, input.entry);
  const dir = mkdtempSync(join(tmpdir(), `noodle-react-widget-${process.pid}-`));
  mkdirSync(dir, { recursive: true });
  const generatedEntry = join(dir, 'entry.tsx');
  writeFileSync(generatedEntry, reactWidgetEntrySource(entry));
  const viteBuild = await loadViteBuild(input.rootDir);
  const result = await viteBuild({
    root: input.rootDir,
    configFile: false,
    logLevel: 'silent',
    mode: 'production',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    esbuild: { jsxDev: false },
    plugins: [portableReactWidgetAuthoringPlugin(input.rootDir), reactSourceAliasPlugin()],
    resolve: {
      alias: [
        { find: /^react$/, replacement: resolvePackageModule('react', input.rootDir) },
        {
          find: /^react\/jsx-runtime$/,
          replacement: resolvePackageModule('react/jsx-runtime', input.rootDir),
        },
        {
          find: /^react\/jsx-dev-runtime$/,
          replacement: resolvePackageModule('react/jsx-dev-runtime', input.rootDir),
        },
        {
          find: /^react-dom\/client$/,
          replacement: resolvePackageModule('react-dom/client', input.rootDir),
        },
        { find: /^@noodleseed\/one\/react$/, replacement: reactHelperModulePath() },
        // The kit stylesheet ships alongside the CLI; alias it so widget bundling resolves it from the
        // toolchain (like the react entry above) instead of the project's node_modules, whose exports may
        // not expose the CSS subpath.
        { find: /^@noodleseed\/one\/react\/styles\.css$/, replacement: reactStylesPath() },
      ],
      dedupe: ['react', 'react-dom'],
    },
    build: {
      write: false,
      sourcemap: false,
      minify: true,
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      rollupOptions: {
        input: generatedEntry,
        output: {
          format: 'es',
          // Single self-contained widget bundle. `codeSplitting: false` is the current Rolldown spelling
          // of the deprecated `inlineDynamicImports: true` (which logged a warning below Vite's logger).
          codeSplitting: false,
          entryFileNames: 'widget.js',
          assetFileNames: 'widget.[ext]',
        },
      },
    },
  });
  const output = viteOutput(result);
  if (output === undefined) throw new Error(`React widget "${input.component}" produced no bundle`);
  const scripts = output
    .filter(isViteChunk)
    .map((item) => item.code)
    .join('\n');
  const styles = output
    .filter(isViteCssAsset)
    .map((item) => String(item.source))
    .join('\n');
  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(input.title)}</title>`,
    styles ? `<style data-noodle-react-bundle>${safeStyle(styles)}</style>` : '',
    '</head>',
    '<body>',
    `<main id="noodle-react-root" data-noodle-react-view="${escapeHtml(input.component)}"></main>`,
    '<noscript>This React widget requires JavaScript in the host iframe.</noscript>',
    `<script type="module" data-noodle-react-bundle>${safeScript(scripts)}</script>`,
    '</body>',
    '</html>',
  ].join('');
}

async function loadViteBuild(rootDir: string): Promise<ViteBuild> {
  let missingProjectVite: unknown;
  try {
    return await importViteBuild(resolveViteEntry(rootDir));
  } catch (error) {
    if (!isMissingViteDependency(error)) throw error;
    missingProjectVite = error;
  }

  const builderViteRoot = process.env.NOODLE_BUILDER_VITE_ROOT;
  if (builderViteRoot !== undefined && builderViteRoot.trim() !== '') {
    try {
      return await importViteBuild(resolveViteEntry(builderViteRoot));
    } catch (error) {
      if (!isMissingViteDependency(error)) throw error;
    }
  }

  throw new Error(
    'React widget bundling requires Vite in your project. Install it with `npm install --save-dev vite`, then retry the deploy.',
    { cause: missingProjectVite },
  );
}

function resolveViteEntry(packageRoot: string): string {
  const fromRoot = createRequire(join(packageRoot, 'package.json'));
  return fromRoot.resolve('vite');
}

async function importViteBuild(viteEntry: string): Promise<ViteBuild> {
  try {
    return (await import(pathToFileURL(viteEntry).href)).build;
  } catch (error) {
    throw new Error(`React widget bundling could not load Vite from ${viteEntry}`, {
      cause: error,
    });
  }
}

function isMissingViteDependency(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'MODULE_NOT_FOUND' &&
    (error.message.includes("'vite'") || error.message.includes('"vite"'))
  );
}

function viteOutput(result: unknown): readonly ViteOutputItem[] | undefined {
  if (Array.isArray(result)) return (result[0] as ViteOutput | undefined)?.output;
  return (result as ViteOutput | undefined)?.output;
}

function isViteChunk(item: ViteOutputItem): item is ViteChunk {
  return item.type === 'chunk';
}

function isViteCssAsset(item: ViteOutputItem): item is ViteAsset {
  return item.type === 'asset' && item.fileName.endsWith('.css');
}

function resolveWidgetEntry(rootDir: string, entry: string): string {
  const resolved = isAbsolute(entry) ? entry : resolve(rootDir, entry);
  if (!existsSync(resolved)) throw new Error(`React widget entry not found: ${entry}`);
  return resolved;
}

function reactWidgetEntrySource(entry: string): string {
  return `
import React from 'react';
import { createRoot } from 'react-dom/client';
import Component from ${JSON.stringify(pathToFileURL(entry).href)};

const root = document.getElementById('noodle-react-root');
if (root) {
  createRoot(root).render(React.createElement(Component));
}
`;
}

function reactHelperModulePath(): string {
  const sourcePath = resolve(packageRoot(), '..', 'authoring', 'src', 'react.ts');
  if (existsSync(sourcePath)) return sourcePath;
  return resolve(packageRoot(), 'node_modules', '@noodle-borg', 'authoring', 'dist', 'react.js');
}

function reactStylesPath(): string {
  // Shipped at `<cli package>/react/styles.css` in both the monorepo and the published `@noodleseed/one`.
  return resolve(packageRoot(), 'react', 'styles.css');
}

function resolvePackageModule(id: string, rootDir: string): string {
  const fromApp = createRequire(join(rootDir, 'package.json'));
  try {
    return fromApp.resolve(id);
  } catch {
    return createRequire(import.meta.url).resolve(id);
  }
}

function reactSourceAliasPlugin() {
  return {
    name: 'noodle-react-source-alias',
    resolveId(source: string) {
      if (source === '@noodleseed/one/react') return reactHelperModulePath();
      if (source === '@noodleseed/one/react/styles.css') return reactStylesPath();
      return null;
    },
  };
}

function portableReactWidgetAuthoringPlugin(rootDir: string) {
  const projectRoot = resolve(rootDir);
  return {
    name: 'noodle-portable-react-widget-authoring',
    enforce: 'pre' as const,
    transform(source: string, id: string) {
      const filename = id.split('?', 1)[0];
      if (filename === undefined || !/\.[cm]?[jt]sx$/i.test(filename)) return null;
      const projectPath = relative(projectRoot, filename);
      if (projectPath.startsWith('..') || isAbsolute(projectPath)) return null;

      const sourceFile = ts.createSourceFile(
        filename,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      let unsafeForm: ts.JsxOpeningLikeElement | undefined;
      let implicitButton: ts.JsxOpeningLikeElement | undefined;
      const visit = (node: ts.Node): void => {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const tagName = node.tagName.getText(sourceFile);
          if (unsafeForm === undefined && tagName === 'form') {
            unsafeForm = node;
            return;
          }
          if (
            implicitButton === undefined &&
            tagName === 'button' &&
            !node.attributes.properties.some(
              (attribute) =>
                ts.isJsxAttribute(attribute) && attribute.name.getText(sourceFile) === 'type',
            )
          ) {
            implicitButton = node;
            return;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      const invalidNode = unsafeForm ?? implicitButton;
      if (invalidNode === undefined) return null;

      const position = sourceFile.getLineAndCharacterOfPosition(invalidNode.getStart(sourceFile));
      if (unsafeForm === undefined) {
        throw new Error(
          `${projectPath}:${position.line + 1}:${position.character + 1} must give every native <button> an explicit type="button" or type="submit". ` +
            'Use type="button" for standalone MCP App actions and type="submit" only inside the portable <Form> component.',
        );
      }
      throw new Error(
        `${projectPath}:${position.line + 1}:${position.character + 1} must use the portable <Form> component for submit workflows or replace the form with a non-form container and an explicit type="button" action. ` +
          'A sandboxed MCP client can block native form activation before React receives onSubmit.',
      );
    },
  };
}

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function safeScript(value: string): string {
  return value.replaceAll('</script', '<\\/script');
}

function safeStyle(value: string): string {
  return value.replaceAll('</style', '<\\/style');
}
