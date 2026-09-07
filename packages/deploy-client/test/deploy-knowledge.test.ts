import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KnowledgeDeployError,
  prepareKnowledgeDocumentsForDeploy,
  rewriteManifestKnowledgeHashes,
} from '../src/index.js';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

function projectWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'noodle-knowledge-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text, 'utf8');
  }
  return root;
}

// Knowledge lives under `server.knowledge` in the real manifest (Core v2). The first shipped
// upload leg parsed it at the manifest root and silently no-opped on every real deploy, so this
// helper must keep the production shape.
function manifestWith(components: unknown[]): string {
  return JSON.stringify({
    manifestVersion: '1',
    server: { name: 'site', version: '1.0.0', knowledge: components },
  });
}

interface RecordedRequest {
  url: string;
  method: string;
  body?: string | Buffer;
}

function fakeService(missing: string[]): { fetchImpl: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(url),
      method: init?.method ?? 'GET',
      ...(init?.body !== undefined ? { body: init.body as string | Buffer } : {}),
    });
    if (String(url).endsWith('/knowledge/preflight')) {
      return new Response(JSON.stringify({ ok: true, missing }), { status: 200 });
    }
    const uploaded = /knowledge\/documents\/([0-9a-f]{64})$/.exec(String(url))?.[1] ?? '';
    return new Response(JSON.stringify({ ok: true, sha256: uploaded }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const target = {
  service: 'https://service.test',
  org: 'acme',
  app: 'site',
  env: 'prod',
} as const;

describe('prepareKnowledgeDocumentsForDeploy', () => {
  it('does nothing when the manifest declares no knowledge', async () => {
    const { fetchImpl, requests } = fakeService([]);
    const summary = await prepareKnowledgeDocumentsForDeploy({
      manifest: JSON.stringify({ manifestVersion: '1' }),
      rootDir: projectWith({}),
      ...target,
      fetchImpl,
    });
    expect(summary).toEqual({ checked: 0, uploaded: 0, reused: 0 });
    expect(requests).toHaveLength(0);
  });

  it('uploads exactly the missing documents from the hashed bytes', async () => {
    const root = projectWith({ 'knowledge/a.md': 'alpha text', 'knowledge/b.md': 'beta text' });
    const { fetchImpl, requests } = fakeService([sha('alpha text')]);
    const summary = await prepareKnowledgeDocumentsForDeploy({
      manifest: manifestWith([
        {
          name: 'product',
          title: 'Product',
          description: 'Docs',
          documents: [
            { path: 'knowledge/a.md', title: 'A', sha256: sha('alpha text'), bytes: 10 },
            { path: 'knowledge/b.md', title: 'B', sha256: sha('beta text'), bytes: 9 },
          ],
          sites: [],
        },
      ]),
      rootDir: root,
      ...target,
      fetchImpl,
    });
    expect(summary).toEqual({ checked: 2, uploaded: 1, reused: 1 });
    const uploads = requests.filter((request) => request.method === 'PUT');
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.url).toBe(
      `https://service.test/v1/orgs/acme/apps/site/envs/prod/knowledge/documents/${sha('alpha text')}`,
    );
    expect(Buffer.from(uploads[0]?.body as Buffer).toString('utf8')).toBe('alpha text');
  });

  it('rejects a symlinked document (no-follow open)', async () => {
    const root = projectWith({ 'real.md': 'real content' });
    symlinkSync(join(root, 'real.md'), join(root, 'link.md'));
    const { fetchImpl } = fakeService([]);
    await expect(
      prepareKnowledgeDocumentsForDeploy({
        manifest: manifestWith([
          {
            name: 'product',
            title: 'Product',
            description: 'Docs',
            documents: [{ path: 'link.md', title: 'L', sha256: sha('real content'), bytes: 12 }],
            sites: [],
          },
        ]),
        rootDir: root,
        ...target,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ stage: 'validate' });
  });

  it('rejects bytes that no longer match the compiled hash (swap race)', async () => {
    const root = projectWith({ 'knowledge/a.md': 'swapped after compile' });
    const { fetchImpl } = fakeService([]);
    await expect(
      prepareKnowledgeDocumentsForDeploy({
        manifest: manifestWith([
          {
            name: 'product',
            title: 'Product',
            description: 'Docs',
            documents: [{ path: 'knowledge/a.md', title: 'A', sha256: sha('original'), bytes: 8 }],
            sites: [],
          },
        ]),
        rootDir: root,
        ...target,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ stage: 'validate' });
  });

  it('surfaces the service fail-closed error with its fix command', async () => {
    const root = projectWith({ 'knowledge/a.md': 'alpha text' });
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          code: 'knowledge_not_enabled',
          error: 'knowledge is not enabled for this org/app/env',
          fix: 'noodle variables set NOODLE_KNOWLEDGE_ENABLED --value true',
        }),
        { status: 403 },
      )) as unknown as typeof fetch;
    const attempt = prepareKnowledgeDocumentsForDeploy({
      manifest: manifestWith([
        {
          name: 'product',
          title: 'Product',
          description: 'Docs',
          documents: [{ path: 'knowledge/a.md', title: 'A', sha256: sha('alpha text'), bytes: 10 }],
          sites: [],
        },
      ]),
      rootDir: root,
      ...target,
      fetchImpl,
    });
    await expect(attempt).rejects.toBeInstanceOf(KnowledgeDeployError);
    await expect(attempt).rejects.toMatchObject({ stage: 'preflight' });
    await expect(attempt).rejects.toThrow(/NOODLE_KNOWLEDGE_ENABLED/);
  });
});

