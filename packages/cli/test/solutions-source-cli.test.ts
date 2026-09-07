import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runSolutions } from '../src/commands/solutions-ops.js';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'source-cli-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});
const env = {
  NOODLE_SERVICE_URL: 'https://cloud.example.test',
  NOODLE_AUTH_TOKEN: 'fixture-token',
};
const args = [
  'sources',
  'refresh',
  'installation',
  'stock',
  '--org',
  'acme',
  '--expected-revision',
  '1',
  '--idempotency-key',
  'original',
];

it.each([
  'queued',
  'running',
  'completed',
  'superseded',
])('reports the actual %s refresh state without claiming immediate collection freshness', async (state) => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const fetchImpl = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          ok: true,
          data: {
            source: {},
            job: {
              id: 'sync_one',
              state,
              coalesced: true,
              requestedAt: '2026-09-07T00:00:00Z',
              ...(state === 'completed' || state === 'superseded'
                ? { replayExpiresAt: '2026-10-07T00:00:00Z' }
                : {}),
            },
          },
        }),
        { status: 202, headers: { 'content-type': 'application/json' } },
      ),
  );
  expect(await runSolutions(args, env, directory, { fetchImpl })).toBe(0);
  expect(output.mock.calls.map((call) => call.join(' ')).join('\n')).toContain(
    `source refresh ${state}`,
  );
});

it('returns typed capacity refusal and does not retry the mutation', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetchImpl = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ code: 'source_capacity_exceeded', error: 'Reference storage is full.' }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      ),
  );
  expect(await runSolutions([...args, '--json'], env, directory, { fetchImpl })).not.toBe(0);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(output.mock.calls)).toContain('source_capacity_exceeded');
});
