import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  AGENT_KIT_VERSION,
  type AgentKitManifest,
  type AgentKitManifestFile,
  contentSha256,
} from '@noodle-borg/agent-kit';
import { compareVersions } from './update.js';

export const AGENT_KIT_PACKAGE_NAME = '@noodleseed/agent-kit';
const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${AGENT_KIT_PACKAGE_NAME.replace('/', '%2F')}/latest`;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The agent-kit version vendored into this CLI build. The offline fallback uses this snapshot. */
export function bundledAgentKitVersion(): string {
  return AGENT_KIT_VERSION;
}

export function skillsUpdatePromptMessage(latest: string, current: string): string {
  return `Skills updated in v${latest} (you have v${current}). Run \`noodle agents setup --write\` to refresh.`;
}

/** Fetch the registry `latest` dist-tag version of `@noodleseed/agent-kit`. Returns undefined on any failure. */
export async function fetchLatestAgentKitVersion(
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  try {
    const res = await fetchImpl(REGISTRY_LATEST_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : undefined;
  } catch {
    return undefined;
  }
}

export function isSkillsUpdateAvailable(
  registryVersion: string | undefined,
  current: string = bundledAgentKitVersion(),
): boolean {
  return registryVersion !== undefined && compareVersions(registryVersion, current) > 0;
}

export type SkillsStaleness = 'current' | 'stale' | 'unknown';

/** Compare an installed skill file's frontmatter version to the registry latest. */
export function skillStaleness(
  installedVersion: string | undefined,
  registryVersion: string | undefined,
): SkillsStaleness {
  if (registryVersion === undefined) return 'unknown';
  if (installedVersion === undefined) return 'stale';
  const cmp = compareVersions(registryVersion, installedVersion);
  if (cmp === 0) return 'current';
  return cmp > 0 ? 'stale' : 'current';
}

/**
 * Extract every regular file from a `.tgz` tarball as `{package-relative path: text content}`.
 * A minimal, dependency-free ustar reader; only handles the entries npm `pack` produces.
 * Throws on malformed input so callers fall back to the bundled snapshot.
 */
export function extractTarGz(tgz: Buffer): Map<string, string> {
  const tar = gunzipSync(tgz);
  const files = new Map<string, string>();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    const name = readField(header, 0, 100).replace(/\0/g, '');
    if (name === '') break;
    const size = parseOctal(readField(header, 124, 12));
    const typeflag = String.fromCharCode(header[156] ?? 0x30);
    offset += 512;
    if (typeflag === '0' || typeflag === '\0') {
      const content = tar.subarray(offset, offset + size);
      files.set(name, Buffer.from(content).toString('utf8'));
    }
    // tar records are padded to 512-byte boundaries
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

function readField(buf: Buffer, start: number, len: number): string {
  return buf.toString('latin1', start, start + len);
}

function parseOctal(s: string): number {
  return Number.parseInt(s.replace(/\0/g, '').trim(), 8) || 0;
}

export interface FetchedAgentKit {
  readonly version: string;
  readonly manifest: AgentKitManifest;
  /** package-relative path → file content (every file listed in the manifest: SKILL.md + references). */
  readonly files: ReadonlyMap<string, string>;
}

export interface AgentKitResolveResult {
  readonly status: 'no-update' | 'fetch-failed' | 'integrity-mismatch' | 'ready' | 'offline';
  readonly kit?: FetchedAgentKit;
}

/**
 * Resolve the latest `@noodleseed/agent-kit` skill files for writing.
 *
 * Fetches the published tarball (via `npm pack` by default), verifies every file's sha256 against
 * the shipped `manifest.json`, and returns the verified files. Any failure (network, missing manifest,
 * sha256 mismatch) returns a non-`ready` status so the caller falls back to the bundled snapshot —
 * the CLI never writes untrusted or unverified content into a user's repo.
 */
export async function resolveAgentKit(input: {
  readonly registryVersion: string | undefined;
  readonly cacheDir: string;
  readonly fetchImpl?: typeof fetch;
  readonly packImpl?: (version: string, dir: string) => Promise<Buffer | undefined>;
  /** Resolve this exact compatibility-pinned version even when it is not newer than bundled. */
  readonly pinned?: boolean;
  readonly force?: boolean;
}): Promise<AgentKitResolveResult> {
  const version = input.registryVersion;
  if (version === undefined) return { status: 'offline' };
  if (input.pinned !== true && !isSkillsUpdateAvailable(version) && input.force !== true) {
    return { status: 'no-update' };
  }
  const cacheVersionDir = join(input.cacheDir, version);
  const manifestPath = join(cacheVersionDir, 'manifest.json');
  if (!input.force && existsSync(manifestPath)) {
    const cached = loadCachedAgentKit({ cacheDir: input.cacheDir, version });
    if (cached !== undefined) return { status: 'ready', kit: cached };
  }
  const packImpl = input.packImpl ?? defaultPack;
  const tgz = await packImpl(version, cacheVersionDir).catch(() => undefined);
  if (tgz === undefined) return { status: 'fetch-failed' };
  try {
    const entries = extractTarGz(tgz);
    const manifest = readManifest(entries);
    if (manifest === undefined) {
      return {
        status: entries.has('package/manifest.json') ? 'integrity-mismatch' : 'fetch-failed',
      };
    }
    if (manifest.packageVersion !== version) return { status: 'integrity-mismatch' };
    if (!manifestCoversPackagedSkills(manifest, entries)) {
      return { status: 'integrity-mismatch' };
    }
    const files = new Map<string, string>();
    for (const entry of manifest.files) {
      const content = entries.get(`package/${entry.path}`);
      if (content === undefined) return { status: 'integrity-mismatch' };
      if (contentSha256(content) !== entry.sha256) return { status: 'integrity-mismatch' };
      files.set(entry.path, content);
    }
    writeCache(cacheVersionDir, manifest, files);
    return { status: 'ready', kit: { version, manifest, files } };
  } catch {
    return { status: 'fetch-failed' };
  }
}

function readManifest(entries: Map<string, string>): AgentKitManifest | undefined {
  const content = entries.get('package/manifest.json');
  if (content === undefined) return undefined;
  try {
    return parseAgentKitManifest(JSON.parse(content));
  } catch {
    return undefined;
  }
}

function parseAgentKitManifest(value: unknown): AgentKitManifest | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 2 ||
    typeof value.packageVersion !== 'string' ||
    !SEMVER_PATTERN.test(value.packageVersion)
  ) {
    return undefined;
  }
  if (!Array.isArray(value.files) || value.files.length === 0) return undefined;
  const publishPaths = new Set<string>();
  const installedPaths = new Set<string>();
  const roots = new Set<string>();
  const files: AgentKitManifestFile[] = [];
  for (const candidate of value.files) {
    if (!isRecord(candidate)) return undefined;
    const { path, installedPath, sha256, agentTarget, skill, skillVersion } = candidate;
    if (
      typeof path !== 'string' ||
      typeof installedPath !== 'string' ||
      typeof sha256 !== 'string' ||
      typeof agentTarget !== 'string' ||
      typeof skill !== 'string' ||
      typeof skillVersion !== 'string'
    ) {
      return undefined;
    }
    if (
      (agentTarget !== 'codex' && agentTarget !== 'claude-code') ||
      !SKILL_NAME_PATTERN.test(skill) ||
      !SEMVER_PATTERN.test(skillVersion) ||
      !SHA256_PATTERN.test(sha256) ||
      !isSafeRelativePath(path) ||
      !isSafeRelativePath(installedPath) ||
      !path.startsWith(`skills/${agentTarget}/`)
    ) {
      return undefined;
    }
    const installedRoot = `${agentTarget === 'codex' ? '.agents' : '.claude'}/skills/${skill}/`;
    if (!installedPath.startsWith(installedRoot)) return undefined;
    if (publishPaths.has(path) || installedPaths.has(installedPath)) return undefined;
    publishPaths.add(path);
    installedPaths.add(installedPath);
    if (installedPath === `${installedRoot}SKILL.md`) roots.add(`${agentTarget}:${skill}`);
    files.push({ path, installedPath, sha256, agentTarget, skill, skillVersion });
  }
  const groups = new Set(files.map((file) => `${file.agentTarget}:${file.skill}`));
  if ([...groups].some((group) => !roots.has(group))) return undefined;
  return { schemaVersion: 2, packageVersion: value.packageVersion, files };
}

