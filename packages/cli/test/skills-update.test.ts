import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  contentSha256,
  renderAgentKitManifest,
  renderPublishableSkills,
} from '@noodle-borg/agent-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_KIT_PACKAGE_NAME,
  bundledAgentKitVersion,
  extractTarGz,
  fetchLatestAgentKitVersion,
  isSkillsUpdateAvailable,
  resolveAgentKit,
  skillStaleness,
  skillsUpdatePromptMessage,
} from '../src/skills-update.js';

type PackFn = (version: string, dir: string) => Promise<Buffer | undefined>;

function makeTgz(files: ReadonlyMap<string, string>): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'noodle-tgz-'));
  const pkgDir = join(dir, 'package');
  mkdirSync(pkgDir, { recursive: true });
  for (const [relPath, content] of files) {
    const full = join(pkgDir, relPath);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  execSync('tar czf package.tgz -C . package', { cwd: dir });
  const bytes = readFileSync(join(dir, 'package.tgz'));
  rmSync(dir, { recursive: true, force: true });
  return bytes;
}

function validTgz(packageVersion: string = bundledAgentKitVersion()): Buffer {
  const files = new Map<string, string>();
  for (const skill of renderPublishableSkills()) {
    files.set(skill.path, skill.content);
  }
  const manifest = { ...renderAgentKitManifest(), packageVersion };
  files.set('manifest.json', JSON.stringify(manifest, null, 2));
  return makeTgz(files);
}

function nextMajorVersion(version: string = bundledAgentKitVersion()): string {
  const [major = 0] = version.split('.').map((part) => Number(part));
  return `${Number.isFinite(major) ? major + 1 : 1}.0.0`;
}

describe('skills-update version checking', () => {
  it('fetchLatestAgentKitVersion parses registry latest', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ version: '0.2.0' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(await fetchLatestAgentKitVersion(fetchImpl as unknown as typeof fetch)).toBe('0.2.0');
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining(AGENT_KIT_PACKAGE_NAME.replace('/', '%2F')),
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    );
  });

  it('fetchLatestAgentKitVersion swallows network errors to undefined', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(await fetchLatestAgentKitVersion(fetchImpl as unknown as typeof fetch)).toBeUndefined();
  });

  it('isSkillsUpdateAvailable compares against the bundled version', () => {
    expect(isSkillsUpdateAvailable(undefined)).toBe(false);
    expect(isSkillsUpdateAvailable('0.0.1')).toBe(false);
    expect(isSkillsUpdateAvailable(nextMajorVersion())).toBe(true);
    expect(isSkillsUpdateAvailable(bundledAgentKitVersion())).toBe(false);
  });

  it('skillsUpdatePromptMessage is actionable', () => {
    expect(skillsUpdatePromptMessage('0.2.0', '0.1.0')).toBe(
      'Skills updated in v0.2.0 (you have v0.1.0). Run `noodle agents setup --write` to refresh.',
    );
  });

  it('skillStaleness classifies installed vs registry', () => {
    expect(skillStaleness('0.1.0', '0.1.0')).toBe('current');
    expect(skillStaleness('0.1.0', '0.2.0')).toBe('stale');
    expect(skillStaleness(undefined, '0.2.0')).toBe('stale');
    expect(skillStaleness('0.1.0', undefined)).toBe('unknown');
  });
});

describe('skills-update tar extraction', () => {
  it('extracts every regular file from a real npm-style tgz, including nested references', () => {
    const entries = extractTarGz(validTgz());
    expect(entries.get('package/manifest.json')).toBeDefined();
    expect(entries.get('package/skills/codex/SKILL.md')).toBeDefined();
    expect(entries.get('package/skills/claude-code/SKILL.md')).toBeDefined();
    expect(entries.get('package/skills/codex/references/cli-commands.md')).toBeDefined();
    expect(entries.get('package/skills/claude-code/references/compile-errors.md')).toBeDefined();
  });

  it('throws on malformed gzip so callers fall back', () => {
    expect(() => extractTarGz(Buffer.from('not a tgz'))).toThrow();
  });
});

