import ts from 'typescript';
import * as sdk from './index.js';

export { createHash } from './sandbox-crypto.js';

/** Trusted entry bundled at package build time and evaluated only inside the compute sandbox. */
export async function run(input: {
  readonly entrypoint: string;
  readonly files: Readonly<Record<string, string>>;
}) {
  const modules = new Map<string, { exports: Record<string, unknown> }>();
  const transpiled = new Map<string, string>();
  // Parse every TS file, including unused helpers; no uploaded configuration or compiler plugin.
  for (const [fileName, content] of Object.entries(input.files)) {
    if (fileName.endsWith('.css')) continue;
    const result = ts.transpileModule(content, {
      fileName,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
      reportDiagnostics: true,
    });
    const failure = result.diagnostics?.find((d) => d.category === ts.DiagnosticCategory.Error);
    if (failure)
      throw new Error(`${fileName}: ${ts.flattenDiagnosticMessageText(failure.messageText, ' ')}`);
    transpiled.set(fileName, result.outputText);
  }
  const load = (path: string): Record<string, unknown> => {
    const existing = modules.get(path);
    if (existing) return existing.exports;
    const javascript = transpiled.get(path);
    if (javascript === undefined) throw new Error(`TypeScript module unavailable: ${path}`);
    const module = { exports: {} };
    modules.set(path, module);
    const require = (name: string): unknown => {
      if (name === '@noodleseed/one') return sdk;
      if (name === 'zod') return { ...sdk.z, z: sdk.z, default: sdk.z };
      if (name === '@noodleseed/one/platform')
        return {
          noodlePlatform: sdk.noodlePlatform,
          noodlePlatformCatalog: sdk.noodlePlatformCatalog,
        };
      return load(resolveModule(path, name, transpiled));
    };
    // This Function constructor is evaluated in QuickJS, never imported/evaluated in Node.
    new Function('module', 'exports', 'require', javascript)(module, module.exports, require);
    return module.exports;
  };
  const entry = load(input.entrypoint);
  const value = entry.default ?? entry.manifest;
  if (!sdk.isServerDefinition(value)) throw new Error('Expected a Noodle server definition');
  const manifest = JSON.stringify(await value.toManifest());
  const catalog = value.toConnectorCatalog();
  const distribution = value.toDistributionMetadata();
  return {
    manifest,
    ...(catalog ? { connectors: JSON.stringify(catalog) } : {}),
    ...(distribution ? { distribution } : {}),
  };
}

function resolveModule(
  from: string,
  specifier: string,
  files: ReadonlyMap<string, string>,
): string {
  if (
    typeof specifier !== 'string' ||
    specifier.length > 240 ||
    !/^\.{1,2}\//.test(specifier) ||
    /[\\\0?#%]/.test(specifier)
  )
    throw new Error('Import not allowed');
  const parts = from.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new Error('Import escapes the uploaded project');
      parts.pop();
    } else if (!part) throw new Error('Invalid import');
    else parts.push(part);
  }
  const target = parts.join('/');
  const candidates = /\.tsx?$/.test(target)
    ? [target]
    : target.endsWith('.js')
      ? [`${target.slice(0, -3)}.ts`, `${target.slice(0, -3)}.tsx`]
      : [`${target}.ts`, `${target}.tsx`, `${target}/index.ts`, `${target}/index.tsx`];
  const matches = candidates.filter((candidate) => files.has(candidate));
  const match = matches[0];
  if (matches.length !== 1 || match === undefined)
    throw new Error('Import is missing or ambiguous');
  return match;
}
