import { execFileSync } from 'node:child_process';

export const DEFAULT_PACKAGE_SCOPES = {
  defaultMaxSourceLines: 8000,
  warningRatio: 0.9,
  envelopes: [],
  commercialVendorDependencies: [],
};
const ROLES = new Set(['foundation', 'library', 'composition', 'retiring']);
const DEPENDENCY_KINDS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'devDependencies',
];
const SOURCE = /\.[cm]?[jt]sx?$/;
const OMIT =
  /\/(?:test|tests|dist|out|coverage|node_modules|noodle-publish|\.next|\.git|\.pnpm-store)\/|(?:^|[.-])(?:test|spec)\.[cm]?[jt]sx?$/;

export function countedSource(file) {
  return SOURCE.test(file) && !OMIT.test(file);
}

export function sourceMetric(file, text) {
  return { path: file, lines: (text.match(/\n/g) ?? []).length, bytes: Buffer.byteLength(text) };
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function relativeDirectory(value) {
  return (
    typeof value === 'string' &&
    /^[\w.-]+(?:\/[\w.-]+)*$/.test(value) &&
    !value.split('/').some((part) => part === '.' || part === '..')
  );
}

export function validatePackageScopes(scopes) {
  const errors = [];
  if ('pins' in scopes)
    errors.push('packageScopes.pins is obsolete; use fixed, reasoned envelopes (ADR 0203)');
  if (!positiveInteger(scopes.defaultMaxSourceLines))
    errors.push('defaultMaxSourceLines must be a positive integer');
  if (
    typeof scopes.warningRatio !== 'number' ||
    !(scopes.warningRatio > 0 && scopes.warningRatio < 1)
  )
    errors.push('warningRatio must be between zero and one');
  if (!Array.isArray(scopes.envelopes))
    return [...errors, 'packageScopes.envelopes must be an array'];
  const paths = new Set();
  for (const entry of scopes.envelopes) {
    if (!entry || !relativeDirectory(entry.path) || !/^(packages|apps)\/[^/]+$/.test(entry.path)) {
      errors.push('package-scope envelope must name one packages/<name> or apps/<name> directory');
      continue;
    }
    if (paths.has(entry.path)) errors.push(`duplicate package-scope envelope ${entry.path}`);
    paths.add(entry.path);
    if (!ROLES.has(entry.role)) errors.push(`${entry.path}: unknown package role`);
    if (!positiveInteger(entry.maxSourceLines))
      errors.push(`${entry.path}: maxSourceLines must be a positive integer`);
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 10)
      errors.push(`package-scope envelope ${entry.path} must include a reason`);
    if (!Array.isArray(entry.modules ?? [])) {
      errors.push(`${entry.path}: modules must be an array`);
      continue;
    }
    const modules = [];
    for (const module of entry.modules ?? []) {
      if (!module || !relativeDirectory(module.path)) {
        errors.push(`${entry.path}: module path must stay inside its package`);
        continue;
      }
      if (
        modules.some(
          (other) =>
            module.path === other ||
            module.path.startsWith(`${other}/`) ||
            other.startsWith(`${module.path}/`),
        )
      ) {
        errors.push(`${entry.path}: duplicate or overlapping module ${module.path}`);
      }
      modules.push(module.path);
      if (!positiveInteger(module.maxSourceLines))
        errors.push(`${entry.path}/${module.path}: maxSourceLines must be a positive integer`);
      if (typeof module.reason !== 'string' || module.reason.trim().length < 10)
        errors.push(`${entry.path}/${module.path}: module must include a reason`);
    }
  }
  return errors;
}

