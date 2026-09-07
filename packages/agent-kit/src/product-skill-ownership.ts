import { createHash } from 'node:crypto';
import type {
  ProductSkillPackageInput,
  RenderedProductSkillBundleV1,
  RenderedProductSkillFileV1,
} from '@noodle-borg/agent-packaging';
import type { AgentTarget } from './skill-registry.js';

const SHA256 = /^[a-f0-9]{64}$/;
const APP_NAME = /^[a-z0-9_]+$/;
const SIMPLE_SKILL_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_FALLBACK_SLUG = /^n-h[a-f0-9]{59}-n$/;
const MAX_BUNDLE_V1_SKILL_SLUG_CHARS = 64;
const BUNDLE_V1_FALLBACK_DIGEST_CHARS = 59;

export interface ProductSkillStateFile {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
}

/** Project-local ownership record for one rendered host target. */
export interface ProductSkillState {
  readonly schemaVersion: 2;
  readonly bundleSchemaVersion: 1;
  readonly target: AgentTarget;
  readonly app: { readonly name: string; readonly skillSlug: string };
  readonly packageSchemaVersion: '1';
  readonly rendererVersion: string;
  readonly sourceManifestSha256: string;
  readonly mcpSurfaceSha256: string;
  readonly bundleSha256: string;
  readonly files: readonly ProductSkillStateFile[];
}

export interface DecodedProductSkillState {
  readonly state: ProductSkillState;
  readonly migrationRequired: boolean;
}

export function createProductSkillState(input: {
  readonly target: AgentTarget;
  readonly artifact: ProductSkillPackageInput;
  readonly bundle: Pick<
    RenderedProductSkillBundleV1,
    'schemaVersion' | 'rendererVersion' | 'bundleSha256'
  >;
  readonly files: readonly RenderedProductSkillFileV1[];
}): ProductSkillState {
  return {
    schemaVersion: 2,
    bundleSchemaVersion: input.bundle.schemaVersion,
    target: input.target,
    app: { name: input.artifact.app.name, skillSlug: bundleV1SkillSlug(input.artifact.app.name) },
    packageSchemaVersion: input.artifact.schemaVersion,
    rendererVersion: input.bundle.rendererVersion,
    sourceManifestSha256: input.artifact.provenance.sourceManifestSha256,
    mcpSurfaceSha256: input.artifact.provenance.mcpSurfaceSha256,
    bundleSha256: input.bundle.bundleSha256,
    files: input.files.map(({ path, sha256, byteLength }) => ({ path, sha256, byteLength })),
  };
}

/** Decode V2 or normalize a valid V1 record into a migration-pending V2 value. */
export function decodeProductSkillState(
  value: unknown,
  target: AgentTarget,
): DecodedProductSkillState | undefined {
  if (!isRecord(value)) return undefined;
  const migrationRequired = value.schemaVersion === 1;
  const expectedKeys = [
    'schemaVersion',
    ...(migrationRequired ? [] : ['bundleSchemaVersion']),
    'target',
    'app',
    'packageSchemaVersion',
    'rendererVersion',
    'sourceManifestSha256',
    'mcpSurfaceSha256',
    'bundleSha256',
    'files',
  ];
  if (
    !hasExactKeys(value, expectedKeys) ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    (!migrationRequired && value.bundleSchemaVersion !== 1) ||
    value.target !== target ||
    value.packageSchemaVersion !== '1' ||
    typeof value.rendererVersion !== 'string' ||
    value.rendererVersion.trim() === '' ||
    !validDigest(value.sourceManifestSha256) ||
    !validDigest(value.mcpSurfaceSha256) ||
    !validDigest(value.bundleSha256) ||
    !isRecord(value.app) ||
    !hasExactKeys(value.app, ['name', 'skillSlug']) ||
    typeof value.app.name !== 'string' ||
    !APP_NAME.test(value.app.name) ||
    typeof value.app.skillSlug !== 'string' ||
    value.app.skillSlug !== bundleV1SkillSlug(value.app.name) ||
    !Array.isArray(value.files)
  ) {
    return undefined;
  }
  const files: ProductSkillStateFile[] = [];
  const paths = new Set<string>();
  for (const file of value.files) {
    if (
      !isRecord(file) ||
      !hasExactKeys(file, ['path', 'sha256', 'byteLength']) ||
      typeof file.path !== 'string' ||
      paths.has(file.path) ||
      !validDigest(file.sha256) ||
      typeof file.byteLength !== 'number' ||
      !Number.isSafeInteger(file.byteLength) ||
      file.byteLength < 0
    ) {
      return undefined;
    }
    paths.add(file.path);
    files.push({ path: file.path, sha256: file.sha256, byteLength: file.byteLength });
  }
  const expectedPaths = new Set(bundleV1TargetPaths(target, value.app.skillSlug));
  if (files.length !== expectedPaths.size || files.some((file) => !expectedPaths.has(file.path))) {
    return undefined;
  }
  return {
    migrationRequired,
    state: {
      schemaVersion: 2,
      bundleSchemaVersion: 1,
      target,
      app: { name: value.app.name, skillSlug: value.app.skillSlug },
      packageSchemaVersion: '1',
      rendererVersion: value.rendererVersion,
      sourceManifestSha256: value.sourceManifestSha256,
      mcpSurfaceSha256: value.mcpSurfaceSha256,
      bundleSha256: value.bundleSha256,
      files,
    },
  };
}

/** Ownership V2 is bound to the immutable bundle-schema-v1 host slug and two-file layout. */
function bundleV1SkillSlug(name: string): string {
  const simple = name.replaceAll('_', '-');
  if (
    SIMPLE_SKILL_SLUG.test(simple) &&
    simple.length <= MAX_BUNDLE_V1_SKILL_SLUG_CHARS &&
    !RESERVED_FALLBACK_SLUG.test(simple)
  ) {
    return simple;
  }
  const digest = createHash('sha256').update(name).digest('hex');
  return `n-h${digest.slice(0, BUNDLE_V1_FALLBACK_DIGEST_CHARS)}-n`;
}

function bundleV1TargetPaths(target: AgentTarget, slug: string): readonly string[] {
  const root = `${target === 'codex' ? '.agents' : '.claude'}/skills/${slug}`;
  return [`${root}/SKILL.md`, `${root}/references/mcp-surface.md`];
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
