import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, writeConfig } from '../src/index.js';

describe('expired control-plane login recovery', () => {
  let home: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'noodle-cli-expired-login-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: 'invalid_grant', error_description: 'invalid refresh token' },
            { status: 401 },
          ),
        ),
    );
    writeConfig(
      {
        serviceUrl: 'https://svc.example',
        authToken: 'expired-access-token',
        authTokenExpiresAt: new Date(0).toISOString(),
        oauthIssuer: 'https://svc.example',
        oauthClientId: 'cli-client',
        oauthRefreshToken: 'invalid-refresh-token',
        oauthResource: 'https://svc.example',
      },
      home,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  it('replaces a rejected refresh-token stack trace with a re-login prompt', async () => {
    expect(await run(['whoami'], {}, home)).toBe(3);

    expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toBe(
      'Your Noodle login has expired.\nRe-login: noodle login',
    );
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('uses the same recovery for a rejected legacy Google refresh token', async () => {
    writeConfig(
      {
        serviceUrl: 'https://svc.example',
        idToken: 'expired-id-token',
        idTokenExpiresAt: new Date(0).toISOString(),
        googleClientId: 'google-client',
        refreshToken: 'invalid-google-refresh-token',
      },
      home,
    );

    expect(await run(['whoami'], {}, home)).toBe(3);
    expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toBe(
      'Your Noodle login has expired.\nRe-login: noodle login',
    );
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('takes precedence over command-specific recovery handlers', async () => {
    expect(
      await run(['feedback', 'The CLI should handle expired sessions cleanly.'], {}, home),
    ).toBe(3);
    expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toBe(
      'Your Noodle login has expired.\nRe-login: noodle login',
    );
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('escapes the first-run wizard recovery boundary', async () => {
    expect(await run(['start', '--json', '--deploy'], {}, home)).toBe(3);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'auth_session_expired',
        next: 'noodle login',
      },
    });
  });

  it('returns the same recovery as a structured JSON failure', async () => {
    expect(await run(['whoami', '--json'], {}, home)).toBe(3);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      error: {
        code: 'auth_session_expired',
        message: 'Your Noodle login has expired.',
        cause: 'The saved refresh token was rejected.',
        fix: 'Sign in again.',
        next: 'noodle login',
      },
    });
  });

  it('does not reclassify an unrelated refresh-service failure', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(
        {
          error: 'temporarily_unavailable',
          error_description: 'The token service is temporarily unavailable.',
        },
        { status: 503 },
      ),
    );

    await expect(run(['whoami'], {}, home)).rejects.toThrow(
      'The token service is temporarily unavailable.',
    );
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
