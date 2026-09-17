import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCapabilityArgs, runCapabilities } from '../src/commands/capabilities.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
describe('capability CLI', () => {
  it('has explicit target, policy revision and diagnostic-mode flags', () => {
    expect(
      parseCapabilityArgs([
        'configure',
        'pages',
        '--org',
        'acme',
        '--app',
        'web',
        '--env',
        'staging',
        '--policy-file',
        'policy.json',
        '--expected-revision',
        '0',
        '--mutation-id',
        'first',
        '--json',
      ]),
    ).toMatchObject({
      positional: ['configure', 'pages'],
      org: 'acme',
      app: 'web',
      targetEnv: 'staging',
      policyFile: 'policy.json',
      expectedRevision: '0',
      mutationId: 'first',
      json: true,
    });
    expect(parseCapabilityArgs(['--unsafe']).parseError).toBeDefined();
  });
  it('configures through the scoped API, and refuses test calls without an explicit mode before I/O', async () => {
    const home = mkdtempSync(join(tmpdir(), 'noodle-cap-cli-'));
    dirs.push(home);
    const policy = join(home, 'policy.json');
    const request = join(home, 'request.json');
    writeFileSync(policy, JSON.stringify({ enabled: true, dailyCalls: 10 }));
    writeFileSync(request, JSON.stringify({ urls: ['https://example.com/'] }));
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ revision: 1 }), { status: 200 }),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const common = [
      '--org',
      'acme',
      '--app',
      'web',
      '--env',
      'staging',
      '--service',
      'http://127.0.0.1:9999',
      '--json',
    ];
    expect(
      await runCapabilities(
        [
          'configure',
          'pages',
          ...common,
          '--policy-file',
          policy,
          '--expected-revision',
          '0',
          '--mutation-id',
          'first',
        ],
        {},
        home,
        { fetchImpl },
      ),
    ).toBe(0);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'http://127.0.0.1:9999/v1/orgs/acme/apps/web/envs/staging/capabilities/pages/policy',
    );
    expect(
      await runCapabilities(['test', 'pages', ...common, '--request-file', request], {}, home, {
        fetchImpl,
      }),
    ).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
