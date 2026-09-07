import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryControlPlaneStore, type RunningService, serveService } from '@noodle-borg/service';
import { FEEDBACK_MESSAGE_MAX, type FeedbackSubmission } from '@noodle-borg/wire-contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryFeedbackIssueClient } from '../../feedback-operations/src/github-feedback-issues.js';
// The feedback intake route lives in the commercial UNLICENSED module; an Apache package can never
// depend on it, so this slice test imports the route source directly (boundary-gate allowlisted).
import {
  createFeedbackIntakeRoute,
  FeedbackRateLimiter,
} from '../../feedback-operations/src/routes-intake.js';
import { buildFeedbackPayload } from '../src/commands/feedback-ops.js';
import { run, writeConfig } from '../src/index.js';

/**
 * `noodle feedback` verified against a real in-process service instance (unified CLI↔service
 * slice test, same pattern as `apps.test.ts`): local flag validation fails fast before any
 * network call, submissions land as labeled issues in the InMemory feedback client, and the
 * transparency contract (diagnostics echoed to the user) holds.
 */

let service: RunningService;
let issues: InMemoryFeedbackIssueClient;
let home: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  issues = new InMemoryFeedbackIssueClient();
  // The real module intake route through the real module-route dispatch — only the collaborators
  // are test-local, exactly as the service-side tests inject them.
  const feedbackModule = {
    name: 'feedback-operations-test',
    version: '0.0.0',
    apiVersion: 1,
    init: async () => ({
      routes: [
        createFeedbackIntakeRoute({
          feedbackIssues: issues,
          limiter: new FeedbackRateLimiter(() => new Date()),
          maxBody: 1 << 20,
          clock: () => new Date(),
        }),
      ],
    }),
  };
  service = await serveService({
    port: 0,
    controlPlaneStore: new InMemoryControlPlaneStore(),
    modules: [feedbackModule],
    deployGate: {
      authorize: (req) => {
        const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        if (token !== 'dev-token')
          return Promise.resolve({ ok: false, status: 401, message: 'missing bearer token' });
        return Promise.resolve({
          ok: true,
          identity: { subject: 'dev-sub', email: 'dev@acme.test', superAdmin: false },
        });
      },
    },
    verifyOwnerToken: () => Promise.resolve(null),
    authServerIssuer: 'https://as.noodle.test',
  });
});

afterAll(async () => {
  await service.close();
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-feedback-cli-'));
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  logSpy.mockRestore();
  errSpy.mockRestore();
  rmSync(home, { recursive: true, force: true });
});

function stdout(): string {
  return logSpy.mock.calls.map((call) => String(call[0])).join('\n');
}

function stderr(): string {
  return errSpy.mock.calls.map((call) => String(call[0])).join('\n');
}

function loggedIn(): void {
  writeConfig({ serviceUrl: service.url, authToken: 'dev-token' }, home);
}

const DIAG = { cliVersion: '0.4.0', platform: 'darwin arm64 24.5.0', nodeVersion: 'v24.2.0' };

