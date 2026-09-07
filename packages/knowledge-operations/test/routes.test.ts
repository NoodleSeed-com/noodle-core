import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  handleKnowledgeDocumentUpload,
  handleKnowledgePreflight,
  type KnowledgeRouteDeps,
} from '../src/routes.js';
import { InMemoryKnowledgeStagingStore } from '../src/staging-store.js';

const tenant = { org: 'acme', app: 'site', env: 'prod' } as const;

function fakeReq(body: Buffer | string): import('node:http').IncomingMessage {
  const stream = Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body)]);
  return Object.assign(stream, {
    headers: {},
  }) as unknown as import('node:http').IncomingMessage;
}

interface CapturedResponse {
  status?: number;
  body?: unknown;
}

function fakeRes(captured: CapturedResponse): import('node:http').ServerResponse {
  return {
    headersSent: false,
    writeHead(status: number) {
      captured.status = status;
      return this;
    },
    end(payload?: string) {
      captured.body = payload === undefined ? undefined : JSON.parse(payload);
    },
  } as unknown as import('node:http').ServerResponse;
}

function makeDeps(overrides?: Partial<KnowledgeRouteDeps>): KnowledgeRouteDeps {
  return {
    staging: new InMemoryKnowledgeStagingStore(),
    knowledgeEnabled: async () => true,
    maxBodyBytes: 2 * 1024 * 1024,
    ...overrides,
  };
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('knowledge preflight route', () => {
  it('reports all hashes missing when nothing is staged', async () => {
    const deps = makeDeps();
    const captured: CapturedResponse = {};
    const request = {
      components: [{ name: 'product', documents: [{ sha256: sha('a'), bytes: 1 }] }],
    };
    await handleKnowledgePreflight(
      fakeReq(JSON.stringify(request)),
      fakeRes(captured),
      tenant,
      deps,
    );
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({ ok: true, missing: [sha('a')] });
  });

  /**
   * Preflight diffs against transient staging only. It cannot ask "is this whole component
   * already published?" because revision identity includes document metadata (title/path/
   * sourceUrl) the preflight wire shape deliberately never carries — a bytes-only match here
   * once told the CLI to upload nothing while publication then found no metadata-matching
   * revision and failed with knowledge_documents_missing.
   */
  it('omits hashes already staged and requests everything else', async () => {
    const deps = makeDeps();
    await deps.staging.put(
      `${tenant.org}/${tenant.app}/${tenant.env}`,
      sha('staged'),
      Buffer.from('x'),
      1,
    );
    const captured: CapturedResponse = {};
    const request = {
      components: [
        {
          name: 'product',
          documents: [
            { sha256: sha('staged'), bytes: 1 },
            { sha256: sha('missing'), bytes: 1 },
          ],
        },
        { name: 'published', documents: [{ sha256: sha('old'), bytes: 1 }] },
      ],
    };
    await handleKnowledgePreflight(
      fakeReq(JSON.stringify(request)),
      fakeRes(captured),
      tenant,
      deps,
    );
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({ ok: true, missing: [sha('missing'), sha('old')] });
  });

  it('rejects an invalid body with a structured error', async () => {
    const captured: CapturedResponse = {};
    await handleKnowledgePreflight(
      fakeReq(JSON.stringify({ components: [] })),
      fakeRes(captured),
      tenant,
      makeDeps(),
    );
    expect(captured.status).toBe(400);
    expect((captured.body as { code: string }).code).toBe('invalid_knowledge_request');
  });

  it('fails closed with the exact enable command when the gate is off', async () => {
    const captured: CapturedResponse = {};
    const request = {
      components: [{ name: 'product', documents: [{ sha256: sha('a'), bytes: 1 }] }],
    };
    await handleKnowledgePreflight(
      fakeReq(JSON.stringify(request)),
      fakeRes(captured),
      tenant,
      makeDeps({ knowledgeEnabled: async () => false }),
    );
    expect(captured.status).toBe(403);
    const body = captured.body as { code: string; fix: string };
    expect(body.code).toBe('knowledge_not_enabled');
    expect(body.fix).toContain('NOODLE_KNOWLEDGE_ENABLED');
    expect(body.fix).toContain('acme');
  });
});

describe('knowledge document upload route', () => {
  it('verifies hash and length, seals, and stores the document', async () => {
    const seen: Buffer[] = [];
    const deps = makeDeps({
      codec: {
        seal: (plaintext) => {
          seen.push(plaintext);
          return Buffer.concat([Buffer.from('S'), plaintext]);
        },
        open: (sealed) => sealed.subarray(1),
      },
    });
    const captured: CapturedResponse = {};
    const text = 'hello knowledge';
    await handleKnowledgeDocumentUpload(fakeReq(text), fakeRes(captured), tenant, sha(text), deps);
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({ ok: true, sha256: sha(text) });
    expect(seen).toHaveLength(1);
    const stored = await deps.staging.get(`${tenant.org}/${tenant.app}/${tenant.env}`, sha(text));
    expect(stored?.toString('utf8')).toBe(`S${text}`);
  });

  it('rejects bytes whose hash does not match the addressed hash', async () => {
    const deps = makeDeps();
    const captured: CapturedResponse = {};
    await handleKnowledgeDocumentUpload(
      fakeReq('tampered'),
      fakeRes(captured),
      tenant,
      sha('original'),
      deps,
    );
    expect(captured.status).toBe(400);
    expect((captured.body as { code: string }).code).toBe('knowledge_document_hash_mismatch');
    expect(
      await deps.staging.has(`${tenant.org}/${tenant.app}/${tenant.env}`, sha('original')),
    ).toBe(false);
  });

  it('rejects an oversized document before hashing', async () => {
    const deps = makeDeps({ maxBodyBytes: 8 });
    const captured: CapturedResponse = {};
    await handleKnowledgeDocumentUpload(
      fakeReq('way past the tiny limit'),
      fakeRes(captured),
      tenant,
      sha('way past the tiny limit'),
      deps,
    );
    expect(captured.status).toBe(413);
  });

  it('fails closed when the gate is off', async () => {
    const deps = makeDeps({ knowledgeEnabled: async () => false });
    const captured: CapturedResponse = {};
    await handleKnowledgeDocumentUpload(fakeReq('x'), fakeRes(captured), tenant, sha('x'), deps);
    expect(captured.status).toBe(403);
  });

  it('rejects an invalid sha path segment', async () => {
    const deps = makeDeps();
    const captured: CapturedResponse = {};
    await handleKnowledgeDocumentUpload(fakeReq('x'), fakeRes(captured), tenant, 'not-a-sha', deps);
    expect(captured.status).toBe(400);
    expect((captured.body as { code: string }).code).toBe('invalid_knowledge_request');
  });
});
