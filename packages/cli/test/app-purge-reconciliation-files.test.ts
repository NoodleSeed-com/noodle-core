import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { link as linkFile, open as openFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readAppPurgeReconciliationPreview,
  validateAppPurgeReconciliationPreview,
  writeAppPurgeReconciliationPreview,
} from '../src/commands/app-purge-reconciliation-files.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link), open: vi.fn(actual.open) };
});

const SHA = 'a'.repeat(40);

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'noodle-app-purge-files-'));
  vi.mocked(linkFile).mockReset();
  vi.mocked(linkFile).mockImplementation(async (existingPath, newPath) => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    await actual.link(existingPath, newPath);
  });
  vi.mocked(openFile).mockReset();
  vi.mocked(openFile).mockImplementation(async (path, flags, mode) => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    return actual.open(path, flags, mode);
  });
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('app purge reconciliation preview files', () => {
  it('creates a new regular artifact as exact 0600 bytes with one trailing newline', async () => {
    const path = join(directory, 'preview.json');
    const artifact = previewArtifact();

    await writeAppPurgeReconciliationPreview(path, artifact);

    const stat = lstatSync(path);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o7777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify(artifact)}\n`);
    expect(readdirSync(directory)).toEqual(['preview.json']);
  });

  it('refuses an existing path or symlink without modifying either target', async () => {
    const existing = join(directory, 'existing.json');
    const link = join(directory, 'preview-link.json');
    writeFileSync(existing, 'keep me', { mode: 0o600 });
    chmodSync(existing, 0o600);
    symlinkSync(existing, link);

    await expect(writeAppPurgeReconciliationPreview(existing, previewArtifact())).rejects.toThrow(
      'preview artifact',
    );
    await expect(writeAppPurgeReconciliationPreview(link, previewArtifact())).rejects.toThrow(
      'preview artifact',
    );
    expect(readFileSync(existing, 'utf8')).toBe('keep me');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readdirSync(directory).sort()).toEqual(['existing.json', 'preview-link.json']);
  });

  it('rejects a schema-valid artifact over 256 KiB before creating the output path', async () => {
    const path = join(directory, 'oversized.json');
    const artifact = previewArtifact(
      Array.from({ length: 3_500 }, (_, index) => ({
        name: `env-${String(index).padStart(5, '0')}`,
        isProduction: index === 0,
        createdAt: '2026-01-01T00:00:00.000Z',
      })),
    );
    expect(Buffer.byteLength(`${JSON.stringify(artifact)}\n`)).toBeGreaterThan(256 * 1024);
    expect(validateAppPurgeReconciliationPreview(artifact)).toEqual(artifact);

    await expect(writeAppPurgeReconciliationPreview(path, artifact)).rejects.toThrow(
      'preview artifact',
    );

    expect(existsSync(path)).toBe(false);
    expect(readdirSync(directory)).toEqual([]);
  });

  it('does not publish or leak staging files when final publication fails after staging', async () => {
    const path = join(directory, 'preview.json');
    vi.mocked(linkFile).mockRejectedValueOnce(new Error('injected publication failure'));

    await expect(writeAppPurgeReconciliationPreview(path, previewArtifact())).rejects.toThrow(
      'preview artifact',
    );

    expect(existsSync(path)).toBe(false);
    expect(readdirSync(directory)).toEqual([]);
  });

  it('does not publish or leak staging files when descriptor validation fails after open', async () => {
    const path = join(directory, 'preview.json');
    vi.mocked(openFile).mockImplementationOnce(async (filePath, flags, mode) => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      const handle = await actual.open(filePath, flags, mode);
      vi.spyOn(handle, 'stat').mockRejectedValueOnce(new Error('injected descriptor failure'));
      return handle;
    });

    await expect(writeAppPurgeReconciliationPreview(path, previewArtifact())).rejects.toThrow(
      'preview artifact',
    );

    expect(existsSync(path)).toBe(false);
    expect(readdirSync(directory)).toEqual([]);
  });

  it('never recursively removes a substituted non-empty staging directory', async () => {
    const path = join(directory, 'preview.json');
    let substitutedDirectory = '';
    let displacedDirectory = '';
    vi.mocked(linkFile).mockImplementationOnce(async (stagingPath, finalPath) => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      await actual.link(stagingPath, finalPath);
      substitutedDirectory = dirname(String(stagingPath));
      displacedDirectory = `${substitutedDirectory}-displaced`;
      renameSync(substitutedDirectory, displacedDirectory);
      mkdirSync(substitutedDirectory, { mode: 0o700 });
      writeFileSync(join(substitutedDirectory, 'unowned.txt'), 'keep me', { mode: 0o600 });
    });

    await writeAppPurgeReconciliationPreview(path, previewArtifact());

    expect(readFileSync(join(substitutedDirectory, 'unowned.txt'), 'utf8')).toBe('keep me');
    expect(readdirSync(displacedDirectory)).toEqual(['artifact.json']);
    expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify(previewArtifact())}\n`);
  });

  it('reads a strict, checksummed artifact from an exact 0600 regular file', async () => {
    const path = writeArtifact('approved.json', previewArtifact());
    await expect(readAppPurgeReconciliationPreview(path)).resolves.toEqual(previewArtifact());
  });

  it.each([
    ['relative path', 'relative.json'],
    ['directory', 'directory'],
    ['0644 permissions', 'loose.json'],
    ['symlink', 'link.json'],
    ['oversized file', 'large.json'],
    ['malformed JSON', 'malformed.json'],
    ['unknown artifact field', 'unknown.json'],
    ['tampered artifact', 'tampered.json'],
  ])('rejects a %s with one bounded failure', async (kind, name) => {
    const target = prepareInvalid(kind, name);
    await expect(readAppPurgeReconciliationPreview(target)).rejects.toThrow(
      'approved preview artifact is invalid',
    );
  });
});

