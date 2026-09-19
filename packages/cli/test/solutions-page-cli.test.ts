import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSolutions } from '../src/commands/solutions-ops.js';

describe('noodle solutions page', () => {
  let home: string;
  const content = { introduction: 'Business introduction', sections: [] };
  const state = { revision: 1, draft: content, published: null, canEdit: true };
  const env = { NOODLE_SERVICE_URL: 'https://service.example', NOODLE_AUTH_TOKEN: 'private-token' };
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'noodle-page-cli-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });
  const flags = ['business', '--org', 'acme', '--json'];
  it.each([
    'show',
    'save',
    'publish',
    'unpublish',
  ])('projects %s through the authenticated typed API', async (operation) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true, data: { ...state, additive: true } }));
    const extra =
      operation === 'show'
        ? []
        : operation === 'save'
          ? ['--expected-revision', '0', '--data', JSON.stringify(content)]
          : ['--expected-revision', '1', '--confirm'];
    expect(
      await runSolutions(['page', operation, ...flags, ...extra], env, home, { fetchImpl }),
    ).toBe(0);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      `https://service.example/v1/orgs/acme/solution-installations/business/page${['publish', 'unpublish'].includes(operation) ? `/${operation}` : ''}`,
    );
    expect(init?.method).toBe(operation === 'show' ? 'GET' : operation === 'save' ? 'PUT' : 'POST');
    if (operation !== 'show')
      expect(JSON.parse(String(init?.body))).toEqual(
        operation === 'save' ? { expectedRevision: 0, content } : { expectedRevision: 1 },
      );
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain('private-token');
  });
  it.each([
    ['publish', ...flags, '--expected-revision', '1'],
    ['save', ...flags, '--expected-revision', '0', '--data', '{"private":"malformed-secret"'],
    ['show', ...flags, '--data', '{}'],
    ['unpublish', ...flags, '--expected-revision', '0', '--confirm'],
    ['save', ...flags, '--expected-revision', '2147483648', '--data', JSON.stringify(content)],
  ])('rejects invalid or unconfirmed changes without network access: %j', async (...args) => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await runSolutions(['page', ...args], env, home, { fetchImpl })).not.toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain('malformed-secret');
  });
});
