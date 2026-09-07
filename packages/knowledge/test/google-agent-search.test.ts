import { describe, expect, it } from 'vitest';
import { stagedDocument, testComponent, testScope } from '../src/conformance.js';
import { GoogleAgentSearchAdapter, type GoogleTransport } from '../src/google-agent-search.js';
import type { AudiencePredicate, KnowledgeScope } from '../src/ir.js';
import { KnowledgeError } from '../src/ports.js';

/**
 * The managed Google adapter runs its unit tests against a scripted transport — never network — and
 * asserts the wire-visible contract: tenant/revision/audience metadata on every import, positive
 * filters on every search, policy postfiltering before the limit, and attributable errors that
 * never carry provider bodies. The shared port suites plus the external canary (Noodle-owned
 * project) complete the acceptance picture per the roadmap.
 */

interface RecordedCall {
  readonly url: string;
  readonly body: unknown;
}

function scriptTransport(
  respond: (url: string, body: unknown) => { status: number; payload: unknown },
): { transport: GoogleTransport; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const transport: GoogleTransport = async (url, init) => {
    const body = init.body !== undefined ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ url, body });
    const { status, payload } = respond(url, body);
    return { status, json: async () => payload };
  };
  return { transport, calls };
}

const token = async () => 'test-token';

function makeAdapter(transport: GoogleTransport) {
  return new GoogleAgentSearchAdapter({
    project: 'noodle-managed',
    location: 'us-central1',
    tokenProvider: token,
    transport,
    scope: testScope,
  });
}

function documentResults(...uris: string[]) {
  return {
    results: uris.map((uri, index) => ({
      document: { id: `d${index}`, structData: { title: `Doc ${index}`, uri } },
      snippet: `snippet about pricing ${index}`,
    })),
  };
}

describe('google agent search adapter — KnowledgeIndex', () => {
  it('imports every document tagged with tenant, revision, and public audience', async () => {
    const { transport, calls } = scriptTransport(() => ({ status: 200, payload: {} }));
    const adapter = makeAdapter(transport);
    const revision = await adapter.stage(testScope, testComponent, [
      stagedDocument('knowledge/a.md', 'A', 'alpha pricing details'),
    ]);
    expect(revision.revisionId).toMatch(/^g-[0-9a-f]{24}$/);
    const importCall = calls.find((call) => call.url.includes('documents:import'));
    expect(importCall).toBeDefined();
    const body = importCall?.body as {
      inlineSource: { documents: Array<{ structData?: Record<string, string> }> };
    };
    // Live-verified 2026-08-17: inline documents nest under inlineSource (top-level rejects).
    expect(body.inlineSource.documents).toHaveLength(1);
    expect(body.inlineSource.documents[0]?.structData).toMatchObject({
      audience: 'public',
      revision: revision.revisionId,
    });
    expect(body.inlineSource.documents[0]?.structData?.tenant).toMatch(/^[0-9a-f]{24}$/);
    // Publication necessarily sends content to the provider; compiled artifacts never carry it.
  });

  it('search sends the tenant+revision+audience positive filter and maps bounded hits', async () => {
    const { transport, calls } = scriptTransport(() => ({
      status: 200,
      payload: documentResults('https://acme.example/docs/a'),
    }));
    const adapter = makeAdapter(transport);
    const revision = await adapter.stage(testScope, testComponent, [
      stagedDocument('knowledge/a.md', 'A', 'alpha'),
    ]);
    await adapter.activate(revision.revisionId);
    const hits = await adapter.search(testScope, testComponent, { query: 'pricing', limit: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.sourceKind).toBe('document');
    expect(hits[0]?.excerpt.length).toBeLessThanOrEqual(2000);
    const searchCall = calls.find((call) => call.url.includes(':search'));
    const filter = (searchCall?.body as { filter?: string }).filter;
    expect(filter).toContain('tenant: ANY("');
    expect(filter).toContain(`revision: ANY("${revision.revisionId}")`);
    expect(filter).toContain('audience: ANY("public")');
    // Provider scores and raw snippets never leak past the mapped hit.
    expect(Object.keys(hits[0] ?? {})).not.toContain('score');
  });

  it('fails search before activation with an attributable not-found', async () => {
    const { transport } = scriptTransport(() => ({ status: 200, payload: {} }));
    const adapter = makeAdapter(transport);
    await expect(
      adapter.search(testScope, testComponent, { query: 'x', limit: 5 }),
    ).rejects.toMatchObject({
      layer: 'not-found',
    });
  });

  it('attributes provider failures without propagating provider bodies', async () => {
    const { transport } = scriptTransport(() => ({
      status: 429,
      payload: { error: { message: 'quota exceeded for project noodle-managed' } },
    }));
    const adapter = makeAdapter(transport);
    await expect(
      adapter.stage(testScope, testComponent, [stagedDocument('knowledge/a.md', 'A', 'a')]),
    ).rejects.toMatchObject({ layer: 'provider', message: expect.not.stringContaining('quota') });
  });

  it('refuses a different tenant scope on the bound instance', async () => {
    const { transport } = scriptTransport(() => ({ status: 200, payload: {} }));
    const adapter = makeAdapter(transport);
    const other: KnowledgeScope = { org: 'other', app: 'other', env: 'prod' };
    await expect(
      adapter.stage(other, testComponent, [stagedDocument('knowledge/a.md', 'A', 'a')]),
    ).rejects.toBeInstanceOf(KnowledgeError);
  });
});

describe('google agent search adapter — verify is a real query, not an argument check', () => {
  /**
   * `verify` is the canary's provider acceptance gate: it must prove the just-imported revision
   * is actually searchable with the revision + public-audience filter, not merely echo its
   * arguments back. The first shipped implementation returned true without any request.
   */
  it('executes a filtered search and reports whether the revision answered', async () => {
    let searchPayload: unknown = documentResults('https://acme.test/a');
    const { transport, calls } = scriptTransport((url) =>
      url.includes(':search')
        ? { status: 200, payload: searchPayload }
        : { status: 200, payload: {} },
    );
    const adapter = makeAdapter(transport);
    const staged = await adapter.stage(testScope, testComponent, [
      stagedDocument('knowledge/a.md', 'A', 'pricing text'),
    ]);
    const predicate: AudiencePredicate = { audience: 'public', revision: staged.revisionId };

    await expect(adapter.verify(staged.revisionId, predicate)).resolves.toBe(true);
    const searchCall = calls.find((call) => call.url.includes(':search'));
    const filter = (searchCall?.body as { filter?: string }).filter ?? '';
    expect(filter).toContain(`revision: ANY("${staged.revisionId}")`);
    expect(filter).toContain('audience: ANY("public")');

    searchPayload = { results: [] };
    await expect(adapter.verify(staged.revisionId, predicate)).resolves.toBe(false);
  });
});
