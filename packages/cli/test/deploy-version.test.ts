import { inferDeployVersionFromPath, normalizeDeployVersion } from '@noodle-borg/deploy-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveDeployServerVersion } from '../src/commands/deploy-version-resolution.js';

const readlineMock = vi.hoisted(() => ({
  close: vi.fn(),
  createInterface: vi.fn(),
  question: vi.fn(),
}));

vi.mock('node:readline/promises', () => ({
  createInterface: readlineMock.createInterface,
}));

const stdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const stdoutIsTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

afterEach(() => {
  readlineMock.close.mockReset();
  readlineMock.createInterface.mockReset();
  readlineMock.question.mockReset();
  restoreTty(process.stdin, stdinIsTty);
  restoreTty(process.stdout, stdoutIsTty);
});

describe('deploy version resolution', () => {
  it('normalizes explicit deploy versions', () => {
    expect(normalizeDeployVersion('1')).toBe('1');
    expect(normalizeDeployVersion('01')).toBe('1');
    expect(normalizeDeployVersion('v1')).toBe('1');
    expect(normalizeDeployVersion('2.0.6')).toBe('2.0.6');
    expect(normalizeDeployVersion('v2_0_6')).toBe('2.0.6');
  });

  it('infers versions from versioned entrypoint folders', () => {
    expect(inferDeployVersionFromPath('v1/src/server.ts', '/repo/app')).toBe('1');
    expect(inferDeployVersionFromPath('v2.0.6/server.ts', '/repo/app')).toBe('2.0.6');
  });

  it('uses the nearest versioned folder to the entrypoint', () => {
    expect(inferDeployVersionFromPath('v1/experiments/v2.0.6/server.ts', '/repo/app')).toBe(
      '2.0.6',
    );
  });

  it('ignores non-version folders', () => {
    expect(inferDeployVersionFromPath('latest/src/server.ts', '/repo/app')).toBeUndefined();
    expect(inferDeployVersionFromPath('vnext/src/server.ts', '/repo/app')).toBeUndefined();
  });

  it('resolves an explicit version flag through canonical normalization', async () => {
    await expect(
      resolveDeployServerVersion({
        manifestPath: '/repo/app/src/server.ts',
        versionFlag: 'v01_00',
        noPrompt: true,
        json: true,
      }),
    ).resolves.toEqual({ ok: true, value: '1.0' });
  });

  it('resolves an inferred version from the entrypoint path', async () => {
    await expect(
      resolveDeployServerVersion({
        manifestPath: '/repo/app/v2.0.6/server.ts',
        noPrompt: true,
        json: true,
      }),
    ).resolves.toEqual({ ok: true, value: '2.0.6' });
  });

  it('reuses the linked deployment compatibility version', async () => {
    await expect(
      resolveDeployServerVersion({
        manifestPath: '/repo/app/src/server.ts',
        linkedVersion: 'v10',
        noPrompt: true,
        json: true,
      }),
    ).resolves.toEqual({ ok: true, value: '10' });
  });

  // #703: bare `noodle deploy` on a linked project with a fresh app had nothing to resolve and hard
  // failed, so the most discoverable deploy command could not complete a first deployment. Every
  // shipped example and Agent Kit skill says bare `noodle deploy`, which made this fail in CI and
  // in every agent run. The hosted deployment list is the authority on which versions exist.
  it('starts a brand-new app at version 1 when the hosted app has no deployments', async () => {
    await expect(
      resolveDeployServerVersion({
        manifestPath: '/repo/app/src/server.ts',
        deployedVersions: async () => [],
        noPrompt: true,
        json: true,
      }),
    ).resolves.toEqual({ ok: true, value: '1' });
  });

  it('reuses the only version the hosted app already runs', async () => {
    await expect(
      resolveDeployServerVersion({
        manifestPath: '/repo/app/src/server.ts',
        deployedVersions: async () => ['2.0.6', '2.0.6'],
        noPrompt: true,
        json: true,
      }),
    ).resolves.toEqual({ ok: true, value: '2.0.6' });
  });

  it('refuses to guess when the hosted app runs several versions', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(
        resolveDeployServerVersion({
          manifestPath: '/repo/app/src/server.ts',
          deployedVersions: async () => ['1', '2.0.6'],
          noPrompt: true,
          json: true,
        }),
      ).resolves.toEqual({ ok: false, exitCode: 2 });
      const envelope = JSON.parse(String(output.mock.calls[0]?.[0]));
      expect(envelope.error.code).toBe('ambiguous_server_version');
      expect(envelope.error.cause).toContain('1');
      expect(envelope.error.cause).toContain('2.0.6');
      // The operator otherwise has to look the sequence up out of band on every deploy: the
      // error names the highest deployed version and offers the next new one, ready to paste.
      expect(envelope.error.fix).toContain('highest deployed is 2.0.6');
      expect(envelope.error.next).toBe('noodle deploy --version 3');
    } finally {
      output.mockRestore();
    }
  });

  it('offers the next integer version when the deployed versions are plain integers', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(
        resolveDeployServerVersion({
          manifestPath: '/repo/app/src/server.ts',
          deployedVersions: async () => ['1', '10', '18', '2'],
          noPrompt: true,
          json: true,
        }),
      ).resolves.toEqual({ ok: false, exitCode: 2 });
      const envelope = JSON.parse(String(output.mock.calls[0]?.[0]));
      expect(envelope.error.code).toBe('ambiguous_server_version');
      expect(envelope.error.fix).toContain('highest deployed is 18');
      expect(envelope.error.next).toBe('noodle deploy --version 19');
    } finally {
      output.mockRestore();
    }
  });

  it('falls back to the prompt/fail path when the hosted lookup is unavailable', async () => {
    setTty(false);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(
        resolveDeployServerVersion({
          manifestPath: '/repo/app/src/server.ts',
          deployedVersions: async () => {
            throw new Error('service unreachable');
          },
          noPrompt: true,
          json: true,
        }),
      ).resolves.toEqual({ ok: false, exitCode: 2 });
      expect(JSON.parse(String(output.mock.calls[0]?.[0])).error.code).toBe(
        'missing_server_version',
      );
    } finally {
      output.mockRestore();
    }
  });

  it('prefers an explicit flag and a versioned folder over the hosted lookup', async () => {
    const deployedVersions = vi.fn(async () => ['9']);
    await expect(
      resolveDeployServerVersion({
        manifestPath: '/repo/app/src/server.ts',
        versionFlag: '3',
        deployedVersions,
        noPrompt: true,
        json: true,
      }),
    ).resolves.toEqual({ ok: true, value: '3' });
    await expect(
      resolveDeployServerVersion({
        manifestPath: '/repo/app/v2.0.6/server.ts',
        deployedVersions,
        noPrompt: true,
        json: true,
      }),
    ).resolves.toEqual({ ok: true, value: '2.0.6' });
    expect(deployedVersions).not.toHaveBeenCalled();
  });

  it('fails without prompting when non-interactive mode blocks prompts', async () => {
    setTty(false);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        resolveDeployServerVersion({
          manifestPath: '/repo/app/src/server.ts',
          noPrompt: true,
          json: true,
        }),
      ).resolves.toEqual({ ok: false, exitCode: 2 });
      expect(JSON.parse(String(output.mock.calls[0]?.[0])).error.code).toBe(
        'missing_server_version',
      );
      expect(error).not.toHaveBeenCalled();
    } finally {
      output.mockRestore();
      error.mockRestore();
    }
  });

  it('prompts interactively when no version is available and TTYs are present', async () => {
    setTty(true);
    readlineMock.question.mockResolvedValueOnce('v01');
    readlineMock.createInterface.mockReturnValueOnce({
      close: readlineMock.close,
      question: readlineMock.question,
    });
    await expect(
      resolveDeployServerVersion({
        manifestPath: '/repo/app/src/server.ts',
        noPrompt: false,
        json: false,
      }),
    ).resolves.toEqual({ ok: true, value: '1' });
    expect(readlineMock.question).toHaveBeenCalledWith(
      'Enter server version (for example 1 or 2.0.6): ',
    );
    expect(readlineMock.close).toHaveBeenCalled();
  });
});

function setTty(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value });
}

function restoreTty(
  stream: NodeJS.ReadStream | NodeJS.WriteStream,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
  else Reflect.deleteProperty(stream, 'isTTY');
}
