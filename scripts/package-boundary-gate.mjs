#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import {
  countedSource,
  DEFAULT_PACKAGE_SCOPES,
  evaluatePackageScopes,
  readScopeBaseline,
  sourceMetric,
  validatePackageScopes,
} from './lib/package-scope-policy.mjs';
import { checkProjectedQualityConfig } from './lib/project-quality-config.mjs';
import { withoutTemplateLiterals } from './lib/source-text.mjs';

const BUILTIN_MODULES = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

const EXCLUDED_DIRS = new Set([
  '.git',
  '.next',
  '.pnpm-store',
  'coverage',
  'dist',
  'node_modules',
  'noodle-publish',
  'out',
]);

const SCANNED_ROOTS = ['packages', 'apps'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const IMPORT_RE =
  /^\s*(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"];?|^\s*(?:const|let|var)\s+\w+\s*=\s*(?:await\s+)?import\(\s*['"]([^'"]+)['"]\s*\)|^\s*(?:const|let|var)\s+\w+\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/gm;

function parseArgs(argv) {
  const options = { root: process.cwd(), config: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      options.root = argv[index + 1];
      index += 1;
    } else if (arg === '--config') {
      options.config = argv[index + 1];
      index += 1;
    } else if (arg === '--base') {
      options.base = argv[++index];
      if (!options.base || options.base.startsWith('-')) throw new Error('--base needs a Git ref');
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: node scripts/package-boundary-gate.mjs [--root <dir>] [--config <file>] [--base <ref>] [--json]',
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function normalizeRel(file) {
  return file.split(path.sep).join('/');
}

function globToRegExp(glob) {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    const next = glob[index + 1];
    if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

function matchesAny(value, globs) {
  return globs.some((glob) => globToRegExp(glob).test(value));
}

function loadConfig(root, explicitConfig) {
  const configFile = explicitConfig
    ? path.resolve(root, explicitConfig)
    : path.join(root, 'quality-gates.config.json');
  const parsed = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {};
  return {
    raw: parsed,
    allowCrossPackageSourceImports: parsed.packageBoundaries?.allowCrossPackageSourceImports ?? [],
    allowServiceDevDependencies: parsed.packageBoundaries?.allowServiceDevDependencies ?? [],
    allowUndeclaredExternalImports: parsed.packageBoundaries?.allowUndeclaredExternalImports ?? [],
    scopes: {
      ...DEFAULT_PACKAGE_SCOPES,
      ...parsed.packageScopes,
    },
    carveOutSeams: parsed.carveOutSeams ?? [],
  };
}

function validateConfig(config) {
  const errors = validatePackageScopes(config.scopes);
  for (const seam of config.carveOutSeams) {
    if (
      !seam.name ||
      !seam.package ||
      seamClusters(seam).length === 0 ||
      typeof seam.maxEdges !== 'number'
    ) {
      errors.push('carve-out seam must include name, package, cluster(s) and numeric maxEdges');
    }
    if (!seam.reason || seam.reason.trim().length < 10) {
      errors.push(`carve-out seam ${seam.name ?? '(missing)'} must include a reason`);
    }
  }
  for (const entry of config.allowCrossPackageSourceImports) {
    if (!entry.from || !entry.to)
      errors.push('package-boundary allow entry must include from and to');
    if (!entry.reason || entry.reason.trim().length < 10) {
      errors.push(
        `package-boundary allow entry ${entry.from ?? '(missing)'} must include a reason`,
      );
    }
  }
  for (const entry of config.allowServiceDevDependencies) {
    if (!entry.path) errors.push('package-boundary service dev-dependency entry needs a path');
    if (!entry.reason || entry.reason.trim().length < 10) {
      errors.push(
        `package-boundary service dev-dependency entry ${entry.path ?? '(missing)'} needs a reason`,
      );
    }
  }
  return errors;
}

/** A seam may name one `cluster` glob or several `clusters`; both mean "this directory set". */
function seamClusters(seam) {
  if (Array.isArray(seam.clusters)) return seam.clusters.filter(Boolean);
  return seam.cluster ? [seam.cluster] : [];
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function collectPackageRoots(root) {
  const packages = [];
  for (const scannedRoot of SCANNED_ROOTS) {
    const dir = path.join(root, scannedRoot);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const packageJson = path.join(full, 'package.json');
      if (statSync(full).isDirectory() && existsSync(packageJson)) {
        packages.push({
          root: full,
          rel: normalizeRel(path.relative(root, full)),
          pkg: readJson(packageJson),
        });
      }
    }
  }
  return packages;
}

function collectFiles(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      collectFiles(full, files);
      continue;
    }
    if (stat.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry))) files.push(full);
  }
  return files;
}

/**
 * Include new, nonignored source before staging, but not ignored build output. Bare test fixtures
 * have no Git index; in those directories the source walk is authoritative.
 */
function trackedFiles(root) {
  try {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    const output = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      {
        cwd: root,
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    return new Set(output.split('\0').filter(Boolean).map(normalizeRel));
  } catch {
    return undefined;
  }
}

function workspaceImportName(specifier) {
  if (specifier === '@noodleseed/one' || specifier.startsWith('@noodleseed/one/'))
    return '@noodleseed/one';
  if (specifier.startsWith('@noodle-borg/')) return specifier.split('/').slice(0, 2).join('/');
  return undefined;
}

function dependencySet(pkg, includeDev) {
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...(includeDev ? Object.keys(pkg.devDependencies ?? {}) : []),
  ]);
}

function nonDevDependencySet(pkg) {
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);
}

