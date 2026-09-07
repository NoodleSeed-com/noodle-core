import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DESIGN_AGENT_INSTRUCTION } from '../src/devtools-design-brief.js';
import type { DesignSessionV1 } from '../src/devtools-design-contract.js';
import { handleDesignRoute } from '../src/devtools-design-routes.js';
import { type DesignStore, DesignStoreConflictError } from '../src/devtools-design-store.js';
import { startPreview } from '../src/devtools-preview.js';

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
  while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true });
});

async function designPreview() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'noodle-design-routes-'));
  roots.push(projectRoot);
  const preview = await startPreview({
    mcpUrl: 'http://127.0.0.1:9/o/local/app/dev/mcp',
    theme: 'both',
    device: 'both',
    design: {
      projectRoot,
      entrypoint: 'src/server.ts',
    },
  });
  closers.push(preview.close);
  return { preview, projectRoot };
}

function target() {
  return {
    tagName: 'button',
    role: 'button',
    accessibleName: 'Search stores',
    visibleText: 'Search stores',
    stableId: 'search-stores',
    classNames: ['primary'],
    authorHints: { testId: 'search-stores' },
    ancestry: [],
    siblingIndex: 0,
    siblingCount: 1,
    rect: { x: 10, y: 10, width: 160, height: 40 },
    computedStyles: { 'background-color': 'rgb(0, 0, 0)' },
    resolution: { confidence: 100, evidence: ['stable id'], status: 'resolved' },
  } as const;
}

