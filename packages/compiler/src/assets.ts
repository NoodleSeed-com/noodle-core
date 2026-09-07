import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { CompileError } from './errors.js';
import type { Manifest } from './manifest/schema.js';
import { sniffImageBytes } from './mime-sniffing.js';

export interface PackagedAssetReference {
  readonly kind: 'asset';
  readonly sourcePath: string;
  readonly logicalId: string;
}

export interface LocalAssetOptions {
  readonly rootDir: string;
  readonly publicOrigin: string;
  readonly routePrefix?: string;
}

export interface PreparedPackagedAsset {
  readonly logicalId: string;
  readonly sourcePath: string;
  readonly absolutePath: string;
  readonly contentHash: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
}

export interface PackagedAsset extends PreparedPackagedAsset {
  readonly publicUrl: string;
  readonly objectKey?: string;
}

export interface HostedPackagedAsset {
  readonly logicalId: string;
  readonly sourcePath: string;
  readonly contentHash: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly publicUrl: string;
  readonly objectKey: string;
}

export interface HostedAssetOptions {
  readonly assets: readonly HostedPackagedAsset[];
  readonly assetOrigin?: string;
}

export interface AssetRewriteResult {
  readonly manifest: Manifest;
  readonly assets: readonly PackagedAsset[];
  readonly assetOrigin?: string;
  readonly errors: readonly CompileError[];
}

const ROUTE_PREFIX = '/__noodle/assets';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_DIMENSION = 4096;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export function assetReference(sourcePath: string): PackagedAssetReference {
  return {
    kind: 'asset',
    sourcePath,
    logicalId: logicalIdForSourcePath(normalizeSourcePathForId(sourcePath)),
  };
}

export function isPackagedAssetReference(value: unknown): value is PackagedAssetReference {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'asset' &&
    typeof (value as { sourcePath?: unknown }).sourcePath === 'string' &&
    typeof (value as { logicalId?: unknown }).logicalId === 'string'
  );
}

export function rewriteLocalAssets(
  manifest: Manifest,
  options: LocalAssetOptions | undefined,
): AssetRewriteResult {
  return rewriteAssets(manifest, options === undefined ? undefined : { kind: 'local', options });
}

export function rewriteHostedAssets(
  manifest: Manifest,
  options: HostedAssetOptions | undefined,
): AssetRewriteResult {
  return rewriteAssets(manifest, options === undefined ? undefined : { kind: 'hosted', options });
}

export function prepareLocalAssets(
  manifest: Manifest,
  options: Pick<LocalAssetOptions, 'rootDir'>,
): { readonly assets: readonly PreparedPackagedAsset[]; readonly errors: readonly CompileError[] } {
  const refs: Array<{ ref: PackagedAssetReference; path: string; role: string }> = [];
  collectManifestAssets(manifest, refs);
  const errors: CompileError[] = [];
  const assetsById = new Map<string, PreparedPackagedAsset>();
  for (const item of refs) {
    if (item.role === 'video') {
      errors.push({
        code: 'invalid_asset',
        path: item.path,
        message: 'packaged video assets are not supported until the P2 hosted video slice',
      });
      continue;
    }
    const asset = inspectAsset(item.ref, { rootDir: options.rootDir }, item.path, errors);
    if (asset) assetsById.set(asset.logicalId, asset);
  }
  const total = [...assetsById.values()].reduce((sum, asset) => sum + asset.byteLength, 0);
  if (total > MAX_TOTAL_BYTES) {
    errors.push({
      code: 'invalid_asset',
      path: 'assets',
      message: `packaged assets total ${total} bytes exceeds P0 limit ${MAX_TOTAL_BYTES} bytes`,
    });
  }
  return errors.length > 0
    ? { assets: [], errors }
    : { assets: [...assetsById.values()], errors: [] };
}

type AssetResolver =
  | { readonly kind: 'local'; readonly options: LocalAssetOptions }
  | { readonly kind: 'hosted'; readonly options: HostedAssetOptions };

