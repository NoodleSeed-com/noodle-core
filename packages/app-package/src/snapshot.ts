import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sha256Canonical } from './canonical.js';
import { appPackageArtifactV1Schema } from './schema.js';
import type { AppPackageArtifactV1 } from './types.js';

export const APP_PACKAGE_SNAPSHOT_V1_MAX_BYTES = 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

const appPackageRenderedFileV1Schema = z
  .object({
    target: z.enum(['codex', 'claude-code']),
    path: z.string().min(1),
    content: z.string().refine((value) => value.trim().length > 0),
    sha256: z.string().regex(SHA256),
    byteLength: z.number().int().nonnegative(),
  })
  .strict();

export type AppPackageRenderedFileV1 = z.output<typeof appPackageRenderedFileV1Schema>;

export interface AppPackageRenderedBundleV1 {
  readonly schemaVersion: 1;
  readonly rendererVersion: string;
  readonly files: readonly AppPackageRenderedFileV1[];
  readonly bundleSha256: string;
}

export type AppPackageRendererV1 = (input: AppPackageArtifactV1) => AppPackageRenderedBundleV1;

export type AppPackageRenderedFilesValidatorV1 = (
  artifact: AppPackageArtifactV1,
  files: readonly AppPackageRenderedFileV1[],
) => void;

const appPackageSnapshotV1Shape = z
  .object({
    schemaVersion: z.literal(1),
    artifact: appPackageArtifactV1Schema,
    rendererVersion: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => value.trim() === value),
    files: z.array(appPackageRenderedFileV1Schema).length(4),
    snapshotSha256: z.string().regex(SHA256),
  })
  .strict();

/** Strict persisted sibling schema, including content and metadata hash consistency. */
export const appPackageSnapshotV1Schema = appPackageSnapshotV1Shape.superRefine((snapshot, ctx) => {
  if (serializedBytes(snapshot) > APP_PACKAGE_SNAPSHOT_V1_MAX_BYTES) {
    ctx.addIssue({ code: 'custom', message: 'App Package snapshot exceeds 1 MiB' });
  }
  for (const [index, file] of snapshot.files.entries()) {
    if (file.byteLength !== Buffer.byteLength(file.content, 'utf8')) {
      ctx.addIssue({
        code: 'custom',
        path: ['files', index, 'byteLength'],
        message: 'rendered file byte length does not match its content',
      });
    }
    if (file.sha256 !== sha256Text(file.content)) {
      ctx.addIssue({
        code: 'custom',
        path: ['files', index, 'sha256'],
        message: 'rendered file digest does not match its content',
      });
    }
  }
  if (snapshot.snapshotSha256 !== snapshotSha256(snapshot)) {
    ctx.addIssue({
      code: 'custom',
      path: ['snapshotSha256'],
      message: 'snapshot digest does not match its artifact and rendered file metadata',
    });
  }
});

export type AppPackageSnapshotV1 = z.output<typeof appPackageSnapshotV1Schema>;

/** Stable, non-echoing failure for invalid App Package artifact or snapshot data. */
export class AppPackageValidationError extends Error {
  readonly code = 'app_package_invalid' as const;

  constructor() {
    super('App Package validation failed: app_package_invalid');
    this.name = 'AppPackageValidationError';
  }
}

/** Render, validate, and bind the exact deployment package bytes into an immutable snapshot. */
export function createAppPackageSnapshotV1(
  artifact: AppPackageArtifactV1,
  render: AppPackageRendererV1,
  validateFiles?: AppPackageRenderedFilesValidatorV1,
): AppPackageSnapshotV1 {
  const safeArtifact = deepFreeze(appPackageArtifactV1Schema.parse(artifact));
  const rendered = render(safeArtifact);
  if (!Array.isArray(rendered.files)) fail();
  const files = rendered.files.map((file) => Object.freeze({ ...file }));
  const expectedBundleSha256 = sha256Canonical({
    sourceManifestSha256: safeArtifact.provenance.sourceManifestSha256,
    mcpSurfaceSha256: safeArtifact.provenance.mcpSurfaceSha256,
    files: files.map(({ target, path, sha256 }) => ({ target, path, sha256 })),
  });
  if (
    rendered.schemaVersion !== 1 ||
    typeof rendered.bundleSha256 !== 'string' ||
    !SHA256.test(rendered.bundleSha256) ||
    rendered.bundleSha256 !== expectedBundleSha256 ||
    files.length !== 4
  ) {
    fail();
  }
  const candidate = {
    schemaVersion: 1,
    artifact: safeArtifact,
    rendererVersion: rendered.rendererVersion,
    files,
    snapshotSha256: sha256Canonical({
      artifact: safeArtifact,
      rendererVersion: rendered.rendererVersion,
      files: files.map(({ target, path, sha256, byteLength }) => ({
        target,
        path,
        sha256,
        byteLength,
      })),
    }),
  } as const;
  if (serializedBytes(candidate) > APP_PACKAGE_SNAPSHOT_V1_MAX_BYTES) fail();
  validateFiles?.(safeArtifact, files);
  const parsed = appPackageSnapshotV1Schema.safeParse(candidate);
  if (!parsed.success) fail();
  return deepFreeze(parsed.data);
}

/** Parse only a complete, internally consistent snapshot; malformed optional siblings disappear. */
export function parseAppPackageSnapshotV1(
  value: unknown,
  validateFiles?: AppPackageRenderedFilesValidatorV1,
): AppPackageSnapshotV1 | undefined {
  if (serializedBytes(value) > APP_PACKAGE_SNAPSHOT_V1_MAX_BYTES) return undefined;
  const parsed = appPackageSnapshotV1Schema.safeParse(value);
  if (!parsed.success) return undefined;
  try {
    validateFiles?.(parsed.data.artifact, parsed.data.files);
    return deepFreeze(parsed.data);
  } catch {
    return undefined;
  }
}

function snapshotSha256(snapshot: {
  readonly artifact: AppPackageArtifactV1;
  readonly rendererVersion: string;
  readonly files: readonly AppPackageRenderedFileV1[];
}): string {
  return sha256Canonical({
    artifact: snapshot.artifact,
    rendererVersion: snapshot.rendererVersion,
    files: snapshot.files.map(({ target, path, sha256, byteLength }) => ({
      target,
      path,
      sha256,
      byteLength,
    })),
  });
}

function serializedBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? Number.POSITIVE_INFINITY
      : Buffer.byteLength(serialized, 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) value.forEach(deepFreeze);
  else if (value !== null && typeof value === 'object') Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function fail(): never {
  throw new AppPackageValidationError();
}