describe('buildFeedbackPayload', () => {
  it('maps flags and positional message to the wire payload with diagnostics', () => {
    const result = buildFeedbackPayload(
      [
        'drops idle streams',
        '--type',
        'fix',
        '--severity',
        'p2',
        '--area',
        'cli',
        '--title',
        'idle streams',
        '--agent',
        'codex',
        '--model',
        'gpt-5.6-sol',
      ],
      DIAG,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toEqual({
      message: 'drops idle streams',
      title: 'idle streams',
      type: 'fix',
      severity: 'P2',
      area: 'cli',
      codingAgent: { name: 'codex', model: 'gpt-5.6-sol' },
      diagnostics: DIAG,
    });
  });

  it('requires an agent when a model is supplied', () => {
    const result = buildFeedbackPayload(['message', '--model', 'gpt-5.6-sol'], DIAG);
    expect(result).toMatchObject({
      ok: false,
      error: {
        errors: [
          {
            code: 'missing_dependency',
            path: 'model',
            expected: '--agent <name> with --model',
          },
        ],
      },
    });
  });

  it('rejects unknown enum values locally', () => {
    expect(buildFeedbackPayload(['m', '--type', 'bug'], DIAG).ok).toBe(false);
    expect(buildFeedbackPayload(['m', '--severity', 'P9'], DIAG).ok).toBe(false);
    expect(buildFeedbackPayload(['m', '--area', 'nope'], DIAG).ok).toBe(false);
  });

  it('accepts equals-form value flags', () => {
    expect(
      buildFeedbackPayload(
        ['message', '--title=short title', '--type=fix', '--severity=p1', '--area=cli'],
        DIAG,
      ),
    ).toEqual({
      ok: true,
      payload: {
        message: 'message',
        title: 'short title',
        type: 'fix',
        severity: 'P1',
        area: 'cli',
        diagnostics: DIAG,
      },
    });
  });

  it('rejects an unknown flag instead of ignoring it', () => {
    expect(buildFeedbackPayload(['message', '--private'], DIAG).ok).toBe(false);
    expect(buildFeedbackPayload(['-x'], DIAG).ok).toBe(false);
  });

  it('rejects a value flag whose value is missing', () => {
    expect(buildFeedbackPayload(['message', '--title'], DIAG).ok).toBe(false);
  });

  it('rejects a duplicate flag instead of accepting the last value', () => {
    expect(buildFeedbackPayload(['message', '--type', 'fix', '--type', 'docs'], DIAG).ok).toBe(
      false,
    );
  });

  it('rejects simultaneous positional and --message input', () => {
    expect(buildFeedbackPayload(['positional message', '--message', 'flag message'], DIAG).ok).toBe(
      false,
    );
  });

  it('rejects extra positional arguments', () => {
    expect(buildFeedbackPayload(['first message', 'second message'], DIAG).ok).toBe(false);
  });
});

describe('noodle feedback', () => {
  it('fails locally on an invalid flag value without reaching the service', async () => {
    loggedIn();
    const before = issues.issues.length;
    expect(await run(['feedback', 'msg', '--type', 'bug'], {}, home)).toBe(2);
    expect(issues.issues.length).toBe(before);
  });

  it('requires a login token', async () => {
    writeConfig({ serviceUrl: service.url }, home);
    expect(await run(['feedback', 'some message'], {}, home)).toBe(3);
  });

  it('fails fast when non-interactive and no message is given', async () => {
    loggedIn();
    expect(await run(['feedback'], {}, home)).toBe(2);
  });

  it('returns an actionable field error for a rejected enum literal', async () => {
    expect(await run(['feedback', 'message', '--type', 'bug', '--json'], {}, home)).toBe(2);
    expect(JSON.parse(stdout())).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_feedback',
        errors: [
          {
            code: 'invalid_value',
            path: 'type',
            expected: 'fix | feat | docs | chore',
            got: 'bug',
          },
        ],
      },
    });
    expect(stderr()).toBe('');
  });

  it('reports a token-shaped rejected enum as a safe string descriptor', async () => {
    const marker = ['sk', 'proj', 'customer', 'secret'].join('-');
    expect(await run(['feedback', 'message', '--type', marker, '--json'], {}, home)).toBe(2);
    const out = stdout();
    expect(JSON.parse(out)).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_feedback',
        errors: [
          {
            code: 'invalid_value',
            path: 'type',
            got: `string (length ${marker.length})`,
          },
        ],
      },
    });
    expect(out).not.toContain(marker);
    expect(stderr()).toBe('');
  });

  it('does not expose an unknown flag inline value in its JSON usage failure', async () => {
    const marker = 'private-customer-content';
    expect(await run(['feedback', 'message', `--private=${marker}`, '--json'], {}, home)).toBe(2);
    const out = stdout();
    expect(JSON.parse(out)).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_feedback',
        errors: [{ code: 'unknown_flag', path: 'arguments', got: '--private' }],
      },
    });
    expect(out).not.toContain(marker);
    expect(stderr()).toBe('');
  });

  it('does not expose either auth token when rejecting a duplicate sensitive flag', async () => {
    const firstToken = ['first', 'private', 'token'].join('-');
    const secondToken = ['second', 'private', 'token'].join('-');
    expect(
      await run(
        ['feedback', 'message', '--auth-token', firstToken, '--auth-token', secondToken, '--json'],
        {},
        home,
      ),
    ).toBe(2);
    const out = stdout();
    expect(JSON.parse(out)).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_feedback',
        errors: [{ code: 'duplicate_flag', path: 'auth-token' }],
      },
    });
    expect(out).not.toContain(firstToken);
    expect(out).not.toContain(secondToken);
    expect(stderr()).toBe('');
  });

  it('rejects a single-dash option instead of treating it as a preview message', async () => {
    expect(await run(['feedback', '-x', '--dry-run', '--json'], {}, home)).toBe(2);
    expect(JSON.parse(stdout())).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_feedback',
        errors: [{ code: 'unknown_flag', path: 'arguments', got: '-x' }],
      },
    });
    expect(stderr()).toBe('');
  });

  it('keeps a malformed equals-form --json usage failure on stdout without exposing its value', async () => {
    const marker = 'private-customer-content';
    expect(await run(['feedback', 'message', `--json=${marker}`], {}, home)).toBe(2);
    const out = stdout();
    expect(JSON.parse(out)).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_feedback',
        errors: [{ code: 'unexpected_value', path: 'json' }],
      },
    });
    expect(out).not.toContain(marker);
    expect(stderr()).toBe('');
  });

  it('reports a rejected string by safe type and length without echoing its content', async () => {
    const marker = 'private-customer-content';
    const message = `${marker}${'x'.repeat(FEEDBACK_MESSAGE_MAX + 1 - marker.length)}`;
    expect(await run(['feedback', message, '--json'], {}, home)).toBe(2);
    const out = stdout();
    expect(JSON.parse(out)).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_feedback',
        errors: [
          {
            code: 'invalid_length',
            path: 'message',
            expected: `string length 1-${FEEDBACK_MESSAGE_MAX}`,
            got: `string (length ${FEEDBACK_MESSAGE_MAX + 1})`,
          },
        ],
      },
    });
    expect(out).not.toContain(marker);
    expect(stderr()).toBe('');
  });

  it('previews the exact JSON submission without login or a network request', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('dry-run must not reach the network');
    });
    vi.stubGlobal('fetch', fetch);
    const before = issues.issues.length;

    expect(
      await run(
        [
          'feedback',
          'preview this finding',
          '--title',
          'Preview title',
          '--type',
          'fix',
          '--severity',
          'p1',
          '--area',
          'cli',
          '--agent',
          'codex',
          '--model',
          'gpt-5.6-sol',
          '--dry-run',
          '--json',
        ],
        {},
        home,
      ),
    ).toBe(0);

    expect(JSON.parse(stdout())).toEqual({
      ok: true,
      data: {
        mode: 'preview',
        willSubmit: false,
        destination: 'Noodle Seed private feedback tracker',
        submission: {
          message: 'preview this finding',
          title: 'Preview title',
          type: 'fix',
          severity: 'P1',
          area: 'cli',
          codingAgent: {
            name: 'codex',
            model: 'gpt-5.6-sol',
          },
          diagnostics: {
            cliVersion: expect.any(String),
            platform: expect.any(String),
            nodeVersion: process.version,
          },
        },
      },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(issues.issues.length).toBe(before);
    expect(stderr()).toBe('');
  });

  it('states clearly in human dry-run mode that nothing was sent', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('dry-run must not reach the network');
    });
    vi.stubGlobal('fetch', fetch);
    const before = issues.issues.length;

    expect(await run(['feedback', 'human preview', '--dry-run'], {}, home)).toBe(0);

    expect(stdout()).toContain('Nothing was sent.');
    expect(stdout()).toContain('Noodle Seed private feedback tracker');
    expect(fetch).not.toHaveBeenCalled();
    expect(issues.issues.length).toBe(before);
  });

  it('uses the same defaults and diagnostics in preview and the subsequent live request', async () => {
    expect(await run(['feedback', 'parity finding', '--dry-run', '--json'], {}, home)).toBe(0);
    const preview = JSON.parse(stdout()) as {
      readonly ok: true;
      readonly data: { readonly submission: FeedbackSubmission };
    };
    expect(preview.data.submission).toMatchObject({
      message: 'parity finding',
      type: 'feat',
      severity: 'P3',
    });

    logSpy.mockClear();
    writeConfig({ serviceUrl: 'https://feedback.example', authToken: 'secret-token' }, home);
    const requests: FeedbackSubmission[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)) as FeedbackSubmission);
        return Response.json(
          { ok: true, data: { reference: 'fb-parity', labels: ['feedback'] } },
          { status: 201 },
        );
      }),
    );

    expect(await run(['feedback', 'parity finding', '--json'], {}, home)).toBe(0);
    expect(requests).toEqual([preview.data.submission]);
  });

  it.each([
    {
      status: 401,
      body: { error: 'authentication required' },
      expectedCode: 'auth_failed',
      expectedExit: 3,
      retryable: false,
    },
    {
      status: 429,
      body: {
        error: 'feedback rate limit reached; try again later',
        code: 'feedback_rate_limited',
      },
      expectedCode: 'feedback_rate_limited',
      expectedExit: 1,
      retryable: true,
      retryAfterSeconds: 17,
    },
    {
      status: 503,
      body: { error: 'feedback is not configured on this service', code: 'feedback_unavailable' },
      expectedCode: 'feedback_unavailable',
      expectedExit: 1,
      retryable: true,
    },
    {
      status: 502,
      body: {
        error: 'failed to record feedback; try again later',
        code: 'feedback_recording_failed',
      },
      expectedCode: 'feedback_recording_failed',
      expectedExit: 1,
      retryable: false,
    },
  ])('preserves the $expectedCode service failure in the JSON envelope', async ({
    status,
    body,
    expectedCode,
    expectedExit,
    retryable,
    retryAfterSeconds,
  }) => {
    writeConfig({ serviceUrl: 'https://feedback.example', authToken: 'private-auth-token' }, home);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(body, {
          status,
          ...(retryAfterSeconds !== undefined
            ? { headers: { 'retry-after': String(retryAfterSeconds) } }
            : {}),
        }),
      ),
    );

    expect(await run(['feedback', 'safe approved finding', '--json'], {}, home)).toBe(expectedExit);
    expect(JSON.parse(stdout())).toMatchObject({
      ok: false,
      error: {
        code: expectedCode,
        retryable,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      },
    });
    expect(stdout()).not.toContain('private-auth-token');
    expect(stderr()).toBe('');
  });

  it('treats recording failures as an unknown outcome that must not be retried automatically', async () => {
    writeConfig({ serviceUrl: 'https://feedback.example', authToken: 'private-auth-token' }, home);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            error: 'failed to record feedback; try again later',
            code: 'feedback_recording_failed',
          },
          { status: 502 },
        ),
      ),
    );

    expect(await run(['feedback', 'safe approved finding', '--json'], {}, home)).toBe(1);
    expect(JSON.parse(stdout())).toEqual({
      ok: false,
      error: {
        code: 'feedback_recording_failed',
        message: 'Feedback recording outcome is unknown; the private issue may already exist.',
        cause: 'Feedback recording outcome is unknown; the private issue may already exist.',
        fix: 'Do not retry automatically; contact Noodle Seed support to confirm the outcome.',
        next: 'Wait for confirmation before submitting again.',
        retryable: false,
      },
    });
    expect(stderr()).toBe('');
  });

  it('does not expose untrusted service codes or request identifiers', async () => {
    const codeMarker = 'private/customer/path';
    const requestMarker = ['private', 'request', 'token'].join('-');
    writeConfig({ serviceUrl: 'https://feedback.example', authToken: 'private-auth-token' }, home);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: 'upstream failure', code: codeMarker },
          { status: 502, headers: { 'x-request-id': requestMarker } },
        ),
      ),
    );

    expect(await run(['feedback', 'safe approved finding', '--json'], {}, home)).toBe(1);
    const out = stdout();
    expect(JSON.parse(out)).toMatchObject({
      ok: false,
      error: {
        code: 'feedback_recording_failed',
        retryable: false,
      },
    });
    expect(out).not.toContain(codeMarker);
    expect(out).not.toContain(requestMarker);
    expect(stderr()).toBe('');
  });

  it('preserves the safe first-party client compatibility failure with update recovery', async () => {
    writeConfig({ serviceUrl: 'https://feedback.example', authToken: 'private-auth-token' }, home);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: 'unsupported client version', code: 'client_version_unsupported' },
          { status: 409 },
        ),
      ),
    );

    expect(await run(['feedback', 'safe approved finding', '--json'], {}, home)).toBe(1);
    expect(JSON.parse(stdout())).toEqual({
      ok: false,
      error: {
        code: 'client_version_unsupported',
        message: 'This Noodle CLI version is not supported by the feedback service.',
        cause: 'This Noodle CLI version is not supported by the feedback service.',
        fix: 'Update the Noodle Seed CLI to a supported version.',
        next: 'noodle update',
        retryable: false,
      },
    });
    expect(stderr()).toBe('');
  });

  it('sanitizes service, environment, token, path, and customer content from live failures', async () => {
    const serviceMarker = 'customer/private/service-path';
    const tokenMarker = ['private', 'auth', 'token'].join('-');
    const messageMarker = 'private customer finding';

    expect(
      await run(
        ['feedback', messageMarker, '--json'],
        { NOODLE_SERVICE_URL: serviceMarker, NOODLE_AUTH_TOKEN: tokenMarker },
        home,
      ),
    ).toBe(4);
    const out = stdout();
    expect(JSON.parse(out)).toMatchObject({
      ok: false,
      error: {
        code: 'service_unreachable',
        message: 'The feedback service could not be reached.',
      },
    });
    expect(out).not.toContain(serviceMarker);
    expect(out).not.toContain(tokenMarker);
    expect(out).not.toContain(messageMarker);
    expect(out).not.toContain(home);
    expect(stderr()).toBe('');
  });

  it('envelopes and sanitizes authentication-resolution failures on stdout', async () => {
    const issuerMarker = 'https://auth.example/private-path';
    const refreshMarker = ['private', 'refresh', 'token'].join('-');
    const upstreamMarker = 'customer auth provider detail';
    writeConfig(
      {
        serviceUrl: 'https://feedback.example',
        oauthIssuer: issuerMarker,
        oauthClientId: 'feedback-client',
        oauthRefreshToken: refreshMarker,
      },
      home,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(upstreamMarker);
      }),
    );

    expect(await run(['feedback', 'safe approved finding', '--json'], {}, home)).toBe(3);
    const out = stdout();
    expect(JSON.parse(out)).toMatchObject({
      ok: false,
      error: {
        code: 'auth_failed',
        message: 'Feedback authentication could not be resolved.',
        retryable: false,
      },
    });
    expect(out).not.toContain(issuerMarker);
    expect(out).not.toContain(refreshMarker);
    expect(out).not.toContain(upstreamMarker);
    expect(out).not.toContain(home);
    expect(stderr()).toBe('');
  });

  it('submits and prints the reference and diagnostics in human mode', async () => {
    loggedIn();
    expect(
      await run(
        [
          'feedback',
          'logs --follow drops idle streams',
          '--type',
          'fix',
          '--area',
          'cli',
          '--severity',
          'P2',
          '--agent',
          'codex',
          '--model',
          'gpt-5.6-sol',
        ],
        {},
        home,
      ),
    ).toBe(0);
    const out = stdout();
    expect(out).toContain('fb-1');
    expect(out.toLowerCase()).toContain('diagnostics');
    const issue = issues.issues[0];
    expect(issue?.labels).toEqual([
      'feedback',
      'never-public',
      'P2',
      'type:fix',
      'area:cli',
      'feedback:agent-authored',
    ]);
    expect(issue?.title).toBe('[feedback] logs --follow drops idle streams');
    expect(issue?.body).toContain('logs --follow drops idle streams');
    expect(issue?.body).toContain('dev@acme.test');
    expect(issue?.body).toContain('## Coding agent (client-reported)');
    expect(issue?.body).toContain('| Agent | codex |');
    expect(issue?.body).toContain('| Model | gpt-5.6-sol |');
  });

  it('prints a machine envelope with --json', async () => {
    loggedIn();
    expect(await run(['feedback', 'json mode feedback', '--json'], {}, home)).toBe(0);
    const parsed = JSON.parse(stdout()) as {
      ok: boolean;
      data: { reference: string; labels: string[] };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.reference).toMatch(/^fb-\d+$/);
    expect(parsed.data.labels).toContain('feedback');
  });

  it('maps the service rate limit to a friendly retry-later failure', async () => {
    loggedIn();
    // Two submissions above; the window allows 5 per subject per hour.
    for (let i = 0; i < 3; i++) {
      expect(await run(['feedback', `filler ${i}`], {}, home)).toBe(0);
    }
    expect(await run(['feedback', 'sixth submission'], {}, home)).toBe(1);
    expect(stderr().toLowerCase()).toContain('rate limit');
  });
});