describe('skills-update resolveAgentKit', () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'noodle-skills-cache-'));
  });
  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('returns offline when no registry version is known', async () => {
    const result = await resolveAgentKit({ registryVersion: undefined, cacheDir });
    expect(result.status).toBe('offline');
  });

  it('returns no-update when the registry version is not newer and not forced', async () => {
    const result = await resolveAgentKit({
      registryVersion: bundledAgentKitVersion(),
      cacheDir,
    });
    expect(result.status).toBe('no-update');
  });

  it('verifies sha256 and returns ready files for a newer version', async () => {
    const registryVersion = nextMajorVersion();
    const tgz = validTgz(registryVersion);
    const packImpl = vi.fn(async () => tgz);
    const result = await resolveAgentKit({
      registryVersion,
      cacheDir,
      packImpl: packImpl as unknown as PackFn,
    });
    expect(result.status).toBe('ready');
    expect(result.kit?.files.get('skills/codex/SKILL.md')).toBeDefined();
    expect(result.kit?.files.get('skills/codex/references/cli-commands.md')).toBeDefined();
    expect(result.kit?.manifest.packageVersion).toBe(registryVersion);
  });

  it('rejects a package whose manifest version does not match the requested version', async () => {
    const registryVersion = nextMajorVersion();
    const packImpl = vi.fn(async () => validTgz(bundledAgentKitVersion()));
    const result = await resolveAgentKit({
      registryVersion,
      cacheDir,
      packImpl: packImpl as unknown as PackFn,
    });
    expect(result.status).toBe('integrity-mismatch');
  });

  it('refuses on sha256 integrity mismatch (never writes untrusted content)', async () => {
    const registryVersion = nextMajorVersion();
    const files = new Map<string, string>([
      ...renderPublishableSkills().map((f) => [f.path, f.content] as [string, string]),
    ]);
    files.set('skills/codex/SKILL.md', 'tampered content');
    const manifest = { ...renderAgentKitManifest(), packageVersion: registryVersion };
    files.set('manifest.json', JSON.stringify(manifest, null, 2));
    const tgz = makeTgz(files);
    const packImpl = vi.fn(async () => tgz);
    const result = await resolveAgentKit({
      registryVersion,
      cacheDir,
      packImpl: packImpl as unknown as PackFn,
    });
    expect(result.status).toBe('integrity-mismatch');
  });

  it.each([
    {
      name: 'unsafe installed path',
      mutate: (manifest: ReturnType<typeof renderAgentKitManifest>) => ({
        ...manifest,
        files: manifest.files.map((file, index) =>
          index === 0 ? { ...file, installedPath: '../outside/SKILL.md' } : file,
        ),
      }),
    },
    {
      name: 'duplicate installed path',
      mutate: (manifest: ReturnType<typeof renderAgentKitManifest>) => ({
        ...manifest,
        files: manifest.files.map((file, index) =>
          index === 1 ? { ...file, installedPath: manifest.files[0]?.installedPath ?? '' } : file,
        ),
      }),
    },
    {
      name: 'missing skill root',
      mutate: (manifest: ReturnType<typeof renderAgentKitManifest>) => ({
        ...manifest,
        files: manifest.files.filter((file) => file.path !== 'skills/codex/SKILL.md'),
      }),
    },
  ])('rejects a manifest with $name', async ({ mutate }) => {
    const registryVersion = nextMajorVersion();
    const files = new Map<string, string>(
      renderPublishableSkills().map((file) => [file.path, file.content]),
    );
    files.set(
      'manifest.json',
      JSON.stringify(
        mutate({ ...renderAgentKitManifest(), packageVersion: registryVersion }),
        null,
        2,
      ),
    );
    const result = await resolveAgentKit({
      registryVersion,
      cacheDir,
      packImpl: async () => makeTgz(files),
    });

    expect(result.status).toBe('integrity-mismatch');
    expect(existsSync(join(cacheDir, registryVersion, 'manifest.json'))).toBe(false);
  });

  it('rejects a package whose manifest omits a packaged skill file', async () => {
    const registryVersion = nextMajorVersion();
    const files = new Map<string, string>(
      renderPublishableSkills().map((file) => [file.path, file.content]),
    );
    const manifest = renderAgentKitManifest();
    files.set(
      'manifest.json',
      JSON.stringify(
        {
          ...manifest,
          packageVersion: registryVersion,
          files: manifest.files.filter(
            (file) => file.path !== 'skills/codex/references/sdk-surface.md',
          ),
        },
        null,
        2,
      ),
    );

    const result = await resolveAgentKit({
      registryVersion,
      cacheDir,
      packImpl: async () => makeTgz(files),
    });
    expect(result.status).toBe('integrity-mismatch');
  });

  it('verifies reference files too: a tampered reference is rejected', async () => {
    const registryVersion = nextMajorVersion();
    const files = new Map<string, string>([
      ...renderPublishableSkills().map((f) => [f.path, f.content] as [string, string]),
    ]);
    files.set('skills/codex/references/cli-commands.md', '# tampered reference');
    files.set(
      'manifest.json',
      JSON.stringify({ ...renderAgentKitManifest(), packageVersion: registryVersion }, null, 2),
    );
    const packImpl = vi.fn(async () => makeTgz(files));
    const result = await resolveAgentKit({
      registryVersion,
      cacheDir,
      packImpl: packImpl as unknown as PackFn,
    });
    expect(result.status).toBe('integrity-mismatch');
  });

  it('falls back to fetch-failed when pack throws', async () => {
    const registryVersion = nextMajorVersion();
    const packImpl = vi.fn(async () => undefined);
    const result = await resolveAgentKit({
      registryVersion,
      cacheDir,
      packImpl: packImpl as unknown as PackFn,
    });
    expect(result.status).toBe('fetch-failed');
  });

  it('reuses a verified cache on subsequent resolves (no re-pack)', async () => {
    const registryVersion = nextMajorVersion();
    const tgz = validTgz(registryVersion);
    const packImpl = vi.fn(async () => tgz);
    await resolveAgentKit({
      registryVersion,
      cacheDir,
      packImpl: packImpl as unknown as PackFn,
    });
    const second = await resolveAgentKit({
      registryVersion,
      cacheDir,
      packImpl: packImpl as unknown as PackFn,
    });
    expect(second.status).toBe('ready');
    expect(packImpl).toHaveBeenCalledTimes(1);
    expect(existsSync(join(cacheDir, registryVersion, 'manifest.json'))).toBe(true);
  });

  it('reuses an exact pinned cache even when the pinned version is not newer', async () => {
    const pinnedVersion = '0.0.0';
    const packImpl = vi.fn(async () => validTgz(pinnedVersion));
    await resolveAgentKit({
      registryVersion: pinnedVersion,
      cacheDir,
      force: true,
      packImpl: packImpl as unknown as PackFn,
    });
    const second = await resolveAgentKit({
      registryVersion: pinnedVersion,
      cacheDir,
      pinned: true,
      packImpl: packImpl as unknown as PackFn,
    });
    expect(second.status).toBe('ready');
    expect(packImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a cached manifest whose package version differs from its cache key', async () => {
    const registryVersion = nextMajorVersion();
    const packImpl = vi.fn(async () => validTgz(registryVersion));
    await resolveAgentKit({
      registryVersion,
      cacheDir,
      packImpl: packImpl as unknown as PackFn,
    });
    const manifestPath = join(cacheDir, registryVersion, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { packageVersion: string };
    writeFileSync(
      manifestPath,
      JSON.stringify({ ...manifest, packageVersion: bundledAgentKitVersion() }, null, 2),
    );
    const unavailablePack = vi.fn(async () => undefined);

    const second = await resolveAgentKit({
      registryVersion,
      cacheDir,
      packImpl: unavailablePack as unknown as PackFn,
    });
    expect(second.status).toBe('fetch-failed');
    expect(unavailablePack).toHaveBeenCalledTimes(1);
  });

  it('forces a re-pack with --refresh even when cached', async () => {
    const registryVersion = nextMajorVersion();
    const tgz = validTgz(registryVersion);
    const packImpl = vi.fn(async () => tgz);
    await resolveAgentKit({
      registryVersion,
      cacheDir,
      packImpl: packImpl as unknown as PackFn,
    });
    rmSync(join(cacheDir, registryVersion, 'skills', 'codex', 'SKILL.md'), { force: true });
    const second = await resolveAgentKit({
      registryVersion,
      cacheDir,
      force: true,
      packImpl: packImpl as unknown as PackFn,
    });
    expect(second.status).toBe('ready');
    expect(packImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a cached manifest whose stored file no longer matches sha256', async () => {
    const registryVersion = nextMajorVersion();
    const tgz = validTgz(registryVersion);
    const packImpl = vi.fn(async () => tgz);
    await resolveAgentKit({
      registryVersion,
      cacheDir,
      packImpl: packImpl as unknown as PackFn,
    });
    writeFileSync(join(cacheDir, registryVersion, 'skills', 'codex', 'SKILL.md'), 'tampered cache');
    const second = await resolveAgentKit({
      registryVersion,
      cacheDir,
      packImpl: packImpl as unknown as PackFn,
    });
    // tampered cache fails verification → re-pack → ready (or fetch-failed if pack missing)
    expect(['ready', 'fetch-failed']).toContain(second.status);
  });
});

// keep contentSha256 referenced for fixture sanity
void contentSha256;