function rewriteAssets(
  manifest: Manifest,
  resolver: AssetResolver | undefined,
): AssetRewriteResult {
  const refs: Array<{ ref: PackagedAssetReference; path: string; role: string }> = [];
  collectManifestAssets(manifest, refs);
  if (refs.length === 0) return { manifest, assets: [], errors: [] };
  if (resolver === undefined) {
    return {
      manifest,
      assets: [],
      errors: [
        {
          code: 'invalid_asset',
          path: refs[0]?.path ?? '',
          message: 'packaged assets require a local or hosted asset resolver',
        },
      ],
    };
  }

  const errors: CompileError[] = [];
  const assetsById = new Map<string, PackagedAsset>();
  for (const item of refs) {
    if (item.role === 'video') {
      errors.push({
        code: 'invalid_asset',
        path: item.path,
        message: 'packaged video assets are not supported until the P2 hosted video slice',
      });
      continue;
    }
    if (resolver.kind === 'local') {
      const asset = inspectAsset(item.ref, resolver.options, item.path, errors);
      if (asset) assetsById.set(asset.logicalId, localPublicAsset(asset, resolver.options));
    } else {
      const asset = resolveHostedAsset(item.ref, resolver.options, item.path, errors);
      if (asset) assetsById.set(asset.logicalId, asset);
    }
  }
  const total = [...assetsById.values()].reduce((sum, asset) => sum + asset.byteLength, 0);
  if (total > MAX_TOTAL_BYTES) {
    errors.push({
      code: 'invalid_asset',
      path: 'assets',
      message: `packaged assets total ${total} bytes exceeds P0 limit ${MAX_TOTAL_BYTES} bytes`,
    });
  }
  if (errors.length > 0) return { manifest, assets: [], errors };

  const rewritten = rewriteManifestAssetReferences(manifest, (ref) => {
    const asset = assetsById.get(ref.logicalId);
    return asset?.publicUrl ?? '';
  });
  const assetOrigin =
    resolver.kind === 'local'
      ? new URL(resolver.options.publicOrigin).origin
      : (resolver.options.assetOrigin ?? firstAssetOrigin([...assetsById.values()]));
  return {
    manifest: rewritten,
    assets: [...assetsById.values()],
    ...(assetOrigin !== undefined ? { assetOrigin } : {}),
    errors: [],
  };
}

export function localAssetRoutePrefix(options?: Pick<LocalAssetOptions, 'routePrefix'>): string {
  return options?.routePrefix ?? ROUTE_PREFIX;
}

function inspectAsset(
  ref: PackagedAssetReference,
  options: Pick<LocalAssetOptions, 'rootDir'>,
  path: string,
  errors: CompileError[],
): PreparedPackagedAsset | undefined {
  const normalized = normalizeSourcePath(ref.sourcePath);
  if (!normalized.ok) {
    errors.push({ code: 'invalid_asset', path, message: normalized.message });
    return undefined;
  }
  const root = realpathSync(resolve(options.rootDir));
  const candidate = resolve(root, normalized.path);
  let absolutePath: string;
  try {
    absolutePath = realpathSync(candidate);
  } catch {
    errors.push({
      code: 'invalid_asset',
      path,
      message: `asset file "${normalized.path}" does not exist`,
    });
    return undefined;
  }
  if (!isInside(root, absolutePath)) {
    errors.push({
      code: 'invalid_asset',
      path,
      message: `asset file "${normalized.path}" escapes the app root`,
    });
    return undefined;
  }
  const lst = lstatSync(candidate);
  if (!lst.isFile() && !statSync(candidate).isFile()) {
    errors.push({
      code: 'invalid_asset',
      path,
      message: `asset "${normalized.path}" is not a file`,
    });
    return undefined;
  }

  const ext = extname(normalized.path).toLowerCase();
  if (ext === '.svg') {
    errors.push({ code: 'invalid_asset', path, message: 'SVG assets are not supported in v1' });
    return undefined;
  }
  const expectedMime = MIME_BY_EXTENSION[ext];
  if (!expectedMime) {
    errors.push({
      code: 'invalid_asset',
      path,
      message: `unsupported asset extension "${ext || '(none)'}"`,
    });
    return undefined;
  }

  const bytes = readFileSync(absolutePath);
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    errors.push({
      code: 'invalid_asset',
      path,
      message: `asset "${normalized.path}" is ${bytes.byteLength} bytes; P0 limit is ${MAX_IMAGE_BYTES} bytes`,
    });
    return undefined;
  }
  const detected = sniffImageBytes(bytes);
  if (!detected || detected.mimeType !== expectedMime) {
    errors.push({
      code: 'invalid_asset',
      path,
      message: `asset "${normalized.path}" content does not match supported MIME ${expectedMime}`,
    });
    return undefined;
  }
  if (
    detected.width < 1 ||
    detected.height < 1 ||
    detected.width > MAX_DIMENSION ||
    detected.height > MAX_DIMENSION
  ) {
    errors.push({
      code: 'invalid_asset',
      path,
      message: `asset "${normalized.path}" dimensions ${detected.width}x${detected.height} exceed P0 limit ${MAX_DIMENSION}x${MAX_DIMENSION}`,
    });
    return undefined;
  }

  const contentHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const logicalId = logicalIdForSourcePath(normalized.path);
  return {
    logicalId,
    sourcePath: normalized.path,
    absolutePath,
    contentHash,
    mimeType: detected.mimeType,
    byteLength: bytes.byteLength,
    width: detected.width,
    height: detected.height,
  };
}

