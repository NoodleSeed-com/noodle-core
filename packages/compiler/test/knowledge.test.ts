import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileManifest } from '../src/compile.js';

/**
 * Knowledge compile pass (ADR 0202): authored declarations lower to descriptors + content hashes +
 * generated-tool metadata; every structural limit fails with a precise `server.knowledge[…]` path;
 * compiled artifacts never contain document bytes.
 */

const fixturesRoot = join(import.meta.dirname, 'fixtures', 'knowledge');

function manifest(knowledge: unknown, options: { readonly tools?: 'none' } = {}): unknown {
  return {
    manifestVersion: '2',
    server: {
      name: 'acme_site',
      title: 'Acme Site',
      version: '1.0.0',
      ...(knowledge === undefined ? {} : { knowledge }),
    },
    tools:
      options.tools === 'none'
        ? []
        : [
            {
              name: 'ping',
              description: 'Ping.',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              fulfilment: { use: 'acme.look_up', args: {} },
            },
          ],
    ...(options.tools === 'none' ? {} : { connectors: { acme: { id: 'acme', version: '1.0.0' } } }),
  };
}

const component = (documents: unknown, sites: unknown[] = []) => ({
  name: 'product',
  title: 'Product knowledge',
  description: 'Public product, pricing, and support information.',
  documents,
  sites,
});

function compileWith(knowledge: unknown, rootDir: string | undefined) {
  return compileManifest(manifest(knowledge), {
    ...(rootDir === undefined ? {} : { knowledgeFiles: { rootDir } }),
  });
}

