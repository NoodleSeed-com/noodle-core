import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { ACCESS_MODES } from '@noodle-borg/wire-contracts';
import { type AccessMode, DEFAULT_SERVICE_URL, type OrgMembershipSource, slug } from './deploy.js';
import {
  type ProjectEntrypointResolution,
  type ProjectEntrypointValues,
  resolveConfiguredProjectEntrypoint,
  resolveConventionalEntrypoint,
  resolveProjectEntrypoint,
} from './project-entrypoint.js';
import { helloFiles, httpApiFiles } from './project-scaffold-templates.js';
import { widgetFiles } from './widget-scaffold-template.js';
export type InitTemplate = 'saas' | 'hello' | 'http-api' | 'widget';
export type ProjectAgentTarget = 'codex' | 'claude-code';
export interface ProjectLink {
  readonly entrypoint: string;
  readonly org: string;
  readonly app: string;
  readonly env: string;
  readonly serviceUrl: string;
  readonly accessMode: AccessMode;
}
export interface NoodleProjectConfig {
  readonly $schema?: string;
  readonly entrypoint?: string;
  readonly name?: string;
  readonly app?: string;
  readonly org?: string;
  readonly env?: string;
  readonly accessMode?: AccessMode;
  /** For `org-members`: which membership sources admit callers. Absent means every source (ADR 0183). */
  readonly orgMembershipSources?: readonly OrgMembershipSource[];
  readonly template?: InitTemplate;
  readonly agents?: readonly ('codex' | 'claude-code')[];
  readonly serviceUrl?: string;
}
export interface ProjectDeployment {
  readonly deploymentId: string;
  readonly serverVersion?: string;
  readonly url: string;
  readonly defaultUrl?: string;
  readonly org: string;
  readonly app: string;
  readonly env: string;
  readonly accessMode: AccessMode;
  readonly serviceUrl: string;
  readonly createdAt: string;
}
export {
  CONVENTIONAL_ENTRYPOINTS,
  type ProjectEntrypointResolution,
  resolveConventionalEntrypoint,
} from './project-entrypoint.js';
export interface InitProjectOptions {
  readonly dir?: string;
  readonly template?: InitTemplate;
  readonly name?: string;
  readonly force?: boolean;
  readonly agentTargets?: readonly ProjectAgentTarget[];
  /** Compute the reconcile plan without writing any files. */
  readonly dryRun?: boolean;
}
/**
 * Per-file outcome of an {@link initProject} reconcile:
 * - `created` — the file was absent and was written
 * - `unchanged` — the file already matched the template (no write)
 * - `skipped` — the file exists but differs; left untouched (pass `--force` to overwrite)
 * - `overwritten` — the file differed and `--force` replaced it with the template
 */
