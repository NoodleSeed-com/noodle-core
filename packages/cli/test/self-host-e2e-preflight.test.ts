import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runSelfHostE2E } from '../../../scripts/lib/self-host-e2e.mjs';

describe('projected self-host acceptance preflight', () => {
  it('rejects a project-relative Docker oracle before invoking anything', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noodle-self-host-e2e-docker-path-'));
    writeFileSync(join(root, 'package.json'), '{"name":"noodle-core"}\n');
    const run = vi.fn();

    try {
      await expect(
        runSelfHostE2E({
          root,
          projectName: 'noodle-e2e-a1b2c3d4',
          dockerPath: 'node_modules/.bin/docker',
          runner: { run },
          fetch,
        }),
      ).rejects.toThrow(/absolute Docker path/i);
      expect(run).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a project-relative Node oracle before invoking anything', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noodle-self-host-e2e-node-path-'));
    writeFileSync(join(root, 'package.json'), '{"name":"noodle-core"}\n');
    const run = vi.fn();

    try {
      await expect(
        runSelfHostE2E({
          root,
          projectName: 'noodle-e2e-a1b2c3d4',
          nodePath: 'node_modules/.bin/node',
          runner: { run },
          fetch,
        }),
      ).rejects.toThrow(/absolute Node path/i);
      expect(run).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses existing operator state without invoking or deleting anything', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noodle-self-host-e2e-owned-root-'));
    writeFileSync(join(root, 'package.json'), '{"name":"noodle-core"}\n');
    mkdirSync(join(root, '.self-host'));
    writeFileSync(join(root, '.self-host', 'operator-state'), 'keep me');
    const run = vi.fn();

    try {
      await expect(
        runSelfHostE2E({
          root,
          projectName: 'noodle-e2e-a1b2c3d4',
          runner: { run },
          fetch,
        }),
      ).rejects.toThrow('self-host E2E requires a checkout without existing operator state');
      expect(run).not.toHaveBeenCalled();
      expect(readFileSync(join(root, '.self-host', 'operator-state'), 'utf8')).toBe('keep me');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a private or unknown checkout before invoking anything', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noodle-self-host-e2e-private-root-'));
    writeFileSync(join(root, 'package.json'), '{"name":"noodle-borg"}\n');
    const run = vi.fn();

    try {
      await expect(
        runSelfHostE2E({
          root,
          projectName: 'noodle-e2e-a1b2c3d4',
          runner: { run },
          fetch,
        }),
      ).rejects.toThrow('self-host E2E must run from a materialized Noodle Core tree');
      expect(run).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
