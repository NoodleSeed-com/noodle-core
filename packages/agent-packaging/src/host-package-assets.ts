import { createHash } from 'node:crypto';
import { HOST_PACKAGING_LIMITS } from './host-packaging-limits.js';
import type {
  HostDistributionImageV1,
  HostDistributionMetadataV1,
  HostDistributionScreenshotV1,
  HostPackageAdapterInput,
  HostPackageAssetInput,
  HostPackageIssue,
  ResolvedHostPackageImage,
} from './host-packaging-types.js';

const HEX_16 = /^[a-f0-9]{16}$/;

export function validDistributionImageReference(value: unknown): value is HostDistributionImageV1 {
  return validDistributionImage(value, false);
}

export function validDistributionScreenshotReference(
  value: unknown,
): value is HostDistributionScreenshotV1 {
  return validDistributionImage(value, true);
}

function validDistributionImage(value: unknown, allowPrompt: boolean): boolean {
  if (!isRecord(value) || !boundedProse(value.alt, HOST_PACKAGING_LIMITS.summaryChars))
    return false;
  if (!hasOnlyKeys(value, allowPrompt ? ['source', 'alt', 'prompt'] : ['source', 'alt']))
    return false;
  if (value.prompt !== undefined && !boundedProse(value.prompt, HOST_PACKAGING_LIMITS.summaryChars))
    return false;
  const source = value.source;
  if (!isRecord(source) || source.kind !== 'asset' || !HEX_16.test(String(source.logicalId)))
    return false;
  if (!hasOnlyKeys(source, ['kind', 'sourcePath', 'logicalId'])) return false;
  if (typeof source.sourcePath !== 'string') return false;
  const normalized = normalizeHostAssetPath(source.sourcePath);
  return normalized !== undefined && hostAssetLogicalId(normalized) === source.logicalId;
}

export function resolveHostPackageAssets(
  distribution: HostDistributionMetadataV1,
  inputs: readonly HostPackageAssetInput[],
  target: string,
): {
  readonly assets?: HostPackageAdapterInput['assets'];
  readonly issues: readonly HostPackageIssue[];
} {
  const issues: HostPackageIssue[] = [];
  if (!Array.isArray(inputs)) {
    return {
      issues: [
        issue(
          target,
          'host_package_asset_missing',
          'assets',
          'Required distribution assets are missing.',
        ),
      ],
    };
  }
  const references = [
    distribution.assets.icon,
    ...(distribution.assets.logo === undefined ? [] : [distribution.assets.logo]),
    ...(distribution.assets.screenshots ?? []),
  ];
  const referenceKeys = new Set<string>();
  for (const image of references) {
    const normalized = normalizeHostAssetPath(image.source.sourcePath);
    if (normalized === undefined) {
      return {
        issues: [
          issue(
            target,
            'host_package_invalid_metadata',
            'distribution.assets',
            'A distribution asset reference has an unsafe path.',
          ),
        ],
      };
    }
    referenceKeys.add(assetKey(image.source.logicalId, normalized));
  }
  if (referenceKeys.size !== references.length) {
    issues.push(
      issue(
        target,
        'host_package_invalid_metadata',
        'distribution.assets',
        'Distribution asset references must be unique.',
      ),
    );
  }

  const provided = new Map<string, HostPackageAssetInput>();
  let totalBytes = 0;
  for (const input of inputs) {
    if (
      !isRecord(input) ||
      typeof input.sourcePath !== 'string' ||
      typeof input.logicalId !== 'string'
    ) {
      issues.push(
        issue(
          target,
          'host_package_asset_unreferenced',
          'assets',
          'An unreferenced asset was provided.',
        ),
      );
      continue;
    }
    const normalized = normalizeHostAssetPath(input.sourcePath);
    const key = normalized === undefined ? '' : assetKey(input.logicalId, normalized);
    if (
      normalized === undefined ||
      !HEX_16.test(input.logicalId) ||
      hostAssetLogicalId(normalized) !== input.logicalId ||
      !(input.content instanceof Uint8Array)
    ) {
      issues.push(
        issue(
          target,
          'host_package_asset_unreferenced',
          'assets',
          'An unreferenced asset was provided.',
        ),
      );
      continue;
    }
    if (provided.has(key)) {
      issues.push(
        issue(
          target,
          'host_package_asset_unreferenced',
          'assets',
          'A duplicate asset was provided.',
        ),
      );
      continue;
    }
    provided.set(key, {
      logicalId: input.logicalId,
      sourcePath: input.sourcePath,
      content: input.content,
    });
    totalBytes += input.content.byteLength;
  }

  for (const key of referenceKeys) {
    if (!provided.has(key)) {
      issues.push(
        issue(
          target,
          'host_package_asset_missing',
          'assets',
          'A required distribution asset is missing.',
        ),
      );
    }
  }
  for (const key of provided.keys()) {
    if (!referenceKeys.has(key)) {
      issues.push(
        issue(
          target,
          'host_package_asset_unreferenced',
          'assets',
          'An unreferenced asset was provided.',
        ),
      );
    }
  }
  if (totalBytes > HOST_PACKAGING_LIMITS.totalAssetBytes) {
    issues.push(
      issue(
        target,
        'host_package_asset_invalid',
        'assets',
        'Distribution assets exceed the total byte limit.',
      ),
    );
  }

  const resolved = new Map<string, ResolvedHostPackageImage>();
  for (const image of references) {
    const normalized = normalizeHostAssetPath(image.source.sourcePath);
    if (normalized === undefined) {
      issues.push(
        issue(
          target,
          'host_package_invalid_metadata',
          'distribution.assets',
          'A distribution asset reference has an unsafe path.',
        ),
      );
      continue;
    }
    const key = assetKey(image.source.logicalId, normalized);
    const input = provided.get(key);
    if (input === undefined) continue;
    const dimensions = inspectImage(input.content);
    if (
      input.content.byteLength === 0 ||
      input.content.byteLength > HOST_PACKAGING_LIMITS.assetBytes ||
      dimensions === undefined ||
      dimensions.width > HOST_PACKAGING_LIMITS.imageDimension ||
      dimensions.height > HOST_PACKAGING_LIMITS.imageDimension
    ) {
      issues.push(
        issue(
          target,
          'host_package_asset_invalid',
          'assets',
          'A distribution asset is not a valid bounded image.',
        ),
      );
      continue;
    }
    const content = new Uint8Array(input.content);
    const prompt = 'prompt' in image && typeof image.prompt === 'string' ? image.prompt : undefined;
    resolved.set(key, {
      logicalId: input.logicalId,
      sourcePath: normalized,
      content,
      alt: image.alt,
      ...(prompt === undefined ? {} : { prompt }),
      mimeType: dimensions.mimeType,
      width: dimensions.width,
      height: dimensions.height,
      sha256: sha256(content),
    });
  }
  if (issues.some((candidate) => candidate.severity === 'error')) return { issues };

  const resolve = (image: HostDistributionImageV1): ResolvedHostPackageImage | undefined => {
    const normalized = normalizeHostAssetPath(image.source.sourcePath);
    return normalized === undefined
      ? undefined
      : resolved.get(assetKey(image.source.logicalId, normalized));
  };
  const icon = resolve(distribution.assets.icon);
  const logo =
    distribution.assets.logo === undefined ? undefined : resolve(distribution.assets.logo);
  const screenshots: ResolvedHostPackageImage[] = [];
  for (const image of distribution.assets.screenshots ?? []) {
    const screenshot = resolve(image);
    if (screenshot !== undefined) screenshots.push(screenshot);
  }
  if (
    icon === undefined ||
    (distribution.assets.logo !== undefined && logo === undefined) ||
    screenshots.length !== (distribution.assets.screenshots?.length ?? 0)
  ) {
    return {
      issues: [
        issue(
          target,
          'host_package_asset_missing',
          'assets',
          'A required distribution asset could not be resolved.',
        ),
      ],
    };
  }
  return {
    assets: {
      icon,
      ...(logo === undefined ? {} : { logo }),
      screenshots,
    },
    issues,
  };
}