function declaredDependencySet(pkg) {
  return new Set([...nonDevDependencySet(pkg), ...Object.keys(pkg.devDependencies ?? {})]);
}

function isTestFile(rel) {
  return (
    rel.includes('/test/') ||
    rel.includes('/tests/') ||
    /(?:^|[.-])(test|spec)\.[cm]?[jt]sx?$/.test(rel)
  );
}

function canUseDevDependencies(rel) {
  return isTestFile(rel) || rel.includes('/src/examples/');
}

/** Build/test tooling at a package root; never emitted into `dist`. */
function isConfigFile(rel) {
  return /(?:^|\/)[\w.-]+\.config\.[cm]?[jt]s$/.test(rel);
}

/** Bare specifier -> package name ('@scope/n/sub' -> '@scope/n', 'p/sub' -> 'p'). */
function externalPackageName(specifier, builtins) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) {
    return undefined;
  }
  // tsconfig `paths` aliases and framework virtual modules are not npm packages.
  if (specifier.startsWith('@/')) return undefined;
  if (builtins.has(specifier)) return undefined;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function matchesUndeclaredAllow(config, fileRel, packageName) {
  return config.allowUndeclaredExternalImports.some(
    (entry) => globToRegExp(entry.file).test(fileRel) && entry.package === packageName,
  );
}

function matchesAllow(config, fromRel, toRel) {
  return config.allowCrossPackageSourceImports.some(
    (entry) => globToRegExp(entry.from).test(fromRel) && globToRegExp(entry.to).test(toRel),
  );
}

function findOwningPackage(packages, file) {
  return packages
    .filter(
      (candidate) => file === candidate.root || file.startsWith(`${candidate.root}${path.sep}`),
    )
    .sort((a, b) => b.root.length - a.root.length)[0];
}

function importedSpecifiers(text) {
  return [...text.matchAll(IMPORT_RE)]
    .map((match) => match[1] ?? match[2] ?? match[3])
    .filter(Boolean);
}

