import { createHash } from 'node:crypto';
import {
  resolveHostPackageAssets,
  validDistributionImageReference,
  validDistributionScreenshotReference,
} from './host-package-assets.js';
import { HOST_PACKAGING_LIMITS } from './host-packaging-limits.js';
import type {
  HostDistributionMetadataV1,
  HostPackageAdapterInput,
  HostPackageFile,
  HostPackageFileRole,
  HostPackageIssue,
  HostPackageRequest,
  RenderedHostPackageFile,
} from './host-packaging-types.js';
import {
  ProductSkillRenderError,
  sensitiveContentFinding,
  validateProductSkillPackageInput,
} from './product-skill-validation.js';

const TARGET_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/;
const FILE_ROLES = new Set<HostPackageFileRole>([
  'manifest',
  'mcp',
  'skill',
  'branding',
  'legal',
  'documentation',
  'test',
]);

export { HOST_PACKAGING_LIMITS } from './host-packaging-limits.js';

export interface ValidatedHostPackageInput {
  readonly input?: HostPackageAdapterInput;
  readonly issues: readonly HostPackageIssue[];
}

export function validateHostPackageRequest(
  request: HostPackageRequest,
  target: string,
): ValidatedHostPackageInput {
  const issues: HostPackageIssue[] = [];
  if (!isRecord(request)) {
    issues.push(
      issue(target, 'host_package_invalid_request', '', 'Host package input is invalid.'),
    );
    return { issues };
  }

  try {
    validateProductSkillPackageInput(request.appPackage);
  } catch (error) {
    const code =
      error instanceof ProductSkillRenderError && error.code === 'app_package_sensitive_content'
        ? 'host_package_sensitive_content'
        : 'host_package_app_package_invalid';
    const message =
      code === 'host_package_sensitive_content'
        ? 'Host package input contains credential-shaped content.'
        : 'The canonical App Package is invalid.';
    issues.push(issue(target, code, 'appPackage', message));
  }

  if (!validDistributionMetadata(request.distribution)) {
    issues.push(
      issue(
        target,
        'host_package_invalid_metadata',
        'distribution',
        'Distribution metadata is invalid or exceeds a framework limit.',
      ),
    );
  } else {
    const sensitive = sensitiveContentFinding(request.distribution);
    if (sensitive !== undefined) {
      issues.push(
        issue(
          target,
          sensitive === 'sensitive'
            ? 'host_package_sensitive_content'
            : 'host_package_invalid_metadata',
          'distribution',
          sensitive === 'sensitive'
            ? 'Distribution metadata contains credential-shaped content.'
            : 'Distribution metadata exceeds the safe scan limit.',
        ),
      );
    }
  }

  const normalizedMcpUrl = validateMcpServer(request.mcpServer);
  if (normalizedMcpUrl === undefined) {
    issues.push(
      issue(
        target,
        'host_package_invalid_mcp_url',
        'mcpServer.url',
        'The MCP endpoint must be HTTPS, or loopback HTTP, without credentials, query, or fragment.',
      ),
    );
  }

  const resolvedAssets = validDistributionMetadata(request.distribution)
    ? resolveHostPackageAssets(request.distribution, request.assets, target)
    : { issues: [] as readonly HostPackageIssue[] };
  issues.push(...resolvedAssets.issues);

  if (
    issues.some((candidate) => candidate.severity === 'error') ||
    normalizedMcpUrl === undefined ||
    resolvedAssets.assets === undefined
  ) {
    return { issues };
  }

  return {
    input: {
      appPackage: structuredClone(request.appPackage),
      distribution: structuredClone(request.distribution),
      mcpServer: { url: normalizedMcpUrl, transport: 'streamable-http' },
      assets: resolvedAssets.assets,
    },
    issues,
  };
}

export function validateRenderedHostPackageFiles(
  files: readonly HostPackageFile[],
  target: string,
): {
  readonly files?: readonly RenderedHostPackageFile[];
  readonly issues: readonly HostPackageIssue[];
} {
  const issues: HostPackageIssue[] = [];
  if (!Array.isArray(files) || files.length === 0 || files.length > HOST_PACKAGING_LIMITS.files) {
    issues.push(
      issue(
        target,
        'host_package_invalid_files',
        'files',
        'The adapter returned an invalid number of files.',
      ),
    );
    return { issues };
  }

  const seen = new Set<string>();
  const rendered: RenderedHostPackageFile[] = [];
  let totalBytes = 0;
  for (const candidate of files) {
    if (!isRecord(candidate) || !FILE_ROLES.has(candidate.role as HostPackageFileRole)) {
      issues.push(
        issue(
          target,
          'host_package_invalid_files',
          'files',
          'The adapter returned an invalid file.',
        ),
      );
      continue;
    }
    const path = candidate.path;
    if (typeof path !== 'string' || !safeRelativePath(path)) {
      issues.push(
        issue(
          target,
          'host_package_unsafe_path',
          'files.path',
          'The adapter returned an unsafe output path.',
        ),
      );
      continue;
    }
    if (seen.has(path)) {
      issues.push(
        issue(
          target,
          'host_package_duplicate_path',
          'files.path',
          'The adapter returned duplicate output paths.',
        ),
      );
      continue;
    }
    seen.add(path);

    const bytes = fileBytes(candidate.content);
    if (bytes === undefined || bytes.byteLength === 0) {
      issues.push(
        issue(
          target,
          'host_package_invalid_files',
          'files.content',
          'A generated file is empty or invalid.',
        ),
      );
      continue;
    }
    if (bytes.byteLength > HOST_PACKAGING_LIMITS.fileBytes) {
      issues.push(
        issue(
          target,
          'host_package_file_too_large',
          'files.content',
          'A generated file exceeds the per-file byte limit.',
        ),
      );
      continue;
    }
    totalBytes += bytes.byteLength;
    if (sensitiveContentFinding(new TextDecoder().decode(bytes)) !== undefined) {
      issues.push(
        issue(
          target,
          'host_package_sensitive_content',
          'files.content',
          'Generated output contains credential-shaped content.',
        ),
      );
      continue;
    }
    rendered.push({
      role: candidate.role as HostPackageFileRole,
      path,
      content: bytes,
      sha256: sha256(bytes),
      byteLength: bytes.byteLength,
    });
  }

  if (totalBytes > HOST_PACKAGING_LIMITS.totalFileBytes) {
    issues.push(
      issue(
        target,
        'host_package_total_too_large',
        'files',
        'Generated output exceeds the total byte limit.',
      ),
    );
  }
  if (issues.some((candidate) => candidate.severity === 'error')) return { issues };
  return { files: rendered.sort((left, right) => compareCodeUnits(left.path, right.path)), issues };
}

