import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryControlPlaneStore, type RunningService, serveService } from '@noodle-borg/service';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { accessModeNote } from '../src/commands/deploy-status-ops.js';
import { isAccessMode } from '../src/commands/shared.js';
import { deploy, run } from '../src/index.js';

// `public`/`mixed` serve anonymous MCP (ADR 0055). The runtime + service have supported them since B11
// landed; the CLI `--access` / `access set` surface was the only place that still rejected them. These
// lock the selection surface that reaches the anonymous modes, alongside the identity modes.
const here = dirname(fileURLToPath(import.meta.url));
const helloManifest = join(here, '..', '..', '..', 'examples', 'hello', 'src', 'server.ts');

let service: RunningService;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const controlPlane = new InMemoryControlPlaneStore();
  service = await serveService({
    port: 0,
    controlPlaneStore: controlPlane,
    deployGate: {
      authorize: () =>
        Promise.resolve({
          ok: true,
          identity: { subject: 'owner-sub', email: 'owner@noodleseed.com', superAdmin: true },
        }),
    },
  });
});

afterAll(async () => {
  await service.close();
  logSpy.mockRestore();
});

describe('noodle access-mode selection surface', () => {
  it('accepts every service-supported access mode and rejects unknown / removed ones', () => {
    for (const mode of [
      'owner-only',
      'org-members',
      'authenticated',
      'public',
      'mixed',
      'customers',
    ]) {
      expect(isAccessMode(mode)).toBe(true);
    }
    expect(isAccessMode('caller-key')).toBe(false);
    expect(isAccessMode('team')).toBe(false);
    expect(isAccessMode(undefined)).toBe(false);
  });

  it('has a human note for each anonymous access mode', () => {
    expect(accessModeNote('public')).toMatch(/anyone/i);
    expect(accessModeNote('mixed')).toMatch(/optional/i);
  });

  it('deploys public through the full run() dispatch (loopback service needs no account)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'noodle-cli-access-'));
    try {
      const code = await run(
        [
          'deploy',
          helloManifest,
          '--access',
          'public',
          '--service',
          service.url,
          '--version',
          '1',
          '--no-prompt',
        ],
        {},
        home,
      );
      expect(code).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('deploys mixed against the live service and round-trips the mode', async () => {
    const outcome = await deploy({
      manifestPath: helloManifest,
      accessMode: 'mixed',
      serviceUrl: service.url,
    });
    expect(outcome.ok, outcome.ok ? '' : outcome.message).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.accessMode).toBe('mixed');
    expect(outcome.callerKey).toBeUndefined();
  });
});
