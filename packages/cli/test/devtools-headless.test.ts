import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Shared close spies so the mocked dev/preview modules and the assertions can see the same functions.
const spies = vi.hoisted(() => {
  const sessionClose = vi.fn(async () => {});
  return {
    handleClose: vi.fn(async () => {}),
    sessionClose,
    previewStart: vi.fn(async () => ({
      close: sessionClose,
      url: 'http://127.0.0.1:8888',
    })),
    authChecks: [] as Array<{
      level: 'FAIL';
      name: string;
      message: string;
      fix?: string;
    }>,
    boot: { ok: true } as
      | { ok: true }
      | { ok: false; errors: Array<{ code: string; path: string; message: string }> },
  };
});

vi.mock('../src/validate.js', () => ({
  validate: vi.fn(async () => ({ ok: true, errors: [] })),
}));
vi.mock('../src/project.js', () => ({
  readProjectLink: vi.fn(() => undefined),
  readNoodleProjectConfig: vi.fn(() => undefined),
  resolveLinkedEntrypoint: vi.fn(() => undefined),
}));
vi.mock('../src/dev.js', () => ({
  dev: vi.fn(async () => ({
    url: 'http://127.0.0.1:9999/o/local/app/dev/mcp',
    boot: spies.boot,
    close: spies.handleClose,
  })),
}));
vi.mock('../src/commands/auth-ops.js', () => ({
  genericHostAuthReadiness: vi.fn(async () => spies.authChecks),
}));
vi.mock('../src/preview-session.js', () => ({
  startPreviewSession: spies.previewStart,
  previewBannerLines: vi.fn(
    (_session, options: { localTarget: { target: { org: string; app: string; env: string } } }) => [
      `noodle devtools ${options.localTarget.target.org}/${options.localTarget.target.app}/${options.localTarget.target.env}`,
    ],
  ),
}));

import { parseDevtoolsArgs, runDevtools } from '../src/commands/devtools.js';
import { previewBannerLines } from '../src/preview-session.js';

const flush = () => new Promise<void>((r) => setTimeout(r, 20));

let ttyBefore: boolean | undefined;
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  spies.handleClose.mockClear();
  spies.sessionClose.mockClear();
  spies.previewStart.mockClear();
  spies.boot = { ok: true };
  spies.authChecks = [];
  ttyBefore = process.stdin.isTTY;
  // Force the non-TTY branch deterministically (headless is what should keep it alive, not a TTY).
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process.stdin, 'isTTY', { value: ttyBefore, configurable: true });
});

describe('parseDevtoolsArgs --headless', () => {
  it('defaults headless to false and sets it when --headless is passed', () => {
    expect(parseDevtoolsArgs([]).headless).toBe(false);
    expect(parseDevtoolsArgs(['--headless']).headless).toBe(true);
    // Keeps parsing other args around the flag.
    expect(parseDevtoolsArgs(['server.ts', '--headless', '--theme', 'dark'])).toMatchObject({
      path: 'server.ts',
      headless: true,
      theme: 'dark',
    });
  });
});

describe('runDevtools headless lifecycle (non-TTY)', () => {
  it('does not start local MCP or preview when generic-host OAuth readiness fails', async () => {
    spies.authChecks = [
      {
        level: 'FAIL',
        name: 'MCP host discovery',
        message:
          'https://app.acmehr.example/.well-known/oauth-authorization-server/oauth: HTTP 307',
        fix: 'Serve metadata directly as HTTP 200 JSON.',
      },
    ];

    expect(await runDevtools(['server.ts'])).not.toBe(0);
    expect(spies.previewStart).not.toHaveBeenCalled();
    expect(spies.handleClose).not.toHaveBeenCalled();
  });

  it('does not start the preview when managed configuration prevents MCP boot', async () => {
    spies.boot = {
      ok: false,
      errors: [
        {
          code: 'missing_secret',
          path: 'secrets.ACMEHR_DELEG_CLIENT_SECRET',
          message: 'missing secret',
        },
      ],
    };

    expect(await runDevtools(['server.ts'])).not.toBe(0);
    expect(spies.previewStart).not.toHaveBeenCalled();
    expect(spies.handleClose).toHaveBeenCalledTimes(1);
  });

  it('without --headless, a non-TTY run shuts down immediately and returns 0', async () => {
    const code = await runDevtools(['server.ts']);
    expect(code).toBe(0);
    expect(previewBannerLines).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        localTarget: expect.objectContaining({
          mode: 'unlinked',
          target: expect.any(Object),
        }),
      }),
    );
    expect(spies.sessionClose).toHaveBeenCalledTimes(1);
    expect(spies.handleClose).toHaveBeenCalledTimes(1);
  });

  it('with --headless, a non-TTY run stays up (no synchronous shutdown) until SIGTERM', async () => {
    const pending = runDevtools(['server.ts', '--headless']);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await flush();
    // It reached the preview banner + headless wait, but must NOT have shut down yet.
    expect(settled).toBe(false);
    expect(spies.sessionClose).not.toHaveBeenCalled();
    expect(spies.handleClose).not.toHaveBeenCalled();

    // A signal cleans up and resolves the run.
    process.emit('SIGTERM');
    const code = await pending;
    expect(code).toBe(0);
    expect(spies.sessionClose).toHaveBeenCalledTimes(1);
    expect(spies.handleClose).toHaveBeenCalledTimes(1);
  });

  it('with --headless, SIGINT also cleans up and resolves the run', async () => {
    const pending = runDevtools(['server.ts', '--headless']);
    await flush();
    expect(spies.handleClose).not.toHaveBeenCalled();
    process.emit('SIGINT');
    expect(await pending).toBe(0);
    expect(spies.handleClose).toHaveBeenCalledTimes(1);
  });
});
