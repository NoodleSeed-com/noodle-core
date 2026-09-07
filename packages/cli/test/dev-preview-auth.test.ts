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
  it('does not start local MCP or preview when generic-host OAuth readiness fails', async () => {
    expect(await runDev(['server.ts', '--preview'], {})).toBe(1);
    expect(spies.devStart).not.toHaveBeenCalled();
    expect(spies.previewStart).not.toHaveBeenCalled();
  });
});
