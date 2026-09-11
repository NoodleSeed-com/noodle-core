import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  devStart: vi.fn(),
  previewStart: vi.fn(),
}));

vi.mock('../src/validate.js', () => ({
  validate: vi.fn(async () => ({ ok: true, errors: [] })),
  isMissingDependencyError: vi.fn(() => false),
}));
vi.mock('../src/commands/auth-ops.js', () => ({
  genericHostAuthReadiness: vi.fn(async () => [
    {
      level: 'FAIL',
      name: 'MCP host discovery',
      message: 'https://app.acmehr.example/.well-known/oauth-authorization-server/oauth: HTTP 307',
      fix: 'Serve metadata directly as HTTP 200 JSON.',
    },
  ]),
}));
vi.mock('../src/dev.js', () => ({
  dev: spies.devStart,
  localMcpCall: vi.fn(),
}));
vi.mock('../src/preview-session.js', () => ({
  startPreviewSession: spies.previewStart,
  previewBannerLines: vi.fn(() => []),
}));

import { runDev } from '../src/commands/author-loop.js';
import * as project from '../src/project.js';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  spies.devStart.mockClear();
  spies.previewStart.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('noodle dev preview auth readiness', () => {
  it.each([
    {
      flags: ['--access', 'mixed'],
      env: { NOODLE_ACCESS_MODE: 'customers' },
      projectMode: 'customers',
      expected: 'mixed',
    },
    {
      flags: [],
      env: { NOODLE_ACCESS_MODE: 'mixed' },
      projectMode: 'customers',
      expected: 'mixed',
    },
    { flags: [], env: {}, projectMode: 'customers', expected: 'customers' },
    { flags: [], env: {}, projectMode: undefined, expected: undefined },
  ] as const)('preserves flag, environment and project precedence: %j', async ({
    flags,
    env,
    projectMode,
    expected,
  }) => {
    vi.spyOn(project, 'readResolvedProjectConfig').mockReturnValue(
      projectMode === undefined ? {} : { accessMode: projectMode },
    );
    spies.devStart.mockRejectedValueOnce(new Error('stop after capturing local options'));
    expect(await runDev(['server.ts', '--no-preview', ...flags], env)).toBe(1);
    expect(spies.devStart).toHaveBeenCalledWith(
      expect.objectContaining(expected === undefined ? {} : { accessMode: expected }),
    );
    if (expected === undefined)
      expect(spies.devStart.mock.calls[0]?.[0]).not.toHaveProperty('accessMode');
  });

  it('rejects a hosted project access mode before auth readiness or local startup', async () => {
    vi.spyOn(project, 'readResolvedProjectConfig').mockReturnValue({ accessMode: 'owner-only' });
    expect(await runDev(['server.ts', '--preview'], {})).toBe(2);
    expect(spies.devStart).not.toHaveBeenCalled();
    expect(spies.previewStart).not.toHaveBeenCalled();
  });

  it('does not start local MCP or preview when generic-host OAuth readiness fails', async () => {
    expect(await runDev(['server.ts', '--preview'], {})).toBe(1);
    expect(spies.devStart).not.toHaveBeenCalled();
    expect(spies.previewStart).not.toHaveBeenCalled();
  });
});