function git(root, args, input) {
  // Hooks export these variables; never read another repository's index or object database.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return execFileSync('git', args, {
    cwd: root,
    env,
    input,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Read Git objects as data only: no checkout, install, or execution of the base revision. */
export function readScopeBaseline(root, ref) {
  const sha = git(root, ['rev-parse', '--verify', `${ref}^{commit}`])
    .toString()
    .trim();
  const files = git(root, ['ls-tree', '-rz', '--name-only', sha])
    .toString()
    .split('\0')
    .filter(
      (file) =>
        file === 'quality-gates.config.json' ||
        /^(packages|apps)\/[^/]+\/package\.json$/.test(file) ||
        (/^(packages|apps)\/[^/]+\//.test(file) && countedSource(file)),
    );
  const bytes = git(
    root,
    ['cat-file', '--batch'],
    files.map((file) => `${sha}:${file}\n`).join(''),
  );
  const contents = new Map();
  let offset = 0;
  for (const file of files) {
    const end = bytes.indexOf(10, offset);
    const header = bytes.subarray(offset, end).toString();
    const size = Number(header.split(' ')[2]);
    if (!Number.isSafeInteger(size)) throw new Error(`cannot read scope baseline object: ${file}`);
    contents.set(file, bytes.subarray(end + 1, end + 1 + size).toString());
    offset = end + 1 + size + 1;
  }
  const packages = files
    .filter((file) => /^(packages|apps)\/[^/]+\/package\.json$/.test(file))
    .map((file) => ({
      rel: file.slice(0, -'/package.json'.length),
      pkg: JSON.parse(contents.get(file)),
    }));
  return {
    sha,
    packages,
    metrics: files.filter(countedSource).map((file) => sourceMetric(file, contents.get(file))),
    config: JSON.parse(contents.get('quality-gates.config.json') ?? '{}'),
  };
}

function dependencyEdges(packages) {
  const names = new Map(packages.map((pkg) => [pkg.pkg.name, pkg.rel]));
  return packages.flatMap((pkg) =>
    DEPENDENCY_KINDS.flatMap((kind) =>
      Object.keys(pkg.pkg[kind] ?? {})
        .filter((name) => names.has(name))
        .map((name) => ({ from: pkg.rel, to: names.get(name), kind })),
    ),
  );
}

function metric(path, metrics, maxSourceLines, warningRatio) {
  const files = metrics.filter((file) => file.path.startsWith(`${path}/`));
  const sourceLines = files.reduce((sum, file) => sum + file.lines, 0);
  return {
    path,
    sourceLines,
    sourceFiles: files.length,
    sourceBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    maxSourceLines,
    headroom: maxSourceLines - sourceLines,
    status:
      sourceLines > maxSourceLines
        ? 'over-budget'
        : sourceLines >= Math.ceil(maxSourceLines * warningRatio)
          ? 'warning'
          : 'ok',
  };
}

export function evaluatePackageScopes({ scopes, packages, metrics, baseline, config }) {
  const errors = [];
  const warnings = [];
  const rows = [];
  for (const entry of scopes.envelopes) {
    if (!packages.some((pkg) => pkg.rel === entry.path))
      errors.push(
        `package-scope envelope ${entry.path} matches no package; delete the stale envelope`,
      );
  }
  const assess = (row) => {
    if (row.status === 'over-budget')
      errors.push(
        `${row.path}: ${row.sourceLines} source lines exceeds the budget of ${row.maxSourceLines}; review responsibility seams or request a human-approved envelope change, never compress code or create a satellite to pass`,
      );
    else if (row.status === 'warning')
      warnings.push(
        `${row.path}: ${row.headroom} lines of fixed headroom remain (${row.sourceLines}/${row.maxSourceLines}); plan the next review before the ceiling`,
      );
  };
  for (const pkg of packages) {
    const envelope = scopes.envelopes.find((entry) => entry.path === pkg.rel);
    const row = {
      ...metric(
        pkg.rel,
        metrics,
        envelope?.maxSourceLines ?? scopes.defaultMaxSourceLines,
        scopes.warningRatio,
      ),
      role: envelope?.role ?? (pkg.rel.startsWith('apps/') ? 'composition' : 'library'),
    };
    row.modules = (envelope?.modules ?? []).map((module) =>
      metric(`${pkg.rel}/${module.path}`, metrics, module.maxSourceLines, scopes.warningRatio),
    );
    row.unassignedSourceLines =
      row.sourceLines - row.modules.reduce((sum, module) => sum + module.sourceLines, 0);
    assess(row);
    for (const module of row.modules) {
      if (!module.sourceFiles)
        errors.push(`${module.path}: module envelope matches no source; update its registration`);
      assess(module);
    }
    if (baseline) {
      const before = metric(pkg.rel, baseline.metrics, row.maxSourceLines, scopes.warningRatio);
      row.delta = row.sourceLines - before.sourceLines;
      if (row.role === 'retiring' && row.delta > 0)
        errors.push(
          `${pkg.rel}: retiring surface grew by ${row.delta} source lines; retiring envelopes may only shrink`,
        );
      for (const module of row.modules)
        module.delta =
          module.sourceLines -
          metric(module.path, baseline.metrics, module.maxSourceLines, scopes.warningRatio)
            .sourceLines;
    }
    rows.push(row);
  }
  const newPackages = baseline
    ? packages
        .filter((pkg) => !baseline.packages.some((old) => old.rel === pkg.rel))
        .map((pkg) => pkg.rel)
    : [];
  const edges = dependencyEdges(packages);
  const oldEdges = new Set(
    baseline ? dependencyEdges(baseline.packages).map((edge) => JSON.stringify(edge)) : [],
  );
  const addedDependencyEdges = baseline
    ? edges.filter((edge) => !oldEdges.has(JSON.stringify(edge)))
    : [];
  const policyChanged = baseline
    ? JSON.stringify(config) !== JSON.stringify(baseline.config)
    : false;
  if (newPackages.length)
    warnings.push(
      `New packages need human review of charter, real boundary, consumers, license and publication: ${newPackages.join(', ')}`,
    );
  if (policyChanged)
    warnings.push(
      'Quality policy changed: scope/ceiling increases and boundary relaxations require explicit human direction recorded in the PR; the gate cannot infer approval from a config edit.',
    );
  return {
    version: 1,
    base: baseline?.sha ?? null,
    packages: rows,
    newPackages,
    addedDependencyEdges,
    policyChanged,
    errors,
    warnings,
  };
}
