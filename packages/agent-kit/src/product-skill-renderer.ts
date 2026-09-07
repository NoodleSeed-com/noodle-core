import { createHash } from 'node:crypto';
import type {
  ProductSkillPackageInput,
  ProductSkillRenderTarget,
  RenderedProductSkillBundleV1,
  RenderedProductSkillFileV1,
} from '@noodle-borg/agent-packaging';
import {
  ProductSkillRenderError,
  type ProductSkillRenderErrorCode,
  skillSlug,
  validateProductSkillPackageInput,
} from '@noodle-borg/agent-packaging';
import { renderProductSkillMarkdown } from '@noodle-borg/plugin-distribution';
import { AGENT_KIT_VERSION } from './version.js';

export type { ProductSkillRenderErrorCode } from '@noodle-borg/agent-packaging';
export {
  PRODUCT_SKILL_VALIDATION_LIMITS,
  ProductSkillRenderError,
} from '@noodle-borg/agent-packaging';

const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;
const MAX_SKILL_MD_LINES = 500;

/** Render both project-local host projections without filesystem, network, auth, or compiler dependencies. */
export function renderProductSkillBundle(
  input: ProductSkillPackageInput,
): RenderedProductSkillBundleV1 {
  validateProductSkillPackageInput(input);
  const slug = skillSlug(input.app.name);
  const markdown = renderProductSkillMarkdown(input);
  const unverified = [
    renderFile('codex', `.agents/skills/${slug}/SKILL.md`, markdown.skill),
    renderFile('codex', `.agents/skills/${slug}/references/mcp-surface.md`, markdown.reference),
    renderFile('claude-code', `.claude/skills/${slug}/SKILL.md`, markdown.skill),
    renderFile(
      'claude-code',
      `.claude/skills/${slug}/references/mcp-surface.md`,
      markdown.reference,
    ),
  ];
  validateFiles(unverified, slug);
  const files = unverified.map((file) => deepFreeze(file));
  return deepFreeze({
    schemaVersion: 1,
    rendererVersion: AGENT_KIT_VERSION,
    files: deepFreeze(files),
    bundleSha256: bundleSha256(input, files),
  });
}

/** Verify persisted or injected files against the same canonical host contract used during rendering. */
export function validateRenderedProductSkillFiles(
  input: ProductSkillPackageInput,
  files: readonly RenderedProductSkillFileV1[],
): void {
  validateProductSkillPackageInput(input);
  validateFiles(files, skillSlug(input.app.name));
}

function renderFile(
  target: ProductSkillRenderTarget,
  path: string,
  content: string,
): RenderedProductSkillFileV1 {
  return {
    target,
    path,
    content,
    sha256: sha256(content),
    byteLength: Buffer.byteLength(content, 'utf8'),
  };
}

function validateFiles(files: readonly RenderedProductSkillFileV1[], slug: string): void {
  const expected = new Set([
    `codex\u0000.agents/skills/${slug}/SKILL.md`,
    `codex\u0000.agents/skills/${slug}/references/mcp-surface.md`,
    `claude-code\u0000.claude/skills/${slug}/SKILL.md`,
    `claude-code\u0000.claude/skills/${slug}/references/mcp-surface.md`,
  ]);
  const pairs = new Set<string>();
  let totalBytes = 0;
  let fileTooLarge = false;
  for (const file of files) {
    const pair = `${file.target}\u0000${file.path}`;
    if (!isSafeRelativePath(file.path) || !expected.has(pair)) fail('app_package_unsafe_path');
    if (!hasOneLevelReferenceDepth(file.path, slug)) fail('app_package_unsafe_path');
    if (pairs.has(pair)) fail('app_package_unsafe_path');
    pairs.add(pair);
    if (!nonBlank(file.content)) fail('app_package_invalid');
    const byteLength = Buffer.byteLength(file.content, 'utf8');
    if (file.byteLength !== byteLength || file.sha256 !== sha256(file.content))
      fail('app_package_invalid');
    if (file.path.endsWith('/SKILL.md') && markdownLineCount(file.content) > MAX_SKILL_MD_LINES)
      fail('app_package_file_too_large');
    if (byteLength > MAX_FILE_BYTES) fileTooLarge = true;
    totalBytes += byteLength;
  }
  if (pairs.size !== expected.size || expected.size !== files.length)
    fail('app_package_unsafe_path');
  if (totalBytes > MAX_TOTAL_BYTES) fail('app_package_total_too_large');
  if (fileTooLarge) fail('app_package_file_too_large');
}

function markdownLineCount(content: string): number {
  return (content.match(/\n/g) ?? []).length + (content.endsWith('\n') ? 0 : 1);
}

function hasOneLevelReferenceDepth(path: string, slug: string): boolean {
  const roots = [`.agents/skills/${slug}`, `.claude/skills/${slug}`];
  return roots.some(
    (root) => path === `${root}/SKILL.md` || path === `${root}/references/mcp-surface.md`,
  );
}

function isSafeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function bundleSha256(
  input: ProductSkillPackageInput,
  files: readonly RenderedProductSkillFileV1[],
): string {
  return sha256(
    canonicalJson({
      sourceManifestSha256: input.provenance.sourceManifestSha256,
      mcpSurfaceSha256: input.provenance.mcpSurfaceSha256,
      files: files.map((file) => ({ target: file.target, path: file.path, sha256: file.sha256 })),
    }),
  );
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!isRecord(value))
    throw new TypeError('canonical JSON accepts only objects, arrays, and primitives');
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) value.forEach(deepFreeze);
  else if (isRecord(value)) Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(code: ProductSkillRenderErrorCode): never {
  throw new ProductSkillRenderError(code);
}