function resolveRelativeImport(file, specifier) {
  if (!specifier.startsWith('.')) return undefined;
  const base = path.resolve(path.dirname(file), specifier);
  if (path.extname(base) === '.js') {
    const sourceCandidate = `${base.slice(0, -'.js'.length)}.ts`;
    if (existsSync(sourceCandidate)) return sourceCandidate;
  }
  for (const ext of SOURCE_EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (existsSync(candidate)) return candidate;
  }
  for (const entry of [
    'index.ts',
    'index.tsx',
    'index.mts',
    'index.cts',
    'index.js',
    'index.mjs',
  ]) {
    const candidate = path.join(base, entry);
    if (existsSync(candidate)) return candidate;
  }
  return base;
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const root = path.resolve(options.root);
  const config = loadConfig(root, options.config);
  const configErrors = validateConfig(config);
  if (configErrors.length) {
    console.error('package-boundary-gate config failed:');
    for (const error of configErrors) console.error(`- ${error}`);
    process.exit(2);
  }

  const packages = collectPackageRoots(root);
  const workspaceNames = new Set(packages.map((pkg) => pkg.pkg.name).filter(Boolean));
  const packagesByName = new Map(packages.map((pkg) => [pkg.pkg.name, pkg]));
  const failures = [];
  const commercialCarveoutPackages = new Set([
    '@noodle-borg/asset-store',
    '@noodle-borg/deploy-github',
    '@noodle-borg/platform-identity',
    '@noodle-borg/module-billing',
  ]);
  let checked = 0;

  for (const pkg of packages) {
    if (!['Apache-2.0', 'UNLICENSED'].includes(pkg.pkg.license)) {
      failures.push(
        `${pkg.rel}/package.json: workspace packages must declare Apache-2.0 or UNLICENSED`,
      );
    }
    if (pkg.pkg.license === 'UNLICENSED' && pkg.pkg.private !== true) {
      failures.push(`${pkg.rel}/package.json: UNLICENSED packages must be private`);
    }
    if (pkg.pkg.license === 'Apache-2.0') {
      for (const dependencyName of [
        ...Object.keys(pkg.pkg.dependencies ?? {}),
        ...Object.keys(pkg.pkg.optionalDependencies ?? {}),
      ]) {
        const dependency = packagesByName.get(dependencyName);
        if (dependency?.pkg.license === 'UNLICENSED') {
          failures.push(
            `Apache-2.0 package ${pkg.rel} must not ship UNLICENSED dependency ${dependencyName}`,
          );
        }
      }
    }
    if (
      pkg.pkg.name === '@noodle-borg/module' &&
      Object.keys(pkg.pkg.dependencies ?? {}).length > 0
    ) {
      failures.push(`${pkg.rel}/package.json: @noodle-borg/module must stay zero-dependency`);
    }
    if (pkg.pkg.name?.startsWith('@noodle-borg/module-')) {
      const deps = dependencySet(pkg.pkg, true);
      for (const forbidden of ['@noodle-borg/service', '@noodleseed/one']) {
        if (deps.has(forbidden))
          failures.push(`${pkg.rel}/package.json: module packages must not depend on ${forbidden}`);
      }
    }
    if (commercialCarveoutPackages.has(pkg.pkg.name)) {
      const deps = declaredDependencySet(pkg.pkg);
      for (const forbidden of ['@noodle-borg/service', '@noodleseed/one']) {
        if (deps.has(forbidden)) {
          failures.push(`commercial carve-out package ${pkg.rel} must not depend on ${forbidden}`);
        }
      }
    }
    const allowedServiceConsumer =
      ['@noodle-borg/service', '@noodleseed/one'].includes(pkg.pkg.name) ||
      (pkg.pkg.name === '@noodle-borg/cloud-service' && pkg.rel === 'apps/cloud-service') ||
      (pkg.pkg.name === '@noodle-borg/self-host' && pkg.rel === 'apps/self-host');
    const allowedServiceDevDependency =
      pkg.pkg.devDependencies?.['@noodle-borg/service'] !== undefined &&
      !nonDevDependencySet(pkg.pkg).has('@noodle-borg/service') &&
      config.allowServiceDevDependencies.some((entry) => entry.path === pkg.rel);
    if (
      !allowedServiceConsumer &&
      !allowedServiceDevDependency &&
      declaredDependencySet(pkg.pkg).has('@noodle-borg/service')
    ) {
      failures.push(
        `${pkg.rel}/package.json: only the CLI, cloud-service, and self-host compositions may depend on @noodle-borg/service`,
      );
    }
    // ADR 0203 rule 3: commercial-vendor SDKs inside an open-source package are the mechanical tell
    // that the package has absorbed commercial scope. There are no exemptions: UNLICENSED packages
    // are not checked, and an Apache-2.0 package that needs one has absorbed scope to carve out.
    if (pkg.pkg.license === 'Apache-2.0') {
      for (const dependencyName of dependencySet(pkg.pkg, false)) {
        if (!matchesAny(dependencyName, config.scopes.commercialVendorDependencies)) continue;
        failures.push(
          `Apache-2.0 package ${pkg.rel} must not depend on commercial vendor SDK ${dependencyName}`,
        );
      }
    }
  }

  const tracked = trackedFiles(root);
  // ADR 0203: engine source that reaches into a commercial cluster is an edge the carve-out must
  // sever. Pins ratchet down only, so ordinary feature work routes around the seam by default
  // instead of deepening it and leaving the extraction to pay later.
  const seamEdges = new Map(config.carveOutSeams.map((seam) => [seam.name, 0]));
  // Shared tooling (vitest, typescript, biome) is a root devDependency in this pnpm
  // workspace rather than repeated per package, so test files may rely on it.
  const rootPackageFile = path.join(root, 'package.json');
  const rootDevDependencies = existsSync(rootPackageFile)
    ? Object.keys(readJson(rootPackageFile).devDependencies ?? {})
    : [];
  const metrics = [];
  for (const pkg of packages) {
    for (const file of collectFiles(pkg.root)) {
      checked += 1;
      const rel = normalizeRel(path.relative(root, file));
      const text = readFileSync(file, 'utf8');
      if (countedSource(rel) && (tracked === undefined || tracked.has(rel))) {
        metrics.push(sourceMetric(rel, text));
      }
      // A published tarball installs `dependencies` only, so anything reachable from shipped
      // source must be declared by the package that ships it — otherwise the break surfaces in
      // a customer's install rather than in CI. `packages/**` are the publishable units; apps
      // are deployed, not published, and carry framework path aliases and virtual modules.
      if (pkg.rel.startsWith('packages/') && !isConfigFile(rel)) {
        const declared = new Set([
          ...Object.keys(pkg.pkg.dependencies ?? {}),
          ...Object.keys(pkg.pkg.peerDependencies ?? {}),
          ...(canUseDevDependencies(rel)
            ? [...Object.keys(pkg.pkg.devDependencies ?? {}), ...rootDevDependencies]
            : []),
        ]);
        for (const specifier of importedSpecifiers(withoutTemplateLiterals(text))) {
          const externalName = externalPackageName(specifier, BUILTIN_MODULES);
          if (externalName === undefined) continue;
          if (externalName === pkg.pkg.name) continue;
          if (workspaceNames.has(externalName)) continue; // the workspace rule below owns these
          if (declared.has(externalName)) continue;
          if (matchesUndeclaredAllow(config, rel, externalName)) continue;
          failures.push(
            `${rel}: imports ${externalName} but ${pkg.rel}/package.json does not declare it ` +
              `(a published tarball installs dependencies only)`,
          );
        }
      }
      for (const specifier of importedSpecifiers(text)) {
        const workspaceName = workspaceImportName(specifier);
        if (workspaceName !== undefined && workspaceNames.has(workspaceName)) {
          const deps = dependencySet(pkg.pkg, canUseDevDependencies(rel));
          if (workspaceName !== pkg.pkg.name && !deps.has(workspaceName)) {
            failures.push(
              `${rel}: imports ${workspaceName} but ${pkg.rel}/package.json does not declare it`,
            );
          }
        }

        const resolved = resolveRelativeImport(file, specifier);
        if (resolved === undefined) continue;
        const resolvedRel = normalizeRel(path.relative(root, resolved));
        if (!isTestFile(rel)) {
          for (const seam of config.carveOutSeams) {
            // Intra-cluster imports are free — the cluster moves as one unit. Only source reaching
            // *into* it from outside is an edge someone has to sever later.
            if (seam.package !== pkg.rel) continue;
            if (matchesAny(rel, seamClusters(seam))) continue;
            if (!matchesAny(resolvedRel, seamClusters(seam))) continue;
            seamEdges.set(seam.name, (seamEdges.get(seam.name) ?? 0) + 1);
          }
        }
        const owner = findOwningPackage(packages, resolved);
        if (owner === undefined || owner.root === pkg.root) continue;
        // Any relative import that lands in another package is a boundary crossing, whether the
        // target is shipped source, a test helper, or an app module; only allowlisted test-only
        // crossings pass. Package public exports are the supported path.
        const targetRel = normalizeRel(path.relative(root, resolved));
        if (!isTestFile(rel) || !matchesAllow(config, rel, targetRel)) {
          failures.push(`${rel}: cross-package source import ${targetRel} is not allowed`);
        }
      }
    }
  }

  const baseline = options.base ? readScopeBaseline(root, options.base) : undefined;
  const report = evaluatePackageScopes({
    scopes: config.scopes,
    packages,
    metrics,
    baseline,
    config: config.raw,
  });
  failures.push(...report.errors, ...(await checkProjectedQualityConfig(root)));

  for (const seam of config.carveOutSeams) {
    const edges = seamEdges.get(seam.name) ?? 0;
    if (edges > seam.maxEdges) {
      failures.push(
        `carve-out seam ${seam.name}: ${edges} engine imports exceeds its pin of ${seam.maxEdges}; pins ratchet down only — route it through the module seam (@noodle-borg/module) or put the new code inside the cluster`,
      );
    }
  }

  report.errors = failures;
  report.checkedFiles = checked;
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = failures.length ? 1 : 0;
    return;
  }
  for (const warning of report.warnings) console.warn(`package-boundary-gate warning: ${warning}`);
  if (baseline) {
    for (const row of report.packages.filter((entry) => entry.delta !== 0))
      console.log(
        `scope ${row.path}: ${row.delta >= 0 ? '+' : ''}${row.delta} lines, ${row.headroom} remaining`,
      );
    for (const edge of report.addedDependencyEdges)
      console.log(`new ${edge.kind} edge: ${edge.from} -> ${edge.to}`);
  }
  if (failures.length) {
    console.error(`package-boundary-gate failed with ${failures.length} issue(s):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(`package-boundary-gate ok (${checked} files checked, ${packages.length} packages)`);
}

try {
  await run();
} catch (error) {
  console.error(
    `package-boundary-gate failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(2);
}