function prepareInvalid(kind: string, name: string): string {
  const path = join(directory, name);
  if (kind === 'relative path') return name;
  if (kind === 'directory') {
    mkdirSync(path, { mode: 0o700 });
    return path;
  }
  if (kind === '0644 permissions') {
    writeFileSync(path, JSON.stringify(previewArtifact()), { mode: 0o600 });
    chmodSync(path, 0o644);
    return path;
  }
  if (kind === 'symlink') {
    const target = writeArtifact('target.json', previewArtifact());
    symlinkSync(target, path);
    return path;
  }
  if (kind === 'oversized file') {
    writeFileSync(path, 'x'.repeat(256 * 1024 + 1), { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  }
  if (kind === 'malformed JSON') {
    writeFileSync(path, '{', { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  }
  if (kind === 'unknown artifact field') {
    writeArtifact(name, { ...previewArtifact(), privateRow: 'must-not-be-accepted' });
    return path;
  }
  writeArtifact(name, { ...previewArtifact(), releaseSha: 'b'.repeat(40) });
  return path;
}

function writeArtifact(name: string, value: unknown): string {
  const path = join(directory, name);
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function previewArtifact(
  environments: ReadonlyArray<{
    readonly name: string;
    readonly isProduction: boolean;
    readonly createdAt: string;
  }> = [
    {
      name: 'prod',
      isProduction: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ],
) {
  const unsigned = {
    schemaVersion: 1 as const,
    releaseSha: SHA,
    createdAt: '2026-09-02T00:00:00.000Z',
    expiresAt: '2026-09-02T00:15:00.000Z',
    candidateCount: 1,
    truncated: false,
    candidates: [
      {
        org: 'acme',
        app: 'old-app',
        anchorCreatedAt: '2026-01-01T00:00:00.000Z',
        purgeAuditId: '00000000-0000-4000-8000-000000000001',
        environments,
      },
    ],
  };
  return {
    ...unsigned,
    checksum: `sha256:${createHash('sha256').update(JSON.stringify(unsigned)).digest('hex')}`,
  };
}
