import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSolutions } from '../src/commands/solutions-ops.js';

describe('noodle solutions drafts', () => {
  let directory: string;
  let log: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  const id = '019e6c86-5838-4000-8000-019e6c865838';
  const env = {
    NOODLE_SERVICE_URL: 'https://service.example.test',
    NOODLE_AUTH_TOKEN: 'fixture-token',
  };
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'noodle-draft-cli-'));
    writeFileSync(join(directory, 'server.ts'), '// authored TypeScript\nexport default {};');
    writeFileSync(join(directory, '.env'), 'PRIVATE_VALUE=not-source');
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    log.mockRestore();
    error.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  });
  const flags = ['--org', 'acme', '--app', 'assistant', '--json'];

  it('uploads exact bounded TypeScript source, not environment files or caller authority', async () => {
    const source = {
      entrypoint: 'server.ts',
      files: [{ path: 'server.ts', content: '// authored TypeScript\nexport default {};' }],
    };
    const draft = {
      id,
      org: 'acme',
      app: 'assistant',
      environment: 'prod',
      revision: 1,
      source,
      sourceDigest: 'a'.repeat(64),
      createdAt: '2026-09-18T00:00:00Z',
      updatedAt: '2026-09-18T00:00:00Z',
      createdBySubject: 'owner',
      updatedBySubject: 'owner',
      origin: 'manual',
    };
    const fetchImpl = vi.fn(async () => Response.json({ ok: true, data: { draft } }));
    const exit = await runSolutions(
      [
        'drafts',
        'create',
        ...flags,
        '--env',
        'prod',
        '--source-dir',
        directory,
        '--idempotency-key',
        'create-one',
      ],
      env,
      directory,
      { fetchImpl },
    );
    expect(exit).toBe(0);
    const call = fetchImpl.mock.calls[0];
    expect(call).toBeDefined();
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://service.example.test/v1/orgs/acme/apps/assistant/drafts',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ environment: 'prod', source }),
      }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_VALUE');
    expect(JSON.stringify(log.mock.calls)).not.toContain('fixture-token');
  });

  it('requires an exact revision and confirmation before erasing source', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    expect(
      await runSolutions(
        ['drafts', 'delete', id, ...flags, '--expected-revision', '2'],
        env,
        directory,
        { fetchImpl },
      ),
    ).not.toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      await runSolutions(
        ['drafts', 'delete', id, ...flags, '--expected-revision', '2', '--confirm'],
        env,
        directory,
        { fetchImpl },
      ),
    ).toBe(0);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining(`/drafts/${id}`),
      expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ expectedRevision: 2 }) }),
    );
  });

  it('does not follow source symlinks outside the selected directory', async () => {
    mkdirSync(join(directory, 'source'));
    symlinkSync(join(directory, 'server.ts'), join(directory, 'source', 'server.ts'));
    const fetchImpl = vi.fn();
    expect(
      await runSolutions(
        [
          'drafts',
          'create',
          ...flags,
          '--env',
          'prod',
          '--source-dir',
          join(directory, 'source'),
          '--idempotency-key',
          'create-one',
        ],
        env,
        directory,
        { fetchImpl },
      ),
    ).not.toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('projects list and undo through the same tenant API without hidden local state', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true, data: { drafts: [] } }));
    expect(await runSolutions(['drafts', 'list', ...flags], env, directory, { fetchImpl })).toBe(0);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://service.example.test/v1/orgs/acme/apps/assistant/drafts',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(
      await runSolutions(
        ['drafts', 'undo', id, ...flags, '--target-revision', '1'],
        env,
        directory,
        { fetchImpl },
      ),
    ).not.toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('validates explicit diff revisions and projects authenticated comparison results', async () => {
    const diff = {
      draftId: id,
      fromRevision: 1,
      toRevision: 2,
      fromDigest: 'a'.repeat(64),
      toDigest: 'b'.repeat(64),
      fromEntrypoint: 'server.ts',
      toEntrypoint: 'server.ts',
      changes: [{ path: 'server.ts', before: 'original', after: 'changed' }],
    };
    const fetchImpl = vi.fn(async () => Response.json({ ok: true, data: { diff } }));
    expect(
      await runSolutions(['drafts', 'diff', id, ...flags, '--from-revision', '1'], env, directory, {
        fetchImpl,
      }),
    ).not.toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      await runSolutions(
        ['drafts', 'diff', id, ...flags, '--from-revision', '1', '--to-revision', '2'],
        env,
        directory,
        { fetchImpl },
      ),
    ).toBe(0);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining(`/drafts/${id}/diff?from=1&to=2`),
      expect.objectContaining({ method: 'GET' }),
    );
    expect(JSON.stringify(log.mock.calls)).toContain('changed');
  });

  it.each([
    ['list', '--source-dir', '/unused'],
    ['show', id, '--confirm'],
    ['edit', id, '--env', 'staging'],
    ['delete', id, '--idempotency-key', 'unused'],
    ['create', '--expected-revision', '1'],
    ['undo', id, '--entrypoint', 'server.ts'],
  ])('rejects flags outside the selected operation: %s', async (...operation) => {
    const fetchImpl = vi.fn();
    expect(
      await runSolutions(['drafts', ...operation, ...flags], env, directory, { fetchImpl }),
    ).not.toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
