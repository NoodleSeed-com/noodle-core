import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startStarterCandidateRegistry } from '../../../scripts/lib/starter-candidate-registry.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('isolated candidate package resolution', () => {
  it('serves only the inspected candidate version and exact tarball, never registry fallback for it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'starter-registry-'));
    roots.push(root);
    const tarball = join(root, 'candidate.tgz');
    writeFileSync(tarball, 'candidate-bytes');
    const upstream = vi.fn(async () => new Response('{}'));
    const registry = await startStarterCandidateRegistry({
      tarball,
      manifest: { name: '@noodleseed/one', version: '1.2.3' },
      fetchImpl: upstream,
    });
    try {
      const metadata = await (await fetch(`${registry.url}/@noodleseed%2fone`)).json();
      expect(Object.keys(metadata.versions)).toEqual(['1.2.3']);
      const artifact = await fetch(metadata.versions['1.2.3'].dist.tarball);
      expect(await artifact.text()).toBe('candidate-bytes');
      expect(registry.candidateRequests()).toBe(1);
      expect((await fetch(`${registry.url}/@noodleseed%2fone/9.9.9`)).status).toBe(404);
      expect(upstream).not.toHaveBeenCalled();
    } finally {
      await registry.close();
    }
  });
  it('proxies only public GET metadata without inbound authorization or arbitrary destinations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'starter-registry-'));
    roots.push(root);
    const tarball = join(root, 'candidate.tgz');
    writeFileSync(tarball, 'candidate');
    const upstream = vi.fn(
      async () =>
        new Response('{"name":"vitest"}', { headers: { 'content-type': 'application/json' } }),
    );
    const registry = await startStarterCandidateRegistry({
      tarball,
      manifest: { name: '@noodleseed/one', version: '1.2.3' },
      fetchImpl: upstream,
    });
    try {
      expect(
        (
          await fetch(`${registry.url}/vitest`, {
            headers: { authorization: 'private-test-value' },
          })
        ).status,
      ).toBe(200);
      expect(upstream.mock.calls[0]?.[0]).toBe('https://registry.npmjs.org/vitest');
      expect(upstream.mock.calls[0]?.[1]).toMatchObject({
        headers: { accept: 'application/vnd.npm.install-v1+json' },
        redirect: 'error',
      });
      expect(JSON.stringify(upstream.mock.calls)).not.toContain('private-test-value');
      expect((await fetch(`${registry.url}/vitest`, { method: 'POST' })).status).toBe(405);
      expect(upstream).toHaveBeenCalledOnce();
    } finally {
      await registry.close();
    }
  });
});