function manifestCoversPackagedSkills(
  manifest: AgentKitManifest,
  entries: ReadonlyMap<string, string>,
): boolean {
  const declared = new Set(manifest.files.map((file) => `package/${file.path}`));
  const packaged = [...entries.keys()].filter(
    (path) =>
      path.startsWith('package/skills/') &&
      !path.split('/').some((segment) => segment.startsWith('._')),
  );
  return packaged.length === declared.size && packaged.every((path) => declared.has(path));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 500 || path.startsWith('/') || path.includes('\\')) {
    return false;
  }
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** Load and verify one exact cached Agent Kit without fetching or falling back to bundled content. */
export function loadCachedAgentKit(input: {
  readonly cacheDir: string;
  readonly version: string;
}): FetchedAgentKit | undefined {
  const dir = join(input.cacheDir, input.version);
  try {
    const manifest = parseAgentKitManifest(
      JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')),
    );
    if (manifest === undefined) return undefined;
    if (manifest.packageVersion !== input.version) return undefined;
    const files = new Map<string, string>();
    for (const entry of manifest.files) {
      const content = readFileSync(join(dir, entry.path), 'utf8');
      if (contentSha256(content) !== entry.sha256) return undefined;
      files.set(entry.path, content);
    }
    return { version: manifest.packageVersion, manifest, files };
  } catch {
    return undefined;
  }
}

function writeCache(
  dir: string,
  manifest: AgentKitManifest,
  files: ReadonlyMap<string, string>,
): void {
  mkdirSync(dir, { recursive: true });
  for (const [path, content] of files) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

// Default pack implementation: `npm pack @noodleseed/agent-kit@<version>` into a temp directory.
async function defaultPack(version: string, dir: string): Promise<Buffer | undefined> {
  mkdirSync(dir, { recursive: true });
  return new Promise((resolve) => {
    const child = spawn('npm', ['pack', `${AGENT_KIT_PACKAGE_NAME}@${version}`], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.on('error', () => resolve(undefined));
    child.on('close', (code) => {
      if (code !== 0) return resolve(undefined);
      const filename = stdout.trim().split('\n').pop();
      if (filename === undefined) return resolve(undefined);
      try {
        const bytes = readFileSync(join(dir, filename));
        rmSync(join(dir, filename), { force: true });
        resolve(bytes);
      } catch {
        resolve(undefined);
      }
    });
  });
}