describe('knowledge compile pass', () => {
  it('lowers authored documents to hashed descriptors and generated-tool metadata', () => {
    const result = compileWith(
      [
        component(
          [
            {
              path: 'docs/product.md',
              title: 'Product guide',
              sourceUrl: 'https://acme.test/docs',
            },
            { path: 'docs/faq.txt', title: 'Product FAQ' },
          ],
          [{ origin: 'https://www.acme.test', include: ['/docs/**', '/pricing'] }],
        ),
      ],
      fixturesRoot,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const compiled = result.artifact.server.knowledge;
    expect(compiled).toHaveLength(1);
    const first = compiled?.[0];
    expect(first?.name).toBe('product');
    expect(first?.documents).toHaveLength(2);
    expect(first?.documents[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first?.documents[0]?.bytes).toBeGreaterThan(0);
    expect(first?.sites[0]?.origin).toBe('https://www.acme.test');
    expect(first?.generatedTool.name).toBe('search_product');
    expect(first?.generatedTool.inputSchema).toMatchObject({
      type: 'object',
      required: ['query'],
    });
    // Artifacts carry descriptors, never bytes: no document content may appear anywhere.
    const serialized = JSON.stringify(result.artifact);
    expect(serialized).not.toContain('regional data residency');
    expect(serialized).not.toContain('free tier');
  });

  it('accepts already-compiled hashed descriptors without a project root', () => {
    const result = compileWith(
      [component([{ path: 'docs/product.md', title: 'Guide', sha256: 'a'.repeat(64), bytes: 10 }])],
      undefined,
    );
    expect(result.ok).toBe(true);
  });

  it('fails authored (unhashed) documents without a project root', () => {
    const result = compileWith(
      [component([{ path: 'docs/product.md', title: 'Guide' }])],
      undefined,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const unhashed = result.errors.filter((error) => error.code === 'knowledge_unhashed');
    expect(unhashed).toHaveLength(1);
    expect(unhashed[0]?.path).toBe('server.knowledge[0].documents[0]');
  });

  it('rejects disallowed extensions and missing files with precise paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'noodle-knowledge-'));
    writeFileSync(join(root, 'ok.md'), 'fine');
    const result = compileWith(
      [
        component([
          { path: 'docs/bad.pdf', title: 'Bad' },
          { path: 'missing.md', title: 'Missing' },
        ]),
      ],
      root,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const invalid = result.errors.filter((error) => error.code === 'invalid_knowledge');
    expect(invalid.map((error) => error.path)).toEqual([
      'server.knowledge[0].documents[0].path',
      'server.knowledge[0].documents[1].path',
    ]);
  });

  it('rejects root-escaping document paths at the shape gate', () => {
    const result = compileWith(
      [component([{ path: '../escape.md', title: 'Escape' }])],
      fixturesRoot,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects symlinked documents', () => {
    const root = mkdtempSync(join(tmpdir(), 'noodle-knowledge-'));
    writeFileSync(join(root, 'real.md'), 'content');
    symlinkSync(join(root, 'real.md'), join(root, 'link.md'));
    const result = compileWith([component([{ path: 'link.md', title: 'Link' }])], root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.message.includes('non-symlinked'))).toBe(true);
  });

  it('rejects non-UTF-8 and oversize documents', () => {
    const root = mkdtempSync(join(tmpdir(), 'noodle-knowledge-'));
    writeFileSync(join(root, 'binary.md'), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(1024 * 1024 + 1));
    const result = compileWith(
      [
        component([
          { path: 'binary.md', title: 'Binary' },
          { path: 'big.txt', title: 'Big' },
        ]),
      ],
      root,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const messages = result.errors.map((error) => error.message).join('\n');
    expect(messages).toContain('UTF-8');
    expect(messages).toContain('bytes; the limit is');
  });

  it('rejects duplicate component names and generated-tool collisions', () => {
    const result = compileWith(
      [
        component([{ path: 'docs/product.md', title: 'A' }]),
        component([{ path: 'docs/faq.txt', title: 'B' }]),
      ],
      fixturesRoot,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.errors.some((error) => error.message.includes('duplicate knowledge component name')),
    ).toBe(true);
  });

  it('projects knowledge capabilities through the website allowlist', () => {
    const withAssistant = manifest([
      component([{ path: 'docs/product.md', title: 'Product guide' }]),
    ]) as { server: Record<string, unknown> };
    withAssistant.server.assistant = {
      model: {
        kind: 'openai-compatible',
        baseUrl: 'https://models.test/v1',
        model: 'demo',
        apiKey: 'ASSISTANT_MODEL_API_KEY',
      },
      allowedOrigins: ['https://www.acme.test'],
      surfaces: [
        {
          mode: 'public',
          origins: ['https://www.acme.test'],
          capabilities: [{ kind: 'knowledge', name: 'product' }],
        },
      ],
    };
    const result = compileManifest(withAssistant, { knowledgeFiles: { rootDir: fixturesRoot } });
    expect(result.ok).toBe(true);

    const unknown = { ...withAssistant };
    unknown.server = {
      ...withAssistant.server,
      assistant: {
        ...(withAssistant.server.assistant as object),
        surfaces: [
          {
            mode: 'public',
            origins: ['https://www.acme.test'],
            capabilities: [{ kind: 'knowledge', name: 'ghost' }],
          },
        ],
      },
    };
    const rejected = compileManifest(unknown, { knowledgeFiles: { rootDir: fixturesRoot } });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(
      rejected.errors
        .filter((error) => error.code === 'assistant_capability_unknown')
        .map((error) => error.message),
    ).toEqual([expect.stringContaining('ghost')]);
  });

  it('enforces the per-component document-count bound', () => {
    const documents = Array.from({ length: 101 }, (_, index) => ({
      path: `docs/product.md`,
      title: `Doc ${index}`,
      sha256: 'a'.repeat(64),
      bytes: 1,
    }));
    const result = compileWith([component(documents)], undefined);
    expect(result.ok).toBe(false);
  });
});

describe('knowledge satisfies the Core tool minimum', () => {
  it('compiles a knowledge-only server: the generated search capability is its callable surface', () => {
    const result = compileManifest(
      manifest([component([{ path: 'docs/product.md', title: 'Product guide' }])], {
        tools: 'none',
      }),
      { knowledgeFiles: { rootDir: fixturesRoot } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.tools).toHaveLength(0);
    expect(result.artifact.server.knowledge?.[0]?.generatedTool.name).toBe('search_product');
  });

  it('still rejects a server with neither tools nor knowledge', () => {
    const result = compileManifest(manifest(undefined, { tools: 'none' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Pin the code and path, not zod's locale message text.
    expect(
      result.errors.some((error) => error.code === 'invalid_shape' && error.path === 'tools'),
    ).toBe(true);
  });
});