function normalizeHostAssetPath(value: string): string | undefined {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\/+/, '');
  return safeRelativePath(normalized) ? normalized : undefined;
}

function inspectImage(bytes: Uint8Array):
  | {
      readonly mimeType: ResolvedHostPackageImage['mimeType'];
      readonly width: number;
      readonly height: number;
    }
  | undefined {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    buffer.length >= 24 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    buffer.toString('ascii', 12, 16) === 'IHDR'
  ) {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return width > 0 && height > 0 ? { mimeType: 'image/png', width, height } : undefined;
  }
  const jpeg = inspectJpeg(buffer);
  if (jpeg !== undefined) return { mimeType: 'image/jpeg', ...jpeg };
  const webp = inspectWebp(buffer);
  if (webp !== undefined) return { mimeType: 'image/webp', ...webp };
  return undefined;
}

function inspectJpeg(
  buffer: Buffer,
): { readonly width: number; readonly height: number } | undefined {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) return undefined;
    const marker = buffer[offset + 1];
    if (marker === undefined) return undefined;
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) return undefined;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    offset += 2 + length;
  }
  return undefined;
}

function inspectWebp(
  buffer: Buffer,
): { readonly width: number; readonly height: number } | undefined {
  if (
    buffer.length < 30 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WEBP'
  )
    return undefined;
  const kind = buffer.toString('ascii', 12, 16);
  if (kind === 'VP8X') {
    const width = 1 + buffer.readUIntLE(24, 3);
    const height = 1 + buffer.readUIntLE(27, 3);
    return { width, height };
  }
  return undefined;
}

function safeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= HOST_PACKAGING_LIMITS.pathChars &&
    !path.startsWith('/') &&
    !/^[A-Za-z]:/.test(path) &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function hostAssetLogicalId(sourcePath: string): string {
  return createHash('sha256').update(sourcePath).digest('hex').slice(0, 16);
}

function assetKey(logicalIdValue: string, sourcePath: string): string {
  return `${logicalIdValue}\0${sourcePath}`;
}

function boundedProse(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function issue(target: string, code: string, path: string, message: string): HostPackageIssue {
  return { severity: 'error', code, path, message, origin: 'framework', target };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