function localPublicAsset(asset: PreparedPackagedAsset, options: LocalAssetOptions): PackagedAsset {
  return {
    ...asset,
    publicUrl: `${new URL(options.publicOrigin).origin}${localAssetRoutePrefix(options)}/${asset.logicalId}/${asset.contentHash.slice('sha256:'.length, 'sha256:'.length + 16)}/${encodeURIComponent(basename(asset.sourcePath))}`,
  };
}

function resolveHostedAsset(
  ref: PackagedAssetReference,
  options: HostedAssetOptions,
  path: string,
  errors: CompileError[],
): PackagedAsset | undefined {
  const normalized = normalizeSourcePath(ref.sourcePath);
  if (!normalized.ok) {
    errors.push({ code: 'invalid_asset', path, message: normalized.message });
    return undefined;
  }
  const asset = options.assets.find(
    (candidate) =>
      candidate.logicalId === ref.logicalId && candidate.sourcePath === normalized.path,
  );
  if (asset === undefined) {
    errors.push({
      code: 'invalid_asset',
      path,
      message: `hosted asset metadata missing for "${normalized.path}"`,
    });
    return undefined;
  }
  if (!isAllowedHostedPublicUrl(asset.publicUrl)) {
    errors.push({
      code: 'invalid_asset',
      path,
      message: `hosted asset "${normalized.path}" must use an https public URL unless it is loopback-local`,
    });
    return undefined;
  }
  return { ...asset, absolutePath: '' };
}

function isAllowedHostedPublicUrl(value: string): boolean {
  const url = new URL(value);
  if (url.protocol === 'https:') return true;
  return (
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1')
  );
}

function firstAssetOrigin(assets: readonly PackagedAsset[]): string | undefined {
  const first = assets[0]?.publicUrl;
  return first === undefined ? undefined : new URL(first).origin;
}

function normalizeSourcePath(
  value: string,
): { ok: true; path: string } | { ok: false; message: string } {
  if (value.trim() === '') return { ok: false, message: 'asset path must be non-empty' };
  if (isAbsolute(value)) return { ok: false, message: 'asset path must be project-relative' };
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value))
    return { ok: false, message: 'asset path must not be a URL' };
  const normalized = value.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (normalized === '' || normalized.split('/').some((part) => part === '..' || part === '')) {
    return { ok: false, message: 'asset path must not contain empty segments or .. escapes' };
  }
  return { ok: true, path: normalized };
}

function normalizeSourcePathForId(value: string): string {
  const normalized = normalizeSourcePath(value);
  return normalized.ok ? normalized.path : value.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function logicalIdForSourcePath(sourcePath: string): string {
  return createHash('sha256').update(sourcePath).digest('hex').slice(0, 16);
}

function isInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return (
    rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..'))
  );
}

function collectManifestAssets(
  manifest: Manifest,
  out: Array<{ ref: PackagedAssetReference; path: string; role: string }>,
): void {
  for (const key of ['logo', 'mark', 'avatar'] as const) {
    const asset = manifest.server.branding?.[key];
    if (isPackagedAssetReference(asset?.uri)) {
      out.push({
        ref: asset.uri,
        path: `server.branding.${key}.uri`,
        role: `brand${key[0]?.toUpperCase()}${key.slice(1)}`,
      });
    }
    if (isPackagedAssetReference(asset?.darkUri)) {
      out.push({
        ref: asset.darkUri,
        path: `server.branding.${key}.darkUri`,
        role: `brand${key[0]?.toUpperCase()}${key.slice(1)}Dark`,
      });
    }
  }
}

function rewriteManifestAssetReferences<TManifest extends Manifest>(
  manifest: TManifest,
  urlFor: (ref: PackagedAssetReference) => string,
): TManifest {
  const branding = manifest.server.branding;
  const rewriteBrandAsset = (
    asset: NonNullable<typeof branding>['logo'],
  ): NonNullable<typeof branding>['logo'] => {
    if (!asset) return undefined;
    return {
      ...asset,
      uri: isPackagedAssetReference(asset.uri) ? urlFor(asset.uri) : asset.uri,
      ...(asset.darkUri
        ? {
            darkUri: isPackagedAssetReference(asset.darkUri)
              ? urlFor(asset.darkUri)
              : asset.darkUri,
          }
        : {}),
    };
  };
  return {
    ...manifest,
    server: {
      ...manifest.server,
      ...(branding
        ? {
            branding: {
              ...branding,
              ...(branding.logo ? { logo: rewriteBrandAsset(branding.logo) } : {}),
              ...(branding.mark ? { mark: rewriteBrandAsset(branding.mark) } : {}),
              ...(branding.avatar ? { avatar: rewriteBrandAsset(branding.avatar) } : {}),
            },
          }
        : {}),
    },
  } as TManifest;
}
