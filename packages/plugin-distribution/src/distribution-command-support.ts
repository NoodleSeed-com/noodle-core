import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  HostDistributionMetadataV1,
  HostPackageAssetInput,
  HostPackageRequest,
} from '@noodle-borg/agent-packaging';

export interface DistributionCompileIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly didYouMean?: string;
  readonly suggestions?: readonly string[];
  readonly expected?: string;
  readonly got?: string;
  readonly docAnchor?: string;
}

type DistributionCompileOutcome =
  | {
      readonly ok: true;
      readonly rootDir: string;
      readonly distribution?: HostDistributionMetadataV1;
      readonly compiled: {
        readonly appPackage?: HostPackageRequest['appPackage'];
        readonly artifact?: {
          readonly server: {
            readonly handoff?: { readonly allowedDomains: readonly string[] };
          };
        };
      };
    }
  | { readonly ok: false; readonly errors: readonly DistributionCompileIssue[] };

export type DistributionCompiler = (options: {
  readonly manifestPath: string;
  readonly connectorsPath?: string;
}) => Promise<DistributionCompileOutcome>;

export type DistributionArchiveWriter = (outputPath: string, bytes: Uint8Array) => void;

export function writeDistributionArchiveAtomically(
  outputPath: string,
  bytes: Uint8Array,
  target: string,
): void {
  const absoluteOutput = resolve(outputPath);
  const temporaryPath = resolve(dirname(absoluteOutput), `.noodle-${target}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, bytes, { flag: 'wx' });
    renameSync(temporaryPath, absoluteOutput);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not have been created; cleanup is best-effort.
    }
    throw error;
  }
}

export function readDistributionAssets(
  distribution: HostDistributionMetadataV1,
  rootDir: string,
): readonly HostPackageAssetInput[] {
  const images = [
    distribution.assets.icon,
    ...(distribution.assets.logo === undefined ? [] : [distribution.assets.logo]),
    ...(distribution.assets.screenshots ?? []),
  ];
  const root = realpathSync(resolve(rootDir));
  const byKey = new Map<string, HostPackageAssetInput>();
  for (const image of images) {
    const sourcePath = normalizeAssetPath(image.source.sourcePath);
    if (sourcePath === undefined) throw new Error('unsafe distribution asset path');
    const absolutePath = realpathSync(resolve(root, sourcePath));
    const fromRoot = relative(root, absolutePath);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error('distribution asset escaped the project root');
    }
    if (!lstatSync(absolutePath).isFile()) throw new Error('distribution asset is not a file');
    const key = `${image.source.logicalId}\0${sourcePath}`;
    byKey.set(key, {
      logicalId: image.source.logicalId,
      sourcePath,
      content: readFileSync(absolutePath),
    });
  }
  return [...byKey.values()];
}

function normalizeAssetPath(value: string): string | undefined {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.includes('\0') ||
    normalized.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    return undefined;
  }
  return normalized;
}