export function validAdapterIdentity(target: unknown, version: unknown): boolean {
  return (
    typeof target === 'string' &&
    target.length <= HOST_PACKAGING_LIMITS.identifierChars &&
    TARGET_PATTERN.test(target) &&
    boundedProse(version, HOST_PACKAGING_LIMITS.identifierChars)
  );
}

export function frameworkIssue(
  target: string,
  code: string,
  path: string,
  message: string,
): HostPackageIssue {
  return issue(target, code, path, message);
}

function validDistributionMetadata(value: unknown): value is HostDistributionMetadataV1 {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !hasOnlyKeys(value, [
      'schemaVersion',
      'listing',
      'publisher',
      'support',
      'legal',
      'assets',
      'review',
    ])
  )
    return false;
  if (!isRecord(value.listing) || !isRecord(value.publisher) || !isRecord(value.support))
    return false;
  if (!isRecord(value.legal) || !isRecord(value.assets) || !isRecord(value.review)) return false;
  if (
    !hasOnlyKeys(value.listing, ['summary', 'description', 'keywords']) ||
    !hasOnlyKeys(value.publisher, ['name', 'websiteUrl']) ||
    !hasOnlyKeys(value.support, ['documentationUrl', 'supportUrl']) ||
    !hasOnlyKeys(value.legal, ['privacyPolicyUrl', 'termsOfServiceUrl']) ||
    !hasOnlyKeys(value.assets, ['icon', 'logo', 'screenshots']) ||
    !hasOnlyKeys(value.review, ['instructions', 'scenarios'])
  )
    return false;
  if (!boundedProse(value.listing.summary, HOST_PACKAGING_LIMITS.summaryChars)) return false;
  if (!boundedProse(value.listing.description)) return false;
  if (
    value.listing.keywords !== undefined &&
    !boundedArray(value.listing.keywords, 0, HOST_PACKAGING_LIMITS.keywords, (keyword) =>
      boundedProse(keyword, HOST_PACKAGING_LIMITS.keywordChars),
    )
  )
    return false;
  if (!boundedProse(value.publisher.name) || !validHttpsUrl(value.publisher.websiteUrl))
    return false;
  if (!validHttpsUrl(value.support.documentationUrl) || !validHttpsUrl(value.support.supportUrl))
    return false;
  if (!validHttpsUrl(value.legal.privacyPolicyUrl)) return false;
  if (value.legal.termsOfServiceUrl !== undefined && !validHttpsUrl(value.legal.termsOfServiceUrl))
    return false;
  if (!validDistributionImageReference(value.assets.icon)) return false;
  if (value.assets.logo !== undefined && !validDistributionImageReference(value.assets.logo))
    return false;
  if (
    value.assets.screenshots !== undefined &&
    !boundedArray(
      value.assets.screenshots,
      0,
      HOST_PACKAGING_LIMITS.screenshots,
      validDistributionScreenshotReference,
    )
  )
    return false;
  if (!boundedProse(value.review.instructions)) return false;
  return boundedArray(value.review.scenarios, 1, HOST_PACKAGING_LIMITS.scenarios, (scenario) =>
    Boolean(
      isRecord(scenario) &&
        hasOnlyKeys(scenario, ['id', 'prompt', 'expected', 'shouldInvoke', 'tools']) &&
        validIdentifier(scenario.id) &&
        boundedProse(scenario.prompt) &&
        boundedProse(scenario.expected) &&
        (scenario.shouldInvoke === true
          ? validScenarioTools(scenario.tools)
          : scenario.shouldInvoke === false && scenario.tools === undefined),
    ),
  );
}

function validScenarioTools(value: unknown): boolean {
  if (value === undefined) return true;
  if (!boundedArray(value, 0, HOST_PACKAGING_LIMITS.scenarios, validIdentifier)) return false;
  return new Set(value).size === value.length;
}

function validateMcpServer(value: unknown): string | undefined {
  if (!isRecord(value) || value.transport !== 'streamable-http' || typeof value.url !== 'string')
    return undefined;
  try {
    const url = new URL(value.url);
    const loopback =
      url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== ''
    )
      return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function validHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
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

function fileBytes(value: unknown): Uint8Array | undefined {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  return value instanceof Uint8Array ? new Uint8Array(value) : undefined;
}

function validIdentifier(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length <= HOST_PACKAGING_LIMITS.identifierChars &&
    IDENTIFIER_PATTERN.test(value)
  );
}

function boundedProse(
  value: unknown,
  max: number = HOST_PACKAGING_LIMITS.proseChars,
): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function boundedArray(
  value: unknown,
  min: number,
  max: number,
  predicate: (entry: unknown) => boolean,
): value is readonly unknown[] {
  return (
    Array.isArray(value) && value.length >= min && value.length <= max && value.every(predicate)
  );
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
