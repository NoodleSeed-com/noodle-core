import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DeployRun, renderRunsTable, runGithubRuns } from '../src/commands/github-runs-ops.js';
import { run, writeConfig } from '../src/index.js';
import { chdirIsolated, restoreCwd } from './helpers/isolated-cwd.js';

/**
 * `noodle github runs` (GHD-2) against its public HTTP contract. Service implementation behavior is
 * covered by service-owned tests; this suite proves the CLI request, response, and rendering boundary.
 */

const SERVICE = 'https://service.example';
let home: string;
let runs: DeployRun[];
let stdoutLines: string[];
let stderrLines: string[];
let outSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-github-runs-cli-'));
  chdirIsolated(home);
  stdoutLines = [];
  stderrLines = [];
  outSpy = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
    stdoutLines.push(String(msg));
  });
  errSpy = vi.spyOn(console, 'error').mockImplementation((msg?: unknown) => {
    stderrLines.push(String(msg));
  });
  runs = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(input.toString());
    const limit = Number(url.searchParams.get('limit') ?? runs.length);
    return Response.json({
      ok: true,
      data: {
        runs: runs.slice(0, limit),
        truncated: runs.length > limit,
      },
    });
  });
  writeConfig({ serviceUrl: SERVICE, authToken: 'owner-token' }, home);
});

afterEach(() => {
  restoreCwd();
  outSpy.mockRestore();
  errSpy.mockRestore();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

function stdout(): string {
  return stdoutLines.join('\n');
}

async function seedRun(overrides: Record<string, unknown> = {}): Promise<void> {
  runs.push({
    runId: 'run-abc123def456',
    orgSlug: 'acme',
    appSlug: 'support-bot',
    envName: 'prod',
    sourceEvent: 'push',
    deliveryId: `d-${Math.random().toString(16).slice(2)}`,
    githubRepositoryId: 1001,
    commitSha: 'abcdef1234567890',
    ref: 'refs/heads/main',
    status: 'queued',
    actorLogin: 'octocat',
    createdAt: '2026-07-06T09:30:00.000Z',
    ...overrides,
  } as DeployRun);
}

describe('noodle github runs', () => {
  it('renders the branded RUN/EVENT/COMMIT/ENV/STATUS/AGE table', async () => {
    await seedRun();
    await seedRun({
      runId: 'run-pr7',
      envName: 'pr-7',
      sourceEvent: 'pull_request',
      prNumber: 7,
      commitSha: 'fedcba0987654321',
      blockedReason: 'fork_pending_approval',
    });
    const code = await run(['github', 'runs', '--org', 'acme', '--app', 'support-bot'], {}, home);
    expect(code).toBe(0);
    const out = stdout();
    for (const header of ['RUN', 'EVENT', 'COMMIT', 'ENV', 'STATUS', 'AGE']) {
      expect(out).toContain(header);
    }
    expect(out).toContain('abcdef1'); // short sha
    expect(out).toContain('push');
    expect(out).toContain('PR #7');
    expect(out).toContain('queued (fork)');
  });

  it('--json emits the {runs, truncated} envelope', async () => {
    await seedRun();
    const code = await run(
      ['github', 'runs', '--org', 'acme', '--app', 'support-bot', '--json'],
      {},
      home,
    );
    expect(code).toBe(0);
    const body = JSON.parse(stdout());
    expect(body.ok).toBe(true);
    expect(body.data.runs).toHaveLength(1);
    expect(body.data.runs[0]).toMatchObject({
      envName: 'prod',
      sourceEvent: 'push',
      status: 'queued',
    });
    expect(body.data.truncated).toBe(false);
  });

  it('--limit caps the feed and surfaces the truncation note', async () => {
    await seedRun({ runId: 'run-a', envName: 'pr-1', deliveryId: 'd-a', commitSha: 'sha-a' });
    await seedRun({ runId: 'run-b', envName: 'pr-2', deliveryId: 'd-b', commitSha: 'sha-b' });
    const code = await run(
      ['github', 'runs', '--org', 'acme', '--app', 'support-bot', '--limit', '1'],
      {},
      home,
    );
    expect(code).toBe(0);
    expect(stdout()).toContain('older runs not shown');
  });

  it('prints the guided empty state when no runs exist', async () => {
    const code = await run(['github', 'runs', '--org', 'acme', '--app', 'support-bot'], {}, home);
    expect(code).toBe(0);
    expect(stdout()).toContain('No deploy runs');
    expect(stdout()).toContain('noodle github connect');
  });

  it('--watch conflicts with --json (exit 2, structured error)', async () => {
    const code = await runGithubRuns(
      ['--org', 'acme', '--app', 'support-bot', '--json', '--watch'],
      {},
      home,
    );
    expect(code).toBe(2);
    const body = JSON.parse(stdout());
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('watch_json_conflict');
    expect(stderrLines).toEqual([]);
  });

  it('github --help lists the runs subcommand', async () => {
    expect(await run(['github', '--help'], {}, home)).toBe(0);
    expect(stdout()).toContain('runs');
  });
});

describe('github-runs-response.json contract drift gate', () => {
  it('feeds the golden fixture through the CLI DeployRun render without shape drift', () => {
    const fixturePath = join(
      import.meta.dirname,
      '..',
      '..',
      '..',
      'contract',
      'v1',
      'github-runs-response.json',
    );
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      readonly ok: true;
      readonly data: { readonly runs: readonly DeployRun[]; readonly truncated: boolean };
    };
    expect(fixture.data.runs.length).toBeGreaterThan(0);
    const rendered = renderRunsTable(fixture.data.runs, { color: 'none', glyph: 'unicode' });
    expect(rendered).toContain('prod');
    expect(rendered).toContain('pr-42');
    expect(rendered).toContain('PR #42');
    expect(rendered).toContain('6dcb09b');
    expect(rendered).toContain('queued (fork)');
    expect(rendered).toContain('superseded');
  });
});
