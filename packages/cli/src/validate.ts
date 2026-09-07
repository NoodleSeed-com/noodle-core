import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { manifestSchema, prepareLocalAssets } from '@noodle-borg/compiler';
import { delegatedTokenExchangeIdentityErrors } from '@noodle-borg/connector-defs';
import { compileLocalInput } from './local-compile.js';
import { noodleProjectConfigPath, readNoodleProjectConfig } from './project.js';

function normalizeIdentity(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Best-effort, non-blocking identity nudge. `noodle init` derives the server `name`, its `title`, and the
 * `noodle.json` project name from one project name, so a server `name` that disagrees with the project name
 * beyond kebab/snake/case normalization means the project was renamed (or a scaffold reused) without updating
 * the other half — the app reads inconsistently in MCP hosts. Walks up from the entrypoint directory to the
 * nearest `noodle.json`. Returns `undefined` when there is no readable project name, no server name, or they
 * agree; a malformed `noodle.json` is silently ignored (it is not this check's concern). Title is intentionally
 * not checked — a human-facing label legitimately differs from the package name.
 */
function identityCoherenceWarning(manifestJson: string, startDir: string): string | undefined {
  let serverName: unknown;
  try {
    serverName = (JSON.parse(manifestJson) as { server?: { name?: unknown } }).server?.name;
  } catch {
    return undefined;
  }
  if (typeof serverName !== 'string' || serverName.length === 0) return undefined;

  let dir = startDir;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(noodleProjectConfigPath(dir))) {
      let projectName: string | undefined;
      try {
        projectName = readNoodleProjectConfig(dir)?.name;
      } catch {
        return undefined;
      }
      if (projectName === undefined) return undefined;
      if (normalizeIdentity(projectName) === normalizeIdentity(serverName)) return undefined;
      return `app identity is inconsistent: server name '${serverName}' does not match the project name '${projectName}' in noodle.json — rename one so the app reads consistently in MCP hosts (\`noodle init\` derives both from the project name).`;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * A single author-time validation problem. A structural superset of both the compiler's {@link CompileError}
 * and the connector catalog's compile error, so manifest and connector failures print uniformly. The
 * generation-friendly hints (`didYouMean`/`suggestions`/`docAnchor`) appear only when the underlying error
 * offers them.
 */
export interface ValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly didYouMean?: string;
  readonly suggestions?: readonly string[];
  /** What the compiler expected (value/version/type/argument shape). */
  readonly expected?: string;
  /** What it actually saw (the offending type, value, or identifier). */
  readonly got?: string;
  readonly docAnchor?: string;
}

export interface ValidateOptions {
  readonly manifestPath: string;
  /** Optional declarative connector-catalog file; when present, operation references are resolved against it. */
  readonly connectorsPath?: string;
}

/**
 * A packaged asset the deploy would publish as a public, immutable web asset. Surfaced before upload
 * so authors can confirm what becomes publicly hosted — by project-relative path, not bucket/object key.
 */
interface PackagedAssetSummary {
  readonly sourcePath: string;
  readonly mimeType: string;
  readonly byteLength: number;
}

export type ValidateOutcome =
  | {
      readonly ok: true;
      readonly warnings?: readonly string[];
      /** Packaged assets that would become public web assets on deploy; omitted when none. */
      readonly assets?: readonly PackagedAssetSummary[];
    }
  | {
      readonly ok: false;
      /** Which stage rejected: reading the input, compiling connectors, or compiling the manifest. */
      readonly stage: 'read' | 'connectors' | 'manifest';
      readonly errors: readonly ValidationIssue[];
    };

/**
 * Is a compile/reload failure caused by *missing build dependencies* (e.g. React/Vite for a fresh,
 * un-`npm install`ed widget project) rather than an authoring mistake at a `path`? Such a failure is
 * repaired by installing deps, not by editing the manifest. Shared so every author-loop entry that boots
 * the local compiler — `validate --json` and `start --local` — surfaces the same `npm install` repair
 * instead of a dead-end "failed to compile". Structural over `ValidationIssue` and the `dev` reload error
 * shape (both carry `{ code, message }`).
 */
export function isMissingDependencyError(
  errors: ReadonlyArray<{ readonly code: string; readonly message: string }>,
): boolean {
  return errors.some(
    (error) => error.code === 'read_error' && /npm install|requires Vite/i.test(error.message),
  );
}

/**
 * Compile a manifest (and optional connector catalog) **locally**, exactly as the deploy service does
 * ({@link compile} with an {@link InMemoryCatalog} built from {@link compileConnectors}) — but without a
 * running service, network, or secrets. Returns `ok` or the structured errors the deploy plane would emit,
 * so an author gets instant, faithful feedback (schema shape, naming, expressions, and connector/operation
 * reference resolution with `didYouMean`). Secret-value binding is a deploy-time concern and is not checked
 * here. Pure: reads files and returns a result; never writes or exits.
 */
export async function validate(
  options: ValidateOptions,
  context: { readonly localDevtoolsCustomerIdentity?: boolean } = {},
): Promise<ValidateOutcome> {
  const local = await compileLocalInput(options);
  if (!local.ok) return local;
  const { compiled, manifest, rootDir, secretBindings } = local;
  const identityErrors = delegatedTokenExchangeIdentityErrors(
    secretBindings,
    compiled.artifact.server,
    context.localDevtoolsCustomerIdentity === true ? { localDevtoolsCustomerIdentity: true } : {},
  );
  if (identityErrors.length > 0) {
    return { ok: false, stage: 'manifest', errors: identityErrors };
  }
  const warnings = compiled.warnings?.map((w) => w.message) ?? [];
  const coherence = identityCoherenceWarning(manifest, rootDir);
  if (coherence !== undefined) warnings.push(coherence);
  const assets = listPackagedAssets(manifest, rootDir);
  return {
    ok: true,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(assets.length > 0 ? { assets } : {}),
  };
}

/**
 * Re-discover the packaged assets in a validated manifest as `{ sourcePath, mimeType, byteLength }`.
 * Runs only after a successful compile, so the files are already known to exist and validate; any
 * residual error is treated as "no disclosable assets" rather than failing validation.
 */
function listPackagedAssets(manifest: string, rootDir: string): readonly PackagedAssetSummary[] {
  let raw: unknown;
  try {
    raw = JSON.parse(manifest) as unknown;
  } catch {
    return [];
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) return [];
  const prepared = prepareLocalAssets(parsed.data, { rootDir });
  if (prepared.errors.length > 0) return [];
  return prepared.assets.map((asset) => ({
    sourcePath: asset.sourcePath,
    mimeType: asset.mimeType,
    byteLength: asset.byteLength,
  }));
}