describe('devtools Design routes', () => {
  it('creates, persists, and returns a trusted project-local draft', async () => {
    const { preview } = await designPreview();
    const route = new URL('/design/session', preview.url);
    route.searchParams.set('toolName', 'open_ordering');
    route.searchParams.set('resourceUri', 'ui://food-ordering/open-ordering');
    route.searchParams.set('width', '820');
    route.searchParams.set('height', '640');
    route.searchParams.set('device', 'desktop');
    route.searchParams.set('theme', 'dark');

    const createdResponse = await fetch(route);
    const created = (await createdResponse.json()) as {
      ok: true;
      session: DesignSessionV1;
    };
    expect(createdResponse.status).toBe(200);
    expect(createdResponse.headers.get('cache-control')).toBe('no-store');
    expect(created.session).toMatchObject({
      version: 1,
      status: 'draft',
      project: {
        entrypoint: 'src/server.ts',
        toolName: 'open_ordering',
        resourceUri: 'ui://food-ordering/open-ordering',
      },
      viewport: { width: 820, height: 640, device: 'desktop', theme: 'dark' },
    });

    const updated: DesignSessionV1 = {
      ...created.session,
      updatedAt: new Date(Date.parse(created.session.updatedAt) + 1000).toISOString(),
      annotations: [
        {
          id: 'annotation-1',
          intent: 'Make this the primary action.',
          target: target(),
          changes: [
            {
              property: 'background-color',
              from: 'rgb(0, 0, 0)',
              to: '#ff6b35',
            },
          ],
          acceptanceCriteria: ['The action remains readable.'],
          preserve: ['Keep the label and click behavior.'],
        },
      ],
    };
    const put = await fetch(new URL('/design/session', preview.url), {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'if-unmodified-since': created.session.updatedAt,
      },
      body: JSON.stringify(updated),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ ok: true, session: updated });
  });

  it('finalizes the meaningful draft and returns only the clipboard delivery instruction', async () => {
    const { preview } = await designPreview();
    const route = new URL('/design/session?toolName=open_ordering', preview.url);
    const created = (await (await fetch(route)).json()) as {
      ok: true;
      session: DesignSessionV1;
    };
    const updated: DesignSessionV1 = {
      ...created.session,
      updatedAt: new Date(Date.parse(created.session.updatedAt) + 1000).toISOString(),
      annotations: [
        {
          id: 'annotation-1',
          intent: 'Reduce the empty space above this action.',
          target: target(),
          changes: [],
          acceptanceCriteria: [],
          preserve: [],
        },
      ],
    };
    await fetch(new URL('/design/session', preview.url), {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'if-unmodified-since': created.session.updatedAt,
      },
      body: JSON.stringify(updated),
    });

    const finalized = await fetch(new URL('/design/finalize', preview.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedUpdatedAt: updated.updatedAt }),
    });
    const payload = await finalized.json();

    expect(finalized.status).toBe(200);
    expect(payload).toEqual({
      ok: true,
      delivery: { kind: 'clipboard', instruction: DESIGN_AGENT_INSTRUCTION },
    });
    expect(JSON.stringify(payload)).not.toContain('annotation-1');
    expect(JSON.stringify(payload)).not.toContain('Reduce the empty space');
  });

  it('rejects invalid media types, oversized bodies, and stale writes safely', async () => {
    const { preview } = await designPreview();
    const wrongMedia = await fetch(new URL('/design/session', preview.url), {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(wrongMedia.status).toBe(415);

    const oversized = await fetch(new URL('/design/session', preview.url), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'x'.repeat(256 * 1024 + 1) }),
    });
    expect(oversized.status).toBe(413);

    const created = (await (
      await fetch(new URL('/design/session?toolName=open_ordering', preview.url))
    ).json()) as { session: DesignSessionV1 };
    const stale = await fetch(new URL('/design/session', preview.url), {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'if-unmodified-since': '2026-07-29T00:00:00.000Z',
      },
      body: JSON.stringify(created.session),
    });
    expect(stale.status).toBe(409);
    expect(JSON.stringify(await stale.json())).not.toContain('Search stores');
  });

  it('returns the concurrently created draft when initial creation loses a race', async () => {
    const routes = await import('../src/devtools-design-routes.js');
    const readOrCreate = (
      routes as typeof routes & {
        readOrCreateDesignDraft?: (
          store: DesignStore,
          url: URL,
          context: { projectRoot: string; entrypoint: string },
        ) => DesignSessionV1;
      }
    ).readOrCreateDesignDraft;
    expect(readOrCreate).toBeTypeOf('function');
    if (!readOrCreate) return;

    const raced = {
      ...draftSession(),
      id: '7b575167-690d-4886-9c63-bcbad2e2713d',
      project: { entrypoint: 'src/server.ts', toolName: 'existing_widget' },
    };
    let reads = 0;
    const store: DesignStore = {
      readDraft() {
        reads++;
        return reads === 1 ? undefined : raced;
      },
      writeDraft() {
        throw new DesignStoreConflictError(raced);
      },
      finalize() {
        throw new Error('not used');
      },
      readLatest() {
        return undefined;
      },
    };

    expect(
      readOrCreate(store, new URL('http://127.0.0.1/design/session?toolName=new_widget'), {
        projectRoot: '/tmp/project',
        entrypoint: 'src/server.ts',
      }),
    ).toEqual(raced);
    expect(reads).toBe(2);
  });

  it('maps a corrupt draft encountered during PUT to storage recovery', async () => {
    const { preview, projectRoot } = await designPreview();
    const created = (await (
      await fetch(new URL('/design/session?toolName=open_ordering', preview.url))
    ).json()) as { session: DesignSessionV1 };
    const designDirectory = join(projectRoot, '.noodle', 'design');
    mkdirSync(designDirectory, { recursive: true });
    writeFileSync(join(designDirectory, 'draft.json'), '{not-json');

    const response = await fetch(new URL('/design/session', preview.url), {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'if-unmodified-since': created.session.updatedAt,
      },
      body: JSON.stringify(created.session),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: 'design_storage_invalid',
        message: 'Local Design storage needs recovery.',
      },
    });
  });

  it('terminates an undeclared oversized request after returning 413', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'noodle-design-route-stream-'));
    roots.push(projectRoot);
    const request = new PassThrough() as PassThrough & {
      headers: Record<string, string>;
      method: string;
    };
    request.headers = { 'content-type': 'application/json' };
    request.method = 'PUT';
    const destroy = vi.spyOn(request, 'destroy');
    const response = {
      writeHead: vi.fn(),
      end: vi.fn(),
    };

    expect(
      handleDesignRoute(
        request as never,
        response as never,
        new URL('http://127.0.0.1/design/session'),
        { projectRoot, entrypoint: 'src/server.ts' },
      ),
    ).toBe(true);
    request.write(Buffer.alloc(256 * 1024 + 1, 1));

    expect(response.writeHead).toHaveBeenCalledWith(
      413,
      expect.objectContaining({ 'content-type': 'application/json; charset=utf-8' }),
    );
    expect(destroy).toHaveBeenCalled();
  });
});

function draftSession(): DesignSessionV1 {
  const now = '2026-07-29T12:00:00.000Z';
  return {
    version: 1,
    id: '6e90cfd0-b7ea-401d-9d8f-ff6d063d26ce',
    status: 'draft',
    project: { entrypoint: 'src/server.ts', toolName: 'open_ordering' },
    viewport: { width: 820, height: 640, device: 'desktop', theme: 'dark' },
    createdAt: now,
    updatedAt: now,
    annotations: [],
  };
}