/**
 * The regression that reached production 2026-08-17: the authored manifest carries knowledge
 * documents as bare path descriptors, and no deploy-side pass filled `sha256`/`bytes`, so the
 * service preflight rejected every knowledge-bearing deploy with `knowledge_unhashed`. This
 * rewrite is the deploy leg's half of "hashing happens in the real compile with the project root".
 */
describe('rewriteManifestKnowledgeHashes', () => {
  it('fills sha256/bytes for authored documents and preserves every sibling field', () => {
    const root = projectWith({ 'knowledge/a.md': 'alpha text' });
    const manifest = JSON.stringify({
      manifestVersion: '1',
      server: {
        name: 'site',
        version: '1.0.0',
        knowledge: [
          {
            name: 'product',
            title: 'Product',
            description: 'Docs',
            documents: [{ path: 'knowledge/a.md', title: 'A' }],
            sites: [{ origin: 'https://example.com', include: ['/docs/**'] }],
          },
        ],
      },
      tools: [{ name: 'unrelated_tool' }],
    });
    const rewritten = JSON.parse(rewriteManifestKnowledgeHashes({ manifest, rootDir: root })) as {
      server: {
        knowledge: {
          documents: { path: string; sha256?: string; bytes?: number }[];
          sites: unknown[];
        }[];
      };
      tools: unknown[];
    };
    expect(rewritten.server.knowledge[0]?.documents[0]).toMatchObject({
      path: 'knowledge/a.md',
      title: 'A',
      sha256: sha('alpha text'),
      bytes: 10,
    });
    expect(rewritten.server.knowledge[0]?.sites).toHaveLength(1);
    expect(rewritten.tools).toEqual([{ name: 'unrelated_tool' }]);
  });

  it('returns the manifest unchanged when it declares no knowledge', () => {
    const manifest = JSON.stringify({ manifestVersion: '1', server: { name: 'site' } });
    expect(rewriteManifestKnowledgeHashes({ manifest, rootDir: projectWith({}) })).toBe(manifest);
  });

  it('reports every unreadable document in one validate-stage error', () => {
    const root = projectWith({});
    const manifest = manifestWith([
      {
        name: 'product',
        title: 'Product',
        description: 'Docs',
        documents: [
          { path: 'knowledge/a.md', title: 'A' },
          { path: 'knowledge/b.md', title: 'B' },
        ],
        sites: [],
      },
    ]);
    let caught: unknown;
    try {
      rewriteManifestKnowledgeHashes({ manifest, rootDir: root });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(KnowledgeDeployError);
    expect((caught as KnowledgeDeployError).stage).toBe('validate');
    expect((caught as Error).message).toContain('knowledge/a.md');
    expect((caught as Error).message).toContain('knowledge/b.md');
  });

  it('rejects a symlinked document at rewrite time', () => {
    const root = projectWith({ 'real.md': 'real content' });
    symlinkSync(join(root, 'real.md'), join(root, 'link.md'));
    const manifest = manifestWith([
      {
        name: 'product',
        title: 'Product',
        description: 'Docs',
        documents: [{ path: 'link.md', title: 'L' }],
        sites: [],
      },
    ]);
    expect(() => rewriteManifestKnowledgeHashes({ manifest, rootDir: root })).toThrow(
      /non-symlinked/,
    );
  });

  it('is idempotent over an already-hashed manifest', () => {
    const root = projectWith({ 'knowledge/a.md': 'alpha text' });
    const manifest = manifestWith([
      {
        name: 'product',
        title: 'Product',
        description: 'Docs',
        documents: [{ path: 'knowledge/a.md', title: 'A' }],
        sites: [],
      },
    ]);
    const once = rewriteManifestKnowledgeHashes({ manifest, rootDir: root });
    expect(rewriteManifestKnowledgeHashes({ manifest: once, rootDir: root })).toBe(once);
  });
});
