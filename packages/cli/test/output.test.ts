import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as output from '../src/commands/output.js';
import { serviceFailure } from '../src/commands/shared.js';
import { ServiceRequestError } from '../src/control-plane.js';

describe('agent-native output envelope', () => {
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints {ok:true,data} with no warnings key when there are none', () => {
    output.printJsonOk({ apps: [] });
    expect(stdout).toHaveBeenCalledOnce();
    expect(stdout).toHaveBeenCalledWith(JSON.stringify({ ok: true, data: { apps: [] } }));
    expect(stderr).not.toHaveBeenCalled();
  });

  it('includes a warnings array only when non-empty (mirrors the error envelope shape)', () => {
    output.printJsonOk({ apps: [] }, ['listing truncated to 100 apps']);
    expect(stdout).toHaveBeenCalledOnce();
    expect(stdout).toHaveBeenCalledWith(
      JSON.stringify({ ok: true, data: { apps: [] }, warnings: ['listing truncated to 100 apps'] }),
    );
    expect(stderr).not.toHaveBeenCalled();
  });

  it('prints one failure envelope to stdout and nothing to stderr', () => {
    expect(
      output.printJsonFailure(
        {
          code: 'invalid_input',
          message: 'input is invalid',
          fix: 'Correct the input.',
          next: 'noodle validate --json',
        },
        output.EXIT.USAGE,
      ),
    ).toBe(output.EXIT.USAGE);
    expect(stdout).toHaveBeenCalledOnce();
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      error: {
        code: 'invalid_input',
        message: 'input is invalid',
        fix: 'Correct the input.',
        next: 'noodle validate --json',
      },
    });
    expect(stderr).not.toHaveBeenCalled();
  });

  it('prints snapshot and event records as independently parseable NDJSON envelopes', () => {
    const printSnapshot = Reflect.get(output, 'printJsonStreamSnapshot');
    const printEvent = Reflect.get(output, 'printJsonStreamEvent');

    printSnapshot({ events: [{ id: 'initial' }] });
    printEvent({ id: 'fresh' });

    expect(stdout.mock.calls.map((call) => JSON.parse(String(call[0])))).toEqual([
      {
        ok: true,
        data: { kind: 'snapshot', snapshot: { events: [{ id: 'initial' }] } },
      },
      { ok: true, data: { kind: 'event', event: { id: 'fresh' } } },
    ]);
    expect(stderr).not.toHaveBeenCalled();
  });

  it('exposes a documented exit-code taxonomy matching the shipped serviceFailure codes', () => {
    // serviceFailure() in shared.ts already returns 3 (auth), 4 (network), 1 (failure); usage is 2;
    // 5 (mcp) is the author-loop smoke-failure code (`tools`/`resources`/`prompts`/`test`).
    expect(output.EXIT).toEqual({
      OK: 0,
      FAILURE: 1,
      USAGE: 2,
      AUTH: 3,
      UNREACHABLE: 4,
      MCP: 5,
    });
  });

  it.each([
    {
      status: 0,
      expected: {
        code: 'service_unreachable',
        exitCode: 4,
        retryable: true,
      },
    },
    {
      status: 401,
      expected: { code: 'auth_failed', exitCode: 3, retryable: false },
    },
    {
      status: 403,
      expected: { code: 'auth_failed', exitCode: 3, retryable: false },
    },
    {
      status: 429,
      expected: { code: 'rate_limited', exitCode: 1, retryable: true },
    },
    {
      status: 500,
      expected: { code: 'service_error', exitCode: 1, retryable: true },
    },
    {
      status: 422,
      expected: { code: 'service_error', exitCode: 1, retryable: false },
    },
  ])('translates service status $status into stable machine metadata', ({ status, expected }) => {
    const failure = serviceFailure(
      'apps',
      new ServiceRequestError({ status, message: 'request failed' }),
      'noodle doctor',
    );
    expect(failure).toMatchObject(expected);
  });

  // #700: a plugin-managed login mints a grant-bound credential. When the grant does not cover the
  // operation, `noodle login` remints the same grant — so the generic auth recovery sends the user
  // in a circle. The failure has to name the grant and point at re-authorization.
  it('separates an insufficient developer grant from an ordinary auth failure', () => {
    const failure = serviceFailure(
      'variables',
      new ServiceRequestError({
        status: 403,
        message: 'developer grant does not authorize this operation',
      }),
      'noodle variables list',
    );
    expect(failure).toMatchObject({
      code: 'developer_grant_insufficient',
      exitCode: output.EXIT.AUTH,
      retryable: false,
      next: 'noodle logout && noodle login',
    });
    expect(failure.fix).toContain('organization');
    expect(failure.fix).not.toContain('Sign in again and confirm org access.');
  });

  it('preserves first-party service codes and retry-after metadata', () => {
    const failure = serviceFailure(
      'feedback',
      new ServiceRequestError({
        status: 429,
        message: 'slow down',
        code: 'feedback_rate_limited',
        retryAfterSeconds: 17,
      }),
      'noodle feedback --dry-run --json',
    );
    expect(failure).toMatchObject({
      code: 'feedback_rate_limited',
      retryable: true,
      retryAfterSeconds: 17,
      exitCode: output.EXIT.FAILURE,
    });
  });
});
