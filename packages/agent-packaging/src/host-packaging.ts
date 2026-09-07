import { createHash } from 'node:crypto';
import { deterministicZip } from './host-package-zip.js';
import type {
  HostPackageAdapter,
  HostPackageAdapterInput,
  HostPackageFile,
  HostPackageIssue,
  HostPackageRequest,
  HostPackageResult,
  HostPackageTargetIssue,
  RenderedHostPackageFile,
} from './host-packaging-types.js';
import {
  frameworkIssue,
  HOST_PACKAGING_LIMITS,
  validAdapterIdentity,
  validateHostPackageRequest,
  validateRenderedHostPackageFiles,
} from './host-packaging-validation.js';
import { sensitiveContentFinding } from './product-skill-validation.js';

const TARGET_ISSUE_CODE = /^[a-z][a-z0-9_]{2,99}$/;
const MAX_TARGET_ISSUES = 256;

export type * from './host-packaging-types.js';
export { HOST_PACKAGING_LIMITS } from './host-packaging-validation.js';

/**
 * Validate host-neutral package inputs, delegate only host-specific shaping, and return a reproducible ZIP.
 * The function is pure: callers resolve source assets and persist the returned bytes at their own boundary.
 */
export function packageHostTarget(
  request: HostPackageRequest,
  adapter: HostPackageAdapter,
): HostPackageResult {
  const adapterTarget =
    isRecord(adapter) && typeof adapter.target === 'string' ? adapter.target : '';
  const target = adapterTarget === '' ? 'invalid-target' : adapterTarget;
  const adapterVersion =
    isRecord(adapter) && typeof adapter.version === 'string' ? adapter.version : 'invalid-version';
  if (!validAdapterIdentity(adapterTarget, adapterVersion)) {
    return failure(target, adapterVersion, [
      frameworkIssue(
        target,
        'host_package_adapter_issue_invalid',
        'adapter',
        'The target adapter identity is invalid.',
      ),
    ]);
  }

  const validated = validateHostPackageRequest(request, target);
  if (validated.input === undefined) return failure(target, adapterVersion, validated.issues);

  let targetIssues: readonly HostPackageIssue[];
  try {
    targetIssues = normalizeTargetIssues(adapter.validate(cloneInput(validated.input)), target);
  } catch {
    return failure(target, adapterVersion, [
      ...validated.issues,
      frameworkIssue(
        target,
        'host_package_adapter_failed',
        'adapter.validate',
        'The target adapter failed while validating the package.',
      ),
    ]);
  }
  const issues = [...validated.issues, ...targetIssues];
  if (issues.some((candidate) => candidate.severity === 'error')) {
    return failure(target, adapterVersion, issues);
  }

  let candidateFiles: readonly HostPackageFile[];
  try {
    candidateFiles = adapter.render(cloneInput(validated.input));
  } catch {
    return failure(target, adapterVersion, [
      ...issues,
      frameworkIssue(
        target,
        'host_package_adapter_failed',
        'adapter.render',
        'The target adapter failed while rendering the package.',
      ),
    ]);
  }
  const rendered = validateRenderedHostPackageFiles(candidateFiles, target);
  const allIssues = [...issues, ...rendered.issues];
  if (rendered.files === undefined) return failure(target, adapterVersion, allIssues);

  const files = rendered.files.map(cloneRenderedFile);
  const treeSha256 = sha256(
    JSON.stringify(
      files.map((file) => ({
        path: file.path,
        role: file.role,
        sha256: file.sha256,
        byteLength: file.byteLength,
      })),
    ),
  );
  const archiveBytes = deterministicZip(files);
  return {
    ok: true,
    target,
    adapterVersion,
    files,
    treeSha256,
    archive: {
      format: 'zip',
      bytes: archiveBytes,
      sha256: sha256(archiveBytes),
      byteLength: archiveBytes.byteLength,
    },
    issues: sortIssues(allIssues),
  };
}

function normalizeTargetIssues(value: unknown, target: string): readonly HostPackageIssue[] {
  if (!Array.isArray(value) || value.length > MAX_TARGET_ISSUES) {
    return [invalidTargetIssue(target)];
  }
  const issues: HostPackageIssue[] = [];
  let malformed = false;
  for (const candidate of value) {
    if (!validTargetIssue(candidate)) {
      malformed = true;
      continue;
    }
    issues.push({
      severity: candidate.severity,
      code: candidate.code,
      path: candidate.path,
      message: candidate.message,
      origin: 'target',
      target,
    });
  }
  if (malformed) issues.push(invalidTargetIssue(target));
  return issues;
}

function validTargetIssue(value: unknown): value is HostPackageTargetIssue {
  if (!isRecord(value)) return false;
  return (
    (value.severity === 'error' || value.severity === 'warning') &&
    typeof value.code === 'string' &&
    TARGET_ISSUE_CODE.test(value.code) &&
    typeof value.path === 'string' &&
    value.path.length <= HOST_PACKAGING_LIMITS.pathChars &&
    !value.path.includes('\0') &&
    typeof value.message === 'string' &&
    value.message.trim().length > 0 &&
    value.message.length <= HOST_PACKAGING_LIMITS.proseChars &&
    sensitiveContentFinding(value) === undefined
  );
}

function invalidTargetIssue(target: string): HostPackageIssue {
  return frameworkIssue(
    target,
    'host_package_adapter_issue_invalid',
    'adapter.validate',
    'The target adapter returned an invalid issue.',
  );
}

function failure(
  target: string,
  adapterVersion: string,
  issues: readonly HostPackageIssue[],
): HostPackageResult {
  return { ok: false, target, adapterVersion, issues: sortIssues(issues) };
}

function cloneInput(input: HostPackageAdapterInput): HostPackageAdapterInput {
  return structuredClone(input);
}

function cloneRenderedFile(file: RenderedHostPackageFile): RenderedHostPackageFile {
  return { ...file, content: new Uint8Array(file.content) };
}

function sortIssues(issues: readonly HostPackageIssue[]): readonly HostPackageIssue[] {
  return [...issues].sort((left, right) => {
    const leftKey = `${left.severity}\0${left.origin}\0${left.code}\0${left.path}`;
    const rightKey = `${right.severity}\0${right.origin}\0${right.code}\0${right.path}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
