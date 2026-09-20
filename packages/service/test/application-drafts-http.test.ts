import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InMemoryDailyCounterStore } from '@noodle-borg/admission-limits/portable';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApplicationDraftCompiler } from '../dist/application-drafts/compiler.js';
import { DraftValidationUnavailableError } from '../src/application-drafts/contracts.js';
import { InMemoryApplicationDraftBackend } from '../src/application-drafts/memory.js';
import { ApplicationDraftStore } from '../src/application-drafts/store.js';
import { BusinessMemoryLocks } from '../src/business-information/in-memory-locks.js';
import { InMemoryBusinessWorkspaceBackend } from '../src/business-workspaces/memory.js';
import { BusinessWorkspaceStore } from '../src/business-workspaces/store.js';
import { ServerRegistry } from '../src/registry.js';
import { createServiceHandler } from '../src/service.js';

const compiler = new ApplicationDraftCompiler();
afterAll(() => compiler.close());

describe.each([
  true,
  false,
])('authenticated application draft API (managed records enabled=%s)', (businessInformationEnabled) => {
  let server: Server;
  let base: string;
  let workspaces: BusinessWorkspaceStore;
  let drafts: ApplicationDraftStore;
  let compileDraft: ApplicationDraftCompiler['compile'];
  const source = {
    entrypoint: 'server.ts',
    files: [{ path: 'server.ts', content: '// customer-private\nexport default {};' }],
  };
  beforeEach(async () => {
    const locks = new BusinessMemoryLocks();
    workspaces = new BusinessWorkspaceStore(new InMemoryBusinessWorkspaceBackend(locks), {
      isIdentityActive: async () => true,
    });
    await workspaces.initializeNewWorkspace({ org: 'acme', ownerSubject: 'owner' });
    const invite = await workspaces.invite({
      org: 'acme',
      actor: 'owner',
      email: 'builder@example.test',
      role: 'builder',
      expectedRevision: 1,
    });
    await workspaces.accept({
      org: 'acme',
      subject: 'builder',
      verifiedEmail: 'builder@example.test',
      token: invite.token,
    });
    drafts = new ApplicationDraftStore(new InMemoryApplicationDraftBackend(locks), {
      authorize: async (scope, actor, permission) =>
        (await workspaces.authorize(scope.org, actor, permission)) === 'allowed',
    });
    compileDraft = (source) => compiler.compile(source);
    const publicCounters = new InMemoryDailyCounterStore();
    server = createServer(
      createServiceHandler(new ServerRegistry(), {
        businessAuthoring: {
          drafts,
          workspaces,
          compiler: { compile: (source) => compileDraft(source) },
        },
        businessInformationEnabled,
        admissionCounters: publicCounters,
        maxDeployBodyBytes: 2 * 1024 * 1024,
        deployGate: {
          authorize: async (request) => {
            const subject = request.headers.authorization?.replace(/^Bearer /, '');
            return subject
              ? {
                  ok: true,
                  identity: {
                    subject,
                    email: `${subject}@example.test`,
                    superAdmin: subject === 'super-admin',
                  },
                }
              : { ok: false, status: 401, message: 'Sign in required' };
          },
        },
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/orgs/acme/apps/assistant/drafts`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  function request(
    method = 'GET',
    suffix = '',
    body?: unknown,
    subject = 'builder',
    key = randomUUID(),
  ) {
    return fetch(`${base}${suffix}`, {
      method,
      headers: {
        ...(subject ? { authorization: `Bearer ${subject}` } : {}),
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  it('requires staff authority even for super-admin and never returns customer source on rejection', async () => {
    if (!businessInformationEnabled)
      expect((await fetch(`${new URL(base).origin}/v1/solutions/catalog`)).status).toBe(404);
    expect((await request('GET', '', undefined, '')).status).toBe(401);
    for (const actor of ['stranger', 'super-admin']) {
      const response = await request('POST', '', { source, environment: 'prod' }, actor);
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain('customer-private');
    }
  });

  it('creates, reads, edits, undoes and erases exact source with revision conflicts', async () => {
    const response = await request('POST', '', { source, environment: 'prod' });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const {
      data: { draft },
    } = await response.json();
    expect(draft.revision).toBe(1);
    expect(draft.source).toEqual(source);
    const changedSource = { ...source, files: [{ path: 'server.ts', content: 'changed' }] };
    expect(
      (await request('PATCH', `/${draft.id}`, { source: changedSource, expectedRevision: 1 }))
        .status,
    ).toBe(200);
    expect((await request('PATCH', `/${draft.id}`, { source, expectedRevision: 1 })).status).toBe(
      409,
    );
    const undo = await request('POST', `/${draft.id}/undo`, {
      expectedRevision: 2,
      targetRevision: 1,
    });
    expect(await undo.json()).toMatchObject({ data: { draft: { revision: 3, source } } });
    const history = await request('GET', `/${draft.id}/history`);
    expect(history.status).toBe(200);
    expect(await history.text()).not.toContain('customer-private');
    const diff = await request('GET', `/${draft.id}/diff?from=1&to=2`);
    expect(await diff.json()).toMatchObject({
      data: { diff: { changes: [{ path: 'server.ts', after: 'changed' }] } },
    });
    expect((await request('GET', `/${draft.id}/diff?from=1&from=2`)).status).toBe(400);
    expect(
      (await request('GET', `/${draft.id}/diff?from=1&to=2`, undefined, 'stranger')).status,
    ).toBe(403);
    expect((await request('POST', `/${draft.id}/diff`, {})).status).toBe(405);
    expect(await (await request('GET')).text()).not.toContain('customer-private');
    expect((await request('DELETE', `/${draft.id}`, { expectedRevision: 3 })).status).toBe(204);
    expect((await request('GET', `/${draft.id}`)).status).toBe(404);
  });

  it('rejects caller-authored authority and malformed revision queries', async () => {
    const response = await request('POST', '', {
      source,
      environment: 'prod',
      createdBySubject: 'owner',
      org: 'victim',
    });
    expect(response.status).toBe(400);
    expect((await request('GET', `/${randomUUID()}?revision=NaN`)).status).toBe(400);
    expect((await request('GET', `/${randomUUID()}?revision=1&revision=2`)).status).toBe(400);
  });

  it.each([
    ['busy', 429],
    ['unavailable', 503],
  ] as const)('fails closed when compilation is %s', async (code, status) => {
    const {
      data: { draft },
    } = await (await request('POST', '', { source, environment: 'prod' })).json();
    compileDraft = async () => {
      throw new DraftValidationUnavailableError(code);
    };
    const response = await request('POST', `/${draft.id}/validate`, { expectedRevision: 1 });
    expect(response.status).toBe(status);
    if (code === 'busy') expect(response.headers.get('retry-after')).toBe('2');
    expect(await response.text()).not.toContain('customer-private');
  });

  it('validates exact saved source without accepting execution or publication authority', async () => {
    const nativeSource = {
      entrypoint: 'server.ts',
      files: [
        {
          path: 'server.ts',
          content: `import { server, tool, z } from '@noodleseed/one';
       export default server('welcome', { version: '1.0.0', title: 'Welcome' }, [tool('hello', {
         description: 'Say hello', input: z.object({}), fulfil: () => ({ message: 'hello' })
       })]);`,
        },
      ],
    };
    const created = await request('POST', '', { source: nativeSource, environment: 'prod' });
    const {
      data: { draft },
    } = await created.json();
    const checked = await request('POST', `/${draft.id}/validate`, { expectedRevision: 1 });
    expect(checked.status).toBe(200);
    expect(await checked.json()).toMatchObject({
      data: {
        validation: {
          draftId: draft.id,
          revision: 1,
          sourceDigest: draft.sourceDigest,
          status: 'valid',
          check: 'source-and-manifest',
          published: false,
          issues: [],
        },
      },
    });
    expect((await request('POST', `/${draft.id}/validate`, { expectedRevision: 2 })).status).toBe(
      409,
    );
    expect(
      (await request('POST', `/${draft.id}/validate`, { expectedRevision: 1, publish: true }))
        .status,
    ).toBe(400);
    expect((await request('GET', `/${draft.id}/validate`)).status).toBe(405);
    expect(
      (await request('POST', `/${draft.id}/validate`, { expectedRevision: 1 }, 'stranger')).status,
    ).toBe(403);
    const {
      data: { revisions },
    } = await (await request('GET', `/${draft.id}/history`)).json();
    expect(revisions).toHaveLength(1);
  });

  it('rejects changed source and revoked permission after compilation, without retaining a receipt', async () => {
    const {
      data: { draft },
    } = await (await request('POST', '', { source, environment: 'prod' })).json();
    compileDraft = async () => {
      await drafts.edit({
        scope: { org: 'acme', app: 'assistant' },
        id: draft.id,
        actorSubject: 'builder',
        idempotencyKey: 'edit-during-check',
        expectedRevision: 1,
        source: { ...source, files: [{ path: 'server.ts', content: '// different' }] },
      });
      return { ok: false, issues: [{ code: 'invalid_source', message: 'private diagnostic' }] };
    };
    expect((await request('POST', `/${draft.id}/validate`, { expectedRevision: 1 })).status).toBe(
      409,
    );
    compileDraft = async () => {
      await workspaces.changeRole({
        org: 'acme',
        actor: 'owner',
        subject: 'builder',
        role: 'viewer',
        expectedRevision: 3,
      });
      return { ok: false, issues: [{ code: 'invalid_source', message: 'private diagnostic' }] };
    };
    const denied = await request('POST', `/${draft.id}/validate`, { expectedRevision: 2 });
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain('private diagnostic');
  });

  it('rechecks membership before an exact retry and does not fall back to legacy ownership', async () => {
    const key = randomUUID();
    expect(
      (await request('POST', '', { source, environment: 'prod' }, 'builder', key)).status,
    ).toBe(201);
    await workspaces.changeRole({
      org: 'acme',
      actor: 'owner',
      subject: 'builder',
      role: null,
      expectedRevision: 3,
    });
    expect(
      (await request('POST', '', { source, environment: 'prod' }, 'builder', key)).status,
    ).toBe(403);
    base = base.replace('/acme/', '/legacy/');
    expect((await request('GET', '', undefined, 'owner')).status).toBe(403);
  });
});
