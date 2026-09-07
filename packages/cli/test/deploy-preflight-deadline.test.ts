import { afterEach, describe, expect, it, vi } from 'vitest';
import { preflightHostedDeploy } from '../src/commands/deploy-preflight.js';
import { readDeployInput } from '../src/deploy.js';

vi.mock('../src/deploy.js', () => ({
  readDeployInput: vi.fn(async () => ({
    rootDir: process.cwd(),
    manifest: JSON.stringify({
      manifestVersion: '1',
      server: { name: 'deadline', version: '1.0.0', title: 'Deadline' },
      tools: [],
    }),
  })),
}));

afterEach(() => vi.useRealTimers());

const input = {
  manifestPath: 'server.ts',
  serviceUrl: 'https://service.example',
  token: 'private-token',
  target: { org: 'acme', app: 'support', env: 'prod' },
  serverVersion: '32',
};
const ready = {
  ok: true,
  ready: true,
  target: { ...input.target, appState: 'existing', environmentState: 'existing' },
  config: { ready: true, missingSecrets: [], missingVariables: [] },
  errors: [],
};

describe('preflight network deadline', () => {
  it('rejects an oversized expanded request locally before sending bytes', async () => {
    vi.mocked(readDeployInput).mockResolvedValueOnce({
      rootDir: process.cwd(),
      manifest: JSON.stringify({
        widgets: [
          {
            name: 'oversized',
            view: {
              compiledHtml: 'x'.repeat(32 * 1024 * 1024),
            },
          },
        ],
      }),
    });
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(preflightHostedDeploy({ ...input, fetchImpl })).rejects.toMatchObject({
      code: 'deploy_payload_too_large',
      phase: 'preflight.validation',
      message: expect.stringContaining('largest widget bundles: oversized 32.00 MiB'),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('accepts a successful 18-second check without an automatic second request', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(Response.json(ready)), 18_000);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );
    const pending = preflightHostedDeploy({ ...input, fetchImpl }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(18_000);
    expect(await pending).toMatchObject({ result: { response: ready } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reports an unknown readiness outcome after 75 seconds with elapsed time and correlation', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    const pending = preflightHostedDeploy({ ...input, fetchImpl }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(75_000);
    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(await pending).toMatchObject({
      status: 0,
      code: 'deploy_preflight_timeout',
      phase: 'preflight',
      requestId: headers.get('x-request-id'),
      elapsedMs: 75_000,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