type InitFileAction = 'created' | 'unchanged' | 'skipped' | 'overwritten';
interface InitFileResult {
  readonly path: string;
  readonly action: InitFileAction;
}
export interface InitProjectResult {
  readonly dir: string;
  readonly files: readonly InitFileResult[];
}
export interface LinkProjectOptions {
  readonly entrypoint?: string;
  readonly org: string;
  readonly app: string;
  readonly env?: string;
  readonly serviceUrl?: string;
  readonly accessMode?: AccessMode;
  readonly cwd?: string;
  readonly save?: 'local' | 'project';
}
export function projectConfigPath(cwd: string = process.cwd()): string {
  return join(cwd, '.noodle', 'project.json');
}
export function noodleProjectConfigPath(cwd: string = process.cwd()): string {
  return join(cwd, 'noodle.json');
}
export function projectDeploymentPath(cwd: string = process.cwd()): string {
  return join(cwd, '.noodle', 'deployment.json');
}
export function readProjectLink(cwd: string = process.cwd()): ProjectLink | undefined {
  const resolved = readResolvedProjectConfig(cwd);
  if (
    resolved.entrypoint === undefined ||
    resolved.org === undefined ||
    resolved.app === undefined ||
    resolved.env === undefined ||
    resolved.serviceUrl === undefined ||
    resolved.accessMode === undefined
  ) {
    return undefined;
  }
  return {
    entrypoint: resolved.entrypoint,
    org: resolved.org,
    app: resolved.app,
    env: resolved.env,
    serviceUrl: resolved.serviceUrl,
    accessMode: resolved.accessMode,
  };
}
function readLocalProjectLink(cwd: string = process.cwd()): Partial<ProjectLink> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(projectConfigPath(cwd), 'utf8')) as Partial<ProjectLink>;
    return pickLocalProjectLink(parsed);
  } catch {
    return undefined;
  }
}
export function readNoodleProjectConfig(
  cwd: string = process.cwd(),
): NoodleProjectConfig | undefined {
  const path = noodleProjectConfigPath(cwd);
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  return validateNoodleProjectConfig(parsed);
}
export function readResolvedProjectConfig(cwd: string = process.cwd()): NoodleProjectConfig {
  const project = readNoodleProjectConfig(cwd) ?? {};
  const local = readLocalProjectLink(cwd) ?? {};
  const envAccessMode = isAccessMode(process.env.NOODLE_ACCESS_MODE)
    ? process.env.NOODLE_ACCESS_MODE
    : undefined;
  const entrypoint = process.env.NOODLE_ENTRYPOINT ?? local.entrypoint ?? project.entrypoint;
  const app = process.env.NOODLE_APP ?? local.app ?? project.app ?? project.name;
  const org = process.env.NOODLE_ORG ?? local.org ?? project.org;
  const env = process.env.NOODLE_ENV ?? local.env ?? project.env;
  const accessMode = envAccessMode ?? local.accessMode ?? project.accessMode;
  const serviceUrl = process.env.NOODLE_SERVICE_URL ?? local.serviceUrl ?? project.serviceUrl;
  return compactProjectConfig(
    Object.assign(
      {},
      project.$schema !== undefined ? { $schema: project.$schema } : {},
      entrypoint !== undefined ? { entrypoint } : {},
      project.name !== undefined ? { name: project.name } : {},
      app !== undefined ? { app } : {},
      org !== undefined ? { org } : {},
      env !== undefined ? { env } : {},
      accessMode !== undefined ? { accessMode } : {},
      project.orgMembershipSources !== undefined
        ? { orgMembershipSources: project.orgMembershipSources }
        : {},
      project.template !== undefined ? { template: project.template } : {},
      project.agents !== undefined ? { agents: project.agents } : {},
      serviceUrl !== undefined ? { serviceUrl } : {},
    ),
  );
}
export function writeProjectLink(options: LinkProjectOptions): ProjectLink {
  const cwd = options.cwd ?? process.cwd();
  const link: ProjectLink = {
    entrypoint:
      options.entrypoint ??
      readNoodleProjectConfig(cwd)?.entrypoint ??
      relativeEntrypoint(resolveConventionalEntrypoint(cwd) ?? 'server.ts', cwd),
    org: slug(options.org),
    app: slug(options.app),
    env: slug(options.env ?? 'prod'),
    serviceUrl: options.serviceUrl ?? DEFAULT_SERVICE_URL,
    accessMode: options.accessMode ?? 'owner-only',
  };
  if (options.save === 'project') {
    writeNoodleProjectConfig(cwd, {
      ...readNoodleProjectConfig(cwd),
      entrypoint: link.entrypoint,
      org: link.org,
      app: link.app,
      env: link.env,
      serviceUrl: link.serviceUrl,
      accessMode: link.accessMode,
    });
    return link;
  }
  const dir = join(cwd, '.noodle');
  mkdirSync(dir, { recursive: true });
  writeFileSync(projectConfigPath(cwd), `${JSON.stringify(link, null, 2)}\n`, { mode: 0o600 });
  return link;
}
export function writeNoodleProjectConfig(
  cwd: string,
  config: NoodleProjectConfig,
): NoodleProjectConfig {
  const clean = validateNoodleProjectConfig(
    compactProjectConfig(config) as Record<string, unknown>,
  );
  writeFileSync(noodleProjectConfigPath(cwd), `${JSON.stringify(clean, null, 2)}\n`);
  return clean;
}
export function readProjectDeployment(cwd: string = process.cwd()): ProjectDeployment | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(projectDeploymentPath(cwd), 'utf8'),
    ) as Partial<ProjectDeployment>;
    if (
      typeof parsed.deploymentId !== 'string' ||
      typeof parsed.url !== 'string' ||
      typeof parsed.org !== 'string' ||
      typeof parsed.app !== 'string' ||
      typeof parsed.env !== 'string' ||
      typeof parsed.serviceUrl !== 'string' ||
      typeof parsed.createdAt !== 'string' ||
      !isAccessMode(parsed.accessMode)
    ) {
      return undefined;
    }
    return {
      deploymentId: parsed.deploymentId,
      ...(typeof parsed.serverVersion === 'string' ? { serverVersion: parsed.serverVersion } : {}),
      url: parsed.url,
      ...(typeof parsed.defaultUrl === 'string' ? { defaultUrl: parsed.defaultUrl } : {}),
      org: parsed.org,
      app: parsed.app,
      env: parsed.env,
      accessMode: parsed.accessMode,
      serviceUrl: parsed.serviceUrl,
      createdAt: parsed.createdAt,
    };
  } catch {
    return undefined;
  }
}
export function writeProjectDeployment(
  deployment: ProjectDeployment,
  cwd: string = process.cwd(),
): ProjectDeployment {
  const dir = join(cwd, '.noodle');
  mkdirSync(dir, { recursive: true });
  const path = projectDeploymentPath(cwd);
  writeFileSync(path, `${JSON.stringify(deployment, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return deployment;
}
/**
 * Scaffold (or reconcile) a Noodle project. The reconcile is idempotent and safe to re-run: missing
 * template files are created, identical files are left as `unchanged`, and user-modified files are
 * `skipped` (preserved) unless `--force` overwrites them. This is what lets humans and coding agents
 * re-run `noodle init` to assert a baseline without clobbering edits.
 */
export function initProject(options: InitProjectOptions = {}): InitProjectResult {
  const dir = resolve(options.dir ?? '.');
  // A bare init creates the comprehensive app. Re-running a project keeps its recorded template so
  // changing the product default never expands an existing minimal/API project unexpectedly.
  const template = options.template ?? readNoodleProjectConfig(dir)?.template ?? 'saas';
  const name = slug(options.name ?? basename(dir) ?? 'noodle-app');
  if (!isTemplate(template))
    throw new Error('init: --template must be saas, hello, http-api, or widget');
  const files =
    template === 'saas'
      ? widgetFiles(name, options.agentTargets ?? ['codex', 'claude-code'], 'saas')
      : template === 'hello'
        ? helloFiles(name, options.agentTargets ?? ['codex', 'claude-code'])
        : template === 'http-api'
          ? httpApiFiles(name, options.agentTargets ?? ['codex', 'claude-code'])
          : widgetFiles(name, options.agentTargets ?? ['codex', 'claude-code']);
  return writeProjectScaffold(options, files);
}

/** One customer-file reconcile path for built-in starters and generated imports. */
export function writeProjectScaffold(
  options: Pick<InitProjectOptions, 'dir' | 'force' | 'dryRun'>,
  files: Readonly<Record<string, string>>,
): InitProjectResult {
  const dir = resolve(options.dir ?? '.');
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new Error('init: target path is not a directory');
    const entries = readdirSync(dir).filter((entry) => entry !== '.DS_Store');
    // A non-empty directory that is NOT already a Noodle project is treated as someone else's work:
    // refuse unless --force. An existing Noodle project reconciles silently (no --force needed).
    if (entries.length > 0 && !isNoodleProject(dir) && options.force !== true) {
      throw new Error(
        'init: target directory is not empty; pass --force to add Noodle files anyway',
      );
    }
  }
  const results: InitFileResult[] = [];
  // Check the whole write set before changing anything. A customer symlink is not permission to
  // read or overwrite its destination, including when an explicit --force applies to this project.
  for (const path of Object.keys(files)) assertScaffoldPath(dir, path);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    const action = reconcileFileAction(full, content, options.force === true);
    if (!options.dryRun && (action === 'created' || action === 'overwritten')) {
      mkdirSync(dirname(full), { recursive: true });
      const descriptor = openSync(
        full,
        constants.O_WRONLY |
          constants.O_NOFOLLOW |
          (action === 'created' ? constants.O_CREAT | constants.O_EXCL : constants.O_TRUNC),
      );
      try {
        writeFileSync(descriptor, content);
      } finally {
        closeSync(descriptor);
      }
    }
    results.push({ path, action });
  }
  return { dir, files: results };
}

function assertScaffoldPath(project: string, path: string): void {
  let current = project;
  for (const part of path.split('/')) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new Error(
          'init: scaffold paths must not traverse a symbolic link; preserve the link and choose a separate project directory.',
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
/**
 * A directory is an existing Noodle project if it has a `.noodle/` dir, a conventional entrypoint, or a
 * `package.json` that references `@noodleseed/one` (so a reconcile still recognizes the project even if the
 * entrypoint was deleted). Unrelated non-Noodle directories are not
 * matched, so `init` still refuses them.
 */
function isNoodleProject(dir: string): boolean {
  if (existsSync(noodleProjectConfigPath(dir))) return true;
  if (existsSync(join(dir, '.noodle'))) return true;
  if (resolveConventionalEntrypoint(dir) !== undefined) return true;
  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      return readFileSync(pkgPath, 'utf8').includes('@noodleseed/one');
    } catch {
      return false;
    }
  }
  return false;
}
function reconcileFileAction(full: string, content: string, force: boolean): InitFileAction {
  if (!existsSync(full)) return 'created';
  if (readFileSync(full, 'utf8') === content) return 'unchanged';
  return force ? 'overwritten' : 'skipped';
}
export function resolveLinkedEntrypoint(cwd: string = process.cwd()): string | undefined {
  const result = resolveConfiguredProjectEntrypoint(cwd, readProjectEntrypointValues(cwd));
  return result?.exists ? result.path : undefined;
}
/**
 * The entrypoint a local author-loop command (`dev`, `validate`, `test`, `tools`/`resources`/`prompts`)
 * should run when none is passed explicitly: the linked entrypoint if the directory is linked, otherwise
 * a conventional `src/server.ts`/`server.ts`/`manifest.ts`/`index.ts`. No account, login, or `link` is
 * required.
 */
export function resolveLocalEntrypoint(cwd: string = process.cwd()): string | undefined {
  const result = resolveLocalEntrypointResult(cwd);
  return result?.exists ? result.path : undefined;
}
export function resolveLocalEntrypointResult(
  cwd: string = process.cwd(),
): ProjectEntrypointResolution | undefined {
  return resolveProjectEntrypoint(cwd, readProjectEntrypointValues(cwd));
}
export function relativeEntrypoint(path: string, cwd: string = process.cwd()): string {
  const rel = relative(cwd, resolve(cwd, path));
  return rel === '' ? basename(path) : rel;
}
function readProjectEntrypointValues(cwd: string): ProjectEntrypointValues {
  const project = readNoodleProjectConfig(cwd);
  const local = readLocalProjectLink(cwd);
  return {
    ...(process.env.NOODLE_ENTRYPOINT === undefined
      ? {}
      : { environment: process.env.NOODLE_ENTRYPOINT }),
    ...(local?.entrypoint === undefined ? {} : { local: local.entrypoint }),
    ...(project?.entrypoint === undefined ? {} : { project: project.entrypoint }),
  };
}
function validateNoodleProjectConfig(parsed: Record<string, unknown>): NoodleProjectConfig {
  const allowed = new Set([
    '$schema',
    'entrypoint',
    'name',
    'app',
    'org',
    'env',
    'accessMode',
    'orgMembershipSources',
    'template',
    'agents',
    'serviceUrl',
  ]);
  for (const key of Object.keys(parsed)) {
    if (secretLikeKey(key)) throw new Error(`noodle.json contains secret-like key: ${key}`);
    if (!allowed.has(key)) throw new Error(`noodle.json contains unknown key: ${key}`);
  }
  const config: NoodleProjectConfig = {};
  if (parsed.$schema !== undefined) {
    if (typeof parsed.$schema !== 'string') throw new Error('noodle.json $schema must be a string');
    Object.assign(config, { $schema: parsed.$schema });
  }
  for (const key of ['entrypoint', 'name', 'app', 'org', 'env', 'serviceUrl'] as const) {
    const value = parsed[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new Error(`noodle.json ${key} must be a string`);
    Object.assign(config, { [key]: value });
  }
  if (parsed.accessMode !== undefined) {
    if (!isAccessMode(parsed.accessMode)) throw new Error('noodle.json accessMode is invalid');
    Object.assign(config, { accessMode: parsed.accessMode });
  }
  if (parsed.orgMembershipSources !== undefined) {
    const sources = parsed.orgMembershipSources;
    if (
      !Array.isArray(sources) ||
      sources.length === 0 ||
      !sources.every((s) => s === 'explicit' || s === 'domain')
    ) {
      throw new Error('noodle.json orgMembershipSources must list explicit and/or domain');
    }
    Object.assign(config, { orgMembershipSources: sources });
  }
  if (parsed.template !== undefined) {
    if (typeof parsed.template !== 'string' || !isTemplate(parsed.template)) {
      throw new Error('noodle.json template is invalid');
    }
    Object.assign(config, { template: parsed.template });
  }
  if (parsed.agents !== undefined) {
    if (
      !Array.isArray(parsed.agents) ||
      !parsed.agents.every((agent) => agent === 'codex' || agent === 'claude-code')
    ) {
      throw new Error('noodle.json agents must contain codex and/or claude-code');
    }
    Object.assign(config, { agents: parsed.agents });
  }
  return config;
}
function pickLocalProjectLink(parsed: Partial<ProjectLink>): Partial<ProjectLink> | undefined {
  const link: Partial<ProjectLink> = {};
  if (typeof parsed.entrypoint === 'string') Object.assign(link, { entrypoint: parsed.entrypoint });
  if (typeof parsed.org === 'string') Object.assign(link, { org: parsed.org });
  if (typeof parsed.app === 'string') Object.assign(link, { app: parsed.app });
  if (typeof parsed.env === 'string') Object.assign(link, { env: parsed.env });
  if (typeof parsed.serviceUrl === 'string') Object.assign(link, { serviceUrl: parsed.serviceUrl });
  if (isAccessMode(parsed.accessMode)) Object.assign(link, { accessMode: parsed.accessMode });
  return Object.keys(link).length > 0 ? link : undefined;
}
function compactProjectConfig(config: NoodleProjectConfig): NoodleProjectConfig {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) clean[key] = value;
  }
  return clean as NoodleProjectConfig;
}
function secretLikeKey(key: string): boolean {
  return /token|secret|password|refresh|caller/i.test(key);
}
function isTemplate(value: string): value is InitTemplate {
  return value === 'saas' || value === 'hello' || value === 'http-api' || value === 'widget';
}
function isAccessMode(value: unknown): value is AccessMode {
  return ACCESS_MODES.some((mode) => mode === value);
}
